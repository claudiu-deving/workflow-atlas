#!/usr/bin/env node
// workflow-atlas server — zero dependencies, Node built-ins only.
//
//   npm start            (or: node server/server.mjs)
//
// Serves the static app and exposes an MCP authoring surface so an AI assistant
// can build the visuals it's explaining: create/edit algorithm storyboards and
// workflow maps (stored as JSON under content/), tune review overlays, and edit
// the look directly (raw CSS / HTML). Local-only tooling — a richer channel for
// showing, not just describing, an algorithm. MCP runs over stdio (how Claude
// Code launches it) and at /mcp over HTTP (for manual testing).

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GENERATORS } from '../shared/generators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');        // the app root (parent of server/)
const CONTENT = path.join(ROOT, 'content');
const ALG_DIR = path.join(CONTENT, 'algorithms');
const REVIEW_DIR = path.join(CONTENT, 'reviews');
const WORKFLOWS = path.join(CONTENT, 'workflows.json');
const INDEX = path.join(CONTENT, 'index.json');
const PORT = Number(process.env.PORT) || 5174;
let activePort = PORT;          // the port the UI is actually reachable on (may shift if PORT is taken)
let uiServedElsewhere = false;  // another atlas instance already owns the port — we're a stdio worker
let lastOpenedAt = 0;           // debounce auto-opening the browser
// logs MUST go to stderr — stdout is reserved for the MCP stdio protocol
const log = (...a) => console.error('[workflow-atlas]', ...a);
const BUILTINS = new Set(Object.keys(GENERATORS));

// open the app in the user's default browser — but only when no live tab is
// already connected (the live-reload SSE refreshes those), so authoring doesn't
// spawn a pile of tabs. Disable entirely with ATLAS_NO_OPEN=1 (e.g. headless/CI).
function openInBrowser(urlPath) {
  if (process.env.ATLAS_NO_OPEN) return;
  if (reloadClients.size > 0) return;                 // a tab is open and will live-reload itself
  const now = Date.now();
  if (now - lastOpenedAt < 4000) return;              // collapse a burst of saves into one open
  lastOpenedAt = now;
  const url = `http://localhost:${activePort}${urlPath || '/'}`;
  try {
    const p = process.platform;
    const cmd = p === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : p === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('opened', url, 'in the browser');
  } catch (e) { log('could not open a browser:', e.message, '—', url); }
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.map': 'application/json',
};
const safeId = (s) => /^[a-z0-9][a-z0-9-]*$/.test(s || '');
const algPath = (id) => path.join(ALG_DIR, `${id}.json`);
const reviewPath = (id) => path.join(REVIEW_DIR, `${id}.json`);

async function ensureDirs() {
  await fs.mkdir(ALG_DIR, { recursive: true });
  await fs.mkdir(REVIEW_DIR, { recursive: true });
}

