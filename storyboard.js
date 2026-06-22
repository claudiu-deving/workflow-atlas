import * as collinear from './traces/collinear-run.js';
import * as continuity from './traces/continuity-check.js';
import * as build1d from './traces/build-1d-model.js';
import * as analysis from './traces/beam-analysis.js';
import * as flexural from './traces/flexural-design.js';
import * as shear from './traces/shear-design.js';
import * as bbs from './traces/bbs-generation.js';

// order roughly follows the workflow: select & isolate → analyse → design → schedule
const ALGORITHMS = [collinear, continuity, build1d, analysis, flexural, shear, bbs];
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

let trace = null;        // active algorithm module
let idx = 0;             // current step
let playing = false;
let timer = null;
let params = {};         // live editable tolerances
let comments = {};       // per-step comments (in memory; persisted via server/file)
let decisions = {};      // step → { answer, by, at } resolving an authored open question
let review = { params: {}, comments: {}, decisions: {} };  // baseline overlay loaded from server or sidecar
let hasServer = false;   // is the autosave server reachable?
let saveTimer = null;
const STEP_MS = 1900;

/* ---------- index (title block) ---------- */
const nav = $('alg-index');
ALGORITHMS.forEach((a, i) => {
  const b = document.createElement('button');
  b.className = 'idx';
  b.innerHTML = `<span class="idx-code">${a.meta.code}</span><span class="idx-name">${a.meta.name}</span>`;
  b.addEventListener('click', () => loadAlg(i));
  nav.appendChild(b);
});

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
      const res = await fetch(`traces/${trace.meta.id}.review.json`, { cache: 'no-store' });
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

/* ---------- the predicate, evaluated live ---------- */
function evaluate(m) {
  if (m.gap > params.eps_pos) return { ok: false, reason: 'gap', line: 5,
    clause: `joint gap ${m.gap} mm > max ${params.eps_pos} mm — doesn’t touch` };
  if (m.angle > params.eps_ang) return { ok: false, reason: 'angle', line: 6,
    clause: `off-axis angle ${m.angle}° > max ${params.eps_ang}° — not parallel` };
  if (m.perp != null && m.perp > params.eps_perp) return { ok: false, reason: 'kink', line: 7,
    clause: `lateral offset ${m.perp} mm > max ${params.eps_perp} mm — kink` };
  if (params.require_section && m.section === false) return { ok: false, reason: 'section', line: 8,
    clause: `cross-section changes — run must keep one section` };
  return { ok: true, reason: 'accept', line: 10,
    clause: `gap ${m.gap} mm ≤ ${params.eps_pos}, angle ${m.angle}° ≤ ${params.eps_ang}° — accept` };
}

/* ---------- replay state up to step n (with current params) ---------- */
function stateAt(n) {
  const s = { seed: null, side: 'right', frontier: null, test: null, runL: [], runR: [],
    rejected: new Set(), done: false };
  for (let k = 0; k <= n; k++) {
    const st = trace.steps[k];
    switch (st.act) {
      case 'seed': s.seed = st.beam; break;
      case 'frontier': case 'switchEnd': s.side = st.side; s.frontier = { at: st.at, dir: st.dir }; s.test = null; break;
      case 'test': {
        s.frontier = { at: st.at, dir: st.dir };
        const v = evaluate(st.m);
        if (k === n) s.test = { st, v };
        if (v.ok) {
          (s.side === 'left' ? s.runL : s.runR).push(st.cand);
          if (st.advance) s.frontier = st.advance;
        } else {
          s.rejected.add(st.cand);
        }
        break;
      }
      case 'done': s.done = true; s.test = null; break;
    }
  }
  return s;
}
function runOrder(s) { return [...[...s.runL].reverse(), s.seed, ...s.runR]; }
function isAccepted(s, id) { return id === s.seed || s.runL.includes(id) || s.runR.includes(id); }

/* ---------- geometry helpers ---------- */
const sx = (p) => p[0];
const sy = (p) => -p[1];               // flip Z so +Z reads as "up"
function bounds() {
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (const bm of trace.scene.beams) for (const p of [bm.a, bm.b]) {
    mnx = Math.min(mnx, sx(p)); mxx = Math.max(mxx, sx(p));
    mny = Math.min(mny, sy(p)); mxy = Math.max(mxy, sy(p));
  }
  return { mnx, mny, mxx, mxy };
}
const near = (bm, p) => (dist(bm.a, p) < dist(bm.b, p) ? bm.a : bm.b);
const far = (bm, p) => (dist(bm.a, p) < dist(bm.b, p) ? bm.b : bm.a);
function dist(a, b) { return Math.hypot(sx(a) - sx(b), sy(a) - sy(b)); }
const byId = (id) => trace.scene.beams.find((b) => b.id === id);

