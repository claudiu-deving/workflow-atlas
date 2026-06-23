// Workflow maps for the active project — an infinite canvas of nested charts.
// This module is the controller: it loads sheets, drives the left index, owns the
// inspector (the right callout — read-only review OR an edit form), and persists
// edits back to the server (debounced) so the in-app editor and the MCP authoring
// tools write one source of truth. The canvas engine itself lives in canvas.js.
import { esc } from './shared/esc.js';
import { migrateSheet } from './shared/migrate.js';
import { createCanvas } from './canvas.js';
import { resolveProjects, apiBase, withProject, renderSwitcher, wireSwitchLinks, setTabTitle } from './shared/project.js';

const $ = (id) => document.getElementById(id);
let PROJECT = 'default';
const API = () => apiBase(PROJECT);
const indexNav = $('index');
const callout = $('callout');
const scrim = $('scrim');
const frame = document.querySelector('.frame');
const STATUS_LABEL = { done: 'done', partial: 'partial', todo: 'to build' };
const STATUSES = ['done', 'partial', 'todo'];

let SHEETS = [];
let current = null;
let editing = false;
let lastSel = null;          // the canvas selection currently shown in the inspector
let canvas = null;
let suppressHashWrite = false;   // true while we drive nav FROM the URL, so onNav doesn't write it back
let pendingSheetHist = 'replace';// how the next sheet load records in history: 'push' | 'replace'

/* ---------- workflow review (decisions on node open[] questions) ---------- */
let wfReview = { decisions: {} };       // sheetId → { [question text]: { answer, by, at } }
let wfHasServer = false;
const AUTHOR_KEY = 'workflow-atlas.author';
const today = () => new Date().toISOString().slice(0, 10);
const getAuthor = () => { try { return localStorage.getItem(AUTHOR_KEY) || ''; } catch { return ''; } };
const wfDecisions = (sheetId) => (wfReview.decisions && wfReview.decisions[sheetId]) || {};

const wfDraftKey = () => `workflow-atlas.wfreview.${PROJECT}`;
async function loadWorkflowReview() {
  wfReview = { decisions: {} }; wfHasServer = false;
  try {
    const res = await fetch(`${API()}/workflow-review`, { cache: 'no-store' });
    if (res.ok) { wfReview = await res.json(); wfHasServer = true; }
  } catch { /* server not running */ }
  if (!wfHasServer) {
    try { const d = JSON.parse(localStorage.getItem(wfDraftKey()) || 'null'); if (d) wfReview = d; } catch { /* ignore */ }
  }
  wfReview.decisions = wfReview.decisions || {};
}
async function persistWfChange(patch) {
  try { localStorage.setItem(wfDraftKey(), JSON.stringify(wfReview)); } catch { /* ignore */ }
  if (!wfHasServer) return;
  try {
    const res = await fetch(`${API()}/workflow-review`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (res.ok) { const j = await res.json(); if (j && j.saved && j.saved.decisions) wfReview = j.saved; }
  } catch { /* offline — local optimistic state stands */ }
}
function wfDecide(sheetId, question, answer, by) {
  wfReview.decisions = wfReview.decisions || {};
  wfReview.decisions[sheetId] = wfReview.decisions[sheetId] || {};
  wfReview.decisions[sheetId][question] = { answer, by: by || 'you', at: today() };
  persistWfChange({ sheet: sheetId, question, decision: { answer, by: by || 'you' } });
}
function wfReopen(sheetId, question) {
  if (wfReview.decisions && wfReview.decisions[sheetId]) delete wfReview.decisions[sheetId][question];
  persistWfChange({ sheet: sheetId, question, decision: null });
}
// unanswered open questions on a node (the canvas shows this as a badge)
function nodeOpenCount(node) {
  if (!node || !node.detail || !Array.isArray(node.detail.open)) return 0;
  const dec = wfDecisions(current && current.id);
  return node.detail.open.filter((q) => !dec[q]).length;
}

/* ---------- autosave (browser → server; debounced, coalesced) ---------- */
const dirty = new Set();
let saveTimer = null, inflightP = null;
function cleanSheet(s) { const { stations, ...rest } = s; return rest; }   // commit v2: drop the legacy spine
function scheduleSave(id) { dirty.add(id); window.__atlasDirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(flushSaves, 600); }
function putSheet(id) {
  const sheet = SHEETS.find((s) => s.id === id);
  if (!sheet) return Promise.resolve();
  return fetch(`${API()}/sheet/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet: cleanSheet(sheet) }),
  });
}
// Serialize flushes through a chained promise so an awaiter (the live-reload handler)
// truly waits for the LATEST dirty set to land. A re-entrancy guard that returned early
// would resolve before the in-flight PUT finished, letting location.reload() abort it.
function flushSaves() {
  const run = (inflightP || Promise.resolve()).then(async () => {
    const ids = [...dirty]; dirty.clear();
    try { for (const id of ids) await putSheet(id); }
    catch { /* offline — optimistic state stands; file is truth on next load */ }
    finally { window.__atlasDirty = dirty.size > 0; }
  });
  inflightP = run;
  run.finally(() => { if (inflightP === run) inflightP = null; });
  return run;
}
// On unload an async fetch is aborted as the document tears down — fire keepalive PUTs
// synchronously so the final edit survives. (Sheets are small, well under the cap.)
window.addEventListener('beforeunload', () => {
  for (const id of dirty) {
    const sheet = SHEETS.find((s) => s.id === id);
    if (!sheet) continue;
    try { fetch(`${API()}/sheet/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet: cleanSheet(sheet) }), keepalive: true }); } catch { /* ignore */ }
  }
});

