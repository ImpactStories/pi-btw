import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	getNotesFromEntries,
	getSideSessionInfoFromEntries,
	hasLaterNavigationNote,
	normalizeBtwMessage,
	normalizeNoteText,
	type BtwNote,
} from "../src/index.js";

function customBtwEntry(data: Record<string, unknown>, timestamp = "2026-01-01T00:00:00.000Z"): SessionEntry {
	return {
		type: "custom",
		customType: "btw",
		data,
		timestamp,
	} as unknown as SessionEntry;
}

describe("BTW message normalization", () => {
	it("trims and collapses whitespace", () => {
		expect(normalizeNoteText("  check\n\t the   retry logic  ")).toBe("check the retry logic");
	});

	it("formats prompts sent to side sessions", () => {
		expect(normalizeBtwMessage("  follow up\n later  ")).toBe("BTW: follow up later");
	});
});

describe("note replay", () => {
	it("reconstructs notes from create and status entries", () => {
		const notes = getNotesFromEntries([
			customBtwEntry({
				kind: "note",
				version: 1,
				op: "create",
				id: "older",
				text: "older note",
				status: "open",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
			customBtwEntry({
				kind: "note",
				version: 1,
				op: "create",
				id: "newer",
				text: "newer note",
				status: "open",
				createdAt: "2026-01-02T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
			}),
			customBtwEntry(
				{
					kind: "note",
					version: 1,
					op: "status",
					id: "older",
					status: "done",
					updatedAt: "2026-01-03T00:00:00.000Z",
				},
				"2026-01-03T00:00:00.000Z",
			),
		]);

		expect(notes).toMatchObject([
			{ id: "newer", text: "newer note", status: "open" },
			{ id: "older", text: "older note", status: "done", updatedAt: "2026-01-03T00:00:00.000Z" },
		]);
	});

	it("ignores malformed note entries", () => {
		const notes = getNotesFromEntries([
			customBtwEntry({ kind: "note", op: "create", id: "missing-text" }),
			customBtwEntry({ kind: "other", op: "create", id: "other", text: "ignore me" }),
		]);

		expect(notes).toEqual([]);
	});
});

describe("side session metadata", () => {
	it("reads linked side session metadata and parent note snapshots", () => {
		const info = getSideSessionInfoFromEntries([
			customBtwEntry({
				kind: "side-session",
				version: 1,
				noteId: "note-1",
				noteText: "investigate cache invalidation",
				parentSession: "/tmp/parent.jsonl",
				parentNotes: [
					{
						id: "note-1",
						text: "investigate cache invalidation",
						status: "open",
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		]);

		expect(info).toEqual({
			noteId: "note-1",
			noteText: "investigate cache invalidation",
			parentSession: "/tmp/parent.jsonl",
			parentNotes: [
				{
					id: "note-1",
					text: "investigate cache invalidation",
					status: "open",
					anchorEntryId: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
	});
});

describe("note navigation", () => {
	const notes: BtwNote[] = [
		{
			id: "first",
			text: "first",
			status: "open",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		{
			id: "second",
			text: "second",
			status: "open",
			createdAt: "2026-01-02T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		},
	];

	it("detects whether another visible note follows the current one", () => {
		expect(hasLaterNavigationNote(notes, "first")).toBe(true);
		expect(hasLaterNavigationNote(notes, "second")).toBe(false);
		expect(hasLaterNavigationNote(notes, "missing")).toBe(false);
	});
});
