// The infinite-canvas engine with continuous semantic zoom + in-browser editing.
//
// ONE root camera transform on `.world`; every board is a transformed `.board`
// element whose nodes are plain left/top boxes and whose edges live in an `<svg>` in
// the SAME transform — so an edge endpoint can never drift from its node, at any
// nesting depth (the browser's compositor composes the scale chain for us).
//
// Semantic zoom = level-of-detail mounting: a node's child board is rendered in place
// once the node's apparent on-screen size crosses MOUNT_PX, and unmounted (with
// hysteresis) when it shrinks past UNMOUNT_PX — so only what is both visible AND large
// enough is in the DOM. `effScale` (screen px per local unit) is threaded DOWN the
// recursion; it drives the mount decision AND the drag math, with no matrix walking.

import { esc } from './shared/esc.js';
import { boardBBox, nextId, NODE_W, NODE_H, PAD, HEADER, MAX_DEPTH } from './shared/board.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const STATUS_LABEL = { done: 'done', partial: 'partial', todo: 'to build' };

// camera limits + LOD thresholds (apparent px)
const ZOOM_MIN = 0.04, ZOOM_MAX = 40;
const MOUNT_PX = 460, UNMOUNT_PX = 340;   // hysteresis gap kills threshold flicker
const DOT_PX = 86;                         // below this a node is just a status dot + clipped title
const MIN_VISIBLE_PX = 2.5;                // smaller than this on screen → don't paint at all
const CULL_MARGIN = 240;                   // keep nodes mounted this many px beyond the viewport

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r3 = (n) => Math.round(n * 1000) / 1000;
const r5 = (n) => Math.round(n * 100000) / 100000;

