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

Releases are tag-driven. After updating `package.json` and committing the change:

```bash
npm version patch   # or minor / major
git push origin main --follow-tags
```

The release workflow runs type checks and tests, then publishes the package to npm with provenance. It expects an `NPM_TOKEN` repository secret.

## Security

pi extensions run with your local user permissions. Review extension code before installing third-party packages.
