#!/usr/bin/env node
// workflow-atlas server — zero dependencies, Node built-ins only.
//
//   npm start            (or: node server/server.mjs)
//
// Serves the static app, autosaves review overlays to traces/*.review.json over
// REST, and exposes the same data to an AI assistant over MCP (stdio + /mcp).

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');        // the app root (parent of server/)
const TRACES = path.join(ROOT, 'traces');
const PORT = process.env.PORT || 5174;
// logs MUST go to stderr — stdout is reserved for the MCP stdio protocol
const log = (...a) => console.error('[workflow-atlas]', ...a);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.map': 'application/json',
};
const safeAlg = (s) => /^[a-z0-9][a-z0-9-]*$/.test(s || '');
const reviewPath = (alg) => path.join(TRACES, `${alg}.review.json`);

/* ---------------- review store (shared by REST + MCP) ---------------- */
async function readReview(alg) {
  try { return JSON.parse(await fs.readFile(reviewPath(alg), 'utf8')); }
  catch { return { $schema: 'storyboard-review', algorithm: alg, params: {}, comments: {}, decisions: {} }; }
}
async function writeReview(alg, obj) {
  const out = {
    $schema: 'storyboard-review',
    algorithm: alg,
    savedAt: new Date().toISOString().slice(0, 10),
    params: obj.params || {},
    comments: obj.comments || {},
    decisions: obj.decisions || {},      // step → { answer, by, at } for resolved open questions
  };
  await fs.writeFile(reviewPath(alg), JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}
async function listAlgorithms() {
  const files = await fs.readdir(TRACES);
  return files.filter((f) => f.endsWith('.js') && !f.endsWith('.review.json'))
    .map((f) => f.replace(/\.js$/, ''));
}
async function readSource(alg) {
  return fs.readFile(path.join(TRACES, `${alg}.js`), 'utf8');
}
// dynamically import a trace module to read its authored questions. A trace
// exposes its steps either statically (`steps`) or via `compute(params)`; in the
// latter case we evaluate it at its default params to find authored questions.
async function readQuestions(alg) {
  const url = pathToFileURL(path.join(TRACES, `${alg}.js`)).href + `?t=${Date.now()}`;
  const mod = await import(url);
  let steps = mod.steps;
  if (!steps && typeof mod.compute === 'function') {
    const p = {};
    (mod.params || []).forEach((x) => { p[x.key] = x.value; });
    steps = mod.compute(p);
  }
  const out = [];
  (steps || []).forEach((st, i) => { if (st && st.question) out.push({ step: i, question: st.question }); });
  return out;
}

/* ---------------- helpers ---------------- */
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(d)); req.on('error', reject);
  });
}

/* ---------------- MCP (Streamable HTTP, stateless) ---------------- */
const TOOLS = [
  { name: 'list_algorithms', description: 'List the algorithm storyboards and whether each has a saved review.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_review', description: 'Read the saved review (tuned params + per-step comments) for an algorithm.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' } }, required: ['algorithm'] } },
  { name: 'get_algorithm_source', description: 'Read the trace source (scene, pseudocode, params, steps) for an algorithm.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' } }, required: ['algorithm'] } },
  { name: 'set_param', description: 'Set one tolerance/parameter value in an algorithm review. Persists to disk.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, key: { type: 'string' }, value: { type: 'number' } }, required: ['algorithm', 'key', 'value'] } },
  { name: 'set_comment', description: 'Set (or clear, with empty text) a comment on a step of an algorithm. Persists to disk.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, step: { type: 'number' }, text: { type: 'string' } }, required: ['algorithm', 'step'] } },
  { name: 'list_open_questions', description: 'List every authored open question across algorithms and whether it has been decided yet.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'set_decision', description: 'Resolve an open question: record the decision (answer) on a step. Persists to disk.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, step: { type: 'number' }, answer: { type: 'string' }, by: { type: 'string' } }, required: ['algorithm', 'step', 'answer'] } },
  { name: 'reopen_question', description: 'Clear a recorded decision so the question is open again. Persists to disk.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' }, step: { type: 'number' } }, required: ['algorithm', 'step'] } },
];

async function callTool(name, args) {
  const a = args || {};
  const noAlg = new Set(['list_algorithms', 'list_open_questions']);
  if (!noAlg.has(name) && !safeAlg(a.algorithm)) throw new Error('invalid or missing algorithm');
  switch (name) {
    case 'list_algorithms': {
      const algs = await listAlgorithms();
      const rows = algs.map((id) => `${id}${existsSync(reviewPath(id)) ? ' (review saved)' : ''}`);
      return rows.join('\n') || '(none)';
    }
    case 'get_review': return JSON.stringify(await readReview(a.algorithm), null, 2);
    case 'get_algorithm_source': return readSource(a.algorithm);
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
          serverInfo: { name: 'workflow-atlas', version: '0.1.0' },
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

// MCP over stdio — how Claude Code launches & manages this server. Reads
// newline-delimited JSON-RPC on stdin, writes responses on stdout.
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

/* ---------------- REST + static ---------------- */
async function handleApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/review\/([^/]+)$/);
  if (url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (m) {
    const alg = decodeURIComponent(m[1]);
    if (!safeAlg(alg)) return json(res, 400, { error: 'invalid algorithm' });
    if (req.method === 'GET') return json(res, 200, await readReview(alg));
    if (req.method === 'PUT') {
      try {
        const obj = JSON.parse(await readBody(req));
        const out = await writeReview(alg, obj);
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
      'Cache-Control': 'no-cache' });
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

server.on('error', (e) => {
  // another instance (e.g. one Claude Code already spawned) holds the port —
  // keep running so MCP-over-stdio still works.
  if (e.code === 'EADDRINUSE') log(`port ${PORT} already in use — app served by another instance; continuing with MCP over stdio.`);
  else log('http error:', e.message);
});
server.listen(PORT, () => {
  log(`atlas → http://localhost:${PORT}/  (app: /algorithms.html · REST: /api · MCP: /mcp + stdio)`);
});

// always accept MCP over stdio (active when Claude Code spawns us; harmless otherwise)
startStdio();
