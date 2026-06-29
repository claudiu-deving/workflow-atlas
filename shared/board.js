// Pure model helpers for the workflow CANVAS — shared by the browser (canvas/app)
// and the Node server. No DOM, no Node APIs: this module is the contract both sides
// agree on, so a node/edge that the editor produces is exactly what the server
// validates and persists. (Imported by server.mjs the same way generators.js is.)

// ---- geometry defaults (a board's LOCAL units; 1 unit renders as 1px at zoom 1) ----
export const NODE_W = 240, NODE_H = 96;   // default node box
export const COL_X = 80, ROW_DY = 200;    // legacy-spine auto-layout: column x, row pitch
export const FAN_DX = 280;                 // x pitch between migrated fan tracks
export const PAD = 40;                      // bbox padding + inset of a child board inside its parent
export const HEADER = 44;                   // title strip reserved at the top of a "frame" node (fits a 2-line title)

export const STATUSES = new Set(['done', 'partial', 'todo']);
const isSlug = (s) => /^[a-z0-9][a-z0-9-]*$/.test(s || '');

// Next stable id within a sibling list: prefix + (1 + max numeric suffix seen).
// Never renumbers — deleting n2 from [n1,n2,n3] then adding yields n4 — so an edge's
// from/to can never silently re-point at a different node after a delete.
export function nextId(list, prefix) {
  let max = 0;
  for (const item of list || []) {
    const id = item && item.id;
    if (typeof id === 'string' && id.startsWith(prefix)) {
      const rest = id.slice(prefix.length);
      if (/^\d+$/.test(rest)) max = Math.max(max, parseInt(rest, 10));
    }
  }
  return prefix + (max + 1);
}

// Bounding box of a board's nodes in local units, with an empty-board FLOOR so a
// fresh sub-chart never yields a 0 / Infinity fit-scale. Pure; callers may memoize.
export function boardBBox(board) {
  const nodes = (board && board.nodes) || [];
  if (!nodes.length) return { w: NODE_W, h: NODE_H };
  let maxX = 0, maxY = 0;
  for (const n of nodes) {
    maxX = Math.max(maxX, (n.x || 0) + (n.w || NODE_W));
    maxY = Math.max(maxY, (n.y || 0) + (n.h || NODE_H));
  }
  return { w: Math.max(maxX + PAD, 1), h: Math.max(maxY + PAD, 1) };
}

// `childOf(node)` is the board a node opens INTO. By default that's its private inline
// board; callers that resolve transclusion (node.boardRef → another sheet's board) pass
// their own resolver so a focus path can cross sheet boundaries seamlessly.
const ownBoard = (n) => n && n.board;

// The BOARD a path points INTO (the child board of the path's last node), or the
// deepest board still resolvable if the path was pruned. Used by the renderer to
// re-derive the focus board after a live reload, and to validate a focus stack.
export function boardAtPath(rootBoard, path, childOf = ownBoard) {
  let board = rootBoard;
  for (const id of (path || [])) {
    const n = board && Array.isArray(board.nodes) && board.nodes.find((x) => x && x.id === id);
    const child = n && childOf(n);
    if (!n || !child) return board;              // pruned: stop at the deepest board that still resolves
    board = child;
  }
  return board;
}

// The chain of { id, title, node } a path walks — feeds the breadcrumb navigator.
export function pathChain(rootBoard, path, childOf = ownBoard) {
  const out = []; let board = rootBoard;
  for (const id of (path || [])) {
    const n = board && Array.isArray(board.nodes) && board.nodes.find((x) => x && x.id === id);
    if (!n) break;
    out.push({ id, title: n.title, node: n });
    board = childOf(n);
    if (!board) break;
  }
  return out;
}

