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

**Projects.** Each session works on ONE project — by default the **git repo root**
(so opening repo `acme`, or any of its **worktrees**, authors the one `acme` project),
else the launch directory's name when it isn't a git repo, or set `$WORKFLOW_ATLAS_PROJECT`
to override. Data lives under `$WORKFLOW_ATLAS_HOME` (`~/.workflow-atlas` by default), so
parallel sessions on different projects stay isolated. Every tool below acts on this
session's project.

**Concurrency.** Each sheet carries a `rev` (a content token). Any edit — yours in the app
or the assistant's over MCP — bumps it. A reading MCP tool records the rev it saw, and a later
`edit_board` / `set_node` / `save_sheet` is **auto-rejected** if the sheet changed since (you
edited it in the app meanwhile) — re-read and re-apply, or pass `force:true`. So the assistant
can't silently overwrite your hand edits. (`baseRev` pins it explicitly; a cross-process file
lock keeps two worktree sessions from clobbering each other.)

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

- **node** — `{ id, x, y, w, h, title, status, sub?, detail?, algorithm?, board?, boardRef? }`.
  `status` ∈ `done·partial·todo`; `detail` = `{ in[], out[], note, open[] }` (the
  inspector); `algorithm` links a storyboard; **`board` nests a child chart** (same
  `{ nodes, edges }` shape, recursively); **`boardRef` MOUNTS another sheet** (transclusion)
  instead of owning a board — the card shows that shared component live + read-only and
  inherits its status. Mark the mounted sheet `shared: true` with its own `status`; the
  cards that mount it surface via `list_shared`. `board`/`boardRef` are mutually exclusive,
  and a boardRef cycle is rejected at save.
- **edge** — `{ id, from, to, kind, label?, fromSide? }`. `from`/`to` MUST be node ids
  **in the SAME board** — express a cross-level link by containment (nest the node),
  never by an edge. `kind` ∈ `flow·loop·dep`; `fromSide` ∈ `top·right·bottom·left`
  is the side the edge leaves the source node.

Author the `board` directly to build nesting. A flat `stations: [...]` spine still
works (auto-migrated: fan → a nested child board, loop → a `loop` edge) — reach for it
only for a quick linear flow.

## MCP tools (25)

- **Read** — `list_sheets` (TOC: ids + status counts + each sheet's `rev`, no boards — start
  here), `get_sheet` (one sheet, optional `depth`), `get_node` (one node by its
  `#sheet/nodeId/…` path, optional `depth`), `find_nodes` (search/index every node by
  text or status across a sheet or the whole project → returns each match's **path**, so
  you jump straight to it instead of drilling board by board), `list_algorithms`,
  `get_algorithm`, `get_review`, `list_open_questions` (open/decided across storyboards
  AND sheets), `list_shared` (transcluded components).
- **Author algorithms** — `save_algorithm` (create/replace a storyboard from a JSON spec),
  `delete_algorithm`.
- **Author workflows (whole sheet)** — `save_sheet` writes a whole sheet **with its nested
  `board`** of nodes/edges (see the model above); `delete_sheet` / `reorder_sheets` manage the
  set. Reach for `save_sheet` to **create** a sheet or rewrite it wholesale. A sheet's `code` is
  a SHORT badge (`"WA-01"`), not pseudocode. A legacy `stations[]` spine is still accepted here
  and auto-migrates to a board on read.
- **Author workflows (granular — preferred for edits)** — keep the diagram in sync without
  resending the sheet:
  - `set_node` — patch ONE card by its `#sheet/nodeId/…` path. `set` merges into the node
    (top-level keys replace; `detail` merges per key — `{detail:{note}}` leaves `in/out/open`
    untouched; a `null` clears a field; an array replaces the whole array). **Patch-by-default**:
    an unknown node id errors (no silent phantom) unless `create:true` (a new node needs a title).
  - `edit_board` — edit a whole board in one atomic call: `at` = a sheet id (root board) or
    `sheetId/nodeId/…` (a nested board); `nodes[]`/`edges[]` upsert-merge by id; `deleteNodes[]`
    (cascades incident edges) / `deleteEdges[]` remove. Use for edges, deletes, or several cards
    at once. Editing into a leaf node with no board yet **creates** that child board (so you can
    author nesting); a typo in a non-leaf segment errors rather than vivifying empty boards.
  - Both take `baseRev` / `force` and are guarded against a concurrent human edit (see
    Concurrency above).
- **Review / decisions** — `set_param`, `set_comment`, `set_decision`, `reopen_question`
  (algorithms, by step); `set_workflow_decision`, `reopen_workflow_question` answer a node's
  `open[]` question (by sheet id + exact question text).
- **The look** — `list_files`, `get_file`, `set_file` (raw CSS/HTML/JS that styles the app;
  project data is edited with the content tools, not these).

`save_algorithm` takes `{ spec }`. The simplest spec is explicit frames:
`{ id, name, kind:"array", code:[…pseudocode…], params:[], steps:[ {array, cls,
ptr, note, line, verdict, question?} … ] }`. Read `get_algorithm` on an existing
storyboard for a worked example, and `README.md` for the full frame/row shapes.

## Where things live

All project data is under `$WORKFLOW_ATLAS_HOME/projects/<this-session's-project>/`
(default `~/.workflow-atlas`) — you reach it through the tools, not the filesystem:

- **Storyboards** → use `save_algorithm` / `get_algorithm` / `list_algorithms`.
- **Workflow maps** → `set_node` / `edit_board` (granular, preferred) for edits, or
  `save_sheet` to create/rewrite a whole sheet; `delete_sheet` / `reorder_sheets` manage the set.
- **Review overlay** (tuned params / comments / decisions) → use the review tools;
  the user edits these in the app, so read them back with `get_review` /
  `list_open_questions` after they say they've answered.
- **Styling** → `styles.css` and the HTML shells, via `set_file`.
