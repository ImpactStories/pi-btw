import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	SessionManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

const BTW_PREFIX = "BTW:";
const BTW_COMMAND_DESCRIPTION = "Capture or manage session-local BTW side notes.";
const BTW_BACK_COMMAND = "Archive the current note and switch back to the parent /btw session.";
const BTW_CUSTOM_TYPE = "btw";
const BTW_STATUS_KEY = "btw";
const BTW_RETURN_WITH_NEXT_STATUS = "↩ BTW session - Shift+Left archive+back • Shift+Right archive+next";
const BTW_RETURN_NO_MORE_STATUS = "↩ BTW session - Shift+Left archive+back • no more notes";
const BTW_NOTES_STATUS_PREFIX = "BTW";
const BTW_NEXT_STATUS_HINT = "Shift+Right next";
const BTW_CAPTURE_STATUS_DURATION_MS = 7000;
const BTW_CAPTURE_STATUS_PREVIEW_WIDTH = 160;
const BTW_BACK_SHORTCUTS = ["shift+left"] as const;
const BTW_NEXT_SHORTCUT = "shift+right";
const NOTE_PANEL_MAX_VISIBLE_NOTES = 10;

export type NoteStatus = "open" | "done" | "archived";

type BtwPanelAction =
	| { type: "open"; noteId: string }
	| { type: "toggle"; noteId: string }
	| { type: "archive"; noteId: string }
	| { type: "return" }
	| { type: "close" };

export interface BtwNote {
	id: string;
	text: string;
	status: NoteStatus;
	anchorEntryId?: string | null;
	createdAt: string;
	updatedAt: string;
}

interface BtwSideSession {
	noteId: string;
	sessionPath: string;
	noteText: string;
	createdAt: string;
}

export interface BtwSideSessionInfo {
	noteId: string;
	noteText: string;
	parentSession: string;
	parentNotes?: BtwNote[];
}

type SwitchSession = ExtensionCommandContext["switchSession"];
type NewSession = ExtensionCommandContext["newSession"];
type NewSessionOptions = NonNullable<Parameters<NewSession>[0]>;
type ReplacementSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];
type TimeoutHandle = ReturnType<typeof setTimeout>;

interface SessionNavigationContext extends ExtensionContext {
	switchSession?: SwitchSession;
	newSession?: NewSession;
	ui: ExtensionContext["ui"] & { switchSession?: SwitchSession; newSession?: NewSession };
}

interface InteractiveModeConstructor {
	prototype: {
		createExtensionUIContext?: (this: InteractiveModeInstance) => ExtensionContext["ui"];
	};
}

interface InteractiveModeInstance {
	handleResumeSession?: SwitchSession;
	runtimeHost?: { newSession?: NewSession };
	loadingAnimation?: { stop: () => void };
	statusContainer?: { clear: () => void };
	renderCurrentSessionState?: () => void;
	ui?: { requestRender?: () => void };
}

interface InteractiveModeModule {
	InteractiveMode?: InteractiveModeConstructor;
}

const BTW_INTERACTIVE_MODE_PATCHED = Symbol.for("impactstories.pi-btw.interactive-mode-patched.v2");

let captureStatusTimer: TimeoutHandle | undefined;
let capturedStatusText: string | undefined;
const nextSideSessionIndexByParent = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function getStatus(value: unknown): NoteStatus | undefined {
	return value === "open" || value === "done" || value === "archived" ? value : undefined;
}

function getNoteSnapshot(value: unknown): BtwNote | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const id = getText(value.id);
	const text = getText(value.text);
	const createdAt = getText(value.createdAt);
	const updatedAt = getText(value.updatedAt);
	if (!id || !text || !createdAt || !updatedAt) {
		return undefined;
	}

	return {
		id,
		text,
		status: getStatus(value.status) ?? "open",
		anchorEntryId: getText(value.anchorEntryId) ?? null,
		createdAt,
		updatedAt,
	};
}

function getNoteSnapshots(value: unknown): BtwNote[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	return value.flatMap((item) => {
		const note = getNoteSnapshot(item);
		return note ? [note] : [];
	});
}

