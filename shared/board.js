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
export const MAX_DEPTH = 6;                 // legacy hint only — nesting is now UNBOUNDED (the renderer
                                            // re-roots, and the validator guards cycles, not depth)

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

// Resolve a node by a path of node ids that walks nested boards. Returns the node,
// the board that directly contains it, and the path's owning chain — or null.
export function findNodeByPath(rootBoard, path) {
  let board = rootBoard, node = null;
  const p = path || [];
  for (let i = 0; i < p.length; i++) {
    if (!board || !Array.isArray(board.nodes)) return null;
    node = board.nodes.find((n) => n && n.id === p[i]);
    if (!node) return null;
    if (i !== p.length - 1) board = node.board;   // descend for the next segment (gate on POSITION,
  }                                                // not id value — ids are only board-local-unique)
  return node ? { node, board } : null;
}

// The BOARD a path points INTO (the child board of the path's last node), or the
// deepest board still resolvable if the path was pruned. Used by the renderer to
// re-derive the focus board after a live reload, and to validate a focus stack.
export function boardAtPath(rootBoard, path) {
  let board = rootBoard;
  for (const id of (path || [])) {
    const n = board && Array.isArray(board.nodes) && board.nodes.find((x) => x && x.id === id);
    if (!n || !n.board) return board;            // pruned: stop at the deepest board that still resolves
    board = n.board;
  }
  return board;
}

// The chain of { id, title, node } a path walks — feeds the breadcrumb navigator.
export function pathChain(rootBoard, path) {
  const out = []; let board = rootBoard;
  for (const id of (path || [])) {
    const n = board && Array.isArray(board.nodes) && board.nodes.find((x) => x && x.id === id);
    if (!n) break;
    out.push({ id, title: n.title, node: n });
    board = n.board;
    if (!board) break;
  }
  return out;
}

export function incidentEdges(board, nodeId) {
  return ((board && board.edges) || []).filter((e) => e && (e.from === nodeId || e.to === nodeId));
}

// Recursive structural validation — REJECTS unknown / dangling / over-deep shapes at
// every level, so the renderer never meets a missing node and the file can't rot.
// `validateDetail` is injected (the server passes its own, so detail rules stay in
// one place); pass a noop to skip detail checks on the client.
export function validateBoard(b, where, seen, validateDetail) {
  // `seen` tracks the ANCESTOR chain so a board nesting one of its own ancestors (an
  // infinite-recursion cycle) is rejected — depth itself is unbounded. Back-compat: the
  // server passes a numeric 0 here, so coerce any non-Set into a fresh traversal set.
  seen = seen instanceof Set ? seen : new Set();
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
  });
  seen.delete(b);   // leave the chain so a board may legitimately recur in a SIBLING subtree; only ANCESTOR cycles throw
}