/* ---------- sheet index (title block) ---------- */
function buildIndex() {
  indexNav.innerHTML = '';
  SHEETS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'idx';
    b.dataset.id = s.id;
    b.innerHTML = `<span class="idx-code">${esc(s.code || '')}</span><span class="idx-name">${esc(s.name || s.title || s.id)}</span>`;
    b.addEventListener('click', () => select(i));
    indexNav.appendChild(b);
  });
}

async function boot() {
  const info = await resolveProjects();
  PROJECT = info.active;
  setTabTitle(PROJECT, 'Workflows');
  renderSwitcher($('proj'), info);
  wireSwitchLinks(PROJECT);
  try {
    const res = await fetch(`${API()}/workflows`, { cache: 'no-store' });
    if (res.ok) SHEETS = ((await res.json()).sheets || []).map(migrateSheet);
  } catch { /* server down */ }
  await loadWorkflowReview();
  buildIndex();
  wireChrome();
  canvas = createCanvas($('canvas'), {
    onChange: (id) => { scheduleSave(id); refreshHeaderCount(); },
    onSelect: (sel) => { lastSel = sel; if (sel) openInspector(sel); else closeCallout(); },
    openCount: nodeOpenCount,
    onNav: (nav, cause) => {       // mirror the nesting position into the URL hash (deep-linkable)
      renderBreadcrumb(nav);
      const mode = cause === 'load' ? pendingSheetHist : (cause === 'user' ? 'push' : 'replace');
      syncHash(nav.path, mode);
    },
    onEditingChange: syncEditUI,   // canvas may auto-enable edit (dbl-click / context-menu add) → keep the UI in sync
  });
  window.__atlasCanvas = canvas;   // handle for power-user debugging / automated checks
  canvas.setEditing(true);         // edit mode is always on (no toggle) → fires onEditingChange → syncEditUI
  // dirty-aware live reload: our own autosave is hash-suppressed server-side, so a
  // message here means a genuine MCP/other-session change — flush any pending edit first.
  try {
    new EventSource('/api/livereload?p=' + encodeURIComponent(PROJECT)).onmessage = async () => {
      await flushSaves();   // ensure any pending/in-flight edit lands before the reload aborts it
      location.reload();
    };
  } catch { /* no server */ }

  if (!SHEETS.length) {
    $('sh-title').textContent = info.projects.length ? 'No workflow maps yet' : 'Start the server';
    $('sh-sub').textContent = info.projects.length
      ? 'Turn on Edit and double-click the canvas to drop a node, or author one over MCP.'
      : 'Run the Atlas server so the assistant can author maps for this project.';
    return;
  }
  navigateToHash();   // open the sheet (and nested focus) the URL points at, else the first sheet
}

