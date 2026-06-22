# Agent setup

Setup for an AI coding assistant. Zero dependencies — no `npm install`.

## Run it

- **In Claude Code**: the project `.mcp.json` registers the server. Reload the
  session so it's read, then **approve** `workflow-atlas` when prompted. Claude
  Code spawns and manages the process; the app is then live at
  http://localhost:5174/ and the MCP tools are available. Approval is a security
  boundary — it cannot be auto-granted.
- **Standalone**: `npm start` (or `node server/server.mjs`) → http://localhost:5174/.

Requires Node ≥ 18. Override the port with `PORT=…`.

## MCP tools

- `list_algorithms`, `get_algorithm_source`, `get_review`
- `set_param` (tune a tolerance), `set_comment` (per-step note)
- `list_open_questions`, `set_decision`, `reopen_question`

All writes land in `traces/<algorithm>.review.json` — the same file the app
autosaves and reloads, so you and the user share one source of truth.

## Where to edit

- **Workflows** → `data.js` (the `SHEETS` array).
- **Algorithm storyboards** → add a `traces/<name>.js` trace, then register it in
  the `ALGORITHMS` array in `storyboard.js`.
- **Tuned params / comments / decisions** → `traces/*.review.json` (or via the
  MCP tools above; don't hand-edit while the app is autosaving).

See `README.md` for the data shapes and the full design.
