# Workflow Atlas

Two tools for thinking and communicating about software, in one tiny app:

1. **Workflows** — hand-laid visual maps of a process, styled like technical drawings.
2. **Algorithm storyboards** — step-by-step *animations* of how an algorithm
   behaves, with editable parameters and per-step comments, so an idea lands as a
   moving picture instead of a wall of prose.

A **zero-dependency local server** serves the app and gives any AI assistant — over
**MCP**, so it's not tied to one provider — an authoring surface: it can create and
edit the algorithm storyboards, the workflow maps, and even the CSS/HTML styling,
so when the assistant proposes an algorithm it can *show* you a moving picture
instead of a wall of prose. One install serves **many projects and parallel
sessions**: each project's content lives in a home directory, and the server routes
each session to its own project automatically (see [Projects](#projects)).

Open source under the **MIT License** (see `LICENSE`). No build step, no npm
install, no framework — plain HTML/CSS/JS and Node built-ins.

> New projects start **empty**, so demos never mix with real work. To populate a
> fresh project with the bundled **demo content** (the authoring-loop and boot &
> serve maps, plus binary search / bubble sort / Euclid's GCD storyboards), run the
> server once with `WORKFLOW_ATLAS_SEED=1`.

## Run

Zero install (Node ≥ 20). From this folder:

```bash
npm start                  # → http://localhost:5174/   (or: node server/server.mjs)
```

Works with **any MCP client**. With **Claude Code** you don't start it yourself —
a project `.mcp.json` registers the server so the client spawns and manages it
(one-time: approve it when prompted). Any other MCP client can launch
`node server/server.mjs` over stdio just the same. The one process serves the app
and exposes the MCP tools.

The open tab **live-reloads** when content changes — author a spec or workflow
(this session or another) and the page refreshes itself (review autosaves are
excluded, so typing a comment never reloads under you). A server is **required**:
the app fetches project data from `/api`, and that data lives in your home dir,
not in the served folder.

When the assistant **authors** a workflow or storyboard (`save_workflows` /
`save_algorithm`) and no tab is open yet, the server **opens the app in your
default browser** so the result is in front of you; if a tab is already open it
just live-reloads instead. Disable the auto-open with `ATLAS_NO_OPEN=1`.

If the port (default `5174`, override with `PORT`) is busy, the server adapts:
if another workflow-atlas instance already holds it, this process reuses that UI
and runs as an MCP/stdio worker (the shared file watcher still live-reloads your
edits); if something unrelated holds it, the server steps to the next free port.

**Local-only by design.** The server binds to `127.0.0.1` and its write surface
(the MCP tools and review autosave) rejects any request that isn't same-machine,
same-origin — so a website you visit or another host on your network can't drive
it. It is unauthenticated tooling meant for your own machine; only set
`ATLAS_HOST` to expose it on another interface if you understand the risk.

## Projects

Every project's content (algorithms, workflow maps, review overlays) is stored
under a home directory — `~/.workflow-atlas/projects/<project>/` by default,
override the base with `$WORKFLOW_ATLAS_HOME`. So one install serves many projects,
and parallel sessions stay isolated.

- **Routing.** Each server process is bound to **one** project: by default the
  directory it was launched in (so an MCP client opened in repo `acme` authors the
  `acme` project automatically). Set `$WORKFLOW_ATLAS_PROJECT` to pick one
  explicitly. The UI has a **project switcher** (top-left) to view any project, and
  the active project shows in the browser tab title.
- **Isolation & concurrency.** Different-project sessions never contend; writes are
  atomic (temp-file + rename) so a torn write or two same-project sessions can't
  corrupt a file. The destructive `save_workflows` (replace-all) snapshots the prior
  file to `workflows.json.bak` first.
- **Seeding.** New projects start empty; `WORKFLOW_ATLAS_SEED=1` copies the bundled
  demos into a fresh project.

## Edit

All content is **JSON** — no diagram syntax, no code — stored per project under
`$WORKFLOW_ATLAS_HOME` (see [Projects](#projects)) and edited through the **MCP
tools** (the assistant authors it; changes show on reload). For workflows, prefer
the **per-sheet/per-station** tools (`save_sheet`, `delete_sheet`, `reorder_sheets`,
`set_station`, `delete_station`) over the replace-all `save_workflows` — they edit
one piece without resending the rest.

A workflow map is a set of sheets (`{ sheets: [...] }`):

- A **sheet** is `{ id, code, name, title, sub, stations: [...] }`; add one and
  it appears in the left index automatically. `code` is a **short badge**
  (e.g. `"WA-01"`), not the pseudocode an algorithm spec carries.
- A **station** is `{ title, sub, status, detail }`. `detail` holds
  `{ in[], out[], note, open[] }` — shown in the callout. Each `open[]` question
  can be **answered in the callout** (recorded as a decision); the assistant can
  read and resolve them over MCP, same as algorithm questions.
- `loop: { to, label }` draws a dashed feedback arc back to an earlier station.
  `to` is a station index **or** a target station's title (a title survives
  reordering).
- `fan: { tracks: [...] }` renders parallel branches off the spine.
- `algorithm: '<id>'` links a station to its storyboard.

`save_sheet` / `save_workflows` **reject** a non-slug `id`, a `code` that isn't a
short string, a bad `status`, and non-string `detail.open/in/out` (and
`save_workflows` also rejects duplicate sheet ids); the response echoes non-fatal
**lint warnings** (overlong badge, a sheet with no stations, a `loop.to` title with
no matching station, an open question whose exact text repeats within a sheet).
Deleting a sheet **keeps** its recorded decisions, so re-creating the same id later
recovers them. The destructive `save_workflows` (replace-all) snapshots the prior
file to the project's `workflows.json.bak` first, so an accidental reset is
recoverable until the next replace-all.

## Algorithm storyboards

A second view (top-left **Workflows / Algorithms** switch, or open
`algorithms.html`) animates an algorithm step by step instead of describing it
in prose. The stage shows the data (an array of value cells, or a worksheet),
the pseudocode highlights the active line, and the narration explains each step
— synced to a play / step / scrub transport (← → to step, space to play).

Each storyboard is a **JSON spec** (authored with `save_algorithm`, auto-discovered
— no registration step). A spec is:

```jsonc
{
  "id": "binary-search", "tag": "ALG-01", "name": "Binary search",
  "sub": "…", "kind": "array",            // "array" (value cells) or "calc" (worksheet)
  "code": ["pseudocode", "lines"],         // highlighted as it runs
  "params": [ { "key": "target", "value": 33, "min": 1, "max": 99, "step": 1 } ],
  "steps": [ /* explicit frames — the simple, fully-authorable path */ ]
}
```

A **frame** (`kind: "array"`) is `{ array[], cls{index:state}, ptr{label:index},
note, line, verdict{ok?,text}, question? }`, where `state` is one of
`idle·active·compare·lo·hi·mid·eliminated·found·sorted`. A **row**
(`kind: "calc"`) is `{ label, result?, expr?, sub?, note, line, question? }`.

Instead of `steps`, a spec may set `"builtin": "<name>"` + `"data"` to be driven
live by a built-in generator in `shared/generators.js` (the bundled binary
search, bubble sort, and Euclid demos use this — change a param and the whole
walk re-runs). Authored storyboards just use `steps`. Add one with the
`save_algorithm` MCP tool.

### Tuned params, comments & decisions — the review overlay

Your layer over a storyboard — tuned params, per-step comments, and recorded
decisions — lives beside the spec in the project's `reviews/<id>.json`. With the
server running the app **autosaves** to it as you edit and reloads it as the
baseline next time. (Offline, edits stay in the browser only.)

### Open questions → decisions

A trace step can pose an open design question (`question: '…'`). The storyboard
shows it on that step with a box to **record the decision** (answer + who +
when); resolved questions show settled, and the timeline marks open (hollow) vs
decided (green). The decision is stored alongside the rest in the review file
(`decisions[step]`). The point: addressing a question is one durable action, and
the assistant can read/resolve it too. Best practice — when you decide, also let
it drive a real change (a param default, the logic, a step's status) so the
artifact and the decision can't drift apart.

### Server + MCP — so the assistant shares the same data

`server/server.mjs` is one zero-dependency process that serves the app, persists
reviews over REST, and speaks **MCP** — over **stdio** (how an MCP client like
Claude Code launches it) *and* at `/mcp` over HTTP (for manual testing). Every tool
acts on the session's project. Tools:

- **Read** — `list_algorithms`, `get_algorithm`, `get_workflows`, `get_sheet`,
  `get_review`, `get_workflow_review`, `list_open_questions`
- **Author algorithms** — `save_algorithm`, `delete_algorithm`
- **Author workflows** — `save_sheet` / `delete_sheet` / `reorder_sheets` and
  `set_station` / `delete_station` (per-piece upserts; preferred), or
  `save_workflows` (replace-all)
- **Review / decisions** — `set_param`, `set_comment`, `set_decision`,
  `reopen_question` (algorithms); `set_workflow_decision`,
  `reopen_workflow_question` (workflow open questions)
- **The look** — `list_files`, `get_file`, `set_file` → read/overwrite the raw
  CSS / HTML / JS that style the app (project data is edited with the content tools)

So the loop is: the assistant proposes an algorithm → it builds the storyboard
with `save_algorithm` → you watch it run and leave a comment or decision → the
assistant reads that over MCP and revises. Showing, not just telling. (The server
also advertises this in its MCP `instructions`, so when you say you've answered,
the assistant knows to call `list_open_questions` and read your decisions back.)

### Optional: auto-pickup hook

`scripts/atlas-review-hook.mjs` is a Claude Code **UserPromptSubmit** hook: once
you've answered every open question on a sheet/storyboard, your next message
carries those decisions automatically (so the assistant revises without being
told to re-read). It fires **per unit** — answering one sheet doesn't wait on the
others, and the bundled demo questions never block it — and only once per
answered state.

Wire it in your **user** settings with the **absolute** path to the script. It
reads the same project the server bound to — derived from the directory Claude Code
is open in, under `$WORKFLOW_ATLAS_HOME` — so it works from any repo:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "node \"/abs/path/to/workflow-atlas/scripts/atlas-review-hook.mjs\"" }
] } ] } }
```

`ATLAS_HOOK_DEBUG=1` prints why it did/didn't fire (and which project) to stderr;
`ATLAS_CONTENT_DIR` overrides the project path. It never blocks your prompt.

**If your client is Claude Code**, a project `.mcp.json` runs the server as a stdio
MCP server, so it's spawned every session — you never start it by hand. One-time:
**reload the session** (so `.mcp.json` is read) and **approve** the server when
prompted. Other MCP clients register `node server/server.mjs` however they spawn
stdio servers.

## Files

```
workflow-atlas/
  index.html             workflows shell (title block · sheet · callout)
  algorithms.html        storyboard shell (stage · pseudocode · narration)
  styles.css             design system — palette, type, spine, stage
  app.js                 workflow renderer (sheets, stations, loops, callout)
  storyboard.js          algorithm player (loads specs, replay, transport)
  shared/generators.js   built-in algorithm generators (browser + server)
  shared/project.js      active-project resolution + switcher (browser)
  scripts/
    atlas-review-hook.mjs  optional Claude Code UserPromptSubmit hook
  content/               bundled demo seed (copied into a project on WORKFLOW_ATLAS_SEED=1)
  server/server.mjs      zero-dep Node server: static + REST + MCP (stdio + /mcp)
  package.json           npm start, metadata (zero dependencies)
  .mcp.json              registers the server for Claude Code
  LICENSE                MIT

~/.workflow-atlas/       project DATA (override with $WORKFLOW_ATLAS_HOME)
  projects/<project>/
    workflows.json       workflow maps
    algorithms/*.json    algorithm storyboards
    index.json           discovery manifest (server rewrites on save/delete)
    reviews/*.json       tuned params + comments + decisions (server writes)
```

`.mcp.json` registers the server (Claude Code's format; any MCP client can spawn
`node server/server.mjs` over stdio):

```json
{ "mcpServers": { "workflow-atlas": { "command": "node", "args": ["server/server.mjs"] } } }
```

(Another project can point its own `.mcp.json` here via a relative path such as
`../workflow-atlas/server/server.mjs`, so the tool stays usable from that
session too.)