export function createCanvas(viewportEl, opts = {}) {
  const onChange = opts.onChange || (() => {});
  const onSelect = opts.onSelect || (() => {});
  const openCount = opts.openCount || (() => 0);
  ensureArrowDefs();

  const world = viewportEl.querySelector('.world');
  const rootBoardEl = buildBoardEl();
  world.appendChild(rootBoardEl);

  const cam = { x: 0, y: 0, zoom: 1 };
  let active = null;            // the sheet being shown
  let editing = false;
  let selection = null;         // { kind:'node'|'edge', node|edge, board }
  let viewW = 0, viewH = 0;

  /* ---------- bbox cache (kept off the model so JSON stays clean) ---------- */
  const bboxCache = new WeakMap();
  const bboxOf = (board) => { let b = bboxCache.get(board); if (!b) { b = boardBBox(board); bboxCache.set(board, b); } return b; };
  const invalidateBBox = (board) => bboxCache.delete(board);

  /* ---------- render loop (coalesced into one rAF) ---------- */
  let rafPending = false;
  function requestRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(frame); }

  // Promote `.world` to a GPU layer ONLY while a gesture is in flight, then drop the
  // promotion ~180ms after it settles. A permanently `will-change`d layer is rasterized
  // once and bitmap-scaled during zoom → text/edges look pixelated until a repaint (a
  // click) forces a re-raster. Dropping will-change at rest makes Chrome re-rasterize
  // crisply at the final zoom, with no click needed, while keeping pan/zoom smooth.
  let wcTimer = null;
  function promoteWorld() {
    if (world.style.willChange !== 'transform') world.style.willChange = 'transform';
    clearTimeout(wcTimer);
    wcTimer = setTimeout(() => { world.style.willChange = 'auto'; requestRender(); }, 180);
  }
  function frame() {
    rafPending = false;
    if (!active) return;
    viewW = viewportEl.clientWidth; viewH = viewportEl.clientHeight;
    world.style.transform = `translate(${r3(cam.x)}px, ${r3(cam.y)}px) scale(${r5(cam.zoom)})`;
    renderBoard(active.board, rootBoardEl, cam.x, cam.y, cam.zoom, 0, []);
  }

  // ox/oy = screen (canvas-relative) position of this board's local (0,0); eff = px/unit.
  function renderBoard(board, boardEl, ox, oy, eff, depth, path) {
    const bbox = bboxOf(board);
    boardEl._board = board; boardEl._eff = eff; boardEl._ox = ox; boardEl._oy = oy; boardEl._bw = bbox.w; boardEl._bh = bbox.h;
    if (boardEl._lastBW !== bbox.w || boardEl._lastBH !== bbox.h) {
      boardEl.style.width = bbox.w + 'px'; boardEl.style.height = bbox.h + 'px';
      boardEl._lastBW = bbox.w; boardEl._lastBH = bbox.h;
    }
    drawEdges(board, boardEl);

    const map = boardEl._nodes;
    const present = new Set();
    for (const node of board.nodes) {
      present.add(node.id);
      let el = map.get(node.id);
      if (!el) { el = buildNodeEl(); map.set(node.id, el); boardEl.appendChild(el); }
      el._node = node;
      const w = node.w || NODE_W, h = node.h || NODE_H;
      const sx = ox + node.x * eff, sy = oy + node.y * eff, sw = w * eff, sh = h * eff;
      const onScreen = sx + sw > -CULL_MARGIN && sx < viewW + CULL_MARGIN && sy + sh > -CULL_MARGIN && sy < viewH + CULL_MARGIN;
      const selected = selection && selection.node === node;
      if ((!onScreen || sw < MIN_VISIBLE_PX) && !selected) { if (el._shown !== false) { el.style.display = 'none'; el._shown = false; } unmountChild(el); continue; }
      if (el._shown === false) { el.style.display = ''; el._shown = true; }
      positionNode(el, node, w, h);
      paintNode(el, node);
      setTier(el, sw);
      if (el._sel !== !!selected) { el.classList.toggle('is-selected', !!selected); el._sel = !!selected; }

      const apparent = sw;   // node.w * eff
      const mounted = !!el._childEl;
      const want = node.board && depth < MAX_DEPTH && onScreen && (mounted ? apparent >= UNMOUNT_PX : apparent >= MOUNT_PX);
      if (want && !mounted) mountChild(el);
      else if (!want && mounted) unmountChild(el);
      if (el._childEl) {
        const cb = bboxOf(node.board);
        const innerScale = Math.max(0.0001, Math.min((w - 2 * PAD) / cb.w, (h - HEADER - PAD) / cb.h));
        if (el._innerScale !== innerScale) { el._childEl.style.transform = `translate(${PAD}px, ${HEADER}px) scale(${r5(innerScale)})`; el._innerScale = innerScale; }
        renderBoard(node.board, el._childEl, sx + PAD * eff, sy + HEADER * eff, eff * innerScale, depth + 1, path.concat(node.id));
      }
    }
    for (const [id, el] of map) if (!present.has(id)) { el.remove(); map.delete(id); }
  }

  function positionNode(el, node, w, h) {
    if (el._lx === node.x && el._ly === node.y && el._lw === w && el._lh === h) return;
    el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
    el._lx = node.x; el._ly = node.y; el._lw = w; el._lh = h;
  }

  function paintNode(el, node) {
    const open = openCount(node);
    const status = node.status || 'todo';
    const sig = [node.title, node.sub || '', status, node.algorithm || '', node.board ? 1 : 0, open].join('');
    if (el._sig === sig) return;
    el._sig = sig;
    if (el._status !== status) { el.dataset.status = status; el._status = status; }
    el.querySelector('.node-chrome').innerHTML =
      `<div class="node-top"><span class="node-dot"></span>` +
      `<h3 class="node-title">${esc(node.title)}</h3>` +
      `<span class="node-chip">${STATUS_LABEL[status] || esc(status)}</span></div>` +
      (node.sub ? `<p class="node-sub">${esc(node.sub)}</p>` : '') +
      `<div class="node-foot">` +
      (node.algorithm ? `<span class="node-tag algo">▶ storyboard</span>` : '') +
      (node.board ? `<span class="node-tag nest">▦ chart inside</span>` : '') +
      (open ? `<span class="node-tag q">${open} open</span>` : '') +
      `</div>`;
  }

  function setTier(el, apparentW) {
    const tier = apparentW < DOT_PX ? 'dot' : apparentW < MOUNT_PX ? 'card' : 'frame';
    if (el._tier !== tier) { el.dataset.lod = tier; el._tier = tier; }
  }

  function mountChild(el) {
    const host = buildBoardEl();
    host.style.opacity = '0';
    el.querySelector('.node-inner').appendChild(host);
    el._childEl = host; el._innerScale = null;
    requestAnimationFrame(() => { host.style.opacity = '1'; });
  }
  function unmountChild(el) { if (el._childEl) { el._childEl.remove(); el._childEl = null; el._innerScale = null; } }

  /* ---------- edges (one svg per board, local coords, memoized) ---------- */
  function edgeSig(board) {
    const sel = selection && selection.kind === 'edge' ? selection.edge.id : '';
    let s = sel + '|';
    for (const n of board.nodes) s += n.id + ':' + n.x + ',' + n.y + ',' + (n.w || NODE_W) + ',' + (n.h || NODE_H) + ';';
    s += '|';
    for (const e of board.edges) s += e.id + e.from + '>' + e.to + (e.kind || 'flow') + (e.label || '') + ';';
    return s;
  }
  function drawEdges(board, boardEl) {
    const sig = edgeSig(board);
    if (boardEl._edgeSig === sig) return;
    boardEl._edgeSig = sig;
    const svg = boardEl._svg;
    const bbox = bboxOf(board);
    svg.setAttribute('viewBox', `0 0 ${bbox.w} ${bbox.h}`);
    svg.setAttribute('width', bbox.w); svg.setAttribute('height', bbox.h);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    for (const e of board.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const g = edgeGeom(e.kind || 'flow', a, b);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', g.d);
      path.setAttribute('class', 'edge ' + (e.kind || 'flow') + (selection && selection.kind === 'edge' && selection.edge.id === e.id ? ' is-selected' : ''));
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('marker-end', 'url(#atlas-arrow)');
      path.dataset.eid = e.id;
      svg.appendChild(path);
      if (e.label) {
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('x', g.mx); t.setAttribute('y', g.my - 4); t.setAttribute('class', 'edge-label'); t.setAttribute('text-anchor', 'middle');
        t.textContent = e.label;
        svg.appendChild(t);
      }
    }
  }
  function edgeGeom(kind, a, b) {
    const aw = a.w || NODE_W, ah = a.h || NODE_H, bw = b.w || NODE_W, bh = b.h || NODE_H;
    const acx = a.x + aw / 2, acy = a.y + ah / 2, bcx = b.x + bw / 2, bcy = b.y + bh / 2;
    if (kind === 'loop') {
      // feedback: exit the source's right edge, bow out to the right, re-enter the target's right
      const sx = a.x + aw, sy = acy, ex = b.x + bw, ey = bcy;
      const gx = Math.max(a.x + aw, b.x + bw) + 70;
      return { d: `M ${sx} ${sy} C ${gx} ${sy}, ${gx} ${ey}, ${ex} ${ey}`, mx: gx, my: (sy + ey) / 2 };
    }
    const dx = bcx - acx, dy = bcy - acy;
    let sx, sy, ex, ey, c1x, c1y, c2x, c2y;
    if (Math.abs(dy) >= Math.abs(dx)) {           // vertical-dominant
      const down = dy >= 0;
      sx = acx; sy = down ? a.y + ah : a.y; ex = bcx; ey = down ? b.y : b.y + bh;
      const k = Math.max(40, Math.abs(ey - sy) * 0.4);
      c1x = sx; c1y = sy + (down ? k : -k); c2x = ex; c2y = ey - (down ? k : -k);
    } else {                                       // horizontal-dominant
      const right = dx >= 0;
      sx = right ? a.x + aw : a.x; sy = acy; ex = right ? b.x : b.x + bw; ey = bcy;
      const k = Math.max(40, Math.abs(ex - sx) * 0.4);
      c1x = sx + (right ? k : -k); c1y = sy; c2x = ex - (right ? k : -k); c2y = ey;
    }
    return { d: `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`, mx: (sx + ex) / 2, my: (sy + ey) / 2 };
  }

  /* ---------- element factories ---------- */
  function buildBoardEl() {
    const b = document.createElement('div');
    b.className = 'board';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'edges');
    b.appendChild(svg);
    b._svg = svg; b._nodes = new Map(); b._edgeSig = null;
    return b;
  }
  function buildNodeEl() {
    const el = document.createElement('div');
    el.className = 'node'; el.dataset.lod = 'card';
    const chrome = document.createElement('div'); chrome.className = 'node-chrome';
    const inner = document.createElement('div'); inner.className = 'node-inner';
    const ports = document.createElement('div'); ports.className = 'node-ports';
    ports.innerHTML = '<span class="port port-out" data-port="out" title="drag to connect"></span>';
    el.append(chrome, inner, ports);
    el._shown = true;
    return el;
  }

  /* ---------- helpers for screen↔local + finding board elements ---------- */
  const canvasRect = () => viewportEl.getBoundingClientRect();
  function boardElOf(board) { let f = null; viewportEl.querySelectorAll('.board').forEach((b) => { if (b._board === board) f = b; }); return f; }
  function nodeElFor(node) { let f = null; viewportEl.querySelectorAll('.node').forEach((el) => { if (el._node === node) f = el; }); return f; }
  // deepest mounted board whose on-screen rect contains the cursor (smallest eff wins)
  function activeBoardElAt(clientX, clientY) {
    const r = canvasRect(); const x = clientX - r.left, y = clientY - r.top;
    let best = rootBoardEl, bestEff = Infinity;
    viewportEl.querySelectorAll('.board').forEach((b) => {
      if (b._eff == null) return;
      if (x >= b._ox && x <= b._ox + b._bw * b._eff && y >= b._oy && y <= b._oy + b._bh * b._eff && b._eff < bestEff) { bestEff = b._eff; best = b; }
    });
    return best;
  }
  function localPoint(boardEl, clientX, clientY) {
    const r = canvasRect();
    return { lx: (clientX - r.left - boardEl._ox) / boardEl._eff, ly: (clientY - r.top - boardEl._oy) / boardEl._eff };
  }

  /* ---------- selection ---------- */
  function selectNodeKnown(node, board) { selection = { kind: 'node', node, board }; onSelect(selection); requestRender(); }
  function selectNode(node, nodeEl) {
    const board = (nodeEl ? nodeEl.parentElement._board : (nodeElFor(node) || {}).parentElement && nodeElFor(node).parentElement._board) || activeBoardElForNode(node);
    selectNodeKnown(node, board);
  }
  function activeBoardElForNode(node) { const el = nodeElFor(node); return el ? el.parentElement._board : active.board; }
  function selectEdge(pathEl) {
    const boardEl = pathEl.closest('.board'); const board = boardEl && boardEl._board;
    const edge = board && board.edges.find((e) => e.id === pathEl.dataset.eid);
    if (!edge) return;
    selection = { kind: 'edge', edge, board };
    boardEl._edgeSig = null;            // force a redraw so the highlight shows
    onSelect(selection); requestRender();
  }
  function clearSelection() { if (!selection) return; const b = selection.board; selection = null; if (b) { const be = boardElOf(b); if (be) be._edgeSig = null; } onSelect(null); requestRender(); }

  /* ---------- pointer: pan / drag / connect / click ---------- */
  let mode = null, pending = null, moved = 0, lastX = 0, lastY = 0, connect = null;
  viewportEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const portEl = editing && e.target.closest && e.target.closest('.port-out');
    const nodeEl = e.target.closest && e.target.closest('.node');
    const edgeEl = e.target.classList && e.target.classList.contains('edge') ? e.target : null;
    lastX = e.clientX; lastY = e.clientY; moved = 0; mode = null; pending = null; connect = null;
    try { viewportEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (portEl && nodeEl) { startConnect(nodeEl); mode = 'connect'; e.preventDefault(); return; }
    if (edgeEl) { selectEdge(edgeEl); return; }   // a click on an edge selects it (no drag)
    pending = nodeEl ? { node: nodeEl._node, nodeEl, boardEl: nodeEl.parentElement } : null;
  });
  viewportEl.addEventListener('pointermove', (e) => {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (mode === null) {
      if (e.buttons === 0) return;                 // not dragging
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved <= 4) { lastX = e.clientX; lastY = e.clientY; return; }
      mode = (editing && pending) ? 'drag' : 'pan';
      if (mode === 'pan') viewportEl.classList.add('grabbing');
    }
    if (mode === 'pan') { cam.x += dx; cam.y += dy; promoteWorld(); requestRender(); }
    else if (mode === 'drag') {
      const eff = pending.boardEl._eff || cam.zoom;
      pending.node.x += dx / eff; pending.node.y += dy / eff;
      invalidateBBox(pending.boardEl._board);
      requestRender(); onChange(active.id);
    } else if (mode === 'connect') updateConnect(e);
    lastX = e.clientX; lastY = e.clientY;
  });
  viewportEl.addEventListener('pointerup', (e) => {
    viewportEl.classList.remove('grabbing');
    try { viewportEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (mode === 'connect') finishConnect(e);
    else if (mode === 'drag' && pending) {           // snap to integer local coords on drop (clean JSON)
      pending.node.x = Math.round(pending.node.x); pending.node.y = Math.round(pending.node.y);
      invalidateBBox(pending.boardEl._board); onChange(active.id); requestRender();
    } else if (mode === null) {                      // a click, not a drag
      if (pending && pending.node) selectNode(pending.node, pending.nodeEl);
      else clearSelection();
    }
    mode = null; pending = null; connect = null;
  });
  // a system-cancelled gesture (touch takeover, etc.) never reaches pointerup — tear
  // down cleanly so a half-drawn connection edge and a stuck 'connect' mode don't linger.
  // (Not lostpointercapture: pointerup itself releases capture, which would fire it mid-handler.)
  viewportEl.addEventListener('pointercancel', () => {
    if (connect && connect.pathEl) connect.pathEl.remove();
    viewportEl.classList.remove('grabbing');
    mode = null; pending = null; connect = null;
  });
  viewportEl.addEventListener('dblclick', (e) => {
    const nodeEl = e.target.closest && e.target.closest('.node');
    if (nodeEl) { zoomToNode(nodeEl._node, nodeEl); return; }
    if (editing) createNodeAt(e.clientX, e.clientY);
  });
  viewportEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvasRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const z = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    const k = z / cam.zoom;
    cam.x = k * cam.x + (1 - k) * sx; cam.y = k * cam.y + (1 - k) * sy; cam.zoom = z;
    promoteWorld(); requestRender();
  }, { passive: false });

  function startConnect(nodeEl) { connect = { fromNode: nodeEl._node, boardEl: nodeEl.parentElement, pathEl: null }; }
  function updateConnect(e) {
    const b = connect.boardEl, a = connect.fromNode;
    const sx = a.x + (a.w || NODE_W) / 2, sy = a.y + (a.h || NODE_H);
    const { lx, ly } = localPoint(b, e.clientX, e.clientY);
    if (!connect.pathEl) { connect.pathEl = document.createElementNS(SVGNS, 'path'); connect.pathEl.setAttribute('class', 'edge rubber'); connect.pathEl.setAttribute('vector-effect', 'non-scaling-stroke'); b._svg.appendChild(connect.pathEl); }
    connect.pathEl.setAttribute('d', `M ${sx} ${sy} L ${lx} ${ly}`);
  }
  function finishConnect(e) {
    if (connect.pathEl) connect.pathEl.remove();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetEl = el && el.closest && el.closest('.node');
    if (targetEl && targetEl.parentElement === connect.boardEl && targetEl._node !== connect.fromNode) {
      const board = connect.boardEl._board;
      board.edges.push({ id: nextId(board.edges, 'e'), from: connect.fromNode.id, to: targetEl._node.id, kind: 'flow' });
      connect.boardEl._edgeSig = null; onChange(active.id); requestRender();
    } else if (targetEl && targetEl.parentElement !== connect.boardEl) {
      toast('edges stay within one board — nest a node to link levels');
    }
  }

  function createNodeAt(clientX, clientY) {
    const boardEl = activeBoardElAt(clientX, clientY);
    const { lx, ly } = localPoint(boardEl, clientX, clientY);
    const board = boardEl._board;
    const node = { id: nextId(board.nodes, 'n'), x: Math.round(lx - NODE_W / 2), y: Math.round(ly - NODE_H / 2), w: NODE_W, h: NODE_H, title: 'New node', status: 'todo' };
    board.nodes.push(node); invalidateBBox(board); onChange(active.id);
    selectNodeKnown(node, board);
  }

  /* ---------- camera moves ---------- */
  function zoomToNode(node, nodeEl) {
    nodeEl = nodeEl || nodeElFor(node); if (!nodeEl) return;
    const b = nodeEl.parentElement, eff = b._eff;
    const w = node.w || NODE_W, h = node.h || NODE_H;
    const scx = b._ox + (node.x + w / 2) * eff, scy = b._oy + (node.y + h / 2) * eff;
    const zoomNew = clamp(cam.zoom * ((MOUNT_PX * 1.5) / w) / eff, ZOOM_MIN, ZOOM_MAX);
    const k = zoomNew / cam.zoom;
    const nx = k * cam.x + (1 - k) * scx + (viewW / 2 - scx);
    const ny = k * cam.y + (1 - k) * scy + (viewH / 2 - scy);
    tweenCamera(nx, ny, zoomNew);
  }
  let tween = null;
  function tweenCamera(x, y, z) {
    const sx = cam.x, sy = cam.y, sz = cam.zoom, t0 = performance.now(), dur = 320;
    if (tween) cancelAnimationFrame(tween);
    const stepFn = () => {
      const t = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      cam.x = sx + (x - sx) * e; cam.y = sy + (y - sy) * e; cam.zoom = sz + (z - sz) * e;
      frame();
      if (t < 1) tween = requestAnimationFrame(stepFn); else tween = null;
    };
    tween = requestAnimationFrame(stepFn);
  }
  function fit() {
    if (!active) return;
    const bb = bboxOf(active.board);
    const vw = viewportEl.clientWidth || 800, vh = viewportEl.clientHeight || 600, pad = 70;
    const z = clamp(Math.min((vw - pad * 2) / bb.w, (vh - pad * 2) / bb.h), ZOOM_MIN, 1.4);
    cam.zoom = z; cam.x = (vw - bb.w * z) / 2; cam.y = (vh - bb.h * z) / 2;
    requestRender();
  }

  /* ---------- toast ---------- */
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'canvas-toast'; viewportEl.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  /* ---------- public API (driven by app.js) ---------- */
  function load(sheet) {
    active = sheet; selection = null; onSelect(null);
    for (const [, el] of rootBoardEl._nodes) el.remove();
    rootBoardEl._nodes.clear(); rootBoardEl._edgeSig = null;
    frame(); fit();
  }
  function setEditing(b) { editing = b; viewportEl.classList.toggle('editing', b); requestRender(); }
  function refresh() {                                   // after an inspector edit mutated the selected node
    if (selection && selection.board) { invalidateBBox(selection.board); const be = boardElOf(selection.board); if (be) be._edgeSig = null; }
    requestRender();
  }
  function deleteSelected() {
    if (!selection) return;
    const board = selection.board;
    if (selection.kind === 'node') {
      const i = board.nodes.indexOf(selection.node); if (i >= 0) board.nodes.splice(i, 1);
      board.edges = board.edges.filter((e) => e.from !== selection.node.id && e.to !== selection.node.id);
      invalidateBBox(board);
    } else if (selection.kind === 'edge') {
      const i = board.edges.indexOf(selection.edge); if (i >= 0) board.edges.splice(i, 1);
    }
    const be = boardElOf(board); if (be) be._edgeSig = null;
    selection = null; onSelect(null); onChange(active.id); requestRender();
  }
  function addSubchart() {
    if (!selection || selection.kind !== 'node') return;
    const node = selection.node;
    if (!node.board) node.board = { nodes: [], edges: [], view: { x: 0, y: 0, zoom: 1 } };
    onChange(active.id); onSelect(selection); requestRender();
    requestAnimationFrame(() => zoomToNode(node));        // glide in so the (empty) child mounts in place
  }

  window.addEventListener('resize', requestRender);

  return { load, setEditing, refresh, fit, deleteSelected, addSubchart, zoomToNode, getSelection: () => selection, clearSelection, _frame: frame };
}

// One shared arrowhead marker (referenced document-wide by every board's edges).
function ensureArrowDefs() {
  if (document.getElementById('atlas-arrow')) return;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
  svg.innerHTML = '<defs><marker id="atlas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>';
  document.body.appendChild(svg);
}