export function normalizeNoteText(message: string): string {
	return message.trim().replace(/\s+/g, " ").trim();
}

export function normalizeBtwMessage(message: string): string {
	return `${BTW_PREFIX} ${normalizeNoteText(message)}`;
}

function createNoteId(): string {
	return randomUUID().slice(0, 8);
}

function getParentSessionPath(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getHeader()?.parentSession;
}

function appendNoteCreate(ctx: ExtensionContext, text: string): BtwNote {
	const now = new Date().toISOString();
	const note: BtwNote = {
		id: createNoteId(),
		text,
		status: "open",
		anchorEntryId: ctx.sessionManager.getLeafId(),
		createdAt: now,
		updatedAt: now,
	};

	(ctx.sessionManager as SessionManager).appendCustomEntry(BTW_CUSTOM_TYPE, {
		kind: "note",
		version: 1,
		op: "create",
		id: note.id,
		text: note.text,
		status: note.status,
		anchorEntryId: note.anchorEntryId,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
	});

	return note;
}

function appendNoteStatus(ctx: ExtensionContext, noteId: string, status: NoteStatus): void {
	(ctx.sessionManager as SessionManager).appendCustomEntry(BTW_CUSTOM_TYPE, {
		kind: "note",
		version: 1,
		op: "status",
		id: noteId,
		status,
		updatedAt: new Date().toISOString(),
	});
}

function appendNoteSnapshotCreate(ctx: ExtensionContext, note: BtwNote): void {
	(ctx.sessionManager as SessionManager).appendCustomEntry(BTW_CUSTOM_TYPE, {
		kind: "note",
		version: 1,
		op: "create",
		id: note.id,
		text: note.text,
		status: note.status,
		anchorEntryId: note.anchorEntryId,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
	});
}

export function getNotesFromEntries(entries: SessionEntry[]): BtwNote[] {
	const notes = new Map<string, BtwNote>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BTW_CUSTOM_TYPE || !isRecord(entry.data)) {
			continue;
		}

		if (entry.data.kind !== "note") {
			continue;
		}

		const id = getText(entry.data.id);
		const op = getText(entry.data.op);
		if (!id || !op) {
			continue;
		}

		if (op === "create") {
			const text = getText(entry.data.text);
			if (!text) {
				continue;
			}

			notes.set(id, {
				id,
				text,
				status: getStatus(entry.data.status) ?? "open",
				anchorEntryId: getText(entry.data.anchorEntryId) ?? null,
				createdAt: getText(entry.data.createdAt) ?? entry.timestamp,
				updatedAt: getText(entry.data.updatedAt) ?? entry.timestamp,
			});
			continue;
		}

		const note = notes.get(id);
		if (!note) {
			continue;
		}

		if (op === "status") {
			const status = getStatus(entry.data.status);
			if (status) {
				note.status = status;
				note.updatedAt = getText(entry.data.updatedAt) ?? entry.timestamp;
			}
		}
	}

	return [...notes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getSessionNotes(ctx: ExtensionContext): BtwNote[] {
	return getNotesFromEntries(ctx.sessionManager.getEntries());
}

function getVisibleNotes(ctx: ExtensionContext): BtwNote[] {
	return getSessionNotes(ctx).filter((note) => note.status !== "archived");
}

function getOpenNoteCount(ctx: ExtensionContext): number {
	return getSessionNotes(ctx).filter((note) => note.status === "open").length;
}

export function getSideSessionInfoFromEntries(entries: SessionEntry[]): BtwSideSessionInfo | undefined {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BTW_CUSTOM_TYPE || !isRecord(entry.data)) {
			continue;
		}

		if (entry.data.kind !== "side-session") {
			continue;
		}

		const noteId = getText(entry.data.noteId);
		const noteText = getText(entry.data.noteText);
		const parentSession = getText(entry.data.parentSession);
		if (noteId && noteText && parentSession) {
			return { noteId, noteText, parentSession, parentNotes: getNoteSnapshots(entry.data.parentNotes) };
		}
	}

	return undefined;
}