/* ---------------- algorithm store ---------------- */
async function listAlgorithms() {
  try {
    const files = await fs.readdir(ALG_DIR);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch { return []; }
}
async function readAlgorithm(id) {
  return JSON.parse(await fs.readFile(algPath(id), 'utf8'));
}
function validateAlgorithm(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  if (!safeId(spec.id)) throw new Error('spec.id must be a slug: [a-z0-9][a-z0-9-]*');
  if (!spec.name) throw new Error('spec.name is required');
  if (!['array', 'calc'].includes(spec.kind)) throw new Error("spec.kind must be 'array' or 'calc'");
  if (!Array.isArray(spec.code)) throw new Error('spec.code must be an array of pseudocode lines');
  if (spec.params != null && !Array.isArray(spec.params)) throw new Error('spec.params must be an array');
  const hasBuiltin = typeof spec.builtin === 'string';
  const hasSteps = Array.isArray(spec.steps);
  if (!hasBuiltin && !hasSteps) throw new Error('spec needs either "steps" (array of frames) or "builtin" + "data"');
  if (hasBuiltin && !BUILTINS.has(spec.builtin)) throw new Error(`unknown builtin "${spec.builtin}". Known: ${[...BUILTINS].join(', ')}`);
}
async function writeAlgorithm(spec) {
  validateAlgorithm(spec);
  await ensureDirs();
  await fs.writeFile(algPath(spec.id), JSON.stringify(spec, null, 2) + '\n', 'utf8');
  await rebuildIndex();
  return spec.id;
}
async function deleteAlgorithm(id) {
  await fs.rm(algPath(id), { force: true });
  await fs.rm(reviewPath(id), { force: true });
  await rebuildIndex();
}
async function rebuildIndex() {
  const algorithms = await listAlgorithms();
  const body = {
    note: 'Discovery manifest — the server rewrites this on every algorithm create/delete. The app reads it to know which storyboards to load (works with or without the server).',
    algorithms,
  };
  await fs.writeFile(INDEX, JSON.stringify(body, null, 2) + '\n', 'utf8');
}
// authored questions: builtins declare them in spec.questions; static traces
// carry them inline on steps[i].question.
async function readQuestions(id) {
  const spec = await readAlgorithm(id);
  if (spec.builtin) return (spec.questions || []).map((q) => ({ step: q.step, question: q.text }));
  return (spec.steps || []).map((st, i) => (st && st.question ? { step: i, question: st.question } : null)).filter(Boolean);
}

/* ---------------- workflow store ---------------- */
async function readWorkflows() {
  try { return JSON.parse(await fs.readFile(WORKFLOWS, 'utf8')); }
  catch { return { sheets: [] }; }
}
async function writeWorkflows(obj) {
  const sheets = Array.isArray(obj) ? obj : (obj && obj.sheets);
  if (!Array.isArray(sheets)) throw new Error('workflows must be an array of sheets, or { sheets: [...] }');
  await fs.writeFile(WORKFLOWS, JSON.stringify({ sheets }, null, 2) + '\n', 'utf8');
  return sheets.length;
}

/* ---------------- review store (params + comments + decisions) ---------------- */
async function readReview(id) {
  try { return JSON.parse(await fs.readFile(reviewPath(id), 'utf8')); }
  catch { return { $schema: 'storyboard-review', algorithm: id, params: {}, comments: {}, decisions: {} }; }
}
async function writeReview(id, obj) {
  await ensureDirs();
  const out = {
    $schema: 'storyboard-review',
    algorithm: id,
    savedAt: new Date().toISOString().slice(0, 10),
    params: obj.params || {},
    comments: obj.comments || {},
    decisions: obj.decisions || {},      // step → { answer, by, at } for resolved open questions
  };
  await fs.writeFile(reviewPath(id), JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

/* ---------------- raw file editing (the "look") ---------------- */
const EDIT_EXT = new Set(['.css', '.html', '.js', '.json', '.svg', '.md', '.txt']);
const PROTECTED = ['server', 'content', 'node_modules', '.git', '.claude'];   // edited via their own tools, or off-limits
function resolveEditable(rel) {
  const fp = path.normalize(path.join(ROOT, rel || ''));
  if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) throw new Error('path escapes the project root');
  const r = path.relative(ROOT, fp).split(path.sep).join('/');
  const top = r.split('/')[0];
  if (PROTECTED.includes(top)) throw new Error(`"${top}/" is managed by its own tools and not raw-editable`);
  return { fp, rel: r };
}
async function listEditableFiles() {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = path.relative(ROOT, full).split(path.sep).join('/');
      if (PROTECTED.includes(r.split('/')[0])) continue;
      if (e.isDirectory()) await walk(full);
      else if (EDIT_EXT.has(path.extname(e.name))) out.push(r);
    }
  }
  await walk(ROOT);
  return out.sort();
}

/* ---------------- helpers ---------------- */
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(d)); req.on('error', reject);
  });
}