/* ---------- URL ↔ focus path (deep-linkable nesting: #sheetId/nodeId/nodeId…) ---------- */
function parseHash() {
  const parts = location.hash.replace(/^#/, '').split('/').map(decodeURIComponent).filter(Boolean);
  return { sheetId: parts[0] || '', path: parts.slice(1) };
}
function buildHash(sheetId, path) {
  return '#' + [sheetId, ...(path || [])].filter(Boolean).map(encodeURIComponent).join('/');
}
// Write the current sheet+focus to the URL. pushState/replaceState don't fire hashchange, so this
// never loops back into navigateToHash; mode 'push' adds a Back-step, 'replace' just keeps it current.
function syncHash(path, mode) {
  if (suppressHashWrite || !current) return;
  const h = buildHash(current.id, path);
  if (h === location.hash) return;
  if (mode === 'push') history.pushState(null, '', h);
  else history.replaceState(null, '', h);
}
// Drive the app FROM the URL (boot, back/forward, deep link, manual edit). Idempotent.
function navigateToHash() {
  const { sheetId, path } = parseHash();
  let i = SHEETS.findIndex((s) => s.id === sheetId);
  if (i < 0) { if (!sheetId && SHEETS.length) i = 0; else return; }   // empty hash → first sheet
  const sameSheet = current && current.id === SHEETS[i].id;
  if (sameSheet && JSON.stringify(canvas.getNav().path) === JSON.stringify(path)) return;  // already there
  suppressHashWrite = true;
  try {
    if (!sameSheet) select(i, { focus: path });
    else canvas.focusPath(path, { instant: true });
  } finally { suppressHashWrite = false; }
  syncHash(canvas.getNav().path, 'replace');   // canonicalize (e.g. if the path was pruned)
}

/* ---------- render a sheet ---------- */
function select(i, opts = {}) {
  const s = SHEETS[i];
  if (!s) return;
  pendingSheetHist = opts.hist || 'push';   // a sheet switch is a Back-step; boot/hash nav suppress this
  current = migrateSheet(s);
  [...indexNav.children].forEach((b, j) => b.classList.toggle('active', j === i));
  $('sh-code').textContent = s.code || '';
  $('sh-title').textContent = s.title || s.name || s.id;
  $('sh-sub').textContent = s.sub || '';
  refreshHeaderCount();
  closeCallout();
  canvas.load(current, { focus: opts.focus });   // hash is written by onNav, not here
}

function refreshHeaderCount() {
  if (!current || !current.board) { $('sh-count').textContent = ''; return; }
  const nodes = current.board.nodes || [];
  const c = { done: 0, partial: 0, todo: 0 };
  nodes.forEach((n) => { const k = n.status || 'todo'; c[k] = (c[k] || 0) + 1; });
  $('sh-count').textContent = `${nodes.length} NODES · ${c.done} DONE · ${c.partial} PARTIAL · ${c.todo} TO BUILD`;
}

/* ---------- breadcrumb / depth navigator (driven by the canvas focus stack) ---------- */
function renderBreadcrumb(nav) {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  if (!nav || !nav.depth) { el.innerHTML = ''; el.classList.remove('show'); return; }
  el.classList.add('show');
  const rootTitle = (current && (current.title || current.name || current.id)) || 'map';
  const crumbs = [{ title: rootTitle }, ...nav.chain];
  el.innerHTML = crumbs
    .map((c, i) => `<button class="bc" type="button" data-i="${i}">${esc(c.title || c.id || '?')}</button>`)
    .join('<span class="bc-sep">›</span>')
    + `<span class="bc-depth" title="nesting depth">${nav.depth} level${nav.depth > 1 ? 's' : ''} deep</span>`;
  el.querySelectorAll('.bc').forEach((b) =>
    b.addEventListener('click', () => canvas.focusPath(nav.path.slice(0, +b.dataset.i))));   // crumb i → first i ids
}

/* ---------- chrome: edit toggle, fit, new map, editable header ---------- */
// Single source of truth for edit-mode UI. Driven by canvas.setEditing (via onEditingChange),
// so the button reflects edit mode whether the user toggled it or the canvas auto-enabled it.
function syncEditUI(on) {
  editing = on;
  document.body.classList.toggle('is-editing', on);
  setHeaderEditable(on);
  if (lastSel) openInspector(lastSel);    // re-render inspector in the new mode
}
function wireChrome() {
  $('fit-btn').addEventListener('click', () => canvas.fit());
  $('new-sheet').addEventListener('click', createSheet);
  // keyboard: Esc closes the callout; Delete/Backspace deletes the selection (edit mode) or,
  // when nothing's selected, climbs one nesting level out (works at any depth, any mode).
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === 'Escape') { closeCallout(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (editing && canvas.getSelection()) { e.preventDefault(); canvas.deleteSelected(); return; }
      const nav = canvas.getNav && canvas.getNav();
      if (nav && nav.canPop) { e.preventDefault(); canvas.popFocus(); }
    }
  });
}
function setHeaderEditable(on) {
  for (const [id, key] of [['sh-title', 'title'], ['sh-sub', 'sub']]) {
    const el = $(id);
    el.contentEditable = on ? 'true' : 'false';
    el.classList.toggle('editable', on);
    el.oninput = on ? () => { if (current) { current[key] = el.textContent; scheduleSave(current.id); } } : null;
  }
}
async function createSheet() {
  const base = 'map'; let n = 1, id = base;
  const ids = new Set(SHEETS.map((s) => s.id));
  while (ids.has(id)) id = `${base}-${++n}`;
  const sheet = { id, code: `WA-${String(SHEETS.length).padStart(2, '0')}`, name: 'New map', title: 'New map', sub: '', schema: 2, board: { nodes: [], edges: [], view: { x: 0, y: 0, zoom: 1 } } };
  SHEETS.push(sheet);
  buildIndex();
  select(SHEETS.length - 1);
  scheduleSave(id);
}

