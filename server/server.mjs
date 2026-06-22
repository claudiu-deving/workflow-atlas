#!/usr/bin/env node
// workflow-atlas server — zero dependencies, Node built-ins only.
//
//   npm start            (or: node server/server.mjs)
//
// Serves the static app and exposes an MCP authoring surface so an AI assistant
// (any MCP client) can build the visuals it's explaining: create/edit algorithm
// storyboards and workflow maps, tune review overlays, and edit the look directly
// (raw CSS / HTML). Data for each project is stored under ~/.workflow-atlas, so one
// install serves many projects and parallel sessions. Local-only tooling. MCP runs
// over stdio (how an MCP client like Claude Code launches it) and at /mcp over HTTP.

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GENERATORS } from '../shared/generators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');        // the app files (this repo) — served as static
const SEED = path.join(ROOT, 'content');           // bundled demo content used to seed a new project

// Data (every user's projects) lives OUTSIDE the repo, so one install serves many
// projects and many parallel sessions. Default ~/.workflow-atlas; override with
// WORKFLOW_ATLAS_HOME. Each project is a folder under projects/ holding its own
// algorithms/, reviews/, workflows.json, index.json.
const ATLAS_HOME = process.env.WORKFLOW_ATLAS_HOME || path.join(os.homedir(), '.workflow-atlas');
const PROJECTS_DIR = path.join(ATLAS_HOME, 'projects');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'default';
// Each server process is bound to ONE project: explicit WORKFLOW_ATLAS_PROJECT, else
// derived from the launch directory — so an MCP client opened in repo X authors X's
// project automatically, and parallel sessions in different repos stay isolated.
// (Prefer CLAUDE_PROJECT_DIR so the server and the review hook agree on the project.)
const CURRENT_PROJECT = slug(process.env.WORKFLOW_ATLAS_PROJECT || path.basename(process.env.CLAUDE_PROJECT_DIR || process.cwd()));

const projDir = (p) => path.join(PROJECTS_DIR, slug(p));
const algDir = (p) => path.join(projDir(p), 'algorithms');
const reviewDir = (p) => path.join(projDir(p), 'reviews');
const workflowsPath = (p) => path.join(projDir(p), 'workflows.json');
const indexPath = (p) => path.join(projDir(p), 'index.json');
const algPath = (p, id) => path.join(algDir(p), `${id}.json`);
const reviewPath = (p, id) => path.join(reviewDir(p), `${id}.json`);
const workflowReviewPath = (p) => path.join(reviewDir(p), '_workflows.json');

// Atomic, serialized-per-file write. A torn write can't corrupt the live file, and
// queueing writes to the same file avoids two concurrent renames onto the same
// target (which Windows rejects with a sharing violation); a short retry covers a
// cross-process race. The tmp is always cleaned up. Last writer in the queue wins.
const writeQueues = new Map();
async function renameWithRetry(tmp, file, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fs.rename(tmp, file); }
    catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 8 * (i + 1)));
    }
  }
}
async function writeAtomic(file, data) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const tmp = `${file}.tmp-${randomUUID()}`;
    try { await fs.writeFile(tmp, data, 'utf8'); await renameWithRetry(tmp, file); }
    finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  });
  writeQueues.set(file, run);
  try { await run; } finally { if (writeQueues.get(file) === run) writeQueues.delete(file); }
}

const PORT = Number(process.env.PORT) || 5174;
// Local-only by default: bind loopback so the unauthenticated write surface
// (MCP tools, review autosave) is never reachable from the LAN. Advanced users
// can opt into a different interface with ATLAS_HOST=0.0.0.0 (at their own risk).
const HOST = process.env.ATLAS_HOST || '127.0.0.1';
let activePort = PORT;          // the port the UI is actually reachable on (may shift if PORT is taken)
let uiServedElsewhere = false;  // another atlas instance already owns the port — we're a stdio worker
let hasAutoOpened = false;      // auto-open the browser at most once per server run
// logs MUST go to stderr — stdout is reserved for the MCP stdio protocol
const log = (...a) => console.error('[workflow-atlas]', ...a);
const BUILTINS = new Set(Object.keys(GENERATORS));
// What each builtin generator needs to render a non-empty, non-NaN storyboard.
const BUILTIN_REQUIRES = {
  'binary-search': { array: true, params: ['target'] },
  'bubble-sort': { array: true, params: [] },
  'euclid-gcd': { array: false, params: ['a', 'b'] },
};

