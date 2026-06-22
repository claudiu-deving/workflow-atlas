# Workflow Atlas

Two tools for thinking and communicating about software, in one tiny app:

1. **Workflows** — hand-laid visual maps of a process, styled like shop drawings.
2. **Algorithm storyboards** — step-by-step *animations* of how an algorithm
   behaves, with editable parameters and per-step comments, so an idea lands as a
   moving picture instead of a wall of prose.

A **zero-dependency local server** serves the app, autosaves your edits to disk,
and bridges them to an AI coding assistant over **MCP** — so you and the
assistant read and write the same tuned parameters and comments.

Open source under the **MIT License** (see `LICENSE`). No build step, no npm
install, no framework — plain HTML/CSS/JS and Node built-ins.

> The bundled examples are **demo content**: a generic "ship a feature"
> workflow and classic-algorithm storyboards (binary search, bubble sort,
> Euclid's GCD). Replace `data.js` and `traces/` with your own.

## Run

Zero install (Node ≥ 18). From this folder:

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

(A server is needed because `app.js` imports `data.js` as an ES module, which
the browser blocks over `file://`.) If an edit doesn't show up, it's the browser
caching the module — hard-reload (Ctrl/Cmd-Shift-R).

## Edit

Everything lives in **`data.js`** — no diagram syntax, just structured data:

- A **sheet** is `{ id, code, name, title, sub, stations: [...] }`; add one to
  the `SHEETS` array and it appears in the left index automatically.
- A **station** is `{ title, sub, status, detail }`. `detail` holds
  `{ in[], out[], note, open[] }` — shown in the callout.
- `loop: { to, label }` draws a dashed feedback arc back to an earlier station
  (e.g. *checks fail → coefficients*).
- `fan: { tracks: [...] }` renders parallel branches off the spine (e.g. the
  three deliverables).

Reload to see changes.

## Algorithm storyboards

A second view (top-left **Workflows / Algorithms** switch, or open
`algorithms.html`) animates an algorithm step by step instead of describing it
in prose. The stage shows the data (an array of value cells, or a worksheet),
the pseudocode highlights the active line, and the narration explains each step
— synced to a play / step / scrub transport (← → to step, space to play).

Each storyboard is a **trace** in `traces/*.js` exposing `meta`, `kind`
(`'array'` or `'calc'`), `code` (pseudocode lines), editable `params`, and a
`compute(params)` that returns the ordered frames. Because the frames are
*computed* from the params, changing a param re-runs the whole walk live — e.g.
change the search `target` and binary search re-evaluates. A frame may also
carry an open `question`. First one: `traces/binary-search.js`. To add one,
write a trace module and register it in the `ALGORITHMS` array in
`storyboard.js`.

### Saving tuned params + comments — the `.review.json` overlay

The algorithm trace (`*.js`) is mine to author. **Your layer** — tuned
tolerances and per-step comments — is a committed file:
`traces/<algorithm>.review.json`.

With the server running, the app **autosaves straight to that file** as you edit
(no Export, no JSON juggling). It auto-loads it as the baseline next time:
defaults ← saved overlay. (Without a server, edits stay in the browser only.)

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

`server/server.mjs` is one zero-dependency process that does three jobs: serves
the app, autosaves reviews over REST, and speaks **MCP** — over **stdio** (how
Claude Code launches it) *and* at `/mcp` over HTTP (for manual testing). Tools:

- `list_algorithms`, `get_review`, `get_algorithm_source`
- `set_param`, `set_comment`  → write the same `.review.json` files
- `list_open_questions`, `set_decision`, `reopen_question`  → resolve questions

So the loop is: you tweak a tolerance or leave a comment in the app → it lands in
the repo file → the assistant reads it over MCP, answers a comment or adjusts a
value → you see it on reload. No file shuffling either way.

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
  index.html         workflows shell (title block · sheet · callout)
  algorithms.html    storyboard shell (stage · pseudocode · narration)
  styles.css         shared design system — palette, type, spine, stage
  app.js             workflow renderer (sheets, stations, loops, callout)
  storyboard.js      algorithm player (replay, stage, transport)
  data.js            workflow content        ← edit for workflows
  traces/*.js        algorithm traces        ← edit / add for algorithms
  traces/*.review.json  tuned params + comments per algorithm (server autosaves these)
  server/server.mjs  zero-dep Node server: static + REST autosave + MCP (stdio + /mcp)
  package.json       npm start, metadata (zero dependencies)
  .mcp.json          registers the server for Claude Code
  LICENSE            MIT
```

`.mcp.json` registers the server with Claude Code for *this* repo:

```json
{ "mcpServers": { "workflow-atlas": { "command": "node", "args": ["server/server.mjs"] } } }
```

(Another project can point its own `.mcp.json` here via a relative path such as
`../workflow-atlas/server/server.mjs`, so the tool stays usable from that
session too.)