function getCurrentSideSessionInfo(ctx: ExtensionContext): BtwSideSessionInfo | undefined {
	return getSideSessionInfoFromEntries(ctx.sessionManager.getEntries());
}

function parseSessionFile(filePath: string): { header?: Record<string, unknown>; entries: SessionEntry[] } {
	const lines = readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim());
	const parsed = lines.flatMap((line) => {
		try {
			return [JSON.parse(line) as unknown];
		} catch {
			return [];
		}
	});
	const header = parsed.find((entry) => isRecord(entry) && entry.type === "session") as Record<string, unknown> | undefined;
	const entries = parsed.filter((entry): entry is SessionEntry => isRecord(entry) && entry.type !== "session") as SessionEntry[];
	return { header, entries };
}

function listLinkedSideSessions(ctx: ExtensionContext): BtwSideSession[] {
	const currentSession = ctx.sessionManager.getSessionFile();
	if (!currentSession) {
		return [];
	}

	let filenames: string[];
	try {
		filenames = readdirSync(ctx.sessionManager.getSessionDir());
	} catch {
		return [];
	}

	const sideSessions: BtwSideSession[] = [];
	for (const filename of filenames) {
		if (!filename.endsWith(".jsonl")) {
			continue;
		}

		const sessionPath = join(ctx.sessionManager.getSessionDir(), filename);
		if (sessionPath === currentSession) {
			continue;
		}

		try {
			const { header, entries } = parseSessionFile(sessionPath);
			if (header?.parentSession !== currentSession) {
				continue;
			}

			const sideSession = getSideSessionInfoFromEntries(entries);
			if (sideSession?.parentSession === currentSession) {
				sideSessions.push({
					noteId: sideSession.noteId,
					sessionPath,
					noteText: sideSession.noteText,
					createdAt: getText(header.timestamp) ?? "",
				});
			}
		} catch {
			continue;
		}
	}

	return sideSessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getSideSessionByNoteId(sideSessions: BtwSideSession[]): Map<string, BtwSideSession> {
	const byNoteId = new Map<string, BtwSideSession>();
	for (const sideSession of sideSessions) {
		if (!byNoteId.has(sideSession.noteId)) {
			byNoteId.set(sideSession.noteId, sideSession);
		}
	}
	return byNoteId;
}

function getSwitchSession(ctx: ExtensionContext): SwitchSession | undefined {
	const navigationContext = ctx as SessionNavigationContext;
	return navigationContext.switchSession ?? navigationContext.ui.switchSession;
}

function getNewSession(ctx: ExtensionContext): NewSession | undefined {
	const navigationContext = ctx as SessionNavigationContext;
	return navigationContext.newSession ?? navigationContext.ui.newSession;
}

function getNavigationNotesFromEntries(entries: SessionEntry[]): BtwNote[] {
	return getNotesFromEntries(entries)
		.filter((note) => note.status !== "archived")
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function getNavigationNotes(ctx: ExtensionContext): BtwNote[] {
	return getNavigationNotesFromEntries(ctx.sessionManager.getEntries());
}

export function hasLaterNavigationNote(notes: BtwNote[], noteId: string): boolean {
	const currentIndex = notes.findIndex((note) => note.id === noteId);
	return currentIndex >= 0 && currentIndex < notes.length - 1;
}

function sideSessionHasLaterNote(sideSession: BtwSideSessionInfo): boolean {
	try {
		const { entries } = parseSessionFile(sideSession.parentSession);
		const notes = getNavigationNotesFromEntries(entries);
		return notes.length > 0
			? hasLaterNavigationNote(notes, sideSession.noteId)
			: hasLaterNavigationNote(sideSession.parentNotes ?? [], sideSession.noteId);
	} catch {
		return sideSession.parentNotes ? hasLaterNavigationNote(sideSession.parentNotes, sideSession.noteId) : true;
	}
}

function restoreMissingParentNotes(ctx: ExtensionContext, notes: BtwNote[] | undefined): void {
	if (!notes?.length) {
		return;
	}

	const existingNoteIds = new Set(getSessionNotes(ctx).map((note) => note.id));
	for (const note of notes) {
		if (existingNoteIds.has(note.id)) {
			continue;
		}

		appendNoteSnapshotCreate(ctx, note);
		existingNoteIds.add(note.id);
	}
}

function archiveSideSessionNote(ctx: ExtensionContext, sideSession: BtwSideSessionInfo): void {
	const parentSession = ctx.sessionManager.getSessionFile() ?? sideSession.parentSession;
	const visibleBeforeArchive = getNavigationNotes(ctx);
	const currentIndex = visibleBeforeArchive.findIndex((note) => note.id === sideSession.noteId);

	appendNoteStatus(ctx, sideSession.noteId, "archived");

	const remainingNoteCount = getNavigationNotes(ctx).length;
	if (remainingNoteCount === 0) {
		nextSideSessionIndexByParent.delete(parentSession);
		return;
	}

	nextSideSessionIndexByParent.set(parentSession, Math.max(0, currentIndex) % remainingNoteCount);
}

function clearBtwCaptureIndicator(): void {
	if (captureStatusTimer) {
		clearTimeout(captureStatusTimer);
		captureStatusTimer = undefined;
	}

	capturedStatusText = undefined;
}

function updateBtwStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	const parentSession = getParentSessionPath(ctx);
	if (parentSession) {
		const sideSession = getCurrentSideSessionInfo(ctx);
		const status = sideSession && !sideSessionHasLaterNote(sideSession) ? BTW_RETURN_NO_MORE_STATUS : BTW_RETURN_WITH_NEXT_STATUS;
		ctx.ui.setStatus(BTW_STATUS_KEY, ctx.ui.theme.bold(ctx.ui.theme.fg("warning", status)));
		return;
	}

	const openCount = getOpenNoteCount(ctx);
	if (openCount === 0 && !capturedStatusText) {
		ctx.ui.setStatus(BTW_STATUS_KEY, undefined);
		return;
	}

	const nextSuffix = getVisibleNotes(ctx).length > 0 ? ` - ${BTW_NEXT_STATUS_HINT}` : "";
	const capturedSuffix = capturedStatusText ? ` - captured "${capturedStatusText}"` : "";
	ctx.ui.setStatus(
		BTW_STATUS_KEY,
		ctx.ui.theme.bold(ctx.ui.theme.fg("warning", `${BTW_NOTES_STATUS_PREFIX}: ${openCount} open${nextSuffix}${capturedSuffix}`)),
	);
}

function showBtwCaptureIndicator(ctx: ExtensionContext, note: BtwNote): void {
	if (!ctx.hasUI) {
		return;
	}

	if (captureStatusTimer) {
		clearTimeout(captureStatusTimer);
	}

	capturedStatusText = truncateToWidth(note.text.replace(/"/g, '\\"'), BTW_CAPTURE_STATUS_PREVIEW_WIDTH);
	updateBtwStatus(ctx);

	captureStatusTimer = setTimeout(() => {
		capturedStatusText = undefined;
		captureStatusTimer = undefined;
		try {
			updateBtwStatus(ctx);
		} catch {
			// The captured context may be stale after session replacement.
		}
	}, BTW_CAPTURE_STATUS_DURATION_MS);
}

function getInteractiveModePath(): string | undefined {
	const candidateEntryPoints = [process.argv[1], "/opt/homebrew/bin/pi", "/usr/local/bin/pi"];
	for (const entryPoint of candidateEntryPoints) {
		if (!entryPoint || !existsSync(entryPoint)) {
			continue;
		}

		const realEntryPoint = realpathSync(entryPoint);
		const candidate = join(dirname(realEntryPoint), "modes", "interactive", "interactive-mode.js");
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

async function installInteractiveModeMonkeyPatch(): Promise<void> {
	const interactiveModePath = getInteractiveModePath();
	if (!interactiveModePath) {
		return;
	}

	const module = (await import(pathToFileURL(interactiveModePath).href)) as InteractiveModeModule;
	const prototype = module.InteractiveMode?.prototype;
	const originalCreateExtensionUIContext = prototype?.createExtensionUIContext;
	if (!prototype || !originalCreateExtensionUIContext || BTW_INTERACTIVE_MODE_PATCHED in prototype) {
		return;
	}

	Object.defineProperty(prototype, BTW_INTERACTIVE_MODE_PATCHED, { value: true });
	prototype.createExtensionUIContext = function createBtwExtensionUIContext(this: InteractiveModeInstance) {
		const ui = originalCreateExtensionUIContext.call(this);
		const switchSession = this.handleResumeSession;
		if (switchSession) {
			Object.defineProperty(ui, "switchSession", {
				value: switchSession.bind(this),
				configurable: true,
			});
		}

		const newSession = this.runtimeHost?.newSession;
		if (newSession) {
			Object.defineProperty(ui, "newSession", {
				value: async (options?: NewSessionOptions) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}

					this.statusContainer?.clear();
					try {
						const result = await newSession.call(this.runtimeHost, options);
						if (!result.cancelled) {
							this.renderCurrentSessionState?.();
							this.ui?.requestRender?.();
						}
						return result;
					} catch (error) {
						ui.notify(`Could not create BTW session: ${error instanceof Error ? error.message : String(error)}`, "error");
						return { cancelled: true };
					}
				},
				configurable: true,
			});
		}

		return ui;
	};
}

async function returnToParentSession(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	const parentSession = getParentSessionPath(ctx);
	if (!parentSession) {
		ctx.ui.notify("No parent /btw session to return to.", "warning");
		return;
	}

	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the assistant to finish before switching sessions.", "warning");
		return;
	}

	const switchSession = getSwitchSession(ctx);
	if (!switchSession) {
		ctx.ui.notify("Session switching is unavailable here. Use /btw-back.", "warning");
		return;
	}

	const sideSession = getCurrentSideSessionInfo(ctx);

	try {
		const result = await switchSession(
			parentSession,
			sideSession
				? {
						withSession: async (parentCtx) => {
							restoreMissingParentNotes(parentCtx, sideSession.parentNotes);
							archiveSideSessionNote(parentCtx, sideSession);
							updateBtwStatus(parentCtx);
							parentCtx.ui.notify("Archived BTW note.", "info");
						},
					}
				: undefined,
		);
		if (result.cancelled) {
			ctx.ui.notify("Switch back was cancelled.", "warning");
		}
	} catch (error) {
		ctx.ui.notify(`Could not switch back: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function openNextBtwSideSession(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	if (getParentSessionPath(ctx)) {
		await archiveCurrentBtwAndNext(ctx);
		return;
	}

	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the assistant to finish before switching BTW sessions.", "warning");
		return;
	}

	const parentSession = ctx.sessionManager.getSessionFile();
	if (!parentSession) {
		ctx.ui.notify("Cannot switch BTW sessions from an unsaved session.", "warning");
		return;
	}

	const navigationNotes = getNavigationNotes(ctx);
	if (navigationNotes.length === 0) {
		ctx.ui.notify("No BTW notes in this session.", "info");
		return;
	}

	const index = (nextSideSessionIndexByParent.get(parentSession) ?? 0) % navigationNotes.length;
	const note = navigationNotes[index];
	if (!note) {
		ctx.ui.notify("No BTW notes available.", "info");
		return;
	}

	const opened = await openNoteSideSession(ctx, note);
	if (opened) {
		nextSideSessionIndexByParent.set(parentSession, (index + 1) % navigationNotes.length);
	}
}

async function archiveCurrentBtwAndNext(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	const sideSession = getCurrentSideSessionInfo(ctx);
	const parentSession = getParentSessionPath(ctx) ?? sideSession?.parentSession;
	if (!sideSession || !parentSession) {
		ctx.ui.notify("No current BTW side session to archive.", "warning");
		return;
	}

	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the assistant to finish before archiving this BTW note.", "warning");
		return;
	}

	const switchSession = getSwitchSession(ctx);
	if (!switchSession) {
		ctx.ui.notify("Session switching is unavailable here. Use /btw-back.", "warning");
		return;
	}

	try {
		const result = await switchSession(parentSession, {
			withSession: async (parentCtx) => {
				restoreMissingParentNotes(parentCtx, sideSession.parentNotes);
				const hasNext = hasLaterNavigationNote(getNavigationNotes(parentCtx), sideSession.noteId);
				archiveSideSessionNote(parentCtx, sideSession);
				updateBtwStatus(parentCtx);
				if (hasNext) {
					await openNextBtwSideSession(parentCtx);
				} else {
					parentCtx.ui.notify("No more BTW notes.", "info");
				}
			},
		});
		if (result.cancelled) {
			ctx.ui.notify("BTW session switch was cancelled.", "warning");
		}
	} catch (error) {
		ctx.ui.notify(`Could not archive BTW note: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function formatDateTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function padToWidth(text: string, width: number): string {
	const currentWidth = visibleWidth(text);
	return currentWidth >= width ? text : `${text}${" ".repeat(width - currentWidth)}`;
}

function frameLine(text: string, width: number, theme: Theme): string {
	const innerWidth = Math.max(0, width - 4);
	return theme.fg("borderAccent", "│ ") + padToWidth(truncateToWidth(text, innerWidth), innerWidth) + theme.fg("borderAccent", " │");
}

function frameEmpty(width: number, theme: Theme): string {
	return frameLine("", width, theme);
}

function frameBorder(width: number, title: string | undefined, theme: Theme): string {
	const innerWidth = Math.max(0, width - 2);
	const label = title ? ` ${title} ` : "";
	const left = label ? "─" : "";
	const remaining = Math.max(0, innerWidth - label.length - left.length);
	return theme.fg("borderAccent", `┌${left}${label}${"─".repeat(remaining)}┐`);
}

function frameBottom(width: number, theme: Theme): string {
	return theme.fg("borderAccent", `└${"─".repeat(Math.max(0, width - 2))}┘`);
}

class BtwNotesPanel implements Component {
	private selectedIndex = 0;
	private scrollOffset = 0;

	constructor(
		private readonly notes: BtwNote[],
		private readonly sideSessionByNoteId: Map<string, BtwSideSession>,
		private readonly currentSideSession: BtwSideSessionInfo | undefined,
		private readonly theme: Theme,
		private readonly done: (action: BtwPanelAction) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done({ type: "close" });
			return;
		}

		if (this.currentSideSession && data.toLowerCase() === "r") {
			this.done({ type: "return" });
			return;
		}

		if (this.notes.length === 0) {
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.syncScrollOffset();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.notes.length - 1, this.selectedIndex + 1);
			this.syncScrollOffset();
			return;
		}

		const selectedNote = this.notes[this.selectedIndex];
		if (matchesKey(data, Key.enter) || data.toLowerCase() === "o") {
			this.done({ type: "open", noteId: selectedNote.id });
			return;
		}

		if (data.toLowerCase() === "d") {
			this.done({ type: "toggle", noteId: selectedNote.id });
			return;
		}

		if (data.toLowerCase() === "x" || matchesKey(data, Key.delete)) {
			this.done({ type: "archive", noteId: selectedNote.id });
		}
	}

	render(width: number): string[] {
		const panelWidth = Math.max(44, width);
		const lines = [frameBorder(panelWidth, "BTW notes", this.theme)];

		if (this.currentSideSession) {
			lines.push(frameLine(this.theme.fg("warning", "Side session"), panelWidth, this.theme));
			for (const wrappedLine of wrapTextWithAnsi(`Note: ${this.currentSideSession.noteText}`, Math.max(10, panelWidth - 4))) {
				lines.push(frameLine(wrappedLine, panelWidth, this.theme));
			}
			lines.push(frameLine(this.theme.fg("dim", "r return to parent session"), panelWidth, this.theme));
			lines.push(frameEmpty(panelWidth, this.theme));
		}

		if (this.notes.length === 0) {
			lines.push(frameLine(this.theme.fg("dim", "No notes in this session."), panelWidth, this.theme));
			lines.push(frameLine(this.theme.fg("dim", "Use /btw <note> to capture one."), panelWidth, this.theme));
		} else {
			const visibleNotes = this.notes.slice(this.scrollOffset, this.scrollOffset + NOTE_PANEL_MAX_VISIBLE_NOTES);
			for (const [visibleIndex, note] of visibleNotes.entries()) {
				const index = this.scrollOffset + visibleIndex;
				const selected = index === this.selectedIndex;
				const status = note.status === "done" ? this.theme.fg("success", "✓") : this.theme.fg("warning", "○");
				const linked = this.sideSessionByNoteId.has(note.id) ? this.theme.fg("accent", "↪") : " ";
				const prefix = selected ? this.theme.fg("accent", ">") : " ";
				const text = selected ? this.theme.fg("accent", note.text) : note.text;
				lines.push(frameLine(`${prefix} ${status} ${linked} ${text}`, panelWidth, this.theme));
				if (selected) {
					lines.push(frameLine(this.theme.fg("dim", `    ${formatDateTime(note.createdAt)}`), panelWidth, this.theme));
				}
			}

			if (this.notes.length > NOTE_PANEL_MAX_VISIBLE_NOTES) {
				lines.push(
					frameLine(
						this.theme.fg("dim", `${this.selectedIndex + 1}/${this.notes.length} • ↑↓ scroll`),
						panelWidth,
						this.theme,
					),
				);
			}
		}

		lines.push(frameEmpty(panelWidth, this.theme));
		lines.push(
			frameLine(
				this.theme.fg("dim", "enter/o discuss • d done/open • x archive • esc close"),
				panelWidth,
				this.theme,
			),
		);
		lines.push(frameBottom(panelWidth, this.theme));
		return lines;
	}

	invalidate(): void {}

	private syncScrollOffset(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		}

		const visibleEnd = this.scrollOffset + NOTE_PANEL_MAX_VISIBLE_NOTES - 1;
		if (this.selectedIndex > visibleEnd) {
			this.scrollOffset = this.selectedIndex - NOTE_PANEL_MAX_VISIBLE_NOTES + 1;
		}
	}
}

async function showBtwPanel(ctx: ExtensionCommandContext): Promise<BtwPanelAction> {
	const notes = getVisibleNotes(ctx);
	const sideSessionByNoteId = getSideSessionByNoteId(listLinkedSideSessions(ctx));
	const currentSideSession = getCurrentSideSessionInfo(ctx);

	return ctx.ui.custom<BtwPanelAction>(
		(tui, theme, _keybindings, done) => {
			const panel = new BtwNotesPanel(notes, sideSessionByNoteId, currentSideSession, theme as Theme, done);
			return {
				render: (width: number) => panel.render(width),
				invalidate: () => panel.invalidate(),
				handleInput: (data: string) => {
					panel.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "70%",
				minWidth: 52,
				maxHeight: "80%",
				anchor: "center",
				margin: 1,
			},
		},
	);
}

function getSideSessionIntro(note: BtwNote, parentSession: string): string {
	return [
		"This is a /btw side session linked to a BTW note.",
		`Parent session: ${parentSession}`,
		`Note: ${note.text}`,
		"Use /btw-back or Shift+Left to archive and return, or Shift+Right to archive and open the next BTW session.",
	].join("\n");
}

async function openNoteSideSession(ctx: ExtensionContext, note: BtwNote): Promise<boolean> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the assistant to finish before opening a BTW side session.", "warning");
		return false;
	}

	const linkedSession = getSideSessionByNoteId(listLinkedSideSessions(ctx)).get(note.id);
	if (linkedSession) {
		const switchSession = getSwitchSession(ctx);
		if (!switchSession) {
			ctx.ui.notify("Session switching is unavailable here. Use /btw.", "warning");
			return false;
		}

		clearBtwCaptureIndicator();
		updateBtwStatus(ctx);

		const result = await switchSession(linkedSession.sessionPath);
		if (result.cancelled) {
			ctx.ui.notify("BTW session switch was cancelled.", "warning");
			return false;
		}
		return true;
	}

	const parentSession = ctx.sessionManager.getSessionFile();
	if (!parentSession) {
		ctx.ui.notify("Cannot create a BTW side session from an unsaved session.", "warning");
		return false;
	}

	const newSession = getNewSession(ctx);
	if (!newSession) {
		ctx.ui.notify("Session creation is unavailable here. Use /btw to open the note.", "warning");
		return false;
	}

	const noteSnapshot = { ...note };
	const parentNotesSnapshot = getNavigationNotes(ctx).map((candidate) => ({ ...candidate }));
	const options: NewSessionOptions = {
		parentSession,
		setup: async (sideSessionManager: SessionManager) => {
			sideSessionManager.appendCustomEntry(BTW_CUSTOM_TYPE, {
				kind: "side-session",
				version: 1,
				noteId: noteSnapshot.id,
				noteText: noteSnapshot.text,
				parentSession,
				parentNotes: parentNotesSnapshot,
				createdAt: new Date().toISOString(),
			});
			sideSessionManager.appendCustomMessageEntry(BTW_CUSTOM_TYPE, getSideSessionIntro(noteSnapshot, parentSession), true, {
				kind: "side-session",
				noteId: noteSnapshot.id,
				parentSession,
			});
		},
		withSession: async (sideCtx: ReplacementSessionContext) => {
			await sideCtx.sendUserMessage(normalizeBtwMessage(noteSnapshot.text));
			sideCtx.ui.notify("Opened BTW side session.", "info");
		},
	};

	clearBtwCaptureIndicator();
	updateBtwStatus(ctx);

	const result = await newSession(options);
	if (result.cancelled) {
		ctx.ui.notify("BTW side session creation was cancelled.", "warning");
		return false;
	}
	return true;
}

async function runBtwPanel(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const action = await showBtwPanel(ctx);
		if (action.type === "close") {
			return;
		}

		if (action.type === "return") {
			await returnToParentSession(ctx);
			return;
		}

		const note = getVisibleNotes(ctx).find((candidate) => candidate.id === action.noteId);
		if (!note) {
			ctx.ui.notify("BTW note no longer exists.", "warning");
			continue;
		}

		if (action.type === "toggle") {
			appendNoteStatus(ctx, note.id, note.status === "done" ? "open" : "done");
			updateBtwStatus(ctx);
			continue;
		}

		if (action.type === "archive") {
			appendNoteStatus(ctx, note.id, "archived");
			updateBtwStatus(ctx);
			continue;
		}

		if (action.type === "open") {
			await openNoteSideSession(ctx, note);
			return;
		}
	}
}