// open the app in the user's default browser — but ONCE per server run, and only
// if no live tab is already connected. After the first open, further authoring
// just live-reloads the open tab; if you closed it, reopen the URL yourself. This
// keeps editing from spawning a tab on every save. Disable entirely with
// ATLAS_NO_OPEN=1 (e.g. headless/CI).
function openInBrowser(urlPath) {
  if (process.env.ATLAS_NO_OPEN) return;
  if (hasAutoOpened) return;                          // already opened once this run
  if (reloadClients.size > 0) return;                 // a tab is open and will live-reload itself
  hasAutoOpened = true;
  // carry the bound project so the tab opens on the right one — even when a sibling
  // instance (a different project) owns the port and actually serves the UI.
  const up = urlPath || '/';
  const hashAt = up.indexOf('#');
  const base = hashAt >= 0 ? up.slice(0, hashAt) : up;
  const hash = hashAt >= 0 ? up.slice(hashAt) : '';
  const withP = `${base}${base.includes('?') ? '&' : '?'}p=${encodeURIComponent(CURRENT_PROJECT)}${hash}`;
  const url = `http://localhost:${activePort}${withP}`;
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

// Defend the write surface against cross-origin / DNS-rebinding abuse: a request
// is only honored if its Host is loopback AND any Origin it carries is loopback
// too. A rebinding page sends Host: evil.com; a plain cross-origin page sends
// Origin: http://evil.com — both fail here, while the same-origin app passes.
const isLoopbackHost = (h) => {
  if (!h) return false;
  const host = String(h).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};
function isLocalRequest(req) {
  if (!isLoopbackHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) { try { return isLoopbackHost(new URL(origin).host); } catch { return false; } }
  return true;
}
// Seed a brand-new project from the bundled demo content the first time it's used,
// so an empty project isn't a blank wall. Runs once (when the project dir is absent).
async function ensureDirs(p) {
  const created = !existsSync(projDir(p));
  await fs.mkdir(algDir(p), { recursive: true });
  await fs.mkdir(reviewDir(p), { recursive: true });
  // New projects start EMPTY (real work shouldn't be mixed with demo content).
  // Opt in to the bundled demos for a fresh project with WORKFLOW_ATLAS_SEED=1.
  if (created && process.env.WORKFLOW_ATLAS_SEED) {
    try {
      for (const f of await fs.readdir(path.join(SEED, 'algorithms'))) {
        if (f.endsWith('.json')) await fs.copyFile(path.join(SEED, 'algorithms', f), path.join(algDir(p), f));
      }
      await fs.copyFile(path.join(SEED, 'workflows.json'), workflowsPath(p));
      await rebuildIndex(p);
    } catch { /* no seed available — leave the project empty */ }
  }
}
async function listProjects() {
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
}

/* ---------------- algorithm store ---------------- */
async function listAlgorithms(p) {
  try {
    const files = await fs.readdir(algDir(p));
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch { return []; }
}
async function readAlgorithm(p, id) {
  return JSON.parse(await fs.readFile(algPath(p, id), 'utf8'));
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
  if (hasSteps && spec.steps.length === 0 && !hasBuiltin) throw new Error('spec.steps is empty — author at least one frame, or use a builtin');
  if (hasBuiltin) {
    if (!BUILTINS.has(spec.builtin)) throw new Error(`unknown builtin "${spec.builtin}". Known: ${[...BUILTINS].join(', ')}`);
    // a builtin drives the storyboard from its data/params — without them it renders an empty or NaN board.
    const req = BUILTIN_REQUIRES[spec.builtin] || {};
    if (req.array && !Array.isArray(spec.data?.array)) throw new Error(`builtin "${spec.builtin}" requires data.array (an array of numbers)`);
    for (const key of req.params || []) {
      const p = (spec.params || []).find((x) => x && x.key === key);
      if (!p || !Number.isFinite(Number(p.value))) throw new Error(`builtin "${spec.builtin}" requires a numeric param "${key}"`);
    }
  }
}
async function writeAlgorithm(p, spec) {
  validateAlgorithm(spec);
  await ensureDirs(p);
  await writeAtomic(algPath(p, spec.id), JSON.stringify(spec, null, 2) + '\n');
  await rebuildIndex(p);
  return spec.id;
}
async function deleteAlgorithm(p, id) {
  await fs.rm(algPath(p, id), { force: true });
  await fs.rm(reviewPath(p, id), { force: true });
  await rebuildIndex(p);
}
async function rebuildIndex(p) {
  const algorithms = await listAlgorithms(p);
  const body = {
    note: 'Discovery manifest — the server rewrites this on every algorithm create/delete.',
    algorithms,
  };
  await fs.mkdir(projDir(p), { recursive: true });
  await writeAtomic(indexPath(p), JSON.stringify(body, null, 2) + '\n');
}
// authored questions: builtins declare them in spec.questions; static traces
// carry them inline on steps[i].question.
async function readQuestions(p, id) {
  const spec = await readAlgorithm(p, id);
  if (spec.builtin) return (spec.questions || []).map((q) => ({ step: q.step, question: q.text }));
  return (spec.steps || []).map((st, i) => (st && st.question ? { step: i, question: st.question } : null)).filter(Boolean);
}

/* ---------------- workflow store ---------------- */
const STATUSES = new Set(['done', 'partial', 'todo']);
const MAX_CODE = 16;   // a sheet's `code` is a short badge ("WA-00"), not pseudocode

// detail.in/out/open are arrays of strings; open[] questions are decision KEYS,
// so a non-string here would silently break answering — reject it at the door.
function validateDetail(detail, where) {
  if (detail == null) return;
  if (typeof detail !== 'object' || Array.isArray(detail)) throw new Error(`${where}.detail must be an object`);
  for (const key of ['in', 'out', 'open']) {
    const arr = detail[key];
    if (arr == null) continue;
    if (!Array.isArray(arr)) throw new Error(`${where}.detail.${key} must be an array of strings`);
    arr.forEach((x, i) => { if (typeof x !== 'string') throw new Error(`${where}.detail.${key}[${i}] must be a string`); });
  }
}
// A station may appear as a spine node or a fan track; both share title/status.
function validateStation(st, where = 'station') {
  if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error(`${where} must be an object`);
  if (!st.title || typeof st.title !== 'string') throw new Error(`${where}.title is required (a string)`);
  if (st.status != null && !STATUSES.has(st.status)) throw new Error(`${where}.status must be one of: ${[...STATUSES].join(', ')}`);
  validateDetail(st.detail, where);
  if (st.loop != null) {
    if (typeof st.loop !== 'object' || (typeof st.loop.to !== 'number' && typeof st.loop.to !== 'string'))
      throw new Error(`${where}.loop must be { to: <station index or title>, label? }`);
  }
  if (st.fan != null) {
    if (typeof st.fan !== 'object' || !Array.isArray(st.fan.tracks)) throw new Error(`${where}.fan must be { tracks: [...] }`);
    st.fan.tracks.forEach((t, i) => {
      if (!t || typeof t !== 'object') throw new Error(`${where}.fan.tracks[${i}] must be an object`);
      if (!t.title || typeof t.title !== 'string') throw new Error(`${where}.fan.tracks[${i}].title is required`);
      if (t.status != null && !STATUSES.has(t.status)) throw new Error(`${where}.fan.tracks[${i}].status must be one of: ${[...STATUSES].join(', ')}`);
      validateDetail(t.detail, `${where}.fan.tracks[${i}]`);
    });
  }
}
// Guard the `code` overload: on a SHEET it's a short badge, NOT the pseudocode
// lines[] an algorithm spec carries — a long string/array here breaks the index.
function validateSheet(sheet) {
  if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) throw new Error('sheet must be an object');
  if (!safeId(sheet.id)) throw new Error('sheet.id must be a slug: [a-z0-9][a-z0-9-]*');
  if (sheet.code != null) {
    if (typeof sheet.code !== 'string') throw new Error('sheet.code is a SHORT badge string like "WA-01" (an algorithm spec\'s "code" is pseudocode lines[] — a different field). Got: ' + (Array.isArray(sheet.code) ? 'array' : typeof sheet.code));
    if (sheet.code.length > MAX_CODE) throw new Error(`sheet.code is ${sheet.code.length} chars — keep the badge ≤ ${MAX_CODE}; it renders in the index chip`);
  }
  if (sheet.name != null && typeof sheet.name !== 'string') throw new Error('sheet.name must be a string');
  if (sheet.stations != null && !Array.isArray(sheet.stations)) throw new Error('sheet.stations must be an array');
  (sheet.stations || []).forEach((st, i) => validateStation(st, `stations[${i}]`));
}
// non-fatal hints echoed in save responses so the authoring loop is short
function lintSheets(sheets) {
  const warn = [];
  for (const s of sheets || []) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.code === 'string' && s.code.length > 12) warn.push(`sheet ${s.id}: code is ${s.code.length} chars — badges read best ≤ 12`);
    if (!Array.isArray(s.stations) || !s.stations.length) warn.push(`sheet ${s.id}: has no stations`);
    for (const st of s.stations || []) {
      if (st && st.loop && typeof st.loop.to === 'string' && !(s.stations || []).some((x) => x && x.title === st.loop.to))
        warn.push(`sheet ${s.id}: station "${st.title}" loops to "${st.loop.to}" — no station has that title`);
    }
    // decisions are keyed by (sheet, question text), so identical open-question
    // wording within one sheet collapses to a single decision — warn the author.
    const seenQ = new Set();
    const collect = (detail) => { for (const q of (detail && detail.open) || []) { if (typeof q === 'string') { if (seenQ.has(q)) warn.push(`sheet ${s.id}: open question "${q.slice(0, 40)}${q.length > 40 ? '…' : ''}" appears more than once — answering one resolves all (decisions key on question text)`); else seenQ.add(q); } } };
    for (const st of s.stations || []) { collect(st && st.detail); for (const t of (st && st.fan && st.fan.tracks) || []) collect(t && t.detail); }
  }
  return warn;
}
// reject the same id appearing twice — every per-sheet tool addresses by id
function assertUniqueIds(sheets) {
  const ids = sheets.map((s) => s && s.id);
  const dup = ids.find((id, i) => id != null && ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate sheet id: ${dup} — sheet ids must be unique`);
}

async function readWorkflows(p) {
  try { return JSON.parse(await fs.readFile(workflowsPath(p), 'utf8')); }
  catch { return { sheets: [] }; }
}
async function persistWorkflows(p, sheets) {
  await fs.mkdir(projDir(p), { recursive: true });
  await writeAtomic(workflowsPath(p), JSON.stringify({ sheets }, null, 2) + '\n');
}
async function writeWorkflows(p, obj) {
  const sheets = Array.isArray(obj) ? obj : (obj && obj.sheets);
  if (!Array.isArray(sheets)) throw new Error('workflows must be an array of sheets, or { sheets: [...] }');
  sheets.forEach((s) => validateSheet(s));
  assertUniqueIds(sheets);
  // Snapshot the prior file ONLY on this replace-all path — it's the destructive
  // op (an omitted sheet is deleted). Per-piece edits (save_sheet/set_station) must
  // NOT overwrite the .bak, or one follow-up edit would erase the recovery point.
  try { await fs.copyFile(workflowsPath(p), workflowsPath(p) + '.bak'); } catch { /* no prior file */ }
  await persistWorkflows(p, sheets);
  return sheets.length;
}
async function getSheet(p, id) {
  const s = ((await readWorkflows(p)).sheets || []).find((x) => x && x.id === id);
  if (!s) throw new Error(`no such sheet: ${id}`);
  return s;
}
// per-sheet upsert — authoring one sheet never resends the rest
async function saveSheet(p, sheet) {
  validateSheet(sheet);
  const sheets = (await readWorkflows(p)).sheets || [];
  const i = sheets.findIndex((s) => s && s.id === sheet.id);
  const created = i < 0;
  if (created) sheets.push(sheet); else sheets[i] = sheet;
  await persistWorkflows(p, sheets);
  return { id: sheet.id, created, count: sheets.length, warnings: lintSheets([sheet]) };
}
async function deleteSheet(p, id) {
  const sheets = (await readWorkflows(p)).sheets || [];
  const next = sheets.filter((s) => !(s && s.id === id));
  if (next.length === sheets.length) throw new Error(`no such sheet: ${id}`);
  await persistWorkflows(p, next);
  // intentionally KEEP the sheet's decisions in the review file: re-creating the
  // sheet later recovers them, and they only render for questions that still exist.
  return next.length;
}
async function reorderSheets(p, order) {
  if (!Array.isArray(order)) throw new Error('order must be an array of sheet ids');
  const sheets = (await readWorkflows(p)).sheets || [];
  const byId = new Map(sheets.filter((s) => s && s.id).map((s) => [s.id, s]));
  const seen = new Set();
  const out = [];
  for (const id of order) { const s = byId.get(id); if (s && !seen.has(id)) { out.push(s); seen.add(id); } }
  for (const s of sheets) { if (s && !seen.has(s.id)) out.push(s); }   // unlisted sheets keep their order at the end
  await persistWorkflows(p, out);
  return out.map((s) => s.id);
}
// station-level edits within one sheet
async function setStation(p, sheetId, station, index) {
  validateStation(station, 'station');
  const sheets = (await readWorkflows(p)).sheets || [];
  const sheet = sheets.find((s) => s && s.id === sheetId);
  if (!sheet) throw new Error(`no such sheet: ${sheetId}`);
  sheet.stations = Array.isArray(sheet.stations) ? sheet.stations : [];
  // validate the index SHAPE before deciding append-vs-replace, so a fractional
  // or out-of-range index errors instead of silently appending.
  if (index != null && (!Number.isInteger(index) || index < 0)) throw new Error('index must be a non-negative integer');
  const len = sheet.stations.length;
  let at, created;
  if (index == null || index === len) { sheet.stations.push(station); at = len; created = true; }
  else if (index < len) { sheet.stations[index] = station; at = index; created = false; }
  else throw new Error(`index ${index} out of range (0..${len}); pass ${len} to append`);
  await persistWorkflows(p, sheets);
  return { index: at, count: sheet.stations.length, created };
}
async function deleteStation(p, sheetId, index) {
  const sheets = (await readWorkflows(p)).sheets || [];
  const sheet = sheets.find((s) => s && s.id === sheetId);
  if (!sheet) throw new Error(`no such sheet: ${sheetId}`);
  const st = Array.isArray(sheet.stations) ? sheet.stations : [];
  if (!Number.isInteger(index) || index < 0 || index >= st.length) throw new Error(`station index ${index} out of range (0..${st.length - 1})`);
  const removedTitle = st[index] && st[index].title;
  st.splice(index, 1);
  // keep loop.to targets consistent: shift numeric targets past the gap, and drop
  // any loop (numeric or title-based) that pointed at the station just removed.
  for (const s of st) {
    if (!s || !s.loop) continue;
    if (typeof s.loop.to === 'number') {
      if (s.loop.to === index) delete s.loop;         // its target is gone
      else if (s.loop.to > index) s.loop.to -= 1;      // shifted one left
    } else if (typeof s.loop.to === 'string' && s.loop.to === removedTitle) {
      delete s.loop;                                   // title target removed
    }
  }
  sheet.stations = st;
  await persistWorkflows(p, sheets);
  return { count: st.length };
}

/* ---------------- review store (params + comments + decisions) ---------------- */
async function readReview(p, id) {
  try { return JSON.parse(await fs.readFile(reviewPath(p, id), 'utf8')); }
  catch { return { $schema: 'storyboard-review', algorithm: id, params: {}, comments: {}, decisions: {} }; }
}
async function writeReview(p, id, obj) {
  await ensureDirs(p);
  const out = {
    $schema: 'storyboard-review',
    algorithm: id,
    savedAt: new Date().toISOString().slice(0, 10),
    params: obj.params || {},
    comments: obj.comments || {},
    decisions: obj.decisions || {},      // step → { answer, by, at } for resolved open questions
  };
  await writeAtomic(reviewPath(p, id), JSON.stringify(out, null, 2) + '\n');
  return out;
}

/* ---------------- workflow review (decisions on station open[] questions) ---------------- */
// One file per project. Decisions are keyed by sheet id + the exact question text
// (not a station index), so they survive reordering/insertion of stations.
async function readWorkflowReview(p) {
  try { return JSON.parse(await fs.readFile(workflowReviewPath(p), 'utf8')); }
  catch { return { $schema: 'workflow-review', decisions: {} }; }
}
async function writeWorkflowReview(p, obj) {
  await ensureDirs(p);
  const out = {
    $schema: 'workflow-review',
    savedAt: new Date().toISOString().slice(0, 10),
    decisions: (obj && obj.decisions) || {},   // sheetId → { [question text]: { answer, by, at } }
  };
  await writeAtomic(workflowReviewPath(p), JSON.stringify(out, null, 2) + '\n');
  return out;
}
// every open[] question across all sheets' stations and fan tracks
async function workflowQuestions(p) {
  const wf = await readWorkflows(p);
  const out = [];
  for (const s of wf.sheets || []) {
    const at = (detail, where) => { for (const q of (detail && detail.open) || []) out.push({ sheet: s.id, where, text: q }); };
    for (const st of s.stations || []) {
      at(st.detail, st.title || 'station');
      for (const t of (st.fan && st.fan.tracks) || []) at(t.detail, `${st.title} › ${t.title}`);
    }
  }
  return out;
}
// keys that would corrupt the prototype chain if used to index a plain object
const UNSAFE_KEY = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
async function setWorkflowDecision(p, sheetId, question, answer, by) {
  if (UNSAFE_KEY(sheetId) || UNSAFE_KEY(question)) throw new Error('invalid sheet/question');
  const r = await readWorkflowReview(p);
  r.decisions = r.decisions || {};
  r.decisions[sheetId] = r.decisions[sheetId] || {};
  r.decisions[sheetId][question] = { answer: String(answer).trim(), by: (by || 'assistant').trim(), at: new Date().toISOString().slice(0, 10) };
  return writeWorkflowReview(p, r);
}
async function reopenWorkflowQuestion(p, sheetId, question) {
  if (UNSAFE_KEY(sheetId) || UNSAFE_KEY(question)) throw new Error('invalid sheet/question');
  const r = await readWorkflowReview(p);
  if (r.decisions && r.decisions[sheetId]) {
    delete r.decisions[sheetId][question];
    if (!Object.keys(r.decisions[sheetId]).length) delete r.decisions[sheetId];
  }
  return writeWorkflowReview(p, r);
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
  // no Access-Control-Allow-Origin: the app is same-origin and the data is private —
  // a cross-origin page must NOT be able to read project content/reviews.
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0; let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', (c) => {
      len += c.length;
      // collect Buffers and decode once at the end — decoding per chunk corrupts
      // multi-byte UTF-8 that straddles a chunk boundary.
      if (len > 5e6) { req.destroy(); return finish(reject, new Error('payload too large')); }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => finish(reject, e));
    req.on('close', () => finish(reject, new Error('connection closed before body completed')));
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
  { name: 'list_open_questions', description: 'List every authored open question — across algorithm storyboards AND workflow sheets — and whether each has been decided yet.',
    inputSchema: { type: 'object', properties: {} } },

  // author content
  { name: 'save_algorithm', description: 'Create or replace an algorithm storyboard from a JSON spec. ' +
      'spec = { id (slug), tag?, name, title?, sub?, kind ("array"|"calc"), code (pseudocode lines[]), params? [], ' +
      'and EITHER steps[] (explicit frames) OR builtin (one of: ' + [...BUILTINS].join(', ') + ') + data + questions[] }. ' +
      'A frame (kind "array") = { array[], cls{index:state}, ptr{label:index}, note, line, verdict{ok?,text}, question? } ' +
      'where state ∈ idle|active|compare|lo|hi|mid|eliminated|found|sorted. A row (kind "calc") = ' +
      '{ label, result?, unit?, expr?, sub?, kind?(input|result), bad?, line, note, question? }. Persists to this session\'s project.',
    inputSchema: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] } },
  { name: 'delete_algorithm', description: 'Delete an algorithm storyboard and its review. Persists.',
    inputSchema: { type: 'object', properties: { algorithm: { type: 'string' } }, required: ['algorithm'] } },
  { name: 'save_workflows', description: 'REPLACE-ALL the workflow maps — this OVERWRITES every sheet; any sheet you omit is DELETED. ' +
      'Almost always use save_sheet/set_station for edits instead. If you do use this, call get_workflows first and resend the full set. (The previous file is snapshotted to workflows.json.bak first.) ' +
      'sheets = [ { id (slug), code (SHORT badge string like "WA-01" — NOT pseudocode; an algorithm spec\'s "code" is a different field), name, title, sub, stations[] } ]. ' +
      'A station = { title, sub?, status (done|partial|todo), algorithm?, detail?{in[],out[],note,open[]}, loop?{to (station index OR a target station\'s title), label}, fan?{tracks[]} }. ' +
      'Example sheet: { "id":"checkout", "code":"WF-02", "name":"Checkout", "title":"Order checkout", "sub":"…", "stations":[ {"title":"Validate cart","status":"done","detail":{"in":["cart"],"out":["valid cart"],"open":["allow backorders?"]}} ] }. ' +
      'The response echoes which sheet ids were added/updated/removed plus lint warnings. Persists to this session\'s project.',
    inputSchema: { type: 'object', properties: { sheets: { type: 'array' } }, required: ['sheets'] } },
  { name: 'get_sheet', description: 'Read ONE workflow sheet by id (lighter than get_workflows).',
    inputSchema: { type: 'object', properties: { sheet: { type: 'string' } }, required: ['sheet'] } },
  { name: 'save_sheet', description: 'Upsert ONE workflow sheet by id — create it or replace it in place WITHOUT resending the others. ' +
      'sheet shape and station shape are exactly as in save_workflows (code is a SHORT badge). Returns created-or-updated + lint warnings. Persists to this session\'s project.',
    inputSchema: { type: 'object', properties: { sheet: { type: 'object' } }, required: ['sheet'] } },
  { name: 'delete_sheet', description: 'Delete ONE workflow sheet by id. Persists.',
    inputSchema: { type: 'object', properties: { sheet: { type: 'string' } }, required: ['sheet'] } },
  { name: 'reorder_sheets', description: 'Reorder the sheets in the left index. order = [id, …]; any sheet id you omit keeps its order at the end. Persists.',
    inputSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'string' } } }, required: ['order'] } },
  { name: 'set_station', description: 'Add or replace ONE station inside a sheet WITHOUT resending the rest. ' +
      'With "index" in range it replaces that station; omit index (or pass the current length) to append. station shape as in save_workflows. Returns the resulting index. Persists.',
    inputSchema: { type: 'object', properties: { sheet: { type: 'string' }, station: { type: 'object' }, index: { type: 'number' } }, required: ['sheet', 'station'] } },
  { name: 'delete_station', description: 'Delete the station at "index" within a sheet (numeric loop.to targets are shifted to stay consistent). Persists.',
    inputSchema: { type: 'object', properties: { sheet: { type: 'string' }, index: { type: 'number' } }, required: ['sheet', 'index'] } },
  { name: 'get_workflow_review', description: 'Read recorded decisions on workflow open questions: { decisions: { <sheetId>: { <question text>: { answer, by, at } } } }.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'set_workflow_decision', description: 'Answer a workflow open question — record a decision against a station/track open[] item, identified by its sheet id and the EXACT question text (see list_open_questions). Persists.',
    inputSchema: { type: 'object', properties: { sheet: { type: 'string' }, question: { type: 'string' }, answer: { type: 'string' }, by: { type: 'string' } }, required: ['sheet', 'question', 'answer'] } },
  { name: 'reopen_workflow_question', description: 'Clear a recorded decision so a workflow open question is open again. Persists.',
    inputSchema: { type: 'object', properties: { sheet: { type: 'string' }, question: { type: 'string' } }, required: ['sheet', 'question'] } },

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
  { name: 'list_files', description: 'List the raw app files you may read/edit to design the look (CSS, HTML, JS at the app root). Excludes server/ and the demo seed.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_file', description: 'Read a raw app file (e.g. styles.css, index.html, algorithms.html) to design the look.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'set_file', description: 'Overwrite a raw app file to restyle/redesign the app. Allowed extensions: css, html, js, json, svg, md, txt. ' +
      'Cannot touch server/ or the demo seed (use the content tools for project data). No guardrails on the markup itself — local tooling.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
];

async function callTool(name, args) {
  const a = args || {};
  const needsAlg = new Set(['get_algorithm', 'get_review', 'delete_algorithm', 'set_param', 'set_comment', 'set_decision', 'reopen_question']);
  if (needsAlg.has(name) && !safeId(a.algorithm)) throw new Error('invalid or missing algorithm id (slug)');
  // the advertised inputSchema is not enforced by the JSON-RPC layer, so validate
  // the value types the stores rely on here, before anything is persisted.
  const needsStep = new Set(['set_comment', 'set_decision', 'reopen_question']);
  if (needsStep.has(name) && (!Number.isInteger(a.step) || a.step < 0)) throw new Error('step must be a non-negative integer');
  if (name === 'set_param' && !Number.isFinite(a.value)) throw new Error('value must be a finite number');
  const needsSheet = new Set(['get_sheet', 'delete_sheet', 'set_station', 'delete_station', 'set_workflow_decision', 'reopen_workflow_question']);
  if (needsSheet.has(name) && !safeId(a.sheet)) throw new Error('invalid or missing sheet id (slug)');
  const p = CURRENT_PROJECT;   // this server process is bound to one project (its launch dir)
  switch (name) {
    case 'list_algorithms': {
      const algs = await listAlgorithms(p);
      return algs.map((id) => `${id}${existsSync(reviewPath(p, id)) ? ' (review saved)' : ''}`).join('\n') || '(none)';
    }
    case 'get_algorithm': return JSON.stringify(await readAlgorithm(p, a.algorithm), null, 2);
    case 'get_workflows': return JSON.stringify(await readWorkflows(p), null, 2);
    case 'get_review': return JSON.stringify(await readReview(p, a.algorithm), null, 2);
    case 'list_open_questions': {
      const algs = await listAlgorithms(p);
      const lines = [];
      for (const id of algs) {
        let qs = [];
        try { qs = await readQuestions(p, id); } catch (e) { lines.push(`${id}: (could not read questions: ${e.message})`); continue; }
        if (!qs.length) continue;
        const r = await readReview(p, id); const dec = r.decisions || {};
        for (const q of qs) {
          const d = dec[q.step];
          lines.push(d
            ? `[decided] ${id} step ${q.step}: ${q.question}\n    → ${d.answer}${d.by ? ` (${d.by}, ${d.at || ''})` : ''}`
            : `[OPEN]    ${id} step ${q.step}: ${q.question}`);
        }
      }
      const wq = await workflowQuestions(p);
      if (wq.length) {
        const wdec = (await readWorkflowReview(p)).decisions || {};
        if (lines.length) lines.push('');
        lines.push('— workflow sheets —');
        for (const q of wq) {
          const d = (wdec[q.sheet] || {})[q.text];
          lines.push(d
            ? `[decided] ${q.sheet} (${q.where}): ${q.text}\n    → ${d.answer}${d.by ? ` (${d.by}, ${d.at || ''})` : ''}`
            : `[OPEN]    ${q.sheet} (${q.where}): ${q.text}`);
        }
      }
      return lines.join('\n') || '(no authored questions)';
    }

    case 'save_algorithm': {
      const id = await writeAlgorithm(p, a.spec);
      openInBrowser(`/algorithms.html#${id}`);
      return `saved algorithm "${id}" in project "${p}"`;
    }
    case 'delete_algorithm': {
      if (!existsSync(algPath(p, a.algorithm))) throw new Error(`no such algorithm: ${a.algorithm}`);
      await deleteAlgorithm(p, a.algorithm);
      return `deleted algorithm "${a.algorithm}"`;
    }
    case 'save_workflows': {
      const beforeIds = new Set(((await readWorkflows(p)).sheets || []).map((s) => s && s.id));
      const incoming = Array.isArray(a.sheets) ? a.sheets : [];
      const afterIds = new Set(incoming.map((s) => s && s.id));
      const added = [...afterIds].filter((id) => !beforeIds.has(id));
      const removed = [...beforeIds].filter((id) => !afterIds.has(id));
      const updated = [...afterIds].filter((id) => beforeIds.has(id));
      const n = await writeWorkflows(p, a.sheets);
      openInBrowser('/');
      const warns = lintSheets(incoming);
      return `saved ${n} sheet(s) — added: [${added.join(', ')}]  updated: [${updated.join(', ')}]  removed: [${removed.join(', ')}]` +
        (warns.length ? `\n⚠ ${warns.join('\n⚠ ')}` : '');
    }
    case 'get_sheet': return JSON.stringify(await getSheet(p, a.sheet), null, 2);
    case 'save_sheet': {
      const r = await saveSheet(p, a.sheet);
      openInBrowser('/');
      return `${r.created ? 'created' : 'updated'} sheet "${r.id}" (${r.count} sheet(s) total)` +
        (r.warnings.length ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : '');
    }
    case 'delete_sheet': {
      const n = await deleteSheet(p, a.sheet);
      openInBrowser('/');
      return `deleted sheet "${a.sheet}" (${n} remaining)`;
    }
    case 'reorder_sheets': {
      const order = await reorderSheets(p, a.order);
      openInBrowser('/');
      return `sheet order: ${order.join(', ')}`;
    }
    case 'set_station': {
      const r = await setStation(p, a.sheet, a.station, a.index);
      openInBrowser('/');
      return `${r.created ? 'added' : 'replaced'} station #${r.index} in "${a.sheet}" (${r.count} station(s))`;
    }
    case 'delete_station': {
      const r = await deleteStation(p, a.sheet, a.index);
      openInBrowser('/');
      return `deleted station #${a.index} from "${a.sheet}" (${r.count} remaining)`;
    }
    case 'get_workflow_review': return JSON.stringify(await readWorkflowReview(p), null, 2);
    case 'set_workflow_decision': {
      if (!a.answer || !a.answer.trim()) throw new Error('answer is required');
      const exists = (await workflowQuestions(p)).some((q) => q.sheet === a.sheet && q.text === a.question);
      if (!exists) throw new Error(`no open question with that exact text on sheet "${a.sheet}" — see list_open_questions for the exact wording`);
      await setWorkflowDecision(p, a.sheet, a.question, a.answer, a.by);
      openInBrowser('/'); scheduleReload();   // review writes are watcher-excluded; nudge open tabs
      return `decided on "${a.sheet}": ${a.question}\n→ ${a.answer.trim()}`;
    }
    case 'reopen_workflow_question': {
      await reopenWorkflowQuestion(p, a.sheet, a.question);
      openInBrowser('/'); scheduleReload();
      return `reopened on "${a.sheet}": ${a.question}`;
    }

    case 'set_param': {
      const r = await readReview(p, a.algorithm); r.params = r.params || {}; r.params[a.key] = a.value;
      const out = await writeReview(p, a.algorithm, r);
      scheduleReload();
      return `set ${a.key} = ${a.value}\n${JSON.stringify(out.params)}`;
    }
    case 'set_comment': {
      const r = await readReview(p, a.algorithm); r.comments = r.comments || {};
      if (a.text && a.text.trim()) r.comments[a.step] = a.text.trim(); else delete r.comments[a.step];
      await writeReview(p, a.algorithm, r);
      scheduleReload();
      return `comment on step ${a.step} ${a.text && a.text.trim() ? 'saved' : 'cleared'}`;
    }
    case 'set_decision': {
      if (!a.answer || !a.answer.trim()) throw new Error('answer is required');
      const r = await readReview(p, a.algorithm); r.decisions = r.decisions || {};
      r.decisions[a.step] = { answer: a.answer.trim(), by: (a.by || 'assistant').trim(), at: new Date().toISOString().slice(0, 10) };
      await writeReview(p, a.algorithm, r);
      scheduleReload();
      return `decided step ${a.step}: ${r.decisions[a.step].answer}`;
    }
    case 'reopen_question': {
      const r = await readReview(p, a.algorithm); r.decisions = r.decisions || {};
      delete r.decisions[a.step];
      await writeReview(p, a.algorithm, r);
      scheduleReload();
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
          instructions:
            'Workflow Atlas lets you SHOW algorithms/workflows as visuals instead of describing them. ' +
            'When the user says they have reviewed, commented, or answered the open questions in the app, ' +
            'call list_open_questions (and get_review / get_workflow_review) to read their decisions back, ' +
            'then revise the affected storyboards/sheets and summarize what changed — this closes the review loop. ' +
            'Prefer the per-piece tools (save_sheet, set_station) over save_workflows, which replaces ALL sheets.',
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
  // the MCP surface can write files and delete content; only honor same-machine,
  // same-origin callers so a website or LAN peer can't drive it (CSRF / rebinding).
  if (!isLocalRequest(req)) { res.writeHead(403); return res.end('forbidden: local requests only'); }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version' });
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const resp = await dispatch(msg);
  if (!resp) { res.writeHead(202); return res.end(); }
  return json(res, 200, resp);
}

// MCP over stdio — how an MCP client (e.g. Claude Code) launches & manages this server.
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
  for (const res of reloadClients) {
    try { res.write('data: reload\n\n'); } catch { reloadClients.delete(res); }   // drop dead writers
  }
}
let reloadTimer = null;
const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(broadcastReload, 120); };
// 1) the app files in this repo (so restyling via set_file refreshes the tab)
try {
  watch(ROOT, { recursive: true }, (_ev, file) => {
    if (!file) return;
    const f = String(file).split(path.sep).join('/');
    if (f.startsWith('node_modules/') || f.startsWith('.git/') || f.endsWith('.bak') || f.includes('.tmp-')) return;
    scheduleReload();
  });
} catch (e) { log('live-reload (app) unavailable:', e.message); }
// 2) project data in the home dir — authoring (this session OR another) refreshes
// open tabs. Skip reviews (the app's own autosaves) and atomic-write temp/.bak files.
try {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  watch(PROJECTS_DIR, { recursive: true }, (_ev, file) => {
    if (!file) return;
    const f = String(file).split(path.sep).join('/');
    if (f.includes('/reviews/') || f.endsWith('.bak') || f.includes('.tmp-')) return;
    scheduleReload();
  });
} catch (e) { log('live-reload (data) unavailable:', e.message); }

