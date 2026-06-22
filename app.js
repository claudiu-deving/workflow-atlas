// Workflow maps live in content/workflows.json — authored by the user or by an
// AI over MCP (save_workflows). Fetched at boot so edits show on reload.
import { esc } from './shared/esc.js';
const $ = (id) => document.getElementById(id);
const flow = $('flow');
const indexNav = $('index');
const callout = $('callout');
const scrim = $('scrim');
const STATUS_LABEL = { done: 'done', partial: 'partial', todo: 'to build' };

let SHEETS = [];
let current = null;
let lastCallout = null;   // { st, idx } so answering a question can re-render the panel in place

/* ---------- workflow review (decisions on station open[] questions) ---------- */
let wfReview = { decisions: {} };       // sheetId → { [question text]: { answer, by, at } }
let wfHasServer = false;
const AUTHOR_KEY = 'workflow-atlas.author';
const today = () => new Date().toISOString().slice(0, 10);
const getAuthor = () => { try { return localStorage.getItem(AUTHOR_KEY) || ''; } catch { return ''; } };
const wfDecisions = (sheetId) => (wfReview.decisions && wfReview.decisions[sheetId]) || {};

async function loadWorkflowReview() {
  wfReview = { decisions: {} }; wfHasServer = false;
  try {
    const res = await fetch('/api/workflow-review', { cache: 'no-store' });
    if (res.ok) { wfReview = await res.json(); wfHasServer = true; }
  } catch { /* server not running */ }
  if (!wfHasServer) {
    // static fallback: prefer the committed sidecar; only fall back to the local
    // draft when there is no sidecar, so a committed update never loses to a stale
    // localStorage snapshot.
    let loadedSidecar = false;
    try { const r = await fetch('content/reviews/_workflows.json', { cache: 'no-store' }); if (r.ok) { wfReview = await r.json(); loadedSidecar = true; } } catch { /* no sidecar */ }
    if (!loadedSidecar) {
      try { const d = JSON.parse(localStorage.getItem('workflow-atlas.wfreview') || 'null'); if (d) wfReview = d; } catch { /* ignore */ }
    }
  }
  wfReview.decisions = wfReview.decisions || {};
}
// send ONE decision change so the server can merge it; it can't clobber a decision
// recorded elsewhere since the page loaded. Reconcile local state with the result.
async function persistWfChange(patch) {
  try { localStorage.setItem('workflow-atlas.wfreview', JSON.stringify(wfReview)); } catch { /* ignore */ }
  if (!wfHasServer) return;
  try {
    const res = await fetch('/api/workflow-review', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (res.ok) { const j = await res.json(); if (j && j.saved && j.saved.decisions) wfReview = j.saved; }   // authoritative merged state
  } catch { /* offline — local optimistic state stands */ }
}
function wfDecide(sheetId, question, answer, by) {
  // optimistic local update for an instant re-render, then persist the single change
  wfReview.decisions = wfReview.decisions || {};
  wfReview.decisions[sheetId] = wfReview.decisions[sheetId] || {};
  wfReview.decisions[sheetId][question] = { answer, by: by || 'you', at: today() };
  persistWfChange({ sheet: sheetId, question, decision: { answer, by: by || 'you' } });
}
function wfReopen(sheetId, question) {
  if (wfReview.decisions && wfReview.decisions[sheetId]) delete wfReview.decisions[sheetId][question];
  persistWfChange({ sheet: sheetId, question, decision: null });
}
// unanswered open questions for a station — spine detail AND fan-track detail
function stationOpenCount(st, sheetId) {
  const dec = wfDecisions(sheetId);
  const qs = [...((st.detail && st.detail.open) || [])];
  for (const t of (st.fan && st.fan.tracks) || []) qs.push(...((t.detail && t.detail.open) || []));
  return qs.filter((q) => !dec[q]).length;
}
const badgeHtml = (n) => (n ? ` · <span class="q">${n} open question${n > 1 ? 's' : ''}</span>` : '');
// after a decision changes, refresh every card's open-question badge in place
function refreshBadges() {
  if (!current) return;
  (current.stations || []).forEach((st, idx) => {
    const span = flow.querySelector(`.station[data-idx="${idx}"] .has-detail`);
    if (span) span.innerHTML = `view callout${badgeHtml(stationOpenCount(st, current.id))}`;
  });
}

/* ---------- sheet index (title block) ---------- */
function buildIndex() {
  indexNav.innerHTML = '';
  SHEETS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'idx';
    b.dataset.id = s.id;
    b.innerHTML = `<span class="idx-code">${esc(s.code)}</span><span class="idx-name">${esc(s.name)}</span>`;
    b.addEventListener('click', () => select(i));
    indexNav.appendChild(b);
  });
}

