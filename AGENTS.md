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

## Tests

The runtime ships zero dependencies; tests use dev-only deps (`npm install` first).

- `npm run test:unit` — pure-model unit tests (`shared/board.js`: validation, the
  cycle guard, path helpers). Fast, no browser.
- `npm run test:e2e` — Playwright drives the **real** server + Chromium against an
  isolated seeded project (`.atlas-e2e-home`, wiped each run). Covers the infinite
  nested zoom (dive 25 levels with the cam-scale staying O(1), seamless re-root,
  auto-reroot/pop on continuous wheel), the breadcrumb navigator, focus-depth
  persistence across reload, and direct-manipulation editing (inline title, drag,
  create, delete, space-pan). `npm test` runs both.

The canvas exposes `window.__atlasCanvas` (e.g. `getNav()`, `popFocus()`,
`focusPath()`, `_cam()`, `_settled()`) as the test/automation handle.

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

## The workflow model: an infinite-nested canvas

A workflow map is **sheets**; each sheet is a **board** = `{ nodes: [], edges: [] }`
laid out freely (not a fixed spine). The key move: **a node can contain its own
board** (`node.board`), so charts nest to **unbounded depth** — the canvas zooms into
a node, re-roots onto its child board, and resets its scale at each level, so depth is
free (the e2e suite dives 25 levels). Zoom out to pop; the breadcrumb and the URL hash
(`#<sheet>/<nodeId>/…`) track where you are.

- **node** — `{ id, x, y, w, h, title, status, sub?, detail?, algorithm?, board? }`.
  `status` ∈ `done·partial·todo`; `detail` = `{ in[], out[], note, open[] }` (the
  inspector); `algorithm` links a storyboard; **`board` nests a child chart** (same
  `{ nodes, edges }` shape, recursively).
- **edge** — `{ id, from, to, kind, label?, fromSide? }`. `from`/`to` MUST be node ids
  **in the SAME board** — express a cross-level link by containment (nest the node),
  never by an edge. `kind` ∈ `flow·loop·dep`; `fromSide` ∈ `top·right·bottom·left`
  is the side the edge leaves the source node.

Author the `board` directly to build nesting. A flat `stations: [...]` spine still
works (auto-migrated: fan → a nested child board, loop → a `loop` edge) — reach for it
only for a quick linear flow.

## MCP tools

- **Read** — `list_algorithms`, `get_algorithm`, `get_workflows`, `get_sheet`,
  `get_review`, `get_workflow_review`, `list_open_questions`
- **Author algorithms** — `save_algorithm` (create/replace a storyboard from a
  JSON spec), `delete_algorithm`
- **Author workflows** — `save_sheet` writes a whole sheet **with its nested `board`**
  of nodes/edges (see the model above); `delete_sheet`/`reorder_sheets` manage the set;
  `save_workflows` replaces all sheets. `set_station`/`delete_station` upsert one
  station in the legacy linear-spine shorthand (`loop.to` = station index or target
  title). A sheet's `code` is a SHORT badge (`"WA-01"`), not pseudocode.
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
