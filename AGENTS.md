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

## What this is for

A communication channel: when you propose an algorithm, **build a storyboard for
it over MCP** so the user can watch it run, rather than parsing prose. Author
the visuals; don't just describe them.

## MCP tools

- **Read** — `list_algorithms`, `get_algorithm`, `get_workflows`, `get_review`,
  `list_open_questions`
- **Author content** — `save_algorithm` (create/replace a storyboard from a JSON
  spec), `delete_algorithm`, `save_workflows`
- **Review / decisions** — `set_param`, `set_comment`, `set_decision`,
  `reopen_question`
- **The look** — `list_files`, `get_file`, `set_file` (raw CSS/HTML/JS at the
  project root; `server/` and `content/` are off-limits)

`save_algorithm` takes `{ spec }`. The simplest spec is explicit frames:
`{ id, name, kind:"array", code:[…pseudocode…], params:[], steps:[ {array, cls,
ptr, note, line, verdict, question?} … ] }`. Read `get_algorithm` on a bundled
demo for a worked example, and `README.md` for the full frame/row shapes.

## Where things live

- **Storyboards** → `content/algorithms/<id>.json` (auto-discovered; no
  registration). Use `save_algorithm`.
- **Workflow maps** → `content/workflows.json`. Use `save_workflows`.
- **Review overlay** (tuned params / comments / decisions) →
  `content/reviews/<id>.json`. Use the review tools; don't hand-edit while the
  app is autosaving.
- **Styling** → `styles.css` and the HTML shells, via `set_file`.