/* ---------------- MCP ---------------- */
const TOOLS = [
  // read
  { name: 'list_algorithms', description: 'List the algorithm storyboards and whether each has a saved review.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_algorithm', description: 'Read the full JSON spec of an algorithm storyboard (meta, kind, code, params, steps or builtin).',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' } }, required: ['algorithm'] } },
  { name: 'get_workflows', description: 'Read the workflow maps (the SHEETS data) shown in the Workflows view.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_review', description: 'Read the saved review (tuned params + per-step comments + decisions) for an algorithm.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' } }, required: ['algorithm'] } },
  { name: 'list_open_questions', description: 'List every authored open question across algorithms and whether it has been decided yet.',
    inputSchema: { type: 'object', properties: {} } },

  // author content
  { name: 'save_algorithm', description: 'Create or replace an algorithm storyboard from a JSON spec. ' +
      'spec = { id (slug), tag?, name, title?, sub?, kind ("array"|"calc"), code (pseudocode lines[]), params? [], ' +
      'and EITHER steps[] (explicit frames) OR builtin (one of: ' + [...BUILTINS].join(', ') + ') + data + questions[] }. ' +
      'A frame (kind "array") = { array[], cls{index:state}, ptr{label:index}, note, line, verdict{ok?,text}, question? } ' +
      'where state ∈ idle|active|compare|lo|hi|mid|eliminated|found|sorted. A row (kind "calc") = ' +
      '{ label, result?, unit?, expr?, sub?, kind?(input|result), bad?, line, note, question? }. Persists to content/algorithms/<id>.json.',
    inputSchema: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] } },
  { name: 'delete_algorithm', description: 'Delete an algorithm storyboard and its review. Persists.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' } }, required: ['algorithm'] } },
  { name: 'save_workflows', description: 'Replace the workflow maps. sheets = [ { id, code, name, title, sub, stations[] } ]. ' +
      'A station = { title, sub?, status (done|partial|todo), algorithm?, detail?{in[],out[],note,open[]}, ' +
      'loop?{to,label}, fan?{tracks[]} }. Persists to content/workflows.json.',
    inputSchema: { type: 'object', properties: { sheets: { type: 'array' } }, required: ['sheets'] } },

  // review / decisions
  { name: 'set_param', description: 'Set one param value in an algorithm review (re-evaluates the storyboard live). Persists.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, key: { type: 'string' }, value: { type: 'number' } }, required: ['algorithm', 'key', 'value'] } },
  { name: 'set_comment', description: 'Set (or clear, with empty text) a comment on a step of an algorithm. Persists.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, step: { type: 'number' }, text: { type: 'string' } }, required: ['algorithm', 'step'] } },
  { name: 'set_decision', description: 'Resolve an open question: record the decision (answer) on a step. Persists.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, step: { type: 'number' }, answer: { type: 'string' }, by: { type: 'string' } }, required: ['algorithm', 'step', 'answer'] } },
  { name: 'reopen_question', description: 'Clear a recorded decision so the question is open again. Persists.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, step: { type: 'number' } }, required: ['algorithm', 'step'] } },

  // the look — raw files
  { name: 'list_files', description: 'List the raw app files you may read/edit to design the look (CSS, HTML, JS at the project root). Excludes server/ and content/.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_file', description: 'Read a raw app file (e.g. styles.css, index.html, algorithms.html) to design the look.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'set_file', description: 'Overwrite a raw app file to restyle/redesign the app. Allowed extensions: css, html, js, json, svg, md, txt. ' +
      'Cannot touch server/ or content/ (use the content tools for those). No guardrails on the markup itself — local tooling.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
];

async function callTool(name, args) {
  const a = args || {};
  const needsAlg = new Set(['get_algorithm', 'get_review', 'delete_algorithm', 'set_param', 'set_comment', 'set_decision', 'reopen_question']);
  if (needsAlg.has(name) && !safeId(a.algorithm)) throw new Error('invalid or missing algorithm id (slug)');
  switch (name) {
    case 'list_algorithms': {
      const algs = await listAlgorithms();
      return algs.map((id) => `${id}${existsSync(reviewPath(id)) ? ' (review saved)' : ''}`).join('\n') || '(none)';
    }
    case 'get_algorithm': return JSON.stringify(await readAlgorithm(a.algorithm), null, 2);
    case 'get_workflows': return JSON.stringify(await readWorkflows(), null, 2);
    case 'get_review': return JSON.stringify(await readReview(a.algorithm), null, 2);
    case 'list_open_questions': {
      const algs = await listAlgorithms();
      const lines = [];
      for (const id of algs) {
        let qs = [];
        try { qs = await readQuestions(id); } catch (e) { lines.push(`${id}: (could not read questions: ${e.message})`); continue; }
        if (!qs.length) continue;
        const r = await readReview(id); const dec = r.decisions || {};
        for (const q of qs) {
          const d = dec[q.step];
          lines.push(d
            ? `[decided] ${id} step ${q.step}: ${q.question}\n    → ${d.answer}${d.by ? ` (${d.by}, ${d.at || ''})` : ''}`
            : `[OPEN]    ${id} step ${q.step}: ${q.question}`);
        }
      }
      return lines.join('\n') || '(no authored questions)';
    }

    case 'save_algorithm': {
      const id = await writeAlgorithm(a.spec);
      openInBrowser(`/algorithms.html#${id}`);
      return `saved algorithm "${id}" → content/algorithms/${id}.json`;
    }
    case 'delete_algorithm': {
      if (!existsSync(algPath(a.algorithm))) throw new Error(`no such algorithm: ${a.algorithm}`);
      await deleteAlgorithm(a.algorithm);
      return `deleted algorithm "${a.algorithm}"`;
    }
    case 'save_workflows': {
      const n = await writeWorkflows(a.sheets);
      openInBrowser('/');
      return `saved ${n} workflow sheet(s) → content/workflows.json`;
    }

    case 'set_param': {
      const r = await readReview(a.algorithm); r.params = r.params || {}; r.params[a.key] = a.value;
      const out = await writeReview(a.algorithm, r);
      return `set ${a.key} = ${a.value}\n${JSON.stringify(out.params)}`;
    }
    case 'set_comment': {
      const r = await readReview(a.algorithm); r.comments = r.comments || {};
      if (a.text && a.text.trim()) r.comments[a.step] = a.text.trim(); else delete r.comments[a.step];
      await writeReview(a.algorithm, r);
      return `comment on step ${a.step} ${a.text && a.text.trim() ? 'saved' : 'cleared'}`;
    }
    case 'set_decision': {
      if (!a.answer || !a.answer.trim()) throw new Error('answer is required');
      const r = await readReview(a.algorithm); r.decisions = r.decisions || {};
      r.decisions[a.step] = { answer: a.answer.trim(), by: (a.by || 'claude').trim(), at: new Date().toISOString().slice(0, 10) };
      await writeReview(a.algorithm, r);
      return `decided step ${a.step}: ${r.decisions[a.step].answer}`;
    }
    case 'reopen_question': {
      const r = await readReview(a.algorithm); r.decisions = r.decisions || {};
      delete r.decisions[a.step];
      await writeReview(a.algorithm, r);
      return `reopened step ${a.step}`;
    }

    case 'list_files': return (await listEditableFiles()).join('\n') || '(none)';
    case 'get_file': {
      const { fp, rel } = resolveEditable(a.path);
      if (!EDIT_EXT.has(path.extname(fp))) throw new Error(`not an editable file type: ${rel}`);
      return fs.readFile(fp, 'utf8');
    }
    case 'set_file': {
      const { fp, rel } = resolveEditable(a.path);
      if (!EDIT_EXT.has(path.extname(fp))) throw new Error(`refusing to write a non-editable file type: ${rel}`);
      if (typeof a.content !== 'string') throw new Error('content must be a string');
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.writeFile(fp, a.content, 'utf8');
      return `wrote ${rel} (${a.content.length} bytes)`;
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// shared JSON-RPC dispatch — used by both the HTTP /mcp endpoint and stdio
async function dispatch(msg) {
  if (msg.id === undefined || msg.id === null) return null;   // notification: no response
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  try {
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'workflow-atlas', version: '0.2.0' },
        });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const text = await callTool(msg.params?.name, msg.params?.arguments);
        return ok({ content: [{ type: 'text', text: String(text) }] });
      }
      default: return err(-32601, `method not found: ${msg.method}`);
    }
  } catch (e) {
    return ok({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
  }
}

async function handleMcp(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version' });
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const resp = await dispatch(msg);
  if (!resp) { res.writeHead(202, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
  return json(res, 200, resp);
}

// MCP over stdio — how Claude Code launches & manages this server.
function startStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resp = await dispatch(msg);
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    }
  });
  process.stdin.on('error', () => {});
}

/* ---------------- live reload (zero-dep SSE) ---------------- */
const reloadClients = new Set();
function broadcastReload() {
  for (const res of reloadClients) { try { res.write('data: reload\n\n'); } catch { /* dropped */ } }
}
let reloadTimer = null;
// watch the project for edits and nudge open tabs to refresh. Skip the app's own
// review autosaves (content/reviews/) so typing a comment never reloads under you.
try {
  watch(ROOT, { recursive: true }, (_ev, file) => {
    if (!file) return;
    const f = String(file).split(path.sep).join('/');
    if (f.startsWith('node_modules/') || f.startsWith('.git/') || f.startsWith('content/reviews/')) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(broadcastReload, 120);
  });
} catch (e) { log('live-reload watch unavailable:', e.message); }

/* ---------------- REST + static ---------------- */
async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'workflow-atlas', port: activePort });
  if (url.pathname === '/api/livereload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 1000\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;   // long-lived connection
  }
  const m = url.pathname.match(/^\/api\/review\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!safeId(id)) return json(res, 400, { error: 'invalid algorithm' });
    if (req.method === 'GET') return json(res, 200, await readReview(id));
    if (req.method === 'PUT') {
      try {
        const obj = JSON.parse(await readBody(req));
        const out = await writeReview(id, obj);
        return json(res, 200, { ok: true, saved: out });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    return json(res, 405, { error: 'GET or PUT' });
  }
  return json(res, 404, { error: 'not found' });
}

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store' });   // local dev tool — always serve fresh so edits show on reload
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/mcp') return await handleMcp(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await handleStatic(req, res, url);
  } catch (e) {
    res.writeHead(500); res.end('server error: ' + e.message);
  }
});

