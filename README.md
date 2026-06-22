# Workflow Atlas

Two tools for thinking and communicating about software, in one tiny app:

1. **Workflows** — hand-laid visual maps of a process, styled like technical drawings.
2. **Algorithm storyboards** — step-by-step *animations* of how an algorithm
   behaves, with editable parameters and per-step comments, so an idea lands as a
   moving picture instead of a wall of prose.

A **zero-dependency local server** serves the app and gives an AI coding
assistant an **MCP authoring surface**: it can create and edit the algorithm
storyboards, the workflow maps, and even the CSS/HTML styling — so when the
assistant proposes an algorithm it can *show* you a moving picture instead of a
wall of prose you have to decode. Local-only tooling: a richer back-and-forth
channel between you and the assistant.

Open source under the **MIT License** (see `LICENSE`). No build step, no npm
install, no framework — plain HTML/CSS/JS and Node built-ins.

> The bundled examples are **demo content**: two workflow maps of the tool's own
> internals — the **authoring loop** (how a described algorithm becomes a moving
> storyboard) and **boot & serve** (how the server runs) — plus classic-algorithm
> storyboards (binary search, bubble sort, Euclid's GCD). Replace the JSON under
> `content/` with your own (or have the assistant do it over MCP).

## Run

Zero install (Node ≥ 20). From this folder:

```bash
npm start                  # → http://localhost:5174/   (or: node server/server.mjs)
```

**With Claude Code**, you don't start it yourself — the project `.mcp.json`
registers the server so Claude Code spawns and manages it for you (one-time:
approve it when prompted). The same process serves the app at
http://localhost:5174/ and gives the assistant the MCP tools.

Read-only fallback (any static server, no autosave):

```bash
python -m http.server 8080   # → http://localhost:8080
```

(A server is needed because the app fetches its content (`content/*.json`) over
HTTP, which the browser blocks over `file://`.) With the server running the open
tab **live-reloads** whenever a file changes — edit a spec, a workflow, or the
CSS and the page refreshes itself (the app's own review autosaves are excluded,
so typing a comment never reloads under you).

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

## Edit

All content is **JSON under `content/`** — no diagram syntax, no code. Edit the
files directly, or have the assistant write them over MCP; changes show on
reload. For workflows, prefer the **per-sheet/per-station** tools (`save_sheet`,
`delete_sheet`, `reorder_sheets`, `set_station`, `delete_station`) over the
replace-all `save_workflows` — they edit one piece without resending the rest.

Workflow maps live in **`content/workflows.json`** (`{ sheets: [...] }`):

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
file to `content/workflows.json.bak` first, so an accidental reset is recoverable
until the next replace-all.

## Algorithm storyboards

A second view (top-left **Workflows / Algorithms** switch, or open
`algorithms.html`) animates an algorithm step by step instead of describing it
in prose. The stage shows the data (an array of value cells, or a worksheet),
the pseudocode highlights the active line, and the narration explains each step
— synced to a play / step / scrub transport (← → to step, space to play).

Each storyboard is a **JSON spec** in `content/algorithms/<id>.json` —
auto-discovered via `content/index.json`, no registration step. A spec is:

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
`save_algorithm` MCP tool, or by dropping a JSON file in `content/algorithms/`.

### Tuned params, comments & decisions — the review overlay

Your layer over a storyboard — tuned params, per-step comments, and recorded
decisions — is a separate file: `content/reviews/<id>.json`. With the server
running the app **autosaves** to it as you edit and reloads it as the baseline
next time. (Without a server, edits stay in the browser only.)

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
reviews over REST, and speaks **MCP** — over **stdio** (how Claude Code launches
it) *and* at `/mcp` over HTTP (for manual testing). Tools:

- **Read** — `list_algorithms`, `get_algorithm`, `get_workflows`, `get_sheet`,
  `get_review`, `get_workflow_review`, `list_open_questions`
- **Author algorithms** — `save_algorithm`, `delete_algorithm`
- **Author workflows** — `save_sheet` / `delete_sheet` / `reorder_sheets` and
  `set_station` / `delete_station` (per-piece upserts; preferred), or
  `save_workflows` (replace-all) → write `content/workflows.json`
- **Review / decisions** — `set_param`, `set_comment`, `set_decision`,
  `reopen_question` (algorithms); `set_workflow_decision`,
  `reopen_workflow_question` (workflow open questions)
- **The look** — `list_files`, `get_file`, `set_file` → read/overwrite the raw
  CSS / HTML / JS at the project root (`server/` and `content/` are off-limits —
  use the content tools for those)

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

Because you normally run Claude Code in *another* project (the Atlas server is an
MCP tool), wire it in your **user** settings with the **absolute** path to the
script — the script finds Atlas's `content/` relative to itself:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "node \"/abs/path/to/workflow-atlas/scripts/atlas-review-hook.mjs\"" }
] } ] } }
```

Set `ATLAS_CONTENT_DIR` if your content lives elsewhere, and `ATLAS_HOOK_DEBUG=1`
to print why it did/didn't fire to stderr. It never blocks your prompt.

**Claude Code manages the process.** A project `.mcp.json` runs the server as a
stdio MCP server (`node server/server.mjs`), so Claude Code spawns it every
session — you never start it by hand. One-time: **reload the session** (so
`.mcp.json` is read) and **approve** the server when prompted. After that the
tools are available and the app is live at http://localhost:5174/.

(Approval is Claude Code's security boundary — it can't be auto-granted. If the
server doesn't appear or won't connect, tell me; some builds want a different
transport key.)

## Files

```
workflow-atlas/
  index.html             workflows shell (title block · sheet · callout)
  algorithms.html        storyboard shell (stage · pseudocode · narration)
  styles.css             design system — palette, type, spine, stage
  app.js                 workflow renderer (sheets, stations, loops, callout)
  storyboard.js          algorithm player (loads specs, replay, transport)
  shared/generators.js   built-in algorithm generators (browser + server)
  content/
    index.json           discovery manifest (server rewrites on save/delete)
    workflows.json       workflow maps          ← content tools edit these
    algorithms/*.json    algorithm storyboards
    reviews/*.json       tuned params + comments + decisions (server writes)
  server/server.mjs      zero-dep Node server: static + REST + MCP (stdio + /mcp)
  package.json           npm start, metadata (zero dependencies)
  .mcp.json              registers the server for Claude Code
  LICENSE                MIT
```

`.mcp.json` registers the server with Claude Code for *this* repo:

```json
{ "mcpServers": { "workflow-atlas": { "command": "node", "args": ["server/server.mjs"] } } }
```

(Another project can point its own `.mcp.json` here via a relative path such as
`../workflow-atlas/server/server.mjs`, so the tool stays usable from that
session too.)