/* ---------- step model (beam: authored steps; calc: computed rows) ---------- */
const isCalc = () => trace.kind === 'calc';
function calcRows() { return trace.compute(params) || []; }
function stepCount() { return isCalc() ? calcRows().length : trace.steps.length; }
function currentStep() { return isCalc() ? calcRows()[idx] : trace.steps[idx]; }

/* ---------- render ---------- */
function render() {
  if (isCalc()) return renderCalc();
  const s = stateAt(idx);
  const step = trace.steps[idx];

  // narration + verdict + code + counter
  $('alg-note').textContent = step.note;
  const vEl = $('alg-verdict');
  if (s.test) {
    vEl.textContent = (s.test.v.ok ? '✓ ' : '✗ ') + s.test.v.clause;
    vEl.className = 'verdict ' + (s.test.v.ok ? 'ok' : 'bad');
  } else if (s.done) {
    // a 'done' step may author its own summary; default to the accumulated run
    vEl.textContent = step.summary || ('→ run: ' + runOrder(s).join(' – '));
    vEl.className = 'verdict ' + (step.bad ? 'bad' : 'ok');
  } else { vEl.textContent = ''; vEl.className = 'verdict'; }

  highlightCode(s.test ? [s.test.v.line] : (step.code || []));
  $('alg-counter').textContent = `${String(idx + 1).padStart(2, '0')} / ${String(stepCount()).padStart(2, '0')}`;
  [...$('alg-scrub').children].forEach((d, j) => d.classList.toggle('on', j <= idx));
  $('alg-play').textContent = playing ? '❚❚' : '▶';
  syncComment();
  syncQuestion();

  // svg stage
  const stage = $('alg-stage');
  stage.innerHTML = '';
  const b = bounds(), pad = 2.2;
  const vb = [b.mnx - pad, b.mny - pad, (b.mxx - b.mnx) + pad * 2, (b.mxy - b.mny) + pad * 2];
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', vb.join(' '));
  svg.setAttribute('class', `stage-svg ${s.done ? 'is-done' : ''}`);

  for (const bm of trace.scene.beams) {
    let cls = 'idle';
    if (isAccepted(s, bm.id)) cls = 'accepted';
    if (s.rejected.has(bm.id)) cls = 'rejected';
    if (s.test && s.test.st.cand === bm.id) cls = s.test.v.ok ? 'testing ok' : 'testing bad';
    if (bm.id === s.seed) cls += ' seed';

    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', sx(bm.a)); line.setAttribute('y1', sy(bm.a));
    line.setAttribute('x2', sx(bm.b)); line.setAttribute('y2', sy(bm.b));
    line.setAttribute('class', `bm ${cls}`);
    svg.appendChild(line);

    for (const p of [bm.a, bm.b]) {
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', sx(p)); dot.setAttribute('cy', sy(p)); dot.setAttribute('r', 0.12);
      dot.setAttribute('class', `joint ${cls.split(' ')[0]}`);
      svg.appendChild(dot);
    }
    const mid = [(sx(bm.a) + sx(bm.b)) / 2, (sy(bm.a) + sy(bm.b)) / 2];
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', mid[0]); t.setAttribute('y', mid[1] - 0.35);
    t.setAttribute('class', `bm-id ${cls.split(' ')[0]}`); t.textContent = bm.id;
    svg.appendChild(t);
  }

  if (s.frontier && !s.done) {
    const f = document.createElementNS(SVGNS, 'circle');
    f.setAttribute('cx', sx(s.frontier.at)); f.setAttribute('cy', sy(s.frontier.at));
    f.setAttribute('r', 0.42); f.setAttribute('class', 'frontier');
    svg.appendChild(f);
  }
  if (s.test) drawTest(svg, s.test.st, s.test.v);

  stage.appendChild(svg);
}