// probe whoever holds a port: is it another workflow-atlas instance, or something else?
function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: '/api/health', timeout: 600 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const MAX_PORT_TRIES = 12;
let portTries = 0;

server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') { log('http error:', e.message); return; }
  const health = await probeHealth(activePort);
  if (health && health.app === 'workflow-atlas') {
    // a sibling instance already serves the UI here — reuse it, run as a stdio worker.
    // (its file watcher live-reloads the shared content, so our edits still show.)
    uiServedElsewhere = true;
    log(`port ${activePort} already serves a workflow-atlas instance — using it for the UI; this process runs as an MCP/stdio worker.`);
    return;
  }
  // occupied by something unrelated — step to the next port and serve the UI there.
  if (portTries < MAX_PORT_TRIES) {
    const next = PORT + (++portTries);
    log(`port ${activePort} is busy (not workflow-atlas) — trying ${next}…`);
    activePort = next;
    setTimeout(() => server.listen(next), 60);
  } else {
    log(`no free port found after ${MAX_PORT_TRIES} tries — continuing with MCP over stdio only.`);
  }
});

server.listen(activePort, () => {
  log(`atlas → http://localhost:${activePort}/  (app: /algorithms.html · REST: /api · MCP: /mcp + stdio)`);
});

// always accept MCP over stdio (active when Claude Code spawns us; harmless otherwise)
startStdio();