async function boot() {
  try {
    const res = await fetch('content/workflows.json', { cache: 'no-store' });
    if (res.ok) SHEETS = (await res.json()).sheets || [];
  } catch { /* no content */ }
  await loadWorkflowReview();
  buildIndex();
  if (!SHEETS.length) return;
  const start = SHEETS.findIndex((s) => s.id === location.hash.slice(1));
  select(start >= 0 ? start : 0);
}

/* ---------- render a sheet ---------- */
function select(i) {
  const s = SHEETS[i];
  if (!s) return;
  current = s;
  location.hash = s.id;

  [...indexNav.children].forEach((b, j) => b.classList.toggle('active', j === i));

  const tally = countStatus(s);
  $('sh-code').textContent = s.code;
  $('sh-count').textContent = `${tally.total} STEPS · ${tally.done} DONE · ${tally.partial} PARTIAL · ${tally.todo} TO BUILD`;
  $('sh-title').textContent = s.title;
  $('sh-sub').textContent = s.sub;

  flow.classList.remove('anim');
  flow.innerHTML = '';
  closeCallout();

  // overlay for loop-back arcs
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'loops');
  flow.appendChild(svg);

  (s.stations || []).forEach((st, idx) => {
    if (idx > 0) flow.appendChild(linkEl(idx));
    flow.appendChild(stationEl(st, idx));
  });

  // force reflow, then animate in with stagger
  void flow.offsetWidth;
  flow.classList.add('anim');
  [...flow.children].forEach((el, k) => {
    if (el.classList?.contains('loops')) return;
    el.style.animationDelay = `${k * 55}ms`;
  });

  requestAnimationFrame(() => drawLoops(s, svg));
}

function linkEl() {
  const d = document.createElement('div');
  d.className = 'link';
  return d;
}

function stationEl(st, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'station';
  wrap.dataset.status = st.status || 'todo';
  wrap.dataset.idx = idx;

  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.innerHTML = `<div class="node-idx">${String(idx + 1).padStart(2, '0')}</div>`;

  const body = document.createElement('div');

  const card = document.createElement('div');
  card.className = 'card';
  card.tabIndex = 0;
  const openCount = stationOpenCount(st, current && current.id);   // unanswered, incl. fan tracks
  card.innerHTML = `
    <div class="card-top">
      <h3>${esc(st.title)}</h3>
      <span class="chip ${esc(st.status || 'todo')}">${STATUS_LABEL[st.status] || esc(st.status || 'todo')}</span>
    </div>
    ${st.sub ? `<p class="sub">${esc(st.sub)}</p>` : ''}
    ${st.detail ? `<span class="has-detail">view callout${badgeHtml(openCount)}</span>` : ''}
  `;
  if (st.detail) {
    const open = () => openCallout(st, idx);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  } else if (!st.algorithm) {
    card.style.cursor = 'default';
  }
  if (st.algorithm) card.appendChild(algoLink(st.algorithm));
  body.appendChild(card);

  if (st.fan) body.appendChild(fanEl(st.fan));

  wrap.append(marker, body);
  return wrap;
}

function fanEl(fan) {
  const f = document.createElement('div');
  f.className = 'fan';
  const tracks = fan.tracks || [];
  f.innerHTML = `<p class="fan-cap">parallel · ${tracks.length} branches</p>`;
  const rail = document.createElement('div');
  rail.className = 'fan-rail';
  tracks.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'track';
    el.dataset.status = t.status || 'todo';
    el.innerHTML = `<h4>${esc(t.title)}</h4><span class="tstatus">${STATUS_LABEL[t.status] || esc(t.status || 'todo')}</span>`;
    if (t.detail) {
      el.tabIndex = 0;
      const open = () => openCallout({ title: t.title, status: t.status, detail: t.detail }, null);
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    }
    if (t.algorithm) el.appendChild(algoLink(t.algorithm));
    rail.appendChild(el);
  });
  f.appendChild(rail);
  return f;
}

// a link from a workflow step to its algorithm storyboard
function algoLink(id) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'algo-link';
  b.innerHTML = '<span class="play">▶</span> storyboard';
  b.title = `Open the “${id}” algorithm storyboard`;
  b.addEventListener('click', (e) => { e.stopPropagation(); location.href = `algorithms.html#${id}`; });
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); } });
  return b;
}