// Recursive structural validation — REJECTS unknown / dangling / over-deep shapes at
// every level, so the renderer never meets a missing node and the file can't rot.
// `validateDetail` is injected (the server passes its own, so detail rules stay in
// one place); pass a noop to skip detail checks on the client.
const MAX_BOARD_DEPTH = 256;   // re-rooting keeps the live tree shallow; this only caps the stored spec
export function validateBoard(b, where, seen, validateDetail) {
  // `seen` tracks the ANCESTOR chain so a board nesting one of its own ancestors (an
  // infinite-recursion cycle) is rejected — depth itself is unbounded. Back-compat: the
  // server passes a numeric 0 here, so coerce any non-Set into a fresh traversal set.
  seen = seen instanceof Set ? seen : new Set();
  // A distinct-object board chained thousands deep passes the ancestor-cycle check below
  // but would still overflow the stack on this (and every other) recursive walk — cap it.
  if (seen.size >= MAX_BOARD_DEPTH) throw new Error(`${where}: board nested too deep (max ${MAX_BOARD_DEPTH})`);
  if (!b || typeof b !== 'object' || Array.isArray(b) || !Array.isArray(b.nodes) || !Array.isArray(b.edges))
    throw new Error(`${where} must be { nodes: [], edges: [] }`);
  if (seen.has(b)) throw new Error(`${where}: board cycle detected (a board nests one of its ancestors)`);
  seen.add(b);
  const ids = new Set();
  b.nodes.forEach((n, i) => {
    const w = `${where}.nodes[${i}]`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error(`${w} must be an object`);
    if (typeof n.id !== 'string' || !n.id) throw new Error(`${w}.id is required (a string)`);
    if (ids.has(n.id)) throw new Error(`${w}.id "${n.id}" is duplicated within this board`);
    ids.add(n.id);
    for (const k of ['x', 'y', 'w', 'h']) if (n[k] != null && !Number.isFinite(n[k])) throw new Error(`${w}.${k} must be a finite number`);
    if (n.w != null && n.w <= 0) throw new Error(`${w}.w must be > 0`);
    if (n.h != null && n.h <= 0) throw new Error(`${w}.h must be > 0`);
    if (!n.title || typeof n.title !== 'string') throw new Error(`${w}.title is required (a string)`);
    if (n.status != null && !STATUSES.has(n.status)) throw new Error(`${w}.status must be one of: ${[...STATUSES].join(', ')}`);
    if (n.algorithm != null && !isSlug(n.algorithm)) throw new Error(`${w}.algorithm must be a slug`);
    // boardRef MOUNTS another sheet's board (transclusion) instead of owning one inline.
    // A node's interior is either private (board) or shared (boardRef) — never both. The
    // cross-sheet cycle these can form is caught at the server (assertRefsAcyclic), not here.
    if (n.boardRef != null) {
      if (!isSlug(n.boardRef)) throw new Error(`${w}.boardRef must be a sheet-id slug`);
      if (n.board != null) throw new Error(`${w} has both board and boardRef — a node's interior is private (board) OR shared (boardRef), not both`);
    }
    if (typeof validateDetail === 'function') validateDetail(n.detail, w);
    if (n.board != null) validateBoard(n.board, `${w}.board`, seen, validateDetail);   // recurse (cycle-guarded)
  });
  const eids = new Set();
  b.edges.forEach((e, i) => {
    const w = `${where}.edges[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${w} must be an object`);
    if (typeof e.id !== 'string' || !e.id) throw new Error(`${w}.id is required (a string)`);
    if (eids.has(e.id)) throw new Error(`${w}.id "${e.id}" is duplicated`);
    eids.add(e.id);
    // The keystone invariant: an edge connects two nodes in THE SAME board. Cross-level
    // links are expressed by containment (node.board), never by an edge.
    if (!ids.has(e.from) || !ids.has(e.to))
      throw new Error(`${w}: endpoint must be a node id in THIS board (from="${e.from}", to="${e.to}")`);
    if (e.from === e.to) throw new Error(`${w}: self-edge not allowed (from === to === "${e.from}")`);
    if (e.kind != null && !['flow', 'loop', 'dep'].includes(e.kind)) throw new Error(`${w}.kind must be flow, loop, or dep`);
    if (e.fromSide != null && !['top', 'right', 'bottom', 'left'].includes(e.fromSide)) throw new Error(`${w}.fromSide must be top, right, bottom, or left`);
  });
  seen.delete(b);   // leave the chain so a board may legitimately recur in a SIBLING subtree; only ANCESTOR cycles throw
}