/* ---------------- REST + static ---------------- */
async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'workflow-atlas', port: activePort });
  if (url.pathname === '/api/livereload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    reloadClients.add(res);
    // a periodic comment-line heartbeat keeps proxies/NAT from dropping the idle
    // stream, and lets us notice a dead peer; remove the client on any teardown.
    const hb = setInterval(() => { try { res.write(':keepalive\n\n'); } catch { /* dropped */ } }, 25000);
    const drop = () => { clearInterval(hb); reloadClients.delete(res); };
    req.on('close', drop);
    res.on('error', drop);
    return;   // long-lived connection
  }
  // Everything below exposes project data (and enumerates projects), so it is
  // local-only — same defense as the write paths, against a website reading it.
  if (!isLocalRequest(req)) return json(res, 403, { error: 'local requests only' });

  // the projects this install knows about + which one this server process authors
  if (url.pathname === '/api/projects') return json(res, 200, { projects: await listProjects(), current: CURRENT_PROJECT });

  // everything else is project-scoped: /api/p/<project>/<resource>
  const pm = url.pathname.match(/^\/api\/p\/([^/]+)\/(.+)$/);
  if (pm) {
    const proj = slug(decodeURIComponent(pm[1]));
    const rest = pm[2];

    // content reads (the app fetches these instead of static content/ files)
    if (req.method === 'GET' && rest === 'workflows') return json(res, 200, await readWorkflows(proj));
    if (req.method === 'GET' && rest === 'index') {
      try { return json(res, 200, JSON.parse(await fs.readFile(indexPath(proj), 'utf8'))); }
      catch { return json(res, 200, { algorithms: await listAlgorithms(proj) }); }
    }
    const am = rest.match(/^algorithm\/([^/]+)$/);
    if (am && req.method === 'GET') {
      const id = decodeURIComponent(am[1]);
      if (!safeId(id)) return json(res, 400, { error: 'invalid algorithm' });
      try { return json(res, 200, await readAlgorithm(proj, id)); } catch { return json(res, 404, { error: 'not found' }); }
    }

    // workflow review — single-decision PATCH so a browser answer can't clobber a
    // decision recorded by MCP (or another tab) since the page loaded.
    if (rest === 'workflow-review') {
      if (req.method === 'GET') return json(res, 200, await readWorkflowReview(proj));
      if (req.method === 'PUT') {
        if (!isLocalRequest(req)) return json(res, 403, { error: 'local requests only' });
        try {
          const obj = JSON.parse(await readBody(req));
          let saved;
          if (obj && typeof obj.sheet === 'string' && typeof obj.question === 'string') {
            saved = obj.decision
              ? await setWorkflowDecision(proj, obj.sheet, obj.question, obj.decision.answer, obj.decision.by)
              : await reopenWorkflowQuestion(proj, obj.sheet, obj.question);
          } else { saved = await writeWorkflowReview(proj, obj); }
          return json(res, 200, { ok: true, saved });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 405, { error: 'GET or PUT' });
    }

    // algorithm review (tuned params + comments + decisions)
    const rm = rest.match(/^review\/([^/]+)$/);
    if (rm) {
      const id = decodeURIComponent(rm[1]);
      if (!safeId(id)) return json(res, 400, { error: 'invalid algorithm' });
      if (req.method === 'GET') return json(res, 200, await readReview(proj, id));
      if (req.method === 'PUT') {
        if (!isLocalRequest(req)) return json(res, 403, { error: 'local requests only' });
        try {
          const obj = JSON.parse(await readBody(req));
          return json(res, 200, { ok: true, saved: await writeReview(proj, id, obj) });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 405, { error: 'GET or PUT' });
    }
  }
  return json(res, 404, { error: 'not found' });
}

// top-level paths that must never be served over HTTP (source, VCS, deps, agent
// config, and the demo seed — the app reads project data from /api instead)
const STATIC_DENY = new Set(['server', '.git', 'node_modules', '.claude', 'content']);
async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  // contain to the project root — compare WITH the separator so a sibling dir that
  // merely shares the name prefix (e.g. workflow-atlas-backup) can't be reached.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  const top = path.relative(ROOT, filePath).split(path.sep)[0];
  if (STATIC_DENY.has(top) || filePath.endsWith('.bak')) { res.writeHead(403); return res.end('forbidden'); }
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
    // launched by hand (npm start, interactive) rather than as an MCP stdio worker:
    // there is no stdin peer to talk to, so just show the existing UI and exit
    // instead of lingering as an inert process that serves nothing.
    if (process.stdin.isTTY) { openInBrowser('/'); setTimeout(() => process.exit(0), 300); }
    return;
  }
  // occupied by something unrelated — step to the next port and serve the UI there.
  if (portTries < MAX_PORT_TRIES) {
    const next = PORT + (++portTries);
    log(`port ${activePort} is busy (not workflow-atlas) — trying ${next}…`);
    activePort = next;
    setTimeout(() => server.listen(next, HOST), 60);
  } else {
    log(`no free port found after ${MAX_PORT_TRIES} tries — continuing with MCP over stdio only.`);
  }
});

// make sure this session's project exists (so it appears in the picker), seeding
// demos only when WORKFLOW_ATLAS_SEED is set.
ensureDirs(CURRENT_PROJECT).catch(() => {});

server.listen(activePort, HOST, () => {
  log(`atlas → http://localhost:${activePort}/  (app · REST: /api · MCP: /mcp + stdio)`);
  log(`project "${CURRENT_PROJECT}" · data in ${ATLAS_HOME}`);
});

// always accept MCP over stdio (active when an MCP client spawns us; harmless otherwise)
startStdio();
