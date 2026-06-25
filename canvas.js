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
import { boardBBox, nextId, NODE_W, NODE_H, PAD, HEADER, pathChain, boardAtPath } from './shared/board.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const STATUS_LABEL = { done: 'done', partial: 'partial', todo: 'to build' };

// camera limits + LOD thresholds (apparent px)
const ZOOM_MIN = 0.04, ZOOM_MAX = 40;
const MOUNT_PX = 460, UNMOUNT_PX = 340;   // hysteresis gap kills threshold flicker
const DOT_PX = 86;                         // below this a node is just a status dot + clipped title
const MIN_VISIBLE_PX = 2.5;                // smaller than this on screen → don't paint at all
const CULL_MARGIN = 240;                   // keep nodes mounted this many px beyond the viewport
const SNAP_PX = 6;                          // screen-px gravity for snapping a dragged/resized node to siblings' x/y lines
// Infinite-depth navigation: re-root into a child board once its owner FULLY covers the
// viewport, and pop back out once the focus board shrinks under POP_FIT of the viewport.
// The wide hysteresis gap (a board that fully covers vs. one that fits in ~55%) prevents
// ping-pong, and re-rooting resets `cam.zoom` to O(1) so the effScale chain never
// underflows — nesting is unbounded with no float-precision collapse.
const POP_FIT = 0.55;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r3 = (n) => Math.round(n * 1000) / 1000;
const r5 = (n) => Math.round(n * 100000) / 100000;