/* ---------------- granular editing: addressing + merge + apply (pure) ----------------
   These power the granular write tools (edit_board / set_node) and are pure — no IO — so
   the server unit-tests them directly and wraps them with read/migrate/validate/persist. */

// Split a "sheetId/nodeId/nodeId…" address (the URL-hash form; a leading '#' is fine) into the
// sheet id and the node-id segments beneath it. Each segment names a CONTAINER node you descend
// into. Throws on an empty path or a non-slug sheet id.
export function parsePath(raw) {
  const parts = String(raw || '').replace(/^#/, '').split('/').filter(Boolean);
  if (!parts.length) throw new Error('empty path — expected "sheetId/nodeId/…"');
  const [sheetId, ...segs] = parts;
  if (!isSlug(sheetId)) throw new Error(`invalid sheet id in path: "${sheetId}"`);
  return { sheetId, segs };
}

// Descend node-id segments from a root board to the board they point INTO ([] → the root board
// itself). Every segment MUST resolve to an existing node — a typo throws (mirroring get_node's
// contract), so a write tool never silently materializes a chain of empty boards from a bad path.
// `createLast`: when ONLY the final segment's node exists but has no child board yet, create an
// empty one so you can author into it. A boardRef (transclusion) mount is never descended into,
// nor given a private board — its interior belongs to the source sheet.
export function boardForSegs(rootBoard, segs, { createLast = false } = {}) {
  let board = rootBoard;
  const path = segs || [];
  path.forEach((id, i) => {
    const last = i === path.length - 1;
    const n = board && Array.isArray(board.nodes) && board.nodes.find((x) => x && x.id === id);
    if (!n) throw new Error(`no node "${id}" here — check the path ids (read it with get_sheet/get_node)`);
    if (n.boardRef) throw new Error(`node "${id}" mounts shared component "${n.boardRef}" — edit that source sheet, not the mount`);
    if (!n.board) {
      if (last && createLast) n.board = { nodes: [], edges: [], view: { x: 0, y: 0, zoom: 1 } };
      else throw new Error(`node "${id}" has no child board to descend into — author the container first`);
    }
    board = n.board;
  });
  return board;
}

// Merge a PATCH into a node IN PLACE. The contract the tools document:
//   • a top-level key REPLACES that field (title, status, x, y, sub, algorithm, board, …);
//   • `detail` MERGES per key — set {detail:{note}} and detail.in/out/open are left untouched;
//   • a null value CLEARS that field, top-level (sub:null) or inside detail (detail:{open:null});
//   • an array value (detail.open, …) REPLACES the whole array — there is no append.
//   • `id` is fixed by addressing and is never merged.
export function mergeNode(node, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'id') continue;
    if (k === 'detail') {
      if (v == null) { delete node.detail; continue; }
      if (typeof v !== 'object' || Array.isArray(v)) throw new Error('detail must be an object { in?, out?, note?, open? }');
      const next = { ...(node.detail && typeof node.detail === 'object' ? node.detail : {}) };
      for (const [dk, dv] of Object.entries(v)) { if (dv == null) delete next[dk]; else next[dk] = dv; }
      node.detail = next;
    } else if (v == null) {
      delete node[k];
    } else {
      node[k] = v;
    }
  }
  return node;
}