export default async function (pi: ExtensionAPI) {
	await installInteractiveModeMonkeyPatch();

	pi.on("session_start", (_event, ctx) => {
		updateBtwStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		clearBtwCaptureIndicator();
	});

	pi.registerCommand("btw", {
		description: BTW_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const raw = normalizeNoteText(args);
			if (!raw) {
				await runBtwPanel(ctx);
				return;
			}

			const note = appendNoteCreate(ctx, raw);
			updateBtwStatus(ctx);
			showBtwCaptureIndicator(ctx, note);
			ctx.ui.notify("BTW note captured. Run /btw to manage notes.", "info");
		},
	});

	pi.registerCommand("btw-back", {
		description: BTW_BACK_COMMAND,
		handler: async (_args, ctx) => {
			await returnToParentSession(ctx);
		},
	});

	pi.registerShortcut(BTW_NEXT_SHORTCUT, {
		description: "Open the next /btw note session",
		handler: async (ctx) => {
			await openNextBtwSideSession(ctx);
		},
	});

	for (const shortcut of BTW_BACK_SHORTCUTS) {
		pi.registerShortcut(shortcut, {
			description: "Archive the current note and return to the parent /btw session",
			handler: async (ctx) => {
				await returnToParentSession(ctx);
			},
		});
	}
}
