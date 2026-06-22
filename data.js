// Workflow data for the atlas. Replace the SHEETS below with your own.
// status: 'done' (shipped) | 'partial' (exists in pieces) | 'todo' (to build)
// A station may carry: detail {in[], out[], note, open[]}, loop {to, label}, or
// be a fan {tracks:[{title,status,detail}]} — parallel branches off the spine.
// A station or track may carry algorithm:'<trace-id>' to link to its storyboard
// (see traces/) — the renderer shows a "storyboard" link that opens it.
//
// The example below is a generic "ship a feature" pipeline — purely demo content.

export const SHEETS = [
  {
    id: 'overview', code: 'SH-00', name: 'Feature — end to end',
    title: 'From idea to release',
    sub: 'The whole arc of shipping a change: frame it, design it, build it, verify it, release it.',
    stations: [
      { title: 'Frame the problem', sub: 'what are we solving, and for whom', status: 'done',
        detail: { in: ['Request / ticket'], out: ['A one-line problem statement', 'Success criteria'],
          note: 'Agree on the problem before any solution.' } },
      { title: 'Design the approach', sub: 'pick an algorithm and a shape', status: 'partial',
        algorithm: 'binary-search',
        detail: { in: ['Problem statement'], out: ['Chosen approach', 'Interfaces / data shapes'],
          note: 'Sketch the core algorithm as a storyboard before committing.',
          open: ['Build the simple version first, or design for scale up front?',
                 'Which inputs must we handle on day one?'] } },
      { title: 'Implement', sub: 'write the code behind the design', status: 'todo',
        detail: { in: ['Approved design'], out: ['Working code on a branch'] } },
      { title: 'Verify', sub: 'tests, review, manual check', status: 'todo',
        loop: { to: 2, label: 'changes requested' },
        detail: { in: ['Branch'], out: ['Green build', 'Reviewed diff'],
          note: 'If review asks for changes, loop back to implement.' } },
      { title: 'Release', sub: 'ship the three deliverables', status: 'todo',
        fan: { tracks: [
          { title: 'Deploy to production', status: 'todo' },
          { title: 'Update the docs', status: 'todo' },
          { title: 'Add telemetry / alerts', status: 'todo' },
        ] },
        detail: { in: ['Merged change'], out: ['Live feature', 'Docs', 'Dashboards'] } },
    ],
  },

  {
    id: 'design', code: 'SH-01', name: 'Design',
    title: 'Design the approach',
    sub: 'Turn a problem statement into a concrete plan — and prove the core idea with a storyboard.',
    stations: [
      { title: 'List the inputs & outputs', status: 'done',
        detail: { in: ['Problem statement'], out: ['Input set', 'Expected output'] } },
      { title: 'Pick the core algorithm', sub: 'the heart of the feature', status: 'partial',
        algorithm: 'binary-search',
        detail: { note: 'Storyboard the candidate before writing it.',
          open: ['Is the data already sorted, or do we sort first?'] } },
      { title: 'Define the data shapes', sub: 'types, invariants, edge cases', status: 'todo',
        detail: { out: ['Interfaces / schemas'] } },
      { title: 'Sign off the design', sub: 'ready to implement', status: 'todo',
        detail: { note: 'Everything below the spine merges here before coding starts.' } },
    ],
  },

  {
    id: 'build-verify', code: 'SH-02', name: 'Build & verify',
    title: 'Implement, then prove it works',
    sub: 'Code the design, cover it with tests, and watch the algorithms run before review.',
    stations: [
      { title: 'Implement the algorithm', status: 'todo', algorithm: 'binary-search' },
      { title: 'Handle the edge cases', sub: 'empty, duplicate, not-found', status: 'todo',
        algorithm: 'bubble-sort',
        detail: { open: ['Fail loudly or return a sentinel when the input is empty?'] } },
      { title: 'Unit tests', sub: 'one per branch of the logic', status: 'todo' },
      { title: 'Self-review the diff', sub: 'read it like a stranger would', status: 'todo',
        loop: { to: 0, label: 'rework' } },
      { title: 'Open the pull request', sub: 'hand it to a reviewer', status: 'todo',
        detail: { out: ['Reviewable change'] } },
    ],
  },
];
