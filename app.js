// Workflow maps for the active project — an infinite canvas of nested charts.
// This module is the controller: it loads sheets, drives the left index, owns the
// inspector (the right callout — read-only review OR an edit form), and persists
// edits back to the server (debounced) so the in-app editor and the MCP authoring
// tools write one source of truth. The canvas engine itself lives in canvas.js.
import { esc } from './shared/esc.js';
import { migrateSheet } from './shared/migrate.js';
import { createCanvas } from './canvas.js';
import { resolveProjects, apiBase, renderSwitcher, wireSwitchLinks, setTabTitle } from './shared/project.js';

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
const sheetById = (id) => SHEETS.find((s) => s && s.id === id) || null;
// The board a node opens into: its private inline board, else the board of the sheet it
// MOUNTS via boardRef (transclusion). Shared with the canvas so hash paths resolve across sheets.
const childBoardOf = (n) => (n && (n.board || (n.boardRef ? (sheetById(n.boardRef) || {}).board : null))) || null;
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
// Question tally for a node AND all its descendant boards, so a parent badges
// when a chart nested inside it still has questions. Decisions are sheet-global
// (keyed by question text), so any node at any depth resolves against the same map.
function nodeQuestionStats(node) {
  const dec = wfDecisions(current && current.id);
  let open = 0, decided = 0;
  const walk = (n) => {
    if (!n) return;
    if (n.detail && Array.isArray(n.detail.open)) {
      for (const q of n.detail.open) { if (dec[q]) decided++; else open++; }
    }
    if (n.board && Array.isArray(n.board.nodes)) n.board.nodes.forEach(walk);
  };
  walk(node);
  return { open, decided, total: open + decided };
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
    b.className = 'idx' + (s.shared ? ' shared' : '');
    b.dataset.id = s.id;
    b.innerHTML = `<span class="idx-code">${esc(s.code || '')}</span><span class="idx-name">${esc(s.name || s.title || s.id)}${s.shared ? ' <span class="idx-shared" title="shared component">▣</span>' : ''}</span>`;
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
  // Register live-reload FIRST, before anything below can throw. A hot reload that
  // lands on a transiently-broken app file (mid-write, or an inconsistent edit) used
  // to throw in createCanvas — and because this listener was set up *after* that, the
  // tab lost its reload connection and stayed blank until a manual project switch.
  // Wiring it up front means the next save always reloads the tab and self-heals it.
  try {
    new EventSource('/api/livereload?p=' + encodeURIComponent(PROJECT)).onmessage = async () => {
      await flushSaves();   // ensure any pending/in-flight edit lands before the reload aborts it
      location.reload();
    };
  } catch { /* no server */ }
  try {
    const res = await fetch(`${API()}/workflows`, { cache: 'no-store' });
    if (res.ok) SHEETS = ((await res.json()).sheets || []).map(migrateSheet);
  } catch { /* server down */ }
  await loadWorkflowReview();
  buildIndex();
  wireChrome();
  try {
    canvas = createCanvas($('canvas'), {
      resolveSheet: sheetById,        // node.boardRef → the mounted sheet (transclusion)
      onChange: (id) => { scheduleSave(id); refreshHeaderCount(); },
      onSelect: (sel) => { lastSel = sel; if (sel) openInspector(sel); else closeCallout(); },
      questionStats: nodeQuestionStats,
      onNav: (nav, cause) => {       // mirror the nesting position into the URL hash (deep-linkable)
        renderBreadcrumb(nav);
        const mode = cause === 'load' ? pendingSheetHist : (cause === 'user' ? 'push' : 'replace');
        syncHash(nav.path, mode);
      },
      onEditingChange: syncEditUI,   // canvas may auto-enable edit (dbl-click / context-menu add) → keep the UI in sync
    });
    window.__atlasCanvas = canvas;   // handle for power-user debugging / automated checks
    canvas.setEditing(true);         // edit mode is always on (no toggle) → fires onEditingChange → syncEditUI

    if (!SHEETS.length) {
      $('sh-title').textContent = info.projects.length ? 'No workflow maps yet' : 'Start the server';
      $('sh-sub').textContent = info.projects.length
        ? 'Turn on Edit and double-click the canvas to drop a node, or author one over MCP.'
        : 'Run the Atlas server so the assistant can author maps for this project.';
      return;
    }
    navigateToHash();   // open the sheet (and nested focus) the URL points at, else the first sheet
  } catch (err) {
    // A throw here (e.g. a hot reload that landed on a half-written app file) used to
    // leave a silent blank canvas. Live-reload is wired up above, so the next save heals
    // the tab — but show a visible reason + recovery in the meantime instead of nothing.
    showBootError(err);
  }
}