/* ---------- inspector (the right callout) ---------- */
function openInspector(sel) {
  if (!sel) return closeCallout();
  if (sel.kind === 'edge') return openEdgeInspector(sel);
  const node = sel.node;
  if (editing) renderNodeEditor(node, sel.board);
  else renderNodeView(node);
  callout.classList.add('open');
  callout.setAttribute('aria-hidden', 'false');
  scrim.classList.add('open');
  frame.classList.add('callout-open');
}

// read-only review view (answerable open questions — the original review loop)
function renderNodeView(node) {
  const d = node.detail || {};
  const sheetId = current && current.id;
  const status = node.status || 'todo';
  const parts = [
    `<div class="co-tag" style="color:var(--${esc(status)})">${STATUS_LABEL[status] || esc(status)}</div>`,
    `<h2 class="co-title">${esc(node.title)}</h2>`,
  ];
  if (node.sub) parts.push(`<p class="co-sub">${esc(node.sub)}</p>`);
  if (d.in && d.in.length) parts.push(block('Takes in', `<ul class="io">${d.in.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`));
  if (d.out && d.out.length) parts.push(block('Produces', `<ul class="io out">${d.out.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`));
  if (d.note) parts.push(block('Where it stands', `<p class="co-note">${esc(d.note)}</p>`));
  if (d.open && d.open.length) parts.push(block('Open questions', `<ul class="co-qs">${d.open.map((q, i) => wfQuestionItem(sheetId, q, i)).join('')}</ul>`));
  if (node.board) parts.push(`<button class="co-enter" type="button">⤢ Zoom into this chart</button>`);
  if (node.algorithm) parts.push(`<a class="co-algo" href="${esc(withProject(`algorithms.html#${node.algorithm}`, PROJECT))}"><span class="play">▶</span> Watch the algorithm storyboard</a>`);
  $('callout-body').innerHTML = parts.join('');
  if (d.open && d.open.length && sheetId) wireWfDecisions(sheetId, d.open);
  const enter = $('callout-body').querySelector('.co-enter');
  if (enter) enter.addEventListener('click', () => canvas.zoomToNode(node));
}

// edit form: mutate the node in place, repaint the canvas, schedule a save
function renderNodeEditor(node, board) {
  node.detail = node.detail || {};
  const d = node.detail;
  const openSnapshot = [...(d.open || [])];   // to detect a question RENAME and carry its decision
  const seg = STATUSES.map((s) => `<button type="button" class="seg ${node.status === s ? 'on' : ''}" data-st="${s}">${STATUS_LABEL[s]}</button>`).join('');
  $('callout-body').innerHTML = `
    <div class="co-tag">EDIT NODE</div>
    <div class="ed">
      <label class="ed-l">Title</label>
      <input class="ed-in" id="ed-title" value="${esc(node.title || '')}" />
      <label class="ed-l">Subtitle</label>
      <input class="ed-in" id="ed-sub" value="${esc(node.sub || '')}" />
      <label class="ed-l">Status</label>
      <div class="seg-row" id="ed-status">${seg}</div>
      <label class="ed-l">Note</label>
      <textarea class="ed-ta" id="ed-note" rows="3">${esc(d.note || '')}</textarea>
      <label class="ed-l">Takes in <i>(one per line)</i></label>
      <textarea class="ed-ta" id="ed-in" rows="2">${esc((d.in || []).join('\n'))}</textarea>
      <label class="ed-l">Produces <i>(one per line)</i></label>
      <textarea class="ed-ta" id="ed-out" rows="2">${esc((d.out || []).join('\n'))}</textarea>
      <label class="ed-l">Open questions <i>(one per line)</i></label>
      <textarea class="ed-ta" id="ed-open" rows="2">${esc((d.open || []).join('\n'))}</textarea>
      <label class="ed-l">Algorithm storyboard id <i>(optional)</i></label>
      <input class="ed-in" id="ed-algo" value="${esc(node.algorithm || '')}" />
      <div class="ed-row">
        <span><label class="ed-l">Width</label><input class="ed-num" id="ed-w" type="number" min="80" value="${node.w || 240}" /></span>
        <span><label class="ed-l">Height</label><input class="ed-num" id="ed-h" type="number" min="48" value="${node.h || 96}" /></span>
      </div>
      <div class="ed-actions">
        <button type="button" class="ed-btn" id="ed-sub-chart">${node.board ? '⤢ Enter chart inside' : '＋ Add chart inside'}</button>
        <button type="button" class="ed-btn danger" id="ed-del">🗑 Delete node</button>
      </div>
    </div>`;
  const b = $('callout-body');
  const save = () => { scheduleSave(current.id); canvas.refresh(); };
  const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
  b.querySelector('#ed-title').addEventListener('input', (e) => { node.title = e.target.value; save(); });
  b.querySelector('#ed-sub').addEventListener('input', (e) => { node.sub = e.target.value || undefined; save(); });
  b.querySelector('#ed-note').addEventListener('input', (e) => { d.note = e.target.value || undefined; save(); });
  b.querySelector('#ed-in').addEventListener('input', (e) => { d.in = lines(e.target.value); save(); });
  b.querySelector('#ed-out').addEventListener('input', (e) => { d.out = lines(e.target.value); save(); });
  const openEl = b.querySelector('#ed-open');
  openEl.addEventListener('input', (e) => { d.open = lines(e.target.value); save(); });
  openEl.addEventListener('change', () => {
    // On blur, if exactly one question was renamed (one removed + one added), carry any
    // recorded decision across to the new wording — decisions key on exact text, so a
    // rename would otherwise silently orphan the answer and re-show the question as open.
    const cur = d.open || [];
    const removed = openSnapshot.filter((q) => !cur.includes(q));
    const added = cur.filter((q) => !openSnapshot.includes(q));
    if (removed.length === 1 && added.length === 1) {
      const dec = wfDecisions(current.id)[removed[0]];
      if (dec) { wfDecide(current.id, added[0], dec.answer, dec.by); wfReopen(current.id, removed[0]); }
    }
    openSnapshot.length = 0; openSnapshot.push(...cur);
  });
  b.querySelector('#ed-algo').addEventListener('input', (e) => { node.algorithm = e.target.value.trim() || undefined; save(); });
  b.querySelector('#ed-w').addEventListener('input', (e) => { node.w = Math.max(80, +e.target.value || 240); save(); });
  b.querySelector('#ed-h').addEventListener('input', (e) => { node.h = Math.max(48, +e.target.value || 96); save(); });
  b.querySelectorAll('#ed-status .seg').forEach((btn) => btn.addEventListener('click', () => {
    node.status = btn.dataset.st;
    b.querySelectorAll('#ed-status .seg').forEach((x) => x.classList.toggle('on', x === btn));
    save();
  }));
  b.querySelector('#ed-sub-chart').addEventListener('click', () => canvas.addSubchart());
  b.querySelector('#ed-del').addEventListener('click', () => { canvas.deleteSelected(); closeCallout(); });
}

function openEdgeInspector(sel) {
  const e = sel.edge;
  const kinds = ['flow', 'loop', 'dep'];
  const body = editing
    ? `<div class="co-tag">EDIT EDGE</div>
       <h2 class="co-title">${esc(e.from)} → ${esc(e.to)}</h2>
       <label class="ed-l">Kind</label>
       <div class="seg-row" id="ed-kind">${kinds.map((k) => `<button type="button" class="seg ${(e.kind || 'flow') === k ? 'on' : ''}" data-k="${k}">${k}</button>`).join('')}</div>
       <label class="ed-l">Label</label>
       <input class="ed-in" id="ed-elabel" value="${esc(e.label || '')}" />
       <div class="ed-actions"><button type="button" class="ed-btn danger" id="ed-edel">🗑 Delete edge</button></div>`
    : `<div class="co-tag">CONNECTION</div><h2 class="co-title">${esc(e.from)} → ${esc(e.to)}</h2>
       <p class="co-sub">${esc(e.kind || 'flow')}${e.label ? ' · ' + esc(e.label) : ''}</p>`;
  $('callout-body').innerHTML = body;
  callout.classList.add('open'); callout.setAttribute('aria-hidden', 'false'); scrim.classList.add('open'); frame.classList.add('callout-open');
  if (!editing) return;
  const b = $('callout-body');
  const save = () => { scheduleSave(current.id); canvas.refresh(); };
  b.querySelectorAll('#ed-kind .seg').forEach((btn) => btn.addEventListener('click', () => { e.kind = btn.dataset.k; b.querySelectorAll('#ed-kind .seg').forEach((x) => x.classList.toggle('on', x === btn)); save(); }));
  b.querySelector('#ed-elabel').addEventListener('input', (ev) => { e.label = ev.target.value || undefined; save(); });
  b.querySelector('#ed-edel').addEventListener('click', () => { canvas.deleteSelected(); closeCallout(); });
}

// one open question: a recorded decision (with reopen), or a form to answer it
function wfQuestionItem(sheetId, q, i) {
  const dec = wfDecisions(sheetId)[q];
  const body = dec
    ? `<div class="decided">
         <div class="decided-head">✓ DECIDED${dec.at ? ` · ${esc(dec.at)}` : ''}${dec.by ? ` · ${esc(dec.by)}` : ''}</div>
         <p class="decided-answer">${esc(dec.answer)}</p>
         <button class="reopen" type="button" data-i="${i}">Reopen</button>
       </div>`
    : `<div class="decision">
         <textarea class="answer" data-i="${i}" rows="2" placeholder="Record the decision that resolves this…"></textarea>
         <div class="decide-row">
           <input class="author" type="text" placeholder="your name" value="${esc(getAuthor())}" />
           <button class="decide" type="button" data-i="${i}">Mark decided</button>
         </div>
       </div>`;
  return `<li class="co-q${dec ? ' is-decided' : ''}"><div class="co-q-text">${esc(q)}</div>${body}</li>`;
}
function wireWfDecisions(sheetId, questions) {
  const body = $('callout-body');
  const rerender = () => { if (canvas) canvas.refresh(); if (lastSel && lastSel.kind === 'node') renderNodeView(lastSel.node); };
  body.querySelectorAll('.decide').forEach((btn) => btn.addEventListener('click', () => {
    const li = btn.closest('.co-q');
    const answer = li.querySelector('.answer').value.trim();
    if (!answer) { li.querySelector('.answer').focus(); return; }
    const by = li.querySelector('.author').value.trim();
    try { if (by) localStorage.setItem(AUTHOR_KEY, by); } catch { /* ignore */ }
    wfDecide(sheetId, questions[+btn.dataset.i], answer, by);
    rerender();
  }));
  body.querySelectorAll('.reopen').forEach((btn) => btn.addEventListener('click', () => {
    wfReopen(sheetId, questions[+btn.dataset.i]);
    rerender();
  }));
}

function closeCallout() {
  callout.classList.remove('open');
  callout.setAttribute('aria-hidden', 'true');
  scrim.classList.remove('open');
  frame.classList.remove('callout-open');
  if (canvas) canvas.clearSelection();
}
function block(h, inner) { return `<div class="co-block"><div class="co-h">${h}</div>${inner}</div>`; }

/* ---------- wiring ---------- */
$('callout-close').addEventListener('click', closeCallout);
scrim.addEventListener('click', closeCallout);
window.addEventListener('popstate', navigateToHash);   // Back/Forward move through the nesting + sheets
window.addEventListener('hashchange', navigateToHash);  // manual hash edits / external deep links

boot();
