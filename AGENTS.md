# Agent setup

Setup for any AI assistant (over MCP). Zero dependencies — no `npm install`.

## Run it

- **Via an MCP client (e.g. Claude Code)**: a project `.mcp.json` registers the
  server; the client spawns `node server/server.mjs` over stdio and manages it. In
  Claude Code, reload the session so `.mcp.json` is read, then **approve**
  `workflow-atlas` when prompted (approval is a security boundary — it can't be
  auto-granted).
- **Standalone**: `npm start` (or `node server/server.mjs`) → http://localhost:5174/.

Requires Node ≥ 20. Override the port with `PORT=…`. If that port is taken by an
unrelated process the server steps to the next free one; if another atlas
instance holds it, this one reuses that UI and runs as an MCP/stdio worker.

**Projects.** Each session works on ONE project — by default the directory the
server was launched in (so opening repo `acme` authors the `acme` project), or set
`$WORKFLOW_ATLAS_PROJECT`. Data lives under `$WORKFLOW_ATLAS_HOME`
(`~/.workflow-atlas` by default), so parallel sessions on different projects stay
isolated. Every tool below acts on this session's project.

When you author a workflow or storyboard and no tab is open, the server opens the
app in the user's browser so they see it immediately (suppress with
`ATLAS_NO_OPEN=1`). An already-open tab live-reloads instead.

## What this is for

A communication channel: when you propose an algorithm, **build a storyboard for
it over MCP** so the user can watch it run, rather than parsing prose. Author
the visuals; don't just describe them.

## MCP tools

- **Read** — `list_algorithms`, `get_algorithm`, `get_workflows`, `get_sheet`,
  `get_review`, `get_workflow_review`, `list_open_questions`
- **Author algorithms** — `save_algorithm` (create/replace a storyboard from a
  JSON spec), `delete_algorithm`
- **Author workflows** — `save_sheet`/`delete_sheet`/`reorder_sheets` and
  `set_station`/`delete_station` upsert ONE piece by id/index (preferred); or
  `save_workflows` replaces all sheets. A sheet's `code` is a SHORT badge
  (`"WA-01"`), not pseudocode; `loop.to` may be a station index or a target
  station's title.
- **Review / decisions** — `set_param`, `set_comment`, `set_decision`,
  `reopen_question` (algorithms); `set_workflow_decision`,
  `reopen_workflow_question` answer a station's `open[]` question (by sheet id +
  exact question text)
- **The look** — `list_files`, `get_file`, `set_file` (raw CSS/HTML/JS that styles
  the app; project data is edited with the content tools, not these)

`save_algorithm` takes `{ spec }`. The simplest spec is explicit frames:
`{ id, name, kind:"array", code:[…pseudocode…], params:[], steps:[ {array, cls,
ptr, note, line, verdict, question?} … ] }`. Read `get_algorithm` on an existing
storyboard for a worked example, and `README.md` for the full frame/row shapes.

## Where things live

All project data is under `$WORKFLOW_ATLAS_HOME/projects/<this-session's-project>/`
(default `~/.workflow-atlas`) — you reach it through the tools, not the filesystem:

- **Storyboards** → use `save_algorithm` / `get_algorithm` / `list_algorithms`.
- **Workflow maps** → use `save_sheet`/`set_station` (per-piece) or `save_workflows`
  (replace-all).
- **Review overlay** (tuned params / comments / decisions) → use the review tools;
  the user edits these in the app, so read them back with `get_review` /
  `get_workflow_review` / `list_open_questions` after they say they've answered.
- **Styling** → `styles.css` and the HTML shells, via `set_file`.