// Visible recovery panel when the canvas fails to initialize, replacing the silent blank.
function showBootError(err) {
  console.error('Workflow Atlas: canvas init failed —', err);   // keep the full stack in the console
  const host = $('canvas');
  if (!host || host.querySelector('.boot-error')) return;
  const panel = document.createElement('div');
  panel.className = 'boot-error';
  panel.innerHTML =
    `<div class="boot-error-card">
       <div class="boot-error-h">⚠ The canvas failed to load</div>
       <p class="boot-error-msg"></p>
       <p class="boot-error-fix">This is usually a hot reload that caught an app file mid-write. It should heal on the next save — or click Reload. If it keeps happening, open the console (F12) for the full stack and check the Atlas server log.</p>
       <button class="boot-error-btn" type="button">Reload</button>
     </div>`;
  panel.querySelector('.boot-error-msg').textContent = (err && err.message) ? err.message : String(err);
  panel.querySelector('.boot-error-btn').addEventListener('click', () => location.reload());
  host.appendChild(panel);
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
  renderMounts(s);
  refreshHeaderCount();
  closeCallout();
  canvas.load(current, { focus: opts.focus });   // hash is written by onNav, not here
}

// "Mounted by" — for a shared component sheet, the cards across other sheets that mount it
// (node.boardRef === this sheet). Derived by scanning SHEETS; each chip deep-links to that card.
function renderMounts(sheet) {
  const host = $('sh-mounts');
  if (!host) return;
  const consumers = [];
  for (const s of SHEETS) {
    const walk = (board, path) => {
      for (const n of (board && board.nodes) || []) {
        if (n.boardRef === sheet.id) consumers.push({ sheet: s.id, path: path.concat(n.id), title: n.title });
        if (n.board) walk(n.board, path.concat(n.id));
      }
    };
    walk(s.board, []);
  }
  if (!sheet.shared && !consumers.length) { host.innerHTML = ''; return; }
  const tag = sheet.shared ? `<span class="mount-flag">▣ shared component${sheet.status ? ' · ' + esc(sheet.status) : ''}</span>` : '';
  const chips = consumers.length
    ? 'Mounted by ' + consumers.map((c) => `<a class="mount-chip" href="${buildHash(c.sheet, c.path)}">${esc(sheetById(c.sheet) ? (sheetById(c.sheet).name || c.sheet) : c.sheet)} › ${esc(c.title)}</a>`).join(' ')
    : (sheet.shared ? '<span class="mount-none">not mounted anywhere yet</span>' : '');
  host.innerHTML = tag + (tag && chips ? ' · ' : '') + chips;
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
  renderNodeEditor(node, sel.board);   // edit mode is always-on → the editor is the only node view
  callout.classList.add('open');
  callout.setAttribute('aria-hidden', 'false');
  scrim.classList.add('open');
  frame.classList.add('callout-open');
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
      <label class="ed-l">Mount shared component <i>(sheet id — transcludes that sheet)</i></label>
      <input class="ed-in" id="ed-ref" value="${esc(node.boardRef || '')}" placeholder="e.g. ai-review" />
      <p class="ed-hint" id="ed-ref-info"></p>
      <div class="ed-row">
        <span><label class="ed-l">Width</label><input class="ed-num" id="ed-w" type="number" min="80" value="${node.w || 240}" /></span>
        <span><label class="ed-l">Height</label><input class="ed-num" id="ed-h" type="number" min="48" value="${node.h || 96}" /></span>
      </div>
      <div class="ed-actions">
        <button type="button" class="ed-btn" id="ed-sub-chart">${node.boardRef ? '↗ Open shared component' : (node.board ? '⤢ Enter chart inside' : '＋ Add chart inside')}</button>
        <button type="button" class="ed-btn danger" id="ed-del">🗑 Delete node</button>
      </div>
    </div>
    <div id="ed-open-answers" class="ed-answers"></div>`;
  const b = $('callout-body');
  const save = () => { scheduleSave(current.id); canvas.refresh(); };
  const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
  // Edit mode is always-on, so this editor is the ONLY inspector view — answering
  // open questions has to live here too, not just in the read-only review view.
  const sheetId = current && current.id;
  const paintAnswers = () => {
    const host = b.querySelector('#ed-open-answers');
    const qs = d.open || [];
    if (!qs.length || !sheetId) { host.innerHTML = ''; return; }
    host.innerHTML = block('Answer open questions',
      `<ul class="co-qs">${qs.map((q, i) => wfQuestionItem(sheetId, q, i)).join('')}</ul>`);
    host.querySelectorAll('.decide').forEach((btn) => btn.addEventListener('click', () => {
      const li = btn.closest('.co-q');
      const answer = li.querySelector('.answer').value.trim();
      if (!answer) { li.querySelector('.answer').focus(); return; }
      const by = li.querySelector('.author').value.trim();
      try { if (by) localStorage.setItem(AUTHOR_KEY, by); } catch { /* ignore */ }
      wfDecide(sheetId, qs[+btn.dataset.i], answer, by);
      canvas.refresh(); paintAnswers();
    }));
    host.querySelectorAll('.reopen').forEach((btn) => btn.addEventListener('click', () => {
      wfReopen(sheetId, qs[+btn.dataset.i]); canvas.refresh(); paintAnswers();
    }));
  };
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
    paintAnswers();   // questions added/removed/renamed → refresh their answer cards
  });
  b.querySelector('#ed-algo').addEventListener('input', (e) => { node.algorithm = e.target.value.trim() || undefined; save(); });
  // Mount a shared component: node.boardRef names another sheet whose board is transcluded
  // here (read-only, its status inherited). Mutually exclusive with a private inner chart.
  const refInfo = b.querySelector('#ed-ref-info');
  const paintRefInfo = () => {
    const ref = node.boardRef;
    if (!ref) { refInfo.textContent = ''; return; }
    const s = sheetById(ref);
    refInfo.innerHTML = s
      ? `▣ mounts <a href="#${encodeURIComponent(ref)}">${esc(s.title || s.name || ref)}</a> · status: ${esc((s.status || '—'))}${s.shared ? '' : ' · ⚠ target sheet not marked shared'}`
      : `▣ mounts <b>${esc(ref)}</b> · ⚠ no such sheet yet`;
  };
  b.querySelector('#ed-ref').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (v && node.board) { e.target.value = node.boardRef || ''; alert('This card already has a private chart inside. Delete that first to mount a shared component instead.'); return; }
    node.boardRef = v || undefined;
    paintRefInfo();
    // re-render the action button label (Add chart ↔ Open shared) to match the new state
    const btn = b.querySelector('#ed-sub-chart');
    if (btn) btn.textContent = node.boardRef ? '↗ Open shared component' : (node.board ? '⤢ Enter chart inside' : '＋ Add chart inside');
    save();
  });
  paintRefInfo();
  b.querySelector('#ed-w').addEventListener('input', (e) => { node.w = Math.max(80, +e.target.value || 240); save(); });
  b.querySelector('#ed-h').addEventListener('input', (e) => { node.h = Math.max(48, +e.target.value || 96); save(); });
  b.querySelectorAll('#ed-status .seg').forEach((btn) => btn.addEventListener('click', () => {
    node.status = btn.dataset.st;
    b.querySelectorAll('#ed-status .seg').forEach((x) => x.classList.toggle('on', x === btn));
    save();
  }));
  b.querySelector('#ed-sub-chart').addEventListener('click', () => {
    if (node.boardRef) { location.hash = buildHash(node.boardRef, []); return; }   // jump to the shared component's own sheet
    canvas.addSubchart();
  });
  b.querySelector('#ed-del').addEventListener('click', () => { canvas.deleteSelected(); closeCallout(); });
  paintAnswers();
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