// Apply a board edit (upsert/patch nodes & edges by id; delete by id) to a board IN PLACE and
// return a summary. Order: deleteEdges, then deleteNodes (cascading their still-incident edges),
// then node upserts, then edge upserts (so a new edge can reference a just-created node). A NEW
// node gets default geometry and is auto-placed stacked BELOW the current bbox, so a batch of
// creates never overlaps; pass x/y to override. Pure — the caller validates the whole sheet
// (validateBoard) before persisting, which is what rejects a dangling edge / dup id / bad shape.
export function applyBoardEdit(board, edit = {}) {
  if (!board || !Array.isArray(board.nodes) || !Array.isArray(board.edges)) throw new Error('target board is malformed');
  const sum = { created: [], updated: [], deletedNodes: [], deletedEdges: [] };
  for (const id of edit.deleteEdges || []) {
    const i = board.edges.findIndex((e) => e && e.id === id);
    if (i < 0) throw new Error(`deleteEdges: no edge "${id}" in this board`);
    board.edges.splice(i, 1);
    sum.deletedEdges.push(id);
  }
  for (const id of edit.deleteNodes || []) {
    const i = board.nodes.findIndex((n) => n && n.id === id);
    if (i < 0) throw new Error(`deleteNodes: no node "${id}" in this board`);
    board.nodes.splice(i, 1);
    const kept = board.edges.filter((e) => e.from !== id && e.to !== id);   // cascade incident edges
    if (kept.length !== board.edges.length) sum.deletedEdges.push(`*incident-to-${id}`);
    board.edges = kept;
    sum.deletedNodes.push(id);
  }
  let placeY = boardBBox(board).h;   // stack new nodes below everything already present
  for (const patch of edit.nodes || []) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('each nodes[] item must be an object');
    const existing = patch.id != null ? board.nodes.find((n) => n && n.id === patch.id) : null;
    if (existing) { mergeNode(existing, patch); sum.updated.push(existing.id); continue; }
    const id = patch.id != null ? String(patch.id) : nextId(board.nodes, 'n');
    const node = { id, x: COL_X, y: placeY, w: NODE_W, h: NODE_H, status: 'todo' };
    placeY += ROW_DY;
    mergeNode(node, patch);                       // title/status/x/y/… (x/y override the auto-place)
    if (!node.title) throw new Error(`new node "${id}" requires a title`);
    board.nodes.push(node);
    sum.created.push(id);
  }
  for (const e of edit.edges || []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('each edges[] item must be an object');
    if (e.from == null || e.to == null) throw new Error('an edge needs "from" and "to" (node ids in this board)');
    const id = e.id != null ? String(e.id) : nextId(board.edges, 'e');
    const existing = e.id != null ? board.edges.find((x) => x && x.id === id) : null;
    const edge = { id, from: String(e.from), to: String(e.to), kind: e.kind || 'flow' };
    if (e.label != null) edge.label = e.label;
    if (e.fromSide != null) edge.fromSide = e.fromSide;
    if (existing) { Object.assign(existing, edge); sum.updated.push('edge:' + id); }
    else { board.edges.push(edge); sum.created.push('edge:' + id); }
  }
  return sum;
}

/* ---------------- node index / search (pure) — powers find_nodes ---------------- */
// Flatten a board into [{ path, node }] for EVERY node at every depth, each with its addressable
// "sheetId/nodeId/…" path. Descends INLINE child boards (node.board); a boardRef mount is a LEAF
// here (its target sheet is indexed under its own id), which also means no cross-sheet boardRef
// cycle can ever loop this walk.
export function indexNodes(rootBoard, basePath) {
  const out = [];
  const walk = (board, prefix) => {
    for (const n of (board && board.nodes) || []) {
      if (!n || !n.id) continue;
      const path = `${prefix}/${n.id}`;
      out.push({ path, node: n });
      if (n.board) walk(n.board, path);
    }
  };
  if (rootBoard) walk(rootBoard, basePath);
  return out;
}

// Case-insensitive substring search over a node's human-readable fields (`q` must be pre-lowercased).
// Returns the first { field, value } that contains q, or null. Searches id, title, sub, algorithm,
// and detail.note / detail.in / detail.out / detail.open — so "find the card that mentions X" works.
export function matchNode(node, q) {
  if (!q) return { field: 'all', value: '' };
  const hit = (field, value) => (typeof value === 'string' && value.toLowerCase().includes(q)) ? { field, value } : null;
  let m = hit('id', node.id) || hit('title', node.title) || hit('sub', node.sub) || hit('algorithm', node.algorithm);
  if (m) return m;
  const d = node.detail || {};
  if ((m = hit('note', d.note))) return m;
  for (const k of ['in', 'out', 'open']) for (const v of (d[k] || [])) if ((m = hit(k, v))) return m;
  return null;
}
