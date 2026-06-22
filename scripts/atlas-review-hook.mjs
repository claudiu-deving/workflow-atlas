#!/usr/bin/env node
// Atlas review hook (Claude Code UserPromptSubmit).
//
// When EVERY authored open question in the Workflow Atlas review — across
// algorithm storyboards and workflow sheets — has been answered, this surfaces
// all the recorded decisions (and per-step comments) to Claude as context, so it
// reads them back and revises without you re-prompting. It stays silent while any
// question is still open, and fires only ONCE per completed state (a marker under
// content/reviews/ records what was last surfaced). It never blocks your prompt:
// on any error it simply exits 0 with no output.
//
// Wire it as a UserPromptSubmit command hook:
//   node "$CLAUDE_PROJECT_DIR/scripts/atlas-review-hook.mjs"

import fs from 'node:fs';
import path from 'node:path';

try {
  const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const CONTENT = path.join(ROOT, 'content');
  const ALG_DIR = path.join(CONTENT, 'algorithms');
  const REVIEW_DIR = path.join(CONTENT, 'reviews');
  const WORKFLOWS = path.join(CONTENT, 'workflows.json');
  const MARKER = path.join(REVIEW_DIR, '.hook-surfaced');   // gitignored (content/reviews/*)

  const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

  const decisions = [];   // answered questions
  const comments = [];    // per-step comments
  let openCount = 0;      // still-unanswered questions

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
    const qs = spec.builtin
      ? (spec.questions || []).map((q) => ({ step: q.step, text: q.text }))
      : (spec.steps || []).map((st, i) => (st && st.question ? { step: i, text: st.question } : null)).filter(Boolean);
    for (const q of qs) {
      const d = dec[q.step];
      if (d) decisions.push({ where: `algorithm ${id} · step ${q.step}`, question: q.text, answer: d.answer, by: d.by });
      else openCount++;
    }
    for (const step of Object.keys(cmt)) {
      if (cmt[step]) comments.push({ where: `algorithm ${id} · step ${step}`, text: cmt[step] });
    }
  }

  // ---- workflow sheets ----
  const wf = readJSON(WORKFLOWS, { sheets: [] });
  const wfDec = (readJSON(path.join(REVIEW_DIR, '_workflows.json'), {}).decisions) || {};
  for (const s of wf.sheets || []) {
    const collect = (detail, where) => {
      for (const q of (detail && detail.open) || []) {
        const d = (wfDec[s.id] || {})[q];
        if (d) decisions.push({ where: `workflow ${s.id} · ${where}`, question: q, answer: d.answer, by: d.by });
        else openCount++;
      }
    };
    for (const st of s.stations || []) {
      collect(st.detail, st.title || 'station');
      for (const t of (st.fan && st.fan.tracks) || []) collect(t.detail, `${st.title} › ${t.title}`);
    }
  }

  const totalQuestions = decisions.length + openCount;
  // Only act when there are questions AND none remain open.
  if (totalQuestions === 0 || openCount > 0) process.exit(0);

  // Fire once: skip if this exact answered state was already surfaced.
  const signature = JSON.stringify({ decisions, comments });
  let last = '';
  try { last = fs.readFileSync(MARKER, 'utf8'); } catch { /* first time */ }
  if (signature === last) process.exit(0);

  // Build the context block.
  let ctx = `Workflow Atlas review: all ${decisions.length} open question(s) are now answered. `
    + `Read these decisions back and revise the affected storyboards/workflows over MCP `
    + `(set_param / save_algorithm / save_sheet / set_station etc.), then summarize what you changed.\n\nDecisions:\n`;
  for (const d of decisions) ctx += `- [${d.where}] ${d.question}\n    → ${d.answer}${d.by ? ` (${d.by})` : ''}\n`;
  if (comments.length) {
    ctx += `\nComments:\n`;
    for (const c of comments) ctx += `- [${c.where}] ${c.text}\n`;
  }

  try { fs.mkdirSync(REVIEW_DIR, { recursive: true }); fs.writeFileSync(MARKER, signature); } catch { /* best effort */ }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  }));
  process.exit(0);
} catch {
  // never block the prompt on a hook error
  process.exit(0);
}
