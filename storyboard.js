// Algorithm storyboards are JSON specs under content/algorithms/, discovered via
// content/index.json — authored by the user or by an AI over MCP (save_algorithm).
// A spec is rendered straight from explicit `steps`, or driven live by a shared
// `builtin` generator; either way the renderer only ever sees compute(params).
import { GENERATORS } from './shared/generators.js';

let ALGORITHMS = [];     // [{ meta, kind, params, code, compute }]
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

let trace = null;        // active algorithm
let idx = 0;             // current step
let playing = false;
let timer = null;
let params = {};         // live editable params
let comments = {};       // per-step comments (in memory; persisted via server/file)
let decisions = {};      // step → { answer, by, at } resolving an authored open question
let review = { params: {}, comments: {}, decisions: {} };  // baseline overlay loaded from server or sidecar
let hasServer = false;   // is the autosave server reachable?
let saveTimer = null;
const STEP_MS = 1900;
const nav = $('alg-index');

/* ---------- load JSON specs into renderable traces ---------- */
function specToTrace(spec) {
  const meta = {
    id: spec.id, code: spec.tag || '', name: spec.name || spec.id,
    title: spec.title || spec.name || spec.id, sub: spec.sub || '', workflow: spec.workflow,
  };
  let compute;
  if (spec.builtin && GENERATORS[spec.builtin]) {
    const gen = GENERATORS[spec.builtin];
    const data = spec.data || {};
    const questions = spec.questions || [];
    compute = (p) => {
      const frames = gen(p, data) || [];
      questions.forEach((q) => { if (frames[q.step]) frames[q.step].question = q.text; });
      return frames;
    };
  } else {
    const steps = spec.steps || [];
    compute = () => steps;       // explicit, agent-authored frames
  }
  return { meta, kind: spec.kind || 'array', params: spec.params || [], code: spec.code || [], compute };
}

function buildNav() {
  nav.innerHTML = '';
  ALGORITHMS.forEach((a, i) => {
    const b = document.createElement('button');
    b.className = 'idx';
    b.innerHTML = `<span class="idx-code">${a.meta.code}</span><span class="idx-name">${a.meta.name}</span>`;
    b.addEventListener('click', () => loadAlg(i));
    nav.appendChild(b);
  });
}

async function boot() {
  let ids = [];
  try {
    const res = await fetch('content/index.json', { cache: 'no-store' });
    if (res.ok) ids = (await res.json()).algorithms || [];
  } catch { /* no content manifest */ }
  const specs = await Promise.all(ids.map(async (id) => {
    try {
      const r = await fetch(`content/algorithms/${id}.json`, { cache: 'no-store' });
      return r.ok ? specToTrace(await r.json()) : null;
    } catch { return null; }
  }));
  ALGORITHMS = specs.filter(Boolean);
  buildNav();
  if (!ALGORITHMS.length) {
    status('No algorithms yet. Author one over MCP with save_algorithm, then reload.');
    return;
  }
  const start = ALGORITHMS.findIndex((a) => a.meta.id === location.hash.slice(1));
  loadAlg(start >= 0 ? start : 0);
}

async function loadAlg(i) {
  trace = ALGORITHMS[i];
  if (location.hash.slice(1) !== trace.meta.id) location.hash = trace.meta.id;
  [...nav.children].forEach((b, j) => b.classList.toggle('active', j === i));
  $('alg-eyebrow-code').textContent = trace.meta.code;
  $('alg-title').textContent = trace.meta.title;
  $('alg-sub').textContent = trace.meta.sub;

  // back-link to the workflow step this algorithm sits behind
  const back = $('alg-backlink');
  if (trace.meta.workflow) {
    back.hidden = false;
    back.textContent = `◂ ${trace.meta.workflow.label}`;
    back.href = `index.html#${trace.meta.workflow.sheet}`;
  } else { back.hidden = true; }

  await loadReview();
  loadParams();
  buildParamBar();
  buildCode();
  buildScrubber();
  idx = 0;
  render();
  status(hasServer
    ? 'Connected to the local server — tolerances & comments autosave to the repo, and Claude can read them over MCP.'
    : 'No server: edits stay in this browser. Run "npm start" (node server/server.mjs) to autosave to the repo.');
}

