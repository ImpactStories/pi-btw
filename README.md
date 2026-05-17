# pi-btw

`pi-btw` is a [pi](https://pi.dev) extension for parking side thoughts without derailing the current coding-agent session.

Use it when you notice something important but do not want the agent to switch tasks yet. Capture the note, keep working, then later open each note in its own linked side session.

## Install

```bash
pi install npm:@impactstories/pi-btw
```

For local development:

```bash
git clone https://github.com/ImpactStories/pi-btw.git
cd pi-btw
npm install
pi -e .
```

## Commands and shortcuts

| Command / shortcut | What it does |
| --- | --- |
| `/btw <note>` | Capture a session-local BTW note. |
| `/btw` | Open the notes panel. |
| `/btw-back` | From a BTW side session, archive the current note and return to the parent session. |
| `Shift+Right` | Open the next BTW note side session. From a side session, archive the current note and continue to the next note. |
| `Shift+Left` | From a BTW side session, archive the current note and return to the parent session. |

Notes panel keys:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a note. |
| `Enter` / `o` | Open or resume a linked side session for the selected note. |
| `d` | Toggle done/open. |
| `x` / `Delete` | Archive the note. |
| `r` | Return from a side session to the parent session. |
| `Esc` / `Ctrl+C` | Close the panel. |

## Workflow

1. Capture interruptions as they happen:

   ```text
   /btw Check whether the API client should retry 429 responses
   ```

2. Continue the main task. The footer shows how many open BTW notes remain.
3. Press `Shift+Right` or run `/btw` and open a note.
4. pi creates a side session linked to the note and sends the note as a `BTW:` prompt.
5. Press `Shift+Left` or run `/btw-back` to archive the note and return to the parent session.

BTW notes are stored as custom entries in pi's session JSONL file. Side sessions point back to their parent session, so the extension can resume existing side sessions instead of duplicating them.

## Compatibility note: session-navigation monkey patch

`pi-btw` currently applies a small interactive-mode monkey patch at startup.

The extension needs to create and switch sessions from keyboard shortcuts (`Shift+Right` / `Shift+Left`). pi exposes `newSession()` and `switchSession()` to command handlers such as `/btw`, but shortcut handlers currently receive a narrower extension context that does not include those session-navigation methods.

Until pi exposes those methods to shortcut handlers directly, `pi-btw` patches `InteractiveMode.createExtensionUIContext()` to attach:

- `ctx.ui.newSession(...)`, backed by the same runtime path as command `ctx.newSession(...)`
- `ctx.ui.switchSession(...)`, backed by interactive mode's resume-session handler

The patch is guarded by `Symbol.for("impactstories.pi-btw.interactive-mode-patched.v2")` so it is installed only once. If pi changes its interactive internals, the shortcuts may stop opening/switching sessions; the `/btw` and `/btw-back` commands are the intended fallback.

The proper upstream pi change would be to give user-initiated shortcut handlers a command-capable context, or otherwise expose session navigation as a supported shortcut API. That would let this extension remove the monkey patch entirely.

## Development

```bash
npm install
npm run typecheck
npm test
npm run ci
```

Run against a local checkout:

```bash
pi -e /absolute/path/to/pi-btw
```

Or install the local package into pi settings:

```bash
pi install /absolute/path/to/pi-btw
```

## Release

Publishing is currently manual because npm may require passkey/OTP approval:

```bash
npm run ci
npm publish --access public
```

After publishing, commit the version bump and tag it:

```bash
git tag v0.1.0
git push origin main --tags
```

## Security

pi extensions run with your local user permissions. Review extension code before installing third-party packages.
