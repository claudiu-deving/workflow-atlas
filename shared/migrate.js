// Lossless conversion of a LEGACY sheet (vertical spine of stations[] + fan + loop)
// into the v2 canvas model (a board of nodes[] + edges[], with fans becoming nested
// child boards). Pure — no DOM, no Node APIs — so the browser runs it in memory on
// load (viewing never rewrites the file) and the server runs it for a consistent
// read, then commits the v2 form on the first write. Deterministic ids, so re-running
// yields byte-identical boards and decisions (text-keyed) are untouched.

import { NODE_W, NODE_H, COL_X, ROW_DY, FAN_DX } from './board.js';

export function migrateSheet(sheet) {
  if (!sheet || typeof sheet !== 'object') return sheet;
  if (sheet.schema === 2 && sheet.board) return sheet;                 // already v2
  if (!Array.isArray(sheet.stations)) {                                // nothing to convert
    sheet.schema = 2;
    sheet.board = sheet.board || { nodes: [], edges: [], view: { x: 0, y: 0, zoom: 1 } };
    return sheet;
  }
  const stations = sheet.stations;
  const nodes = [], edges = [];

  stations.forEach((st, i) => {
    const id = 'n' + (i + 1);
    const node = {
      id, x: COL_X, y: 40 + i * ROW_DY, w: NODE_W, h: NODE_H,
      title: st.title || `Step ${i + 1}`, status: st.status || 'todo',
    };
    if (st.sub) node.sub = st.sub;
    if (st.detail) node.detail = st.detail;
    if (st.algorithm) node.algorithm = st.algorithm;
    // FAN → a NESTED child board (rather than sibling nodes): keeps the spine clean,
    // preserves "this step expands into N parallel things", and exercises real nesting.
    if (st.fan && Array.isArray(st.fan.tracks) && st.fan.tracks.length) node.board = fanToBoard(st.fan);
    nodes.push(node);
    if (i > 0) edges.push({ id: 'e' + i, from: 'n' + i, to: id, kind: 'flow' });   // spine connector
  });

  // LOOP → a 'loop'-kind feedback edge. Resolve loop.to EXACTLY like the old drawLoops:
  // a numeric station index, OR a target station's title (which survives reordering).
  stations.forEach((st, i) => {
    if (!st.loop) return;
    const t = typeof st.loop.to === 'string'
      ? stations.findIndex((x) => x && x.title === st.loop.to)
      : st.loop.to;
    if (t != null && t >= 0 && t < stations.length)
      edges.push({ id: 'lp' + (i + 1), from: 'n' + (i + 1), to: 'n' + (t + 1), kind: 'loop', label: st.loop.label || 'loop' });
  });

  sheet.schema = 2;
  sheet.board = { nodes, edges, view: { x: 0, y: 0, zoom: 1 } };
  // Keep sheet.stations in memory (harmless): the browser only reads sheet.board, and
  // the SERVER drops stations on the first write. Not deleting here means a re-render
  // can never lose the source data.
  return sheet;
}

function fanToBoard(fan) {
  // Give the fan a real entry node so branch provenance is preserved (entry → each
  // track), instead of a bag of disconnected nodes. Tracks lay out horizontally so
  // the child board fits a wide parent node under contain-fit.
  const nodes = [{ id: 'n1', x: COL_X, y: 40, w: NODE_W, h: NODE_H, title: 'branches', status: 'todo' }];
  const edges = [];
  fan.tracks.forEach((t, j) => {
    const id = 'n' + (j + 2);
    const node = { id, x: COL_X + (j + 1) * FAN_DX, y: 40, w: NODE_W, h: NODE_H, title: t.title || `Branch ${j + 1}`, status: t.status || 'todo' };
    if (t.detail) node.detail = t.detail;
    if (t.algorithm) node.algorithm = t.algorithm;
    nodes.push(node);
    edges.push({ id: 'e' + (j + 1), from: 'n1', to: id, kind: 'flow' });
  });
  return { nodes, edges, view: { x: 0, y: 0, zoom: 1 } };
}
