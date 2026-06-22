// Hand-authored storyboard trace for: auto-detect a continuous run of beams.
// Top-view scene (world X horizontal, Z vertical). Coords in metres.
//
// Each `test` step carries the raw MEASUREMENT (angle, gap, ...). Whether it
// passes is decided at render time against the editable `params` below — so
// changing a tolerance in the app re-evaluates the walk live.

export const meta = {
  id: 'collinear-run',
  code: 'ALG-01',
  name: 'Collinear beam run',
  title: 'Auto-detect a continuous beam run',
  sub: 'Click one beam; grow the maximal chain of collinear, touching, same-section beams that form a single structural member.',
  // the workflow step this algorithm sits behind (links back to the atlas)
  workflow: { sheet: 'select-isolate', label: 'Select & isolate › run detection' },
};

// Editable in the app. `label` is the plain-English name; `sym` is the symbol
// used in the pseudocode; `value` is the default (the player persists overrides).
export const params = [
  { key: 'eps_ang',  label: 'max off-axis angle', sym: 'ε_ang',  value: 2,  unit: '°',  min: 0, max: 90,  step: 0.5,
    hint: 'How far off the seed beam’s axis a candidate can point and still count as “parallel”.' },
  { key: 'eps_pos',  label: 'max joint gap', sym: 'ε_pos', value: 10, unit: 'mm', min: 0, max: 200, step: 1,
    hint: 'How far two beam ends can sit apart and still count as “touching”.' },
  { key: 'eps_perp', label: 'max lateral offset', sym: 'ε_perp', value: 8,  unit: 'mm', min: 0, max: 100, step: 1,
    hint: 'How far a candidate can sit sideways off the run’s line before it reads as a kink.' },
  { key: 'require_section', label: 'same section only', sym: '', value: 1, unit: '', min: 0, max: 1, step: 1,
    hint: 'On = the whole run must keep one cross-section. Off = ignore section changes.' },
];

export const scene = {
  beams: [
    { id: 'b1', a: [-12.05, 0], b: [-9.05, 0], section: 'R30×40' },   // collinear but a gap away, different section
    { id: 'b2', a: [-9, 0],     b: [-6, 0],     section: 'R30×60' },
    { id: 'b3', a: [-6, 0],     b: [-3, 0],     section: 'R30×60' },   // seed
    { id: 'b4', a: [-3, 0],     b: [0, 0],      section: 'R30×60' },
    { id: 'b5', a: [0, 0],      b: [3, 0],      section: 'R30×60' },
    { id: 'b6', a: [-6, 0],     b: [-6, 3],     section: 'R30×50' },   // secondary, frames in at 90°
    { id: 'b7', a: [0, 0],      b: [0, 3],      section: 'R30×50' },   // secondary, frames in at 90°
    { id: 'b8', a: [3, 0],      b: [5.97, 0.42], section: 'R30×60' },  // continues, but bends 8° off axis
  ],
  seed: 'b3',
};

// pseudocode pane — kept short so it never overflows the container
export const code = [
  'detectRun(seed):',
  '  run = [seed]',
  '  for end in seed.A, seed.B:',
  '    while frontier open:',
  '      cand = best(P, dir):',
  '        touch: gap ≤ ε_pos',
  '        angle: |dot| ≥ cos ε_ang',
  '        kink:  perp ≤ ε_perp',
  '        sect:  matches run',
  '      if none: break',
  '      accept; advance',
  '  return run',
];

// act: intro | seed | frontier | switchEnd | test | done
// test carries m:{ angle°, gap mm, perp mm?, section bool } and advance:{at,dir}
// any step may carry question:'…' — an open design question, resolvable in-app;
// the decision (answer/by/at) is stored in <id>.review.json under decisions[step].
export const steps = [
  { act: 'intro', code: [0], note: 'The engineer clicked beam b3. Goal: find every beam that continues it as one straight member.' },
  { act: 'seed', beam: 'b3', code: [1], note: 'Start the run with the seed and walk outward from both of its ends.' },

  // ---- walk right ----
  { act: 'frontier', at: [-3, 0], dir: [1, 0], side: 'right', code: [2, 3],
    note: 'Open the right end of b3. Look for a beam that touches this point and runs the same way.' },
  { act: 'test', cand: 'b4', at: [-3, 0], dir: [1, 0], m: { angle: 0, gap: 0, perp: 0, section: true },
    advance: { at: [0, 0], dir: [1, 0] }, note: 'b4 carries straight on from b3.' },
  { act: 'test', cand: 'b7', at: [0, 0], dir: [1, 0], m: { angle: 90, gap: 0, perp: 0, section: false },
    note: 'A secondary beam frames in here, perpendicular to the run.' },
  { act: 'test', cand: 'b5', at: [0, 0], dir: [1, 0], m: { angle: 0, gap: 0, perp: 0, section: true },
    advance: { at: [3, 0], dir: [1, 0] }, note: 'b5 continues the line and shares the section.' },
  { act: 'test', cand: 'b8', at: [3, 0], dir: [1, 0], m: { angle: 8, gap: 0, perp: 0, section: true },
    advance: { at: [5.97, 0.42], dir: [0.99, 0.14] }, note: 'b8 touches the end but bends off the axis.',
    question: 'Should an 8° kink auto-join, or stop and flag it for the engineer to confirm?' },

  // ---- walk left ----
  { act: 'switchEnd', at: [-6, 0], dir: [-1, 0], side: 'left', code: [2, 3],
    note: 'Right end is exhausted. Now walk the other way, off the left end of b3.' },
  { act: 'test', cand: 'b6', at: [-6, 0], dir: [-1, 0], m: { angle: 90, gap: 0, perp: 0, section: false },
    note: 'Another secondary frames in at the left joint.' },
  { act: 'test', cand: 'b2', at: [-6, 0], dir: [-1, 0], m: { angle: 0, gap: 0, perp: 0, section: true },
    advance: { at: [-9, 0], dir: [-1, 0] }, note: 'b2 carries on to the left.' },
  { act: 'test', cand: 'b1', at: [-9, 0], dir: [-1, 0], m: { angle: 0, gap: 50, perp: 0, section: false },
    advance: { at: [-12.05, 0], dir: [-1, 0] }, note: 'b1 lines up, but its end sits a little short of b2’s.' },

  { act: 'done', code: [11],
    note: 'Both ends exhausted. The accepted beams form one continuous member; its interior joints become support nodes for the 1D model.' },
];
