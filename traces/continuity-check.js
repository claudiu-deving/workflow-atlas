// Storyboard trace for: validate that a selected run is one continuous member.
// Same scene model as collinear-run (beams as top-view line segments). Here the
// run is already chosen (auto or hand-picked) and we CHECK every interior joint,
// flagging the ones that break continuity — we do NOT stop at the first failure.

export const meta = {
  id: 'continuity-check',
  code: 'ALG-02',
  name: 'Continuity check',
  title: 'Validate a run is one continuous member',
  sub: 'Given an ordered run (auto-detected or hand-picked), check every interior joint — shared end, collinear, no kink, same section — and flag the ones that break continuity.',
  workflow: { sheet: 'select-isolate', label: 'Select & isolate › validate continuity' },
};

export const params = [
  { key: 'eps_ang',  label: 'max off-axis angle', sym: 'ε_ang',  value: 2,  unit: '°',  min: 0, max: 90,  step: 0.5,
    hint: 'How far a beam can point off the previous one and still read as collinear.' },
  { key: 'eps_pos',  label: 'max joint gap', sym: 'ε_pos', value: 10, unit: 'mm', min: 0, max: 200, step: 1,
    hint: 'How far two beam ends can sit apart and still count as a shared joint.' },
  { key: 'eps_perp', label: 'max lateral offset', sym: 'ε_perp', value: 8,  unit: 'mm', min: 0, max: 100, step: 1,
    hint: 'How far a beam can sit sideways off the line before the joint reads as a kink.' },
  { key: 'require_section', label: 'same section only', sym: '', value: 1, unit: '', min: 0, max: 1, step: 1,
    hint: 'On = the whole run must keep one cross-section. Off = allow section changes.' },
];

export const scene = {
  beams: [
    { id: 'r1', a: [-9, 0], b: [-6, 0], section: 'R30×60' },
    { id: 'r2', a: [-6, 0], b: [-3, 0], section: 'R30×60' },
    { id: 'r3', a: [-3, 0], b: [0, 0],  section: 'R30×60' },
    { id: 'r4', a: [0, 0],  b: [3, 0],  section: 'R40×60' },   // section changes at joint r3–r4
    { id: 'r5', a: [3, 0],  b: [5.83, 0.49], section: 'R40×60' }, // ~10° kink at joint r4–r5
  ],
  seed: 'r1',
};

export const code = [
  'checkContinuity(run):',
  '  flags = []',
  '  for each interior joint J(i, i+1):',
  '    shared end: gap ≤ ε_pos',
  '    collinear:  |dot| ≥ cos ε_ang',
  '    no kink:    perp ≤ ε_perp',
  '    same section across J',
  '    if any fails: flags.push(J)',
  '  continuous ⇔ flags is empty',
];

// reuses collinear-run's step model: each 'test' is the joint to the next beam.
// Every test carries an `advance` so the walk continues even after a flagged
// joint (we want to report ALL defects, not stop at the first).
export const steps = [
  { act: 'intro', code: [0], note: 'A run of 5 beams was selected (auto or hand-picked). Check that every interior joint is a clean, continuous connection.' },
  { act: 'seed', beam: 'r1', code: [1], note: 'Start at the first beam and step joint by joint.' },

  { act: 'frontier', at: [-6, 0], dir: [1, 0], side: 'right', code: [2],
    note: 'Joint r1–r2.' },
  { act: 'test', cand: 'r2', at: [-6, 0], dir: [1, 0], m: { angle: 0, gap: 0, perp: 0, section: true },
    advance: { at: [-3, 0], dir: [1, 0] }, note: 'Aligned, touching, same section — a clean joint.' },
  { act: 'test', cand: 'r3', at: [-3, 0], dir: [1, 0], m: { angle: 0, gap: 0, perp: 0, section: true },
    advance: { at: [0, 0], dir: [1, 0] }, note: 'Joint r2–r3 is clean too.' },
  { act: 'test', cand: 'r4', at: [0, 0], dir: [1, 0], m: { angle: 0, gap: 0, perp: 0, section: false },
    advance: { at: [3, 0], dir: [1, 0] }, note: 'Joint r3–r4: geometry lines up, but the section jumps R30×60 → R40×60.' },
  { act: 'test', cand: 'r5', at: [3, 0], dir: [1, 0], m: { angle: 10, gap: 0, perp: 0, section: true },
    advance: { at: [5.83, 0.49], dir: [0.98, 0.17] }, note: 'Joint r4–r5: same section, but the beam kinks ~10° off the line.' },

  { act: 'done', code: [8], bad: true,
    summary: '✗ 2 joints flagged: r3–r4 (section change), r4–r5 (kink) — not one continuous member as picked.',
    note: 'Two joints break continuity. Options: split the run at the flagged joints, drop the offending beams, or loosen the relevant tolerance if the engineer accepts it.' },
];
