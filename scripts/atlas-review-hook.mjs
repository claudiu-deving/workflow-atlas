#!/usr/bin/env node
// Atlas review hook (Claude Code UserPromptSubmit).
//
// Surfaces recorded decisions (and per-step comments) to Claude as context, so it
// reads them back and revises without you re-prompting.
//
// Firing is PER UNIT (each algorithm storyboard / each workflow sheet): a unit
// fires as soon as ALL of ITS OWN questions are answered — unrelated units with
// still-open questions (e.g. the bundled demo content) never block it. Each unit
// fires only ONCE per answered state; a per-id signature map under content/reviews/
// records what was last surfaced. It never blocks your prompt: on any error it
// exits 0 with no output. Set ATLAS_HOOK_DEBUG=1 to print diagnostics to stderr
// (which Claude Code surfaces) so a misconfigured hook is discoverable.
//
// Content is resolved relative to THIS script (../content), because the Atlas MCP
// server stores its data in its OWN repo — not in whatever project Claude Code is
// pointed at (CLAUDE_PROJECT_DIR). Override with ATLAS_CONTENT_DIR if needed.
//
// Wire it as a UserPromptSubmit command hook with the ABSOLUTE path to this file
// (Claude Code is normally open in a different project than the Atlas repo):
//   { "type": "command", "command": "node \"/abs/path/to/workflow-atlas/scripts/atlas-review-hook.mjs\"" }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const debug = (...a) => { if (process.env.ATLAS_HOOK_DEBUG) process.stderr.write('[atlas-review-hook] ' + a.join(' ') + '\n'); };

try {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const CONTENT = process.env.ATLAS_CONTENT_DIR || path.resolve(HERE, '..', 'content');
  const ALG_DIR = path.join(CONTENT, 'algorithms');
  const REVIEW_DIR = path.join(CONTENT, 'reviews');
  const WORKFLOWS = path.join(CONTENT, 'workflows.json');
  const MARKER = path.join(REVIEW_DIR, '.hook-surfaced');   // gitignored (content/reviews/*)

  const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

  // A "unit" is one algorithm or one sheet — it tracks its own decisions,
  // comments, and open count so it fires independently of the others.
  const units = [];   // { key, label, decisions[], comments[], open }

  // ---- algorithm storyboards ----
  let algFiles = [];
  try { algFiles = fs.readdirSync(ALG_DIR).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of algFiles) {
    const id = f.replace(/\.json$/, '');
    const spec = readJSON(path.join(ALG_DIR, f), null);
    if (!spec) continue;
    const review = readJSON(path.join(REVIEW_DIR, `${id}.json`), {});
    const dec = review.decisions || {};
    const cmt = review.comments || {};
    const unit = { key: `alg:${id}`, label: `algorithm ${id}`, decisions: [], comments: [], open: 0 };
    const qs = spec.builtin
      ? (spec.questions || []).map((q) => ({ step: q.step, text: q.text }))
      : (spec.steps || []).map((st, i) => (st && st.question ? { step: i, text: st.question } : null)).filter(Boolean);
    for (const q of qs) {
      const d = dec[q.step];
      if (d) unit.decisions.push({ where: `${unit.label} · step ${q.step}`, question: q.text, answer: d.answer, by: d.by });
      else unit.open++;
    }
    for (const step of Object.keys(cmt)) {
      if (cmt[step]) unit.comments.push({ where: `${unit.label} · step ${step}`, text: cmt[step] });
    }
    units.push(unit);
  }

  // ---- workflow sheets ----
  const wf = readJSON(WORKFLOWS, { sheets: [] });
  const wfDec = (readJSON(path.join(REVIEW_DIR, '_workflows.json'), {}).decisions) || {};
  for (const s of wf.sheets || []) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;   // skip malformed sheets
    const unit = { key: `sheet:${s.id}`, label: `workflow ${s.id}`, decisions: [], comments: [], open: 0 };
    const seen = new Set();
    const collect = (detail, where) => {
      for (const q of (detail && detail.open) || []) {
        if (seen.has(q)) continue;   // duplicate question text resolves to one decision
        seen.add(q);
        const d = (wfDec[s.id] || {})[q];
        if (d) unit.decisions.push({ where: `${unit.label} · ${where}`, question: q, answer: d.answer, by: d.by });
        else unit.open++;
      }
    };
    for (const st of s.stations || []) {
      collect(st.detail, st.title || 'station');
      for (const t of (st.fan && st.fan.tracks) || []) collect(t.detail, `${st.title} › ${t.title}`);
    }
    units.push(unit);
  }

  // Per-unit marker: { <unit.key>: <signature> } of what was last surfaced. Only
  // honor alg:/sheet: keys, so a legacy or corrupt marker shape is ignored.
  const stored = readJSON(MARKER, {});
  const marker = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const k of Object.keys(stored)) if (/^(alg|sheet):/.test(k)) marker[k] = stored[k];
  }

  // Rebuild the marker from ONLY the currently-ready units (none open, ≥1 answered),
  // so a reopened or deleted unit drops out of it — re-answering later, even to the
  // same value, fires again, and stale keys never accumulate. A unit fires when its
  // signature is new or changed vs what was last surfaced.
  const firing = [];
  const nextMarker = {};
  let ready = 0;
  for (const u of units) {
    if (u.open > 0 || u.decisions.length === 0) continue;
    ready++;
    const signature = JSON.stringify({ decisions: u.decisions, comments: u.comments });
    nextMarker[u.key] = signature;
    if (marker[u.key] !== signature) firing.push(u);
  }

  debug(`content=${CONTENT} units=${units.length} ready=${ready} firing=${firing.length}`);

  // Persist whenever the marker changed — including a reopen that pruned a key but
  // fired nothing — so a later same-value re-answer isn't suppressed by a stale entry.
  if (JSON.stringify(nextMarker) !== JSON.stringify(marker)) {
    try { fs.mkdirSync(REVIEW_DIR, { recursive: true }); fs.writeFileSync(MARKER, JSON.stringify(nextMarker, null, 2)); } catch { /* best effort */ }
  }

  if (firing.length === 0) process.exit(0);

  const decisions = firing.flatMap((u) => u.decisions);
  const comments = firing.flatMap((u) => u.comments);
  const names = firing.map((u) => u.label).join(', ');

  let ctx = `Workflow Atlas review: all open questions are now answered for ${names}. `
    + `Read these decisions back and revise the affected storyboards/workflows over MCP `
    + `(set_param / save_algorithm / save_sheet / set_station etc.), then summarize what you changed.\n\nDecisions:\n`;
  for (const d of decisions) ctx += `- [${d.where}] ${d.question}\n    → ${d.answer}${d.by ? ` (${d.by})` : ''}\n`;
  if (comments.length) {
    ctx += `\nComments:\n`;
    for (const c of comments) ctx += `- [${c.where}] ${c.text}\n`;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  }));
  process.exit(0);
} catch (e) {
  debug('error: ' + (e && e.message));
  process.exit(0);   // never block the prompt on a hook error
}