// baseline overlay (tuned params + comments) — from the server, or the static
// sidecar file as a fallback when the server isn't running.
async function loadReview() {
  review = { params: {}, comments: {}, decisions: {} };
  hasServer = false;
  const take = (j) => { review.params = j.params || {}; review.comments = j.comments || {}; review.decisions = j.decisions || {}; };
  try {
    const res = await fetch(`/api/review/${trace.meta.id}`, { cache: 'no-store' });
    if (res.ok) { take(await res.json()); hasServer = true; }
  } catch { /* server not running */ }
  if (!hasServer) {
    try {
      const res = await fetch(`content/reviews/${trace.meta.id}.json`, { cache: 'no-store' });
      if (res.ok) take(await res.json());
    } catch { /* no sidecar yet */ }
    // local draft fallback when there's no server to write to
    try { const d = JSON.parse(localStorage.getItem(overlayKey()) || 'null'); if (d) review = { params: d.params || {}, comments: d.comments || {}, decisions: d.decisions || {} }; }
    catch { /* ignore */ }
  }
  comments = { ...review.comments };
  decisions = { ...review.decisions };
}

const overlayKey = () => `workflow-atlas.overlay.${trace.meta.id}`;
function buildOverlay() {
  const p = {}; for (const k of trace.params.map((x) => x.key)) p[k] = params[k];
  const c = {}; for (const k in comments) if (comments[k] && String(comments[k]).trim()) c[k] = String(comments[k]).trim();
  return { $schema: 'storyboard-review', algorithm: trace.meta.id, params: p, comments: c, decisions: { ...decisions } };
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 450); status('saving…'); }
async function persist() {
  const overlay = buildOverlay();
  try { localStorage.setItem(overlayKey(), JSON.stringify(overlay)); } catch { /* ignore */ }
  if (hasServer) {
    try {
      const res = await fetch(`/api/review/${trace.meta.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overlay),
      });
      status(res.ok ? 'Saved to the repo ✓ — Claude can read it via MCP.' : 'Save failed — is the server up?');
    } catch { status('Save failed — server unreachable. Edits kept in this browser.'); }
  } else {
    status('Saved in this browser. Run the server ("npm start") to write the repo.');
  }
}

/* ---------- editable params ---------- */
function loadParams() {
  params = {};
  for (const p of trace.params) params[p.key] = p.value;     // defaults
  for (const k in review.params) if (k in params) params[k] = review.params[k];  // baseline overlay
}

function buildParamBar() {
  const bar = $('alg-params');
  bar.innerHTML = '';
  for (const p of trace.params) {
    const wrap = document.createElement('label');
    wrap.className = 'param'; wrap.title = p.hint;
    const isToggle = p.min === 0 && p.max === 1 && p.step === 1;
    const labelHtml = `<span class="p-label">${p.label}</span>${p.sym ? `<span class="p-sym">${p.sym}</span>` : ''}`;
    if (isToggle) {
      wrap.innerHTML = labelHtml;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'p-toggle';
      const sync = () => { btn.classList.toggle('on', !!params[p.key]); btn.textContent = params[p.key] ? 'on' : 'off'; };
      sync();
      btn.addEventListener('click', () => { params[p.key] = params[p.key] ? 0 : 1; sync(); scheduleSave(); render(); });
      wrap.appendChild(btn);
    } else {
      wrap.innerHTML = labelHtml;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.value = params[p.key];
      inp.min = p.min; inp.max = p.max; inp.step = p.step; inp.className = 'p-input';
      inp.addEventListener('input', () => {
        let v = parseFloat(inp.value); if (Number.isNaN(v)) return;
        v = Math.max(p.min, Math.min(p.max, v));
        params[p.key] = v; scheduleSave(); render();
      });
      const unit = document.createElement('span'); unit.className = 'p-unit'; unit.textContent = p.unit;
      wrap.append(inp, unit);
    }
    bar.appendChild(wrap);
  }
  const reset = document.createElement('button');
  reset.className = 'p-reset'; reset.type = 'button'; reset.textContent = 'reset';
  reset.title = 'Restore default tolerances';
  reset.addEventListener('click', () => {
    for (const p of trace.params) params[p.key] = p.value;
    scheduleSave(); buildParamBar(); render();
  });
  bar.appendChild(reset);
}

/* ---------- step model — every trace exposes compute(params) → rows/frames ---------- */
const isCalc = () => trace.kind === 'calc';
function rows() { return trace.compute(params) || []; }
function stepCount() { return rows().length; }
function currentStep() { const r = rows(); return r[Math.min(idx, r.length - 1)]; }

/* ---------- render ---------- */
function render() {
  if (isCalc()) return renderCalc();
  return renderArray();
}

// shared chrome: narration, verdict, code highlight, counter, transport, panes
function renderChrome(cur, rowCount) {
  $('alg-note').textContent = cur.note || '';
  const vEl = $('alg-verdict');
  if (cur.verdict && cur.verdict.text) {
    const ok = cur.verdict.ok;
    const mark = ok === true ? '✓ ' : ok === false ? '✗ ' : '';
    vEl.textContent = mark + cur.verdict.text;
    vEl.className = 'verdict ' + (ok === false ? 'bad' : ok === true ? 'ok' : '');
  } else { vEl.textContent = ''; vEl.className = 'verdict'; }

  highlightCode(cur.line != null ? (Array.isArray(cur.line) ? cur.line : [cur.line]) : []);
  $('alg-counter').textContent = `${String(idx + 1).padStart(2, '0')} / ${String(rowCount).padStart(2, '0')}`;
  [...$('alg-scrub').children].forEach((d, j) => d.classList.toggle('on', j <= idx));
  $('alg-play').textContent = playing ? '❚❚' : '▶';
  syncComment();
  syncQuestion();
}

/* ---------- array stage: a row of value cells, coloured by per-step state ---------- */
function renderArray() {
  const frames = rows();
  if (idx > frames.length - 1) idx = frames.length - 1;
  const f = frames[idx] || {};
  renderChrome(f, frames.length);

  const stage = $('alg-stage');
  stage.innerHTML = '';
  const cells = document.createElement('div');
  cells.className = 'cells';

  const arr = f.array || [];
  const max = Math.max(1, ...arr.map((v) => Math.abs(Number(v)) || 0));
  const ptrAt = {};
  if (f.ptr) for (const lbl in f.ptr) {
    const i = f.ptr[lbl];
    if (i == null || i < 0) continue;
    (ptrAt[i] ||= []).push(lbl);
  }

  arr.forEach((v, i) => {
    const cell = document.createElement('div');
    cell.className = `cell ${(f.cls && f.cls[i]) || 'idle'}`;
    cell.style.setProperty('--h', Math.round((Math.abs(Number(v)) || 0) / max * 100));
    cell.innerHTML =
      `<div class="cell-bar"><span class="cell-val">${esc(String(v))}</span></div>` +
      `<div class="cell-ptr">${ptrAt[i] ? esc(ptrAt[i].join(' ')) : ''}</div>`;
    cells.appendChild(cell);
  });
  stage.appendChild(cells);
}

/* ---------- calc stage: a live worksheet, one revealed row per step ---------- */
function renderCalc() {
  const r = rows();
  if (idx > r.length - 1) idx = r.length - 1;
  const cur = r[idx] || {};
  renderChrome(cur, r.length);

  // verdict: the running summary on the last row, else this row's result
  const vEl = $('alg-verdict');
  if (!cur.verdict) {
    if (idx === r.length - 1 && trace.summary) {
      vEl.textContent = trace.summary(params); vEl.className = 'verdict ok';
    } else if (cur.result != null) {
      vEl.textContent = `${cur.label} = ${cur.result}${cur.unit ? ` ${cur.unit}` : ''}`;
      vEl.className = 'verdict ' + (cur.bad ? 'bad' : 'ok');
    }
  }

  const stage = $('alg-stage');
  stage.innerHTML = '';
  const sheet = document.createElement('div');
  sheet.className = 'worksheet';
  r.forEach((row, j) => {
    if (j > idx) return;                       // reveal progressively
    const el = document.createElement('div');
    el.className = `wrow${j === idx ? ' cur' : ''}${row.kind ? ` ${row.kind}` : ''}${row.bad ? ' bad' : ''}`;
    el.innerHTML = `
      <div class="wrow-head">
        <span class="wrow-label">${esc(row.label)}</span>
        ${row.result != null ? `<span class="wrow-res">${esc(String(row.result))}${row.unit ? ` <i>${esc(row.unit)}</i>` : ''}</span>` : ''}
      </div>
      ${row.expr ? `<div class="wrow-expr">${esc(row.expr)}</div>` : ''}
      ${row.sub ? `<div class="wrow-sub">${esc(row.sub)}</div>` : ''}`;
    sheet.appendChild(el);
  });
  stage.appendChild(sheet);
}

/* ---------- pseudocode pane ---------- */
function buildCode() {
  const pane = $('alg-code');
  pane.innerHTML = '';
  trace.code.forEach((ln, i) => {
    const row = document.createElement('div');
    row.className = 'code-line'; row.dataset.i = i;
    row.innerHTML = `<span class="ln">${String(i).padStart(2, '0')}</span><code>${esc(ln)}</code>`;
    pane.appendChild(row);
  });
}
function highlightCode(lines) {
  const set = new Set(lines);
  [...$('alg-code').children].forEach((r) => r.classList.toggle('hot', set.has(+r.dataset.i)));
}

/* ---------- comments (persisted per step) ---------- */
function getComment(i) { return comments[i] || ''; }
function syncComment() {
  const box = $('alg-comment');
  box.value = getComment(idx);
  $('alg-comment-step').textContent = `step ${String(idx + 1).padStart(2, '0')}`;
}
function onComment() {
  const v = $('alg-comment').value;
  if (v.trim()) comments[idx] = v; else delete comments[idx];
  markCommentedTicks();
  scheduleSave();
}
function markCommentedTicks() {
  [...$('alg-scrub').children].forEach((d, j) => d.classList.toggle('noted', !!getComment(j)));
}

/* ---------- open questions & decisions (persisted per step) ---------- */
const authorKey = 'workflow-atlas.author';
const getAuthor = () => { try { return localStorage.getItem(authorKey) || ''; } catch { return ''; } };

function syncQuestion() {
  const pane = $('alg-question-pane');
  const q = currentStep()?.question;
  if (!q) { pane.hidden = true; return; }
  pane.hidden = false;
  $('alg-question-step').textContent = `step ${String(idx + 1).padStart(2, '0')}`;
  $('alg-question-text').textContent = q;
  renderDecision();
}
function renderDecision() {
  const host = $('alg-decision');
  const d = decisions[idx];
  if (d) {
    host.innerHTML = `
      <div class="decided">
        <div class="decided-head">✓ DECIDED${d.at ? ` · ${esc(d.at)}` : ''}${d.by ? ` · ${esc(d.by)}` : ''}</div>
        <p class="decided-answer">${esc(d.answer)}</p>
        <button class="reopen" type="button">Reopen</button>
      </div>`;
    host.querySelector('.reopen').addEventListener('click', reopen);
  } else {
    host.innerHTML = `
      <textarea class="answer" rows="2" placeholder="Record the decision that resolves this…"></textarea>
      <div class="decide-row">
        <input class="author" type="text" placeholder="your name" value="${esc(getAuthor())}" />
        <button class="decide" type="button">Mark decided</button>
      </div>`;
    host.querySelector('.decide').addEventListener('click', decide);
  }
}
function decide() {
  const answer = $('alg-decision').querySelector('.answer').value.trim();
  if (!answer) { $('alg-decision').querySelector('.answer').focus(); return; }
  const by = $('alg-decision').querySelector('.author').value.trim();
  try { if (by) localStorage.setItem(authorKey, by); } catch { /* ignore */ }
  decisions[idx] = { answer, by: by || 'you', at: today() };
  renderDecision(); markQuestionTicks(); scheduleSave();
}
function reopen() {
  delete decisions[idx];
  renderDecision(); markQuestionTicks(); scheduleSave();
}
function today() { return new Date().toISOString().slice(0, 10); }
function markQuestionTicks() {
  const steps = rows();
  [...$('alg-scrub').children].forEach((d, j) => {
    const has = !!steps[j]?.question;
    d.classList.toggle('asking', has && !decisions[j]);   // open question
    d.classList.toggle('decided', has && !!decisions[j]); // resolved
  });
}

/* ---------- scrubber + transport ---------- */
function buildScrubber() {
  const sc = $('alg-scrub'); sc.innerHTML = '';
  for (let i = 0; i < stepCount(); i++) {
    const d = document.createElement('button');
    d.className = 'tick'; d.title = `step ${i + 1}`;
    d.addEventListener('click', () => { pause(); idx = i; render(); });
    sc.appendChild(d);
  }
  markCommentedTicks();
  markQuestionTicks();
}
function step(n) { idx = Math.max(0, Math.min(stepCount() - 1, idx + n)); render(); }
function play() {
  if (idx >= stepCount() - 1) idx = -1;
  playing = true;
  clearInterval(timer);
  timer = setInterval(() => {
    if (idx >= stepCount() - 1) { pause(); return; }
    idx++; render();
  }, STEP_MS);
  render();
}
function pause() { playing = false; clearInterval(timer); render(); }
function toggle() { playing ? pause() : play(); }

function esc(s) { return String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }

function status(msg) { const el = $('alg-status'); if (el) el.textContent = msg; }

/* ---------- wiring ---------- */
$('alg-prev').addEventListener('click', () => { pause(); step(-1); });
$('alg-next').addEventListener('click', () => { pause(); step(1); });
$('alg-play').addEventListener('click', toggle);
$('alg-restart').addEventListener('click', () => { pause(); idx = 0; render(); });
$('alg-comment').addEventListener('input', onComment);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;  // don't hijack typing
  if (e.key === 'ArrowRight') { pause(); step(1); }
  else if (e.key === 'ArrowLeft') { pause(); step(-1); }
  else if (e.key === ' ') { e.preventDefault(); toggle(); }
});
window.addEventListener('hashchange', () => {
  const i = ALGORITHMS.findIndex((a) => a.meta.id === location.hash.slice(1));
  if (i >= 0 && ALGORITHMS[i] !== trace) loadAlg(i);
});

// discover and load the storyboards, then open the one named in the URL hash
boot();