/* ---------- loop-back arcs (drawn after layout) ---------- */
function drawLoops(s, svg) {
  svg.querySelectorAll('path').forEach((p) => p.remove());
  flow.querySelectorAll('.loop-label').forEach((l) => l.remove());
  const stations = [...flow.querySelectorAll('.station')];
  const fb = flow.getBoundingClientRect();

  (s.stations || []).forEach((st, idx) => {
    if (!st.loop) return;
    // loop.to is a station index, or the title of a target station (survives reorder)
    const target = typeof st.loop.to === 'string'
      ? (s.stations || []).findIndex((x) => x && x.title === st.loop.to)
      : st.loop.to;
    const from = stations[idx];
    const to = stations[target];
    if (!from || !to) return;
    const fr = from.getBoundingClientRect();
    const tr = to.getBoundingClientRect();
    const cardRight = from.querySelector('.card').getBoundingClientRect().right - fb.left;
    const gutter = cardRight + 48;                 // bow clear of the cards
    const xEnter = 55;                             // re-enter near the spine
    const y1 = fr.top - fb.top + fr.height / 2;
    const y2 = tr.top - fb.top + tr.height / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // exit right from the source, bow out through the margin, re-enter the target
    path.setAttribute('d', `M ${cardRight} ${y1} C ${gutter} ${y1}, ${gutter} ${y2}, ${xEnter} ${y2}`);
    svg.appendChild(path);

    const label = document.createElement('div');
    label.className = 'loop-label';
    label.textContent = st.loop.label || 'loop';
    label.style.left = `${gutter}px`;
    label.style.transform = 'translate(-50%, -50%)';
    label.style.top = `${(y1 + y2) / 2}px`;
    flow.appendChild(label);
  });
}

/* ---------- callout panel ---------- */
function openCallout(st, idx) {
  lastCallout = { st, idx };
  const d = st.detail || {};
  const sheetId = current && current.id;
  const status = st.status || 'todo';
  const parts = [`<div class="co-tag" style="color:var(--${esc(status)})">${(idx !== null && idx !== undefined) ? `STEP ${String(idx + 1).padStart(2, '0')} · ` : ''}${STATUS_LABEL[st.status] || esc(status)}</div>`,
    `<h2 class="co-title">${esc(st.title)}</h2>`];
  if (st.sub) parts.push(`<p class="co-sub">${esc(st.sub)}</p>`);

  if (d.in?.length) parts.push(block('Takes in', `<ul class="io">${d.in.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`));
  if (d.out?.length) parts.push(block('Produces', `<ul class="io out">${d.out.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`));
  if (d.note) parts.push(block('Where it stands', `<p class="co-note">${esc(d.note)}</p>`));
  if (d.open?.length) parts.push(block('Open questions', `<ul class="co-qs">${d.open.map((q, i) => wfQuestionItem(sheetId, q, i)).join('')}</ul>`));
  if (st.algorithm) parts.push(`<a class="co-algo" href="algorithms.html#${esc(st.algorithm)}"><span class="play">▶</span> Watch the algorithm storyboard</a>`);

  $('callout-body').innerHTML = parts.join('');
  if (d.open?.length && sheetId) wireWfDecisions(sheetId, d.open);
  callout.classList.add('open');
  callout.setAttribute('aria-hidden', 'false');
  scrim.classList.add('open');
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
  const rerender = () => { refreshBadges(); if (lastCallout) openCallout(lastCallout.st, lastCallout.idx); };
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
}
function block(h, inner) { return `<div class="co-block"><div class="co-h">${h}</div>${inner}</div>`; }

/* ---------- helpers ---------- */
function countStatus(s) {
  const stations = s.stations || [];
  const c = { done: 0, partial: 0, todo: 0, total: stations.length };
  stations.forEach((st) => { const k = st.status || 'todo'; c[k] = (c[k] || 0) + 1; });
  return c;
}

/* ---------- wiring ---------- */
$('callout-close').addEventListener('click', closeCallout);
scrim.addEventListener('click', closeCallout);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCallout(); });
window.addEventListener('resize', () => {
  const svg = flow.querySelector('.loops');
  if (current && svg) drawLoops(current, svg);
});
window.addEventListener('hashchange', () => {
  const i = SHEETS.findIndex((s) => s.id === location.hash.slice(1));
  if (i >= 0 && SHEETS[i] !== current) select(i);
});

boot();