export function createCanvas(viewportEl, opts = {}) {
  const onChange = opts.onChange || (() => {});
  const onSelect = opts.onSelect || (() => {});
  const questionStats = opts.questionStats || (() => ({ open: 0, decided: 0, total: 0 }));
  const onNav = opts.onNav || (() => {});       // breadcrumb / depth HUD callback
  const onEditingChange = opts.onEditingChange || (() => {});   // fires when edit mode flips (incl. auto-enable)
  ensureArrowDefs();

  const world = viewportEl.querySelector('.world');
  const rootBoardEl = buildBoardEl();
  world.appendChild(rootBoardEl);

  const cam = { x: 0, y: 0, zoom: 1 };
  let active = null;            // the sheet being shown (the ABSOLUTE root of the whole tree)
  // Focus stack = the infinite-zoom navigation state. `focusBoard` is the board currently
  // mounted at the render root; `focusPath` is its node-id path from active.board; the stack
  // holds the parents we dove through, each remembering the geometry needed to invert the
  // dive seamlessly (no stored camera — a pop re-derives the parent camera from the live one).
  let focusBoard = null;
  let focusPath = [];
  const focusStack = [];        // [{ board, path, node, px, py, innerScale }]
  let editing = false;
  let selection = null;         // { kind:'node'|'edge', node|edge, board }
  let viewW = 0, viewH = 0;
  let titleEditing = false;     // an inline node-title edit is in flight → suppress repaint/nav
  let rerootCandidate = null;   // set by renderBoard during a walk, applied after it returns

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
  function paintRoot() {
    world.style.transform = `translate(${r3(cam.x)}px, ${r3(cam.y)}px) scale(${r5(cam.zoom)})`;
    renderBoard(focusBoard, rootBoardEl, cam.x, cam.y, cam.zoom, 0, focusPath);
  }
  function frame() {
    rafPending = false;
    if (!active || !focusBoard) return;
    viewW = viewportEl.clientWidth; viewH = viewportEl.clientHeight;
    rerootCandidate = null;
    paintRoot();
    // Auto-navigation is deferred OUT of the per-node render walk (mutating focus mid-walk is
    // unsafe). It fires ONLY in response to a wheel-zoom gesture (navIntent), in that gesture's
    // direction, and never during a drag/tween/title edit — so programmatic dives never trip it
    // and a single wheel can't both re-root and pop. We consume the intent once, then repaint.
    const intent = navIntent; navIntent = 0;
    if (intent && !mode && !tween && !titleEditing) {
      if (intent > 0 && rerootCandidate && rerootCandidate.el.parentElement === rootBoardEl) {
        pushFocus(rerootCandidate.node, rerootCandidate.el); paintRoot();   // dive: child now fills the view
      } else if (intent < 0 && focusStack.length && (focusFitsViewport() || cam.zoom <= ZOOM_MIN * 1.25)) {
        // pop when the focus board has shrunk under POP_FIT — OR when we're pinned at the zoom
        // floor (a board too wide to ever "fit" still climbs out when you keep scrolling out).
        popFocus(); paintRoot();
      }
    }
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
      if (el._tier === 'card') fitCardHeight(el, node, w);
      if (el._sel !== !!selected) { el.classList.toggle('is-selected', !!selected); el._sel = !!selected; }

      const apparent = sw;   // node.w * eff
      const mounted = !!el._childEl;
      // No depth cap: re-rooting (below) keeps the mounted subtree shallow, so mounting is
      // gated purely on apparent size + visibility, at any absolute nesting depth.
      const want = node.board && onScreen && (mounted ? apparent >= UNMOUNT_PX : apparent >= MOUNT_PX);
      if (want && !mounted) mountChild(el);
      else if (!want && mounted) unmountChild(el);
      if (el._childEl) {
        const fl = frameLayout(node), innerScale = fl.s;
        if (el._innerScale !== innerScale || el._cox !== fl.ox || el._coy !== fl.oy) {
          el._childEl.style.transform = `translate(${r3(fl.ox)}px, ${r3(fl.oy)}px) scale(${r5(innerScale)})`;
          el._innerScale = innerScale; el._cox = fl.ox; el._coy = fl.oy;
        }
        renderBoard(node.board, el._childEl, sx + fl.ox * eff, sy + fl.oy * eff, eff * innerScale, depth + 1, path.concat(node.id));
        // A direct child of the focus root that has grown to FULLY cover the viewport becomes
        // the new render root (seamless re-root), so the scale chain never lengthens unboundedly.
        if (depth === 0 && coversViewport(sx, sy, sw, sh)) rerootCandidate = { node, el };
      }
    }
    for (const [id, el] of map) if (!present.has(id)) { el.remove(); map.delete(id); }
  }

  function positionNode(el, node, w, h) {
    if (el._lx === node.x && el._ly === node.y && el._lw === w && el._lh === h) return;
    el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
    el._lx = node.x; el._ly = node.y; el._lw = w; el._lh = h;
  }

  // Card tier stacks title + subtitle + a footer of markers ("▦ chart inside", "▶ storyboard",
  // "N open"). A long subtitle used to push that footer past the node's fixed height and the
  // `overflow:hidden` chrome clipped it — so the "chart inside" marker vanished. Grow node.h to
  // the content's natural height so the footer always shows (cards may end up different sizes).
  // Grow-only: never shrink below the authored/default height, so deliberate sizing is kept.
  // Gated by a content+width signature so the scrollHeight reflow happens only when text changes.
  function fitCardHeight(el, node, w) {
    if (el._editing) return;                       // mid inline-title edit → don't remeasure/jump
    const key = el._sig + '|' + w;
    if (el._fitKey === key) return;
    el._fitKey = key;
    const chrome = el.querySelector('.node-chrome');
    if (!chrome) return;
    const needed = Math.ceil(chrome.scrollHeight) + 2;   // +2 guards the last line against the border
    if (needed > (node.h || NODE_H) + 1) {
      node.h = needed;
      el.style.height = needed + 'px'; el._lh = needed;
      invalidateBBox(el.parentElement._board);          // bbox + edges depend on node.h
      onChange(active.id); requestRender();
    }
  }

  function paintNode(el, node) {
    if (el._editing) return;                 // don't blow away the contentEditable title mid-edit
    const q = questionStats(node);           // own + nested questions, so parents badge too
    const status = node.status || 'todo';
    const sig = [node.title, node.sub || '', status, node.algorithm || '', node.board ? 1 : 0, q.open, q.decided].join('');
    if (el._sig === sig) return;
    el._sig = sig;
    if (el._status !== status) { el.dataset.status = status; el._status = status; }
    // "Has a chart inside" is shown by an accented top-right border (.has-chart), not a tag.
    const hasChart = !!node.board;
    if (el._hasChart !== hasChart) { el.classList.toggle('has-chart', hasChart); el._hasChart = hasChart; }
    // Question marker: a count bubble under the card (visible at every zoom tier,
    // unlike the in-card footer). Amber while any are open; green once all answered.
    el.classList.toggle('has-open', q.total > 0);
    el.classList.toggle('q-done', q.total > 0 && q.open === 0);
    const qEl = el.querySelector('.node-q');
    qEl.textContent = String(q.open || q.decided || '');
    qEl.title = q.open
      ? `${q.open} open question${q.open > 1 ? 's' : ''}`
      : `${q.decided} question${q.decided > 1 ? 's' : ''} answered`;
    el.querySelector('.node-chrome').innerHTML =
      `<div class="node-top"><span class="node-dot"></span>` +
      `<h3 class="node-title">${esc(node.title)}</h3>` +
      `<span class="node-chip">${STATUS_LABEL[status] || esc(status)}</span></div>` +
      (node.sub ? `<p class="node-sub">${esc(node.sub)}</p>` : '') +
      `<div class="node-foot">` +
      (node.algorithm ? `<span class="node-tag algo">▶ storyboard</span>` : '') +
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
    for (const e of board.edges) s += e.id + e.from + '>' + e.to + (e.kind || 'flow') + (e.fromSide || '') + (e.label || '') + ';';
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
      const g = edgeGeom(e.kind || 'flow', a, b, e.fromSide);
      // a fat, transparent "hit" path tracing the same curve makes the 1.5px edge easy to click —
      // non-scaling-stroke keeps the target a constant ~16 screen px at any zoom. It carries class
      // 'edge' + the same eid, so the existing pointer/selectEdge path treats a hit on it as the edge.
      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('d', g.d);
      hit.setAttribute('class', 'edge hit');
      hit.setAttribute('vector-effect', 'non-scaling-stroke');
      hit.dataset.eid = e.id;
      svg.appendChild(hit);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', g.d);
      path.setAttribute('class', 'edge ' + (e.kind || 'flow') + (selection && selection.kind === 'edge' && selection.edge.id === e.id ? ' is-selected' : ''));
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('marker-end', 'url(#atlas-arrow)');
      path.dataset.eid = e.id;
      svg.appendChild(path);
      // the label is NOT drawn inline (it floated off the curve and overlapped) — it shows as a
      // cursor-following tooltip on hover instead; see the mousemove handler below.
    }
  }
  // the connection anchor of one of a node's four sides, with that side's outward unit normal
  function sideAnchor(n, side) {
    const w = n.w || NODE_W, h = n.h || NODE_H;
    switch (side) {
      case 'top':   return { x: n.x + w / 2, y: n.y,         nx: 0,  ny: -1 };
      case 'right': return { x: n.x + w,     y: n.y + h / 2, nx: 1,  ny: 0  };
      case 'left':  return { x: n.x,         y: n.y + h / 2, nx: -1, ny: 0  };
      default:      return { x: n.x + w / 2, y: n.y + h,     nx: 0,  ny: 1  };  // bottom
    }
  }
  // the side of node n that faces the point (px,py) — dominant axis from the node's center
  function autoSide(n, px, py) {
    const w = n.w || NODE_W, h = n.h || NODE_H, dx = px - (n.x + w / 2), dy = py - (n.y + h / 2);
    if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? 'bottom' : 'top';
    return dx >= 0 ? 'right' : 'left';
  }
  function edgeGeom(kind, a, b, fromSide) {
    const aw = a.w || NODE_W, ah = a.h || NODE_H, bw = b.w || NODE_W, bh = b.h || NODE_H;
    const acy = a.y + ah / 2, bcx = b.x + bw / 2, bcy = b.y + bh / 2;
    if (kind === 'loop') {
      // feedback: exit the source's right edge, bow out to the right, re-enter the target's right
      const sx = a.x + aw, sy = acy, ex = b.x + bw, ey = bcy;
      const gx = Math.max(a.x + aw, b.x + bw) + 70;
      return { d: `M ${sx} ${sy} C ${gx} ${sy}, ${gx} ${ey}, ${ex} ${ey}` };
    }
    // leave from the side the user dragged from (fromSide), else the side facing the target;
    // arrive on the target's side that faces the source anchor. Curve out along each side's normal.
    const s = sideAnchor(a, fromSide || autoSide(a, bcx, bcy));
    const t = sideAnchor(b, autoSide(b, s.x, s.y));
    const k = Math.max(40, Math.hypot(t.x - s.x, t.y - s.y) * 0.4);
    const c1x = s.x + s.nx * k, c1y = s.y + s.ny * k, c2x = t.x + t.nx * k, c2y = t.y + t.ny * k;
    return { d: `M ${s.x} ${s.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${t.x} ${t.y}` };
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
    ports.innerHTML = ['top', 'right', 'bottom', 'left']
      .map((side) => `<span class="port" data-port="${side}" title="drag to connect"></span>`).join('');
    const grip = document.createElement('span'); grip.className = 'node-resize'; grip.title = 'drag to resize';
    const q = document.createElement('span'); q.className = 'node-q';
    el.append(chrome, inner, ports, grip, q);
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

  /* ---------- right-click context menu (canvas + node actions) ---------- */
  let ctxEl = null;
  function hideCtx() {
    if (!ctxEl) return;
    ctxEl.remove(); ctxEl = null;
    document.removeEventListener('pointerdown', onCtxAway, true);
    document.removeEventListener('keydown', onCtxKey, true);
  }
  function onCtxAway(e) { if (ctxEl && !ctxEl.contains(e.target)) hideCtx(); }
  function onCtxKey(e) { if (e.key === 'Escape') hideCtx(); }
  function buildCtx(clientX, clientY, items) {
    hideCtx();
    ctxEl = document.createElement('div');
    ctxEl.className = 'ctx-menu';
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; ctxEl.appendChild(s); continue; }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.innerHTML = it.label;
      b.addEventListener('click', () => { hideCtx(); it.run(); });
      ctxEl.appendChild(b);
    }
    viewportEl.appendChild(ctxEl);
    // anchor at the cursor, then nudge back inside the viewport if it would overflow an edge
    const r = canvasRect();
    let lx = clientX - r.left, ly = clientY - r.top;
    if (lx + ctxEl.offsetWidth > r.width) lx = Math.max(0, r.width - ctxEl.offsetWidth - 4);
    if (ly + ctxEl.offsetHeight > r.height) ly = Math.max(0, r.height - ctxEl.offsetHeight - 4);
    ctxEl.style.left = lx + 'px'; ctxEl.style.top = ly + 'px';
    document.addEventListener('pointerdown', onCtxAway, true);
    document.addEventListener('keydown', onCtxKey, true);
    viewportEl.addEventListener('wheel', hideCtx, { once: true });
  }
  function setStatus(node, board, s) {
    if (node.status === s) return;
    node.status = s;
    const el = nodeElFor(node); if (el) el._sig = null;          // force a repaint of the chip + dot
    const be = boardElOf(board); if (be) be._edgeSig = null;
    onChange(active.id);
    if (selection && selection.node === node) onSelect(selection);   // refresh the inspector if it's open
    requestRender();
  }
  function deleteNode(node, board) {
    const i = board.nodes.indexOf(node); if (i >= 0) board.nodes.splice(i, 1);
    board.edges = board.edges.filter((e) => e.from !== node.id && e.to !== node.id);
    invalidateBBox(board);
    const be = boardElOf(board); if (be) be._edgeSig = null;
    if (selection && selection.node === node) { selection = null; onSelect(null); }
    onChange(active.id); requestRender();
  }
  viewportEl.addEventListener('contextmenu', (e) => {
    if (e.target && e.target.isContentEditable) return;          // leave the native menu for inline text editing
    if (e.target.closest && !e.target.closest('.world') && e.target !== viewportEl) return;   // HUD overlays keep theirs
    e.preventDefault();
    const cx = e.clientX, cy = e.clientY;
    const nodeEl = e.target.closest && e.target.closest('.node');
    if (nodeEl && nodeEl._node) {
      const node = nodeEl._node, board = nodeEl.parentElement._board;
      const items = [];
      if (node.board) items.push({ label: '⤢ Dive into chart', run: () => zoomToNode(node, nodeEl) });
      else items.push({ label: '＋ Add chart inside', run: () => { ensureEditing(); selectNodeKnown(node, board); addSubchart(); } });
      items.push({ label: '✎ Rename', run: () => { ensureEditing(); const t = nodeEl.querySelector('.node-title'); if (t) beginTitleEdit(t, node, nodeEl); } });
      items.push({ sep: true });
      for (const s of ['done', 'partial', 'todo'])
        items.push({ label: ((node.status || 'todo') === s ? '● ' : '○ ') + esc(STATUS_LABEL[s] || s), run: () => { ensureEditing(); setStatus(node, board, s); } });
      items.push({ sep: true });
      items.push({ label: '🗑 Delete node', danger: true, run: () => { ensureEditing(); deleteNode(node, board); } });
      buildCtx(cx, cy, items);
    } else {
      const items = [
        { label: '＋ Add node here', run: () => { ensureEditing(); createNodeAt(cx, cy); } },
        { label: '⤢ Fit to view', run: () => fit() },
      ];
      if (focusStack.length) items.push({ sep: true }, { label: '↑ Climb out one level', run: () => popFocusAndFit() });
      buildCtx(cx, cy, items);
    }
  });

  /* ---------- pointer: pan / drag / connect / click ---------- */
  let mode = null, pending = null, moved = 0, lastX = 0, lastY = 0, connect = null, spaceHeld = false, resize = null, pendingEdge = null;
  let navIntent = 0;            // set by the wheel handler (+1 in / -1 out), consumed once by frame()
  const grabPointer = (e) => { try { viewportEl.setPointerCapture(e.pointerId); } catch { /* ignore */ } };
  viewportEl.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.isContentEditable) return;     // let an inline title edit take the click
    // HUD overlays (breadcrumb, etc.) live OUTSIDE `.world` — ignore them here so their own
    // click handlers fire. (Capturing the pointer would steal their click/dblclick target.)
    // BUT the canvas background IS the viewport element itself (`.world` is a 0×0 transform
    // box, so empty canvas hits the viewport, not `.world`) — and it's the primary PAN surface.
    // Letting it through is essential: otherwise we'd return before recording lastX/lastY, and
    // the first pan move would diff against a stale anchor, making the layout leap to the cursor.
    if (e.target !== viewportEl && e.target.closest && !e.target.closest('.world')) return;
    // Space-drag or middle-button always PANS — the only way to slide the canvas when a
    // node fills the screen (exactly the deep-zoom state) without moving the node.
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      lastX = e.clientX; lastY = e.clientY; mode = 'pan'; pending = null; connect = null;
      viewportEl.classList.add('grabbing');
      grabPointer(e); e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    const portEl = editing && e.target.closest && e.target.closest('.port');
    const gripEl = editing && e.target.closest && e.target.closest('.node-resize');
    const nodeEl = e.target.closest && e.target.closest('.node');
    const edgeEl = e.target.classList && e.target.classList.contains('edge') ? e.target : null;
    lastX = e.clientX; lastY = e.clientY; moved = 0; mode = null; pending = null; connect = null; resize = null; pendingEdge = null;
    if (portEl && nodeEl) { startConnect(nodeEl, portEl.dataset.port); mode = 'connect'; grabPointer(e); e.preventDefault(); return; }
    if (gripEl && nodeEl) { startResize(nodeEl, e); mode = 'resize'; grabPointer(e); e.preventDefault(); return; }
    // defer edge selection to pointerup (like a node click) — selecting on pointerDOWN let the
    // pointerup "click, no pending" branch immediately clearSelection() and close the panel.
    if (edgeEl) { pendingEdge = edgeEl; return; }
    // NB: do NOT capture the pointer here. Capturing on a mere press redirects the resulting
    // click/dblclick to `.canvas`, breaking node title double-click-to-edit and HUD buttons.
    // We capture lazily below, only once a real drag/pan actually starts.
    pending = nodeEl ? { node: nodeEl._node, nodeEl, boardEl: nodeEl.parentElement } : null;
  });
  viewportEl.addEventListener('pointermove', (e) => {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (mode === null) {
      if (e.buttons === 0) return;                 // not dragging
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved <= 4) { lastX = e.clientX; lastY = e.clientY; return; }
      mode = (editing && pending) ? 'drag' : 'pan';
      if (mode === 'drag') { pending.rawX = pending.node.x; pending.rawY = pending.node.y; }   // unsnapped anchor
      grabPointer(e);                              // the gesture is real now → capture so it tracks off-element
      if (mode === 'pan') viewportEl.classList.add('grabbing');
    }
    if (mode === 'pan') { cam.x += dx; cam.y += dy; promoteWorld(); requestRender(); }
    else if (mode === 'drag') {
      const eff = pending.boardEl._eff || cam.zoom;
      pending.rawX += dx / eff; pending.rawY += dy / eff;       // accumulate the true position…
      pending.node.x = pending.rawX; pending.node.y = pending.rawY;
      const g = snapDrag(pending.boardEl._board, pending.node, eff);   // …then pull onto sibling x/y lines
      invalidateBBox(pending.boardEl._board);
      requestRender(); onChange(active.id);
      showGuides(pending.boardEl, g.x, g.y);                    // draw the line(s) it snapped to
    } else if (mode === 'connect') updateConnect(e);
    else if (mode === 'resize') updateResize(e);
    lastX = e.clientX; lastY = e.clientY;
  });
  viewportEl.addEventListener('pointerup', (e) => {
    viewportEl.classList.remove('grabbing');
    try { viewportEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (mode === 'connect') finishConnect(e);
    else if (mode === 'resize') finishResize();
    else if (mode === 'drag' && pending) {           // snap to integer local coords on drop (clean JSON)
      pending.node.x = Math.round(pending.node.x); pending.node.y = Math.round(pending.node.y);
      // Let a node drag UP/LEFT past the origin: rebase the whole ROOT board back into the positive
      // quadrant (boardBBox anchors at 0,0) and shift the camera to match, so the content doesn't jump.
      // A NESTED board has no clean camera mapping and its negatives would render into the parent
      // frame's header strip — so there, clamp just this node instead.
      if (pending.boardEl === rootBoardEl) rebaseRoot(pending.boardEl._board);
      else { pending.node.x = Math.max(0, pending.node.x); pending.node.y = Math.max(0, pending.node.y); }
      invalidateBBox(pending.boardEl._board); onChange(active.id); requestRender();
    } else if (mode === null) {                      // a click, not a drag
      if (pending && pending.node) selectNode(pending.node, pending.nodeEl);
      else if (pendingEdge) selectEdge(pendingEdge);
      else clearSelection();
    }
    hideGuides();
    mode = null; pending = null; connect = null; resize = null; pendingEdge = null;
  });
  // a system-cancelled gesture (touch takeover, etc.) never reaches pointerup — tear
  // down cleanly so a half-drawn connection edge and a stuck 'connect' mode don't linger.
  // (Not lostpointercapture: pointerup itself releases capture, which would fire it mid-handler.)
  viewportEl.addEventListener('pointercancel', () => {
    if (connect && connect.pathEl) connect.pathEl.remove();
    viewportEl.classList.remove('grabbing');
    hideGuides();
    mode = null; pending = null; connect = null; resize = null; pendingEdge = null;
  });
  viewportEl.addEventListener('dblclick', (e) => {
    const nodeEl = e.target.closest && e.target.closest('.node');
    const titleEl = e.target.closest && e.target.closest('.node-title');
    if (editing && nodeEl && titleEl) { beginTitleEdit(titleEl, nodeEl._node, nodeEl); return; }
    if (nodeEl) { zoomToNode(nodeEl._node, nodeEl); return; }   // dive into the node (re-roots if it has a chart)
    // Empty canvas → drop a node right where you clicked, in the focused board, at any zoom and even
    // outside the board's tight bounds. Auto-enables edit so you can immediately drag/rename it.
    ensureEditing(); createNodeAt(e.clientX, e.clientY);
  });
  // Track Space for space-to-pan (ignored while typing). preventDefault stops the page scroll.
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) {
      spaceHeld = true; if (e.target === document.body) e.preventDefault();
    }
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

  // Inline node-title editing: make the .node-title contentEditable, commit on Enter/blur,
  // revert on Escape. `el._editing` suppresses paintNode so a re-render can't clobber the text.
  function beginTitleEdit(titleEl, node, el) {
    if (el._editing) return;
    titleEditing = true; el._editing = true;
    let done = false;
    titleEl.setAttribute('contenteditable', 'true');
    titleEl.focus();
    try { document.getSelection().selectAllChildren(titleEl); } catch { /* ignore */ }
    const finish = (commit) => {
      if (done) return; done = true;
      titleEl.removeEventListener('blur', onBlur); titleEl.removeEventListener('keydown', onKey);
      const v = titleEl.textContent.trim();
      if (commit && v && v !== node.title) { node.title = v; el._sig = null; onChange(active.id); }
      else { titleEl.textContent = node.title; }     // empty / unchanged / cancelled → restore
      titleEl.removeAttribute('contenteditable');
      el._editing = false; titleEditing = false;
      requestRender();
    };
    const onBlur = () => finish(true);
    const onKey = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); titleEl.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); titleEl.blur(); }
    };
    titleEl.addEventListener('blur', onBlur); titleEl.addEventListener('keydown', onKey);
  }
  viewportEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvasRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const z = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    const k = z / cam.zoom;
    cam.x = k * cam.x + (1 - k) * sx; cam.y = k * cam.y + (1 - k) * sy; cam.zoom = z;
    // Auto re-root / pop is driven ONLY by a continuous-zoom gesture and only in the gesture's
    // direction — so programmatic dives/fits never trip it, and a single wheel can't both re-root
    // and pop (no oscillation). +1 = zooming in (may re-root), -1 = zooming out (may pop).
    navIntent = e.deltaY < 0 ? 1 : (e.deltaY > 0 ? -1 : 0);
    promoteWorld(); requestRender();
  }, { passive: false });

  function startConnect(nodeEl, side) { connect = { fromNode: nodeEl._node, boardEl: nodeEl.parentElement, side: side || 'bottom', pathEl: null }; }
  function updateConnect(e) {
    const b = connect.boardEl, a = connect.fromNode;
    const s = sideAnchor(a, connect.side);          // rubber leaves the side the user grabbed
    const { lx, ly } = localPoint(b, e.clientX, e.clientY);
    if (!connect.pathEl) { connect.pathEl = document.createElementNS(SVGNS, 'path'); connect.pathEl.setAttribute('class', 'edge rubber'); connect.pathEl.setAttribute('vector-effect', 'non-scaling-stroke'); b._svg.appendChild(connect.pathEl); }
    connect.pathEl.setAttribute('d', `M ${s.x} ${s.y} L ${lx} ${ly}`);
  }
  function finishConnect(e) {
    if (connect.pathEl) connect.pathEl.remove();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetEl = el && el.closest && el.closest('.node');
    if (targetEl && targetEl.parentElement === connect.boardEl && targetEl._node !== connect.fromNode) {
      const board = connect.boardEl._board;
      board.edges.push({ id: nextId(board.edges, 'e'), from: connect.fromNode.id, to: targetEl._node.id, kind: 'flow', fromSide: connect.side });
      connect.boardEl._edgeSig = null; onChange(active.id); requestRender();
    } else if (targetEl && targetEl.parentElement !== connect.boardEl) {
      toast('edges stay within one board — nest a node to link levels');
    }
  }

  /* ---------- alignment snapping (drag + resize) ---------- */
  // Pull a dragged/resized node's edges & center onto any sibling's matching x/y line when within
  // SNAP_PX (screen px → local via eff), so cards line up cleanly. Same-board nodes only.
  function alignLines(board, exclude) {
    const xs = [], ys = [];
    for (const n of (board.nodes || [])) {
      if (n === exclude) continue;
      const w = n.w || NODE_W, h = n.h || NODE_H;
      xs.push(n.x, n.x + w / 2, n.x + w);          // left, center, right
      ys.push(n.y, n.y + h / 2, n.y + h);          // top, center, bottom
    }
    return { xs, ys };
  }
  function snapAxis(anchors, lines, thresh) {       // -> { delta, line } for the nearest within thresh, else null
    let best = null, bestDist = thresh;
    for (const a of anchors) for (const c of lines) {
      const d = c - a, ad = Math.abs(d);
      if (ad <= bestDist) { bestDist = ad; best = { delta: d, line: c }; }
    }
    return best;
  }
  function snapDrag(board, node, eff) {             // align any of the moving node's 3 x/y anchors; report the guide lines
    const thresh = SNAP_PX / eff, w = node.w || NODE_W, h = node.h || NODE_H;
    const { xs, ys } = alignLines(board, node);
    const sx = snapAxis([node.x, node.x + w / 2, node.x + w], xs, thresh);
    const sy = snapAxis([node.y, node.y + h / 2, node.y + h], ys, thresh);
    if (sx) node.x += sx.delta;
    if (sy) node.y += sy.delta;
    return { x: sx && sx.line, y: sy && sy.line };
  }
  function snapResize(board, node, w, h, eff) {     // only the right/bottom edges move during a resize
    const thresh = SNAP_PX / eff;
    const { xs, ys } = alignLines(board, node);
    const sx = snapAxis([node.x + w], xs, thresh);
    const sy = snapAxis([node.y + h], ys, thresh);
    return { w: w + (sx ? sx.delta : 0), h: h + (sy ? sy.delta : 0), x: sx && sx.line, y: sy && sy.line };
  }

  // drag-to-resize from the bottom-right grip: convert the screen-space drag into local units via the
  // board's eff (so it tracks the cursor at any zoom/nesting depth) and clamp to the same minimums the
  // inspector enforces. A frame node's embedded child board refits automatically (frameLayout reads w/h).
  function startResize(nodeEl, e) {
    const node = nodeEl._node;
    resize = { node, boardEl: nodeEl.parentElement, startW: node.w || NODE_W, startH: node.h || NODE_H, startX: e.clientX, startY: e.clientY };
  }
  function updateResize(e) {
    const eff = resize.boardEl._eff || cam.zoom;        // screen px per local unit at this board's depth
    const w = Math.max(80, resize.startW + (e.clientX - resize.startX) / eff);
    const h = Math.max(48, resize.startH + (e.clientY - resize.startY) / eff);
    const s = snapResize(resize.boardEl._board, resize.node, w, h, eff);   // align right/bottom to siblings
    resize.node.w = Math.max(80, Math.round(s.w));
    resize.node.h = Math.max(48, Math.round(s.h));
    invalidateBBox(resize.boardEl._board);              // bbox + edge geometry depend on node w/h
    onChange(active.id); requestRender();
    showGuides(resize.boardEl, s.x, s.y);              // draw the line(s) the edge snapped to
  }
  function finishResize() {
    if (!resize) return;
    invalidateBBox(resize.boardEl._board);
    if (selection && selection.node === resize.node) onSelect(selection);   // refresh the inspector's W/H inputs
    onChange(active.id); requestRender();
  }

  function createNodeAt(clientX, clientY, opts = {}) {
    const boardEl = activeBoardElAt(clientX, clientY);
    if (!boardEl || !boardEl._board || !Number.isFinite(boardEl._eff) || boardEl._eff <= 0) return;  // not painted yet
    const { lx, ly } = localPoint(boardEl, clientX, clientY);
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) return;
    const board = boardEl._board;
    // Clamp into the positive quadrant: boardBBox treats (0,0) as the board's top-left, so a node
    // with negative coords (e.g. dropped in the empty margin ABOVE the content while dived in)
    // would render up into the parent frame's header strip once this board is shown nested.
    const node = { id: nextId(board.nodes, 'n'), x: Math.max(0, Math.round(lx - NODE_W / 2)), y: Math.max(0, Math.round(ly - NODE_H / 2)), w: NODE_W, h: NODE_H, title: opts.title || 'New node', status: 'todo' };
    board.nodes.push(node); invalidateBBox(board); onChange(active.id);
    selectNodeKnown(node, board);
  }
  // public: drop a node (of a given shape) at client coords — used by the sidebar shape library

  /* ---------- focus stack: seamless infinite-zoom navigation ---------- */
  // A "dive" re-roots the renderer onto a node's child board and rebases the camera so the
  // child occupies the EXACT pixels it had while nested — then `cam.zoom` is back to O(1),
  // so the effScale chain can never underflow no matter how deep you go. A "pop" inverts it
  // from the LIVE camera (not a stored one), so it stays seamless however much you zoomed.
  // Fit-and-CENTER a node's child board inside its frame body. The node KEEPS its (small) size —
  // we only set the child's internal zoom so the chart shrinks to fit. The body uses a thin gutter
  // (FRAME_PAD) rather than the fat PAD=40 bbox margin: on a default 96-tall node, HEADER(44)+PAD(40)
  // left only 12px of body and the chart fit to a 0.03 speck — the thin gutter reclaims it so the
  // small preview actually fills the frame. ONE source of truth: the render transform AND the
  // seamless dive/pop camera math both read this, so they can never disagree (a mismatch would seam).
  const FRAME_PAD = 12;   // gutter between a frame's border and its embedded child board
  function frameLayout(node) {
    const w = node.w || NODE_W, h = node.h || NODE_H, cb = bboxOf(node.board);
    const availW = w - 2 * FRAME_PAD, availH = h - HEADER - FRAME_PAD;
    const s = Math.max(1e-4, Math.min(availW / cb.w, availH / cb.h));
    const ox = FRAME_PAD + Math.max(0, (availW - cb.w * s) / 2);
    const oy = HEADER + Math.max(0, (availH - cb.h * s) / 2);
    return { s, ox, oy };
  }
  function coversViewport(sx, sy, sw, sh) {     // an on-screen rect fully spans the viewport
    if (!(Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sw) && Number.isFinite(sh))) return false;
    return sx <= 1 && sy <= 1 && sx + sw >= viewW - 1 && sy + sh >= viewH - 1;
  }
  function focusFitsViewport() {                 // the whole focus board fits within POP_FIT of the view
    if (!Number.isFinite(cam.zoom) || cam.zoom <= 0) return false;
    const bb = bboxOf(focusBoard);
    return bb.w * cam.zoom <= POP_FIT * viewW && bb.h * cam.zoom <= POP_FIT * viewH;
  }
  function pushFocus(node, ownerEl, cause = 'auto') {   // dive one level (node must be a direct child of focusBoard)
    if (!node || !node.board) return;
    if (ownerEl && ownerEl.parentElement !== rootBoardEl) return;
    // Refuse to re-root into an ancestor board (a true cycle). Object-identity match (like
    // board.js's validator) so legitimate id reuse across sibling subtrees still dives fine.
    // The old id-based guard was inert: a direct child is always in focusBoard.nodes, so the
    // `&& indexOf < 0` clause was never true.
    if (node.board === focusBoard || focusStack.some((f) => f.board === node.board)) return;
    const fl = frameLayout(node), innerScale = fl.s, px = node.x + fl.ox, py = node.y + fl.oy, z = cam.zoom;
    focusStack.push({ board: focusBoard, path: focusPath.slice(), node, px, py, innerScale });
    cam.x = cam.x + px * z; cam.y = cam.y + py * z; cam.zoom = z * innerScale;
    focusBoard = node.board; focusPath = focusPath.concat(node.id);
    clearRoot(); emitNav(cause);
  }
  function popFocus(cause = 'auto') {             // climb one level, re-deriving the parent camera
    if (!focusStack.length) return false;
    const fr = focusStack.pop();
    // Prefer LIVE geometry: if the owner node was edited (or its child board grew) while we were
    // focused inside, the snapshot would seam the nested content on the way out. Fall back to the
    // snapshot if the node was deleted. For an unchanged dive/pop pair this is the exact inverse.
    let px = fr.px, py = fr.py, s = fr.innerScale;
    if (fr.node && fr.board.nodes.indexOf(fr.node) >= 0 && fr.node.board) {
      const fl = frameLayout(fr.node); px = fr.node.x + fl.ox; py = fr.node.y + fl.oy; s = fl.s;
    }
    const parentZoom = cam.zoom / s;
    cam.x = cam.x - px * parentZoom; cam.y = cam.y - py * parentZoom; cam.zoom = parentZoom;
    focusBoard = fr.board; focusPath = fr.path.slice();
    clearRoot(); emitNav(cause);
    return true;
  }
  // Jump to an arbitrary path from the sheet root (breadcrumb crumb click). Rebuilds the stack
  // and fits the target level — exact-pixel restoration only matters for the immediate dive/pop pair.
  function focusToPath(path, opts) {
    if (!active) return;
    path = path || [];
    focusStack.length = 0;
    let board = active.board; const acc = [];
    for (const id of path) {
      const n = board.nodes && board.nodes.find((x) => x && x.id === id);
      if (!n || !n.board) break;
      const fl = frameLayout(n);
      focusStack.push({ board, path: acc.slice(), node: n, px: n.x + fl.ox, py: n.y + fl.oy, innerScale: fl.s });
      board = n.board; acc.push(id);
    }
    focusBoard = board; focusPath = acc;
    clearRoot(); emitNav((opts && opts.cause) || 'user');
    if (opts && opts.instant) fit();              // restore (e.g. after reload): land instantly, no glide
    else zoomToFitFocus(0.9);                     // sync → sets `tween`, blocking premature auto-nav in the gap
  }
  function getNav() {
    return { depth: focusPath.length, path: focusPath.slice(), chain: active ? pathChain(active.board, focusPath) : [], canPop: focusStack.length > 0 };
  }
  // The current focus path is mirrored to the URL hash by app.js (via onNav), so it survives reload
  // AND back/forward/deep links. `cause` lets app.js choose pushState (deliberate dive/pop/jump) vs
  // replaceState (the auto re-root/pop on a zoom gesture, and the initial sheet load).
  function emitNav(cause) { onNav(getNav(), cause); }

  /* ---------- camera moves ---------- */
  function zoomToNode(node, nodeEl) {
    nodeEl = nodeEl || nodeElFor(node); if (!nodeEl) return;
    // Diving into a direct child of the focus root re-roots seamlessly, then fits the child.
    // The fit tween MUST start synchronously: it sets `tween`, which blocks the auto-pop from
    // firing in the gap before the child is zoomed in (the child is briefly small → "fits").
    if (node.board && nodeEl.parentElement === rootBoardEl && !tween && !mode) {
      pushFocus(node, nodeEl, 'user');   // deliberate dive (double-click) → a history entry
      zoomToFitFocus(0.9);
      return;
    }
    const b = nodeEl.parentElement, eff = b._eff;
    const w = node.w || NODE_W, h = node.h || NODE_H;
    const scx = b._ox + (node.x + w / 2) * eff, scy = b._oy + (node.y + h / 2) * eff;
    const zoomNew = clamp(cam.zoom * ((MOUNT_PX * 1.5) / w) / eff, ZOOM_MIN, ZOOM_MAX);
    const k = zoomNew / cam.zoom;
    const nx = k * cam.x + (1 - k) * scx + (viewW / 2 - scx);
    const ny = k * cam.y + (1 - k) * scy + (viewH / 2 - scy);
    tweenCamera(nx, ny, zoomNew);
  }
  function zoomToFitFocus(margin) {              // glide the current focus board to fill the viewport
    const bb = bboxOf(focusBoard), m = margin || 0.9;
    const vw = viewW || viewportEl.clientWidth || 800, vh = viewH || viewportEl.clientHeight || 600;
    const z = clamp(Math.min((vw * m) / bb.w, (vh * m) / bb.h), ZOOM_MIN, ZOOM_MAX);
    tweenCamera((vw - bb.w * z) / 2, (vh - bb.h * z) / 2, z);
  }
  let tween = null;
  function tweenCamera(x, y, z) {
    const sx = cam.x, sy = cam.y, sz = cam.zoom, t0 = performance.now(), dur = 320;
    if (tween) cancelAnimationFrame(tween);
    const stepFn = () => {
      const t = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      cam.x = sx + (x - sx) * e; cam.y = sy + (y - sy) * e; cam.zoom = sz + (z - sz) * e;
      if (t < 1) { frame(); tween = requestAnimationFrame(stepFn); }
      else { tween = null; frame(); }   // clear tween BEFORE the final frame → it's a clean resting render
    };
    tween = requestAnimationFrame(stepFn);
  }
  function fit() {
    if (!focusBoard) return;
    const bb = bboxOf(focusBoard);                 // fit the level you're ON, not the whole tree
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

  /* ---------- edge label tooltip (hover → follows the cursor) ---------- */
  let edgeTipEl = null;
  function showEdgeTip(text, clientX, clientY) {
    if (!edgeTipEl) { edgeTipEl = document.createElement('div'); edgeTipEl.className = 'edge-tip'; viewportEl.appendChild(edgeTipEl); }
    if (edgeTipEl.textContent !== text) edgeTipEl.textContent = text;
    const r = canvasRect();
    edgeTipEl.style.left = (clientX - r.left + 14) + 'px';   // offset off the cursor so it isn't covered
    edgeTipEl.style.top = (clientY - r.top + 14) + 'px';
    edgeTipEl.classList.add('show');
  }
  function hideEdgeTip() { if (edgeTipEl) edgeTipEl.classList.remove('show'); }

  /* ---------- snap alignment guides (shown while dragging/resizing) ---------- */
  // A vertical + horizontal line drawn at the local x/y a node just snapped to, converted to
  // canvas-relative px via the board's _ox/_oy/_eff (same mapping the renderer uses).
  let guideV = null, guideH = null;
  function showGuides(boardEl, xLine, yLine) {
    if (!guideV) {
      guideV = document.createElement('div'); guideV.className = 'snap-guide v';
      guideH = document.createElement('div'); guideH.className = 'snap-guide h';
      viewportEl.append(guideV, guideH);
    }
    const eff = boardEl && boardEl._eff;
    if (xLine != null && eff) { guideV.style.transform = `translateX(${r3(boardEl._ox + xLine * eff)}px)`; guideV.style.display = 'block'; }
    else guideV.style.display = 'none';
    if (yLine != null && eff) { guideH.style.transform = `translateY(${r3(boardEl._oy + yLine * eff)}px)`; guideH.style.display = 'block'; }
    else guideH.style.display = 'none';
  }
  function hideGuides() { if (guideV) guideV.style.display = 'none'; if (guideH) guideH.style.display = 'none'; }
  // Hover an edge (its fat hit path) → show its label at the cursor. Cheap and read-only; bails during
  // any gesture so the tip never lingers mid pan/drag/connect/resize.
  viewportEl.addEventListener('mousemove', (e) => {
    if (mode) return hideEdgeTip();
    const pathEl = e.target.classList && e.target.classList.contains('edge') ? e.target : null;
    if (!pathEl) return hideEdgeTip();
    const boardEl = pathEl.closest('.board'), board = boardEl && boardEl._board;
    const edge = board && board.edges.find((x) => x.id === pathEl.dataset.eid);
    if (edge && edge.label) showEdgeTip(edge.label, e.clientX, e.clientY); else hideEdgeTip();
  });
  viewportEl.addEventListener('mouseleave', hideEdgeTip);

  /* ---------- resize-grip proximity fade ---------- */
  // Fade the bottom-right resize grip in as the cursor nears that corner (full at GRIP_FULL px,
  // gone past GRIP_NEAR px), so the handle surfaces only when you reach for it. We set a --grip
  // custom property on the hovered node; CSS maps it to the grip's opacity.
  let gripNodeEl = null;
  const GRIP_NEAR = 110, GRIP_FULL = 18;   // screen px from the corner
  viewportEl.addEventListener('mousemove', (e) => {
    const nodeEl = (!mode && e.target.closest) ? e.target.closest('.node') : null;
    if (gripNodeEl && gripNodeEl !== nodeEl) { gripNodeEl.style.removeProperty('--grip'); gripNodeEl = null; }
    if (!nodeEl || nodeEl.dataset.lod === 'dot') return;
    const r = nodeEl.getBoundingClientRect();
    const dist = Math.hypot(e.clientX - r.right, e.clientY - r.bottom);
    nodeEl.style.setProperty('--grip', clamp((GRIP_NEAR - dist) / (GRIP_NEAR - GRIP_FULL), 0, 1).toFixed(3));
    gripNodeEl = nodeEl;
  });
  viewportEl.addEventListener('mouseleave', () => { if (gripNodeEl) { gripNodeEl.style.removeProperty('--grip'); gripNodeEl = null; } });

  /* ---------- public API (driven by app.js) ---------- */
  function clearRoot() {                          // tear down the mounted tree so frame() rebuilds focusBoard
    for (const [, el] of rootBoardEl._nodes) el.remove();
    rootBoardEl._nodes.clear(); rootBoardEl._edgeSig = null; rootBoardEl._board = null;
  }
  // boardBBox anchors a board at (0,0), so any node with a negative coordinate (e.g. one created
  // long ago in the empty margin above the content) renders ABOVE the body — up into a parent
  // frame's header — once the board is shown nested. Shift each board back into the positive
  // quadrant on load so old data heals itself; new edits are already clamped to ≥ 0.
  function normalizeBoards(board) {
    let changed = false;
    const nodes = (board && board.nodes) || [];
    if (nodes.length) {
      let minX = Infinity, minY = Infinity;
      for (const n of nodes) { const nx = n.x || 0, ny = n.y || 0; if (nx < minX) minX = nx; if (ny < minY) minY = ny; }
      const dx = minX < 0 ? -minX : 0, dy = minY < 0 ? -minY : 0;
      if (dx || dy) { for (const n of nodes) { n.x = (n.x || 0) + dx; n.y = (n.y || 0) + dy; } invalidateBBox(board); changed = true; }
    }
    for (const n of nodes) if (n.board && normalizeBoards(n.board)) changed = true;
    return changed;
  }
  // Shift a RENDER-ROOT board's nodes back into the positive quadrant and move the camera by the
  // same amount, so dragging a node above/left of the origin grows the board that way with no visible
  // jump. Root-only: the camera maps 1:1 to the render-root board's local units (eff === cam.zoom).
  function rebaseRoot(board) {
    const nodes = (board && board.nodes) || [];
    let minX = 0, minY = 0;
    for (const n of nodes) { minX = Math.min(minX, n.x || 0); minY = Math.min(minY, n.y || 0); }
    if (minX >= 0 && minY >= 0) return;
    const sx = -minX, sy = -minY;                    // ≥ 0 (min is floored at 0)
    for (const n of nodes) { n.x = (n.x || 0) + sx; n.y = (n.y || 0) + sy; }
    cam.x -= sx * cam.zoom; cam.y -= sy * cam.zoom;  // keep on-screen pixels fixed
    invalidateBBox(board);
  }
  function load(sheet, opts = {}) {
    active = sheet; selection = null; onSelect(null);
    const healed = normalizeBoards(sheet.board);   // heal any out-of-bounds (negative) coords from old data
    focusBoard = sheet.board; focusPath = []; focusStack.length = 0;   // start at the sheet root
    clearRoot();
    frame(); fit(); emitNav('load');
    // Re-enter a deep focus carried by the URL (back/forward, deep link, reload) — graceful if pruned.
    const focus = opts.focus || [];
    if (focus.length && boardAtPath(active.board, focus) !== active.board) focusToPath(focus, { instant: true, cause: 'load' });
    if (healed) onChange(sheet.id);   // persist the healed coordinates
  }
  function setEditing(b) { if (editing === b) return; editing = b; viewportEl.classList.toggle('editing', b); onEditingChange(b); requestRender(); }
  function ensureEditing() { if (!editing) setEditing(true); }   // mutating actions (add/rename) imply edit mode
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

  // Create a node at the center of the current view, in whatever board is focused/under it.
  function createNodeAtViewCenter() {
    const r = canvasRect();
    createNodeAt(r.left + viewW / 2, r.top + viewH / 2);
    return selection && selection.node;
  }
  // Public climb: pop one level and glide the parent into view (the auto-pop path stays seamless).
  function popFocusAndFit() { if (popFocus('user')) { zoomToFitFocus(0.9); return true; } return false; }

  window.addEventListener('resize', requestRender);

  return {
    load, setEditing, refresh, fit, deleteSelected, addSubchart, zoomToNode,
    getSelection: () => selection, clearSelection,
    // infinite-zoom navigation
    popFocus: popFocusAndFit, getNav, focusPath: focusToPath, createNodeAtViewCenter,
    // test/debug hooks — drive deterministic dive/climb checks from window.__atlasCanvas
    _frame: frame,
    _cam: () => ({ ...cam }),
    _nodeCount: () => viewportEl.querySelectorAll('.node').length,
    _settled: () => !tween && !rafPending,
  };
}

// One shared arrowhead marker (referenced document-wide by every board's edges).
function ensureArrowDefs() {
  if (document.getElementById('atlas-arrow')) return;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
  svg.innerHTML = '<defs><marker id="atlas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>';
  document.body.appendChild(svg);
}