/* ---------- calc stage: a live EC2-style worksheet ---------- */
function renderCalc() {
  const rows = calcRows();
  if (idx > rows.length - 1) idx = rows.length - 1;
  const cur = rows[idx] || {};

  $('alg-note').textContent = cur.note || '';
  const vEl = $('alg-verdict');
  if (idx === rows.length - 1 && trace.summary) {
    vEl.textContent = trace.summary(params); vEl.className = 'verdict ok';
  } else if (cur.result != null) {
    vEl.textContent = `${cur.label} = ${cur.result}${cur.unit ? ` ${cur.unit}` : ''}`;
    vEl.className = 'verdict ' + (cur.bad ? 'bad' : 'ok');
  } else { vEl.textContent = ''; vEl.className = 'verdict'; }

  highlightCode(cur.line != null ? (Array.isArray(cur.line) ? cur.line : [cur.line]) : []);
  $('alg-counter').textContent = `${String(idx + 1).padStart(2, '0')} / ${String(rows.length).padStart(2, '0')}`;
  [...$('alg-scrub').children].forEach((d, j) => d.classList.toggle('on', j <= idx));
  $('alg-play').textContent = playing ? '❚❚' : '▶';
  syncComment();
  syncQuestion();

  const stage = $('alg-stage');
  stage.innerHTML = '';
  const sheet = document.createElement('div');
  sheet.className = 'worksheet';
  rows.forEach((r, j) => {
    if (j > idx) return;                       // reveal progressively
    const row = document.createElement('div');
    row.className = `wrow${j === idx ? ' cur' : ''}${r.kind ? ` ${r.kind}` : ''}${r.bad ? ' bad' : ''}`;
    row.innerHTML = `
      <div class="wrow-head">
        <span class="wrow-label">${esc(r.label)}</span>
        ${r.result != null ? `<span class="wrow-res">${esc(String(r.result))}${r.unit ? ` <i>${esc(r.unit)}</i>` : ''}</span>` : ''}
      </div>
      ${r.expr ? `<div class="wrow-expr">${esc(r.expr)}</div>` : ''}
      ${r.sub ? `<div class="wrow-sub">${esc(r.sub)}</div>` : ''}`;
    sheet.appendChild(row);
  });
  stage.appendChild(sheet);
}

function drawTest(svg, st, v) {
  const cand = byId(st.cand);
  const P = st.at;
  const cDir = norm([sx(far(cand, P)) - sx(P), sy(far(cand, P)) - sy(P)]);
  const fDir = norm([st.dir[0], -st.dir[1]]);
  const a0 = Math.atan2(fDir[1], fDir[0]);
  const a1 = Math.atan2(cDir[1], cDir[0]);
  const R = 1.15;

  const arc = document.createElementNS(SVGNS, 'path');
  arc.setAttribute('d', arcPath(P, R, a0, a1));
  arc.setAttribute('class', `arc ${v.ok ? 'ok' : 'bad'}`);
  svg.appendChild(arc);
  for (const ang of [a0, a1]) {
    const ray = document.createElementNS(SVGNS, 'line');
    ray.setAttribute('x1', sx(P)); ray.setAttribute('y1', sy(P));
    ray.setAttribute('x2', sx(P) + Math.cos(ang) * R); ray.setAttribute('y2', sy(P) + Math.sin(ang) * R);
    ray.setAttribute('class', `ray ${v.ok ? 'ok' : 'bad'}`);
    svg.appendChild(ray);
  }

  const fp = far(cand, P);
  const bx = sx(fp) + (sx(fp) - sx(P)) * 0.12;
  const by = sy(fp) + (sy(fp) - sy(P)) * 0.12 - 0.55;
  const label = v.reason === 'gap' ? `✗  gap ${st.m.gap} mm` : (v.ok ? `✓  ${st.m.angle}°` : `✗  ${st.m.angle}°`);
  badge(svg, bx, by, label, v.ok);

  if (v.reason === 'gap') {
    const np = near(cand, P);
    const dim = document.createElementNS(SVGNS, 'line');
    dim.setAttribute('x1', sx(P)); dim.setAttribute('y1', sy(P) - 0.6);
    dim.setAttribute('x2', sx(np)); dim.setAttribute('y2', sy(np) - 0.6);
    dim.setAttribute('class', 'gapdim');
    svg.appendChild(dim);
  }
}

function badge(svg, x, y, text, ok) {
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', `badge ${ok ? 'ok' : 'bad'}`);
  const w = text.length * 0.42 + 0.7, h = 1.0;
  const r = document.createElementNS(SVGNS, 'rect');
  r.setAttribute('x', x - w / 2); r.setAttribute('y', y - h / 2);
  r.setAttribute('width', w); r.setAttribute('height', h); r.setAttribute('rx', 0.28);
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y); t.textContent = text;
  g.append(r, t); svg.appendChild(g);
}
function arcPath(P, R, a0, a1) {
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const x0 = sx(P) + Math.cos(a0) * R, y0 = sy(P) + Math.sin(a0) * R;
  const x1 = sx(P) + Math.cos(a0 + d) * R, y1 = sy(P) + Math.sin(a0 + d) * R;
  return `M ${x0} ${y0} A ${R} ${R} 0 ${Math.abs(d) > Math.PI ? 1 : 0} ${d > 0 ? 1 : 0} ${x1} ${y1}`;
}
function norm(v) { const m = Math.hypot(v[0], v[1]) || 1; return [v[0] / m, v[1] / m]; }

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
  const steps = isCalc() ? calcRows() : trace.steps;
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

// open the algorithm named in the URL hash (e.g. linked from a workflow step)
const startAlg = ALGORITHMS.findIndex((a) => a.meta.id === location.hash.slice(1));
loadAlg(startAlg >= 0 ? startAlg : 0);
