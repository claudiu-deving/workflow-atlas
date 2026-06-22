// Workflow data for the atlas. Replace the SHEETS below with your own.
// status: 'done' (in the app) | 'partial' (exists in pieces) | 'todo' (to build)
// A station may carry: detail {in[], out[], note, open[]}, loop {to, label}, or
// be a fan {tracks:[{title,status,detail}]} — parallel branches off the spine.
// A station or track may carry algorithm:'<trace-id>' to link to its storyboard
// (see traces/) — the renderer shows a "storyboard" link that opens it.

export const SHEETS = [
  {
    id: 'overview', code: 'SH-00', name: 'RC beam — end to end',
    title: 'RC beam, load to shop drawings',
    sub: 'The whole milestone. Load an IFC, design the cage, hand the engineer the documents.',
    stations: [
      { title: 'Load IFC model', sub: 'web-ifc parses, geometry streams into the scene', status: 'done',
        detail: { in: ['.ifc file'], out: ['Native-IFC beams in the 3D scene'],
          note: 'Works today — beams come in as interactive entities.' } },
      { title: 'Select beam / run', sub: 'one member, or a continuous series', status: 'done',
        detail: { in: ['Click / box select'], out: ['Active selection in the Store'],
          note: 'Single-member selection works. Multi-member run detection is the gap below.' } },
      { title: 'Isolate', sub: 'lift the selection into its own working set', status: 'todo',
        algorithm: 'collinear-run',
        detail: { in: ['Selection'], out: ['Isolated working set', '1D analysis model (spans + support nodes)'],
          note: "We don't have this yet — first thing to build.",
          open: ['How is a continuous run detected — auto from collinear/adjacent, or hand-picked?',
                 'Keep the IFC GUID link for round-trip export?'] } },
      { title: 'Define structural system', sub: 'spans, supports, continuity', status: 'todo',
        detail: { in: ['Working set'], out: ['Beam line with nodes at supports'] } },
      { title: 'Assign material & exposure', sub: 'concrete class, cover, rebar grade', status: 'todo',
        detail: { in: ['Beam line'], out: ['Section + material set'] } },
      { title: 'Apply loads', sub: 'dead, live, combinations', status: 'partial',
        detail: { in: ['Beam line'], out: ['Load set'],
          note: 'Point & distributed loads exist as entities; combinations and self-weight do not.' } },
      { title: 'Set design coefficients', sub: 'safety factors, ductility, code params', status: 'todo',
        detail: { in: ['Load set'], out: ['Design input complete'] } },
      { title: 'Analyse internal forces', sub: 'M, V, T envelopes along the length', status: 'todo',
        detail: { in: ['Design input'], out: ['Force envelopes'] } },
      { title: 'Design & check rebar cage', sub: 'longitudinal, stirrups, anchorage — then code checks', status: 'todo',
        loop: { to: 6, label: 'checks fail' },
        detail: { in: ['Force envelopes'], out: ['Frozen 3D rebar cage'],
          note: 'If checks fail, return to coefficients / sizing and iterate.' } },
      { title: 'Generate deliverables', sub: 'project the frozen cage to documents', status: 'todo',
        fan: { tracks: [
          { title: 'Rebar shop drawings', status: 'todo' },
          { title: 'Cast unit drawing', status: 'todo' },
          { title: 'Bar bending schedule', status: 'todo' },
        ] },
        detail: { in: ['Frozen cage + geometry'], out: ['PDF / DXF deliverables'] } },
    ],
  },

  {
    id: 'load-ifc', code: 'SH-01', name: 'Load IFC',
    title: 'Load IFC',
    sub: 'From a file on disk to interactive beams in the scene.',
    stations: [
      { title: 'User picks .ifc file', status: 'done',
        detail: { in: ['File dialog'], out: ['ArrayBuffer'] } },
      { title: 'web-ifc parses model', status: 'done',
        detail: { out: ['Parsed IFC entities'] } },
      { title: 'Geometry streams into Three.js', status: 'done',
        detail: { out: ['Meshes in the scene'] } },
      { title: 'Beams ready to interact', status: 'done',
        detail: { out: ['Selectable native-IFC entities'],
          open: ['Map IFC structural properties on import (section, material, profile)?',
                 'Keep IFC GUID link for round-trip export?'] } },
    ],
  },

  {
    id: 'select-isolate', code: 'SH-02', name: 'Select & isolate',
    title: 'Select & isolate a beam run',
    sub: 'One member or a continuous chain, lifted into a clean working set.',
    stations: [
      { title: 'Click a beam', status: 'done',
        detail: { out: ['One member selected'] } },
      { title: 'Single or continuous run?', sub: 'branch on intent', status: 'partial',
        algorithm: 'collinear-run',
        fan: { tracks: [
          { title: 'Single member', status: 'done' },
          { title: 'Pick / auto-detect adjacent collinear beams', status: 'todo', algorithm: 'collinear-run' },
        ] },
        detail: { note: 'Run detection is the open design question for this sheet.',
          open: ['Auto-detect from collinear + adjacent geometry, or hand-pick the chain?'] } },
      { title: 'Validate continuity', sub: 'shared axis, end-to-end, same section', status: 'todo',
        algorithm: 'continuity-check' },
      { title: 'Isolate', sub: 'hide / ghost the rest of the model', status: 'todo',
        detail: { out: ['Isolated working set'] } },
      { title: 'Derive 1D analysis model', sub: 'spans + node at each support', status: 'todo',
        algorithm: 'build-1d-model',
        detail: { out: ['Subject for sheets 03–05'] } },
    ],
  },

  {
    id: 'loads-constraints', code: 'SH-03', name: 'Loads & constraints',
    title: 'Loads, constraints, materials & coefficients',
    sub: 'Four input groups, gathered into one design set.',
    stations: [
      { title: 'Supports / constraints', sub: 'pin · roller · fixed, plus continuity', status: 'partial',
        detail: { note: 'Supports exist as entities; continuity over interior supports does not.' } },
      { title: 'Loads', sub: 'self-weight, dead, live — point & distributed', status: 'partial',
        detail: { note: 'Point/distributed loads exist; self-weight and combinations do not.' } },
      { title: 'Material & section', sub: 'concrete class, cover, rebar grade', status: 'todo' },
      { title: 'Coefficients', sub: 'load factors, partial safety, code', status: 'todo' },
      { title: 'Design input set complete', sub: 'ready to analyse — sheet 04', status: 'todo',
        detail: { note: 'All four groups merge here before analysis.' } },
    ],
  },

  {
    id: 'rebar-design', code: 'SH-04', name: 'Rebar design',
    title: 'Analyse & design the rebar cage',
    sub: 'Forces in, a checked 3D cage out.',
    stations: [
      { title: 'Build 1D beam model', status: 'todo', algorithm: 'build-1d-model' },
      { title: 'Solve for envelopes', sub: 'M, V, T along the length', status: 'todo', algorithm: 'beam-analysis' },
      { title: 'Flexural design', sub: 'As required per section', status: 'todo',
        algorithm: 'flexural-design' },
      { title: 'Choose longitudinal bars', sub: 'diameter, count, layers', status: 'todo' },
      { title: 'Shear design', sub: 'stirrup size & spacing zones', status: 'todo', algorithm: 'shear-design' },
      { title: 'Detailing & anchorage', sub: 'spacing, curtailment, laps, hooks', status: 'todo' },
      { title: 'Assemble 3D cage', sub: 'reuses reb / rbg entities', status: 'partial',
        loop: { to: 2, label: 'checks fail' },
        detail: { note: 'Rebar entities exist; the design logic that drives them does not.' } },
      { title: 'Cage frozen', sub: 'feeds drawings & BBS', status: 'todo' },
    ],
  },

  {
    id: 'drawings-bbs', code: 'SH-05', name: 'Drawings & BBS',
    title: 'Deliverables — drawings & schedule',
    sub: 'Project the frozen cage to the documents the engineer downloads.',
    stations: [
      { title: 'Frozen cage + geometry', status: 'todo',
        detail: { out: ['Source for every deliverable'] } },
      { title: '2D drawing engine', sub: 'project views from the 3D model', status: 'todo' },
      { title: 'Deliverables', sub: 'three documents from one model', status: 'todo',
        fan: { tracks: [
          { title: 'Rebar shop drawing', status: 'todo', detail: { out: ['Elevation + sections', 'Bar marks & callouts'] } },
          { title: 'Cast unit drawing', status: 'todo', detail: { out: ['Formwork outline + dims', 'Embeds, cover, pour notes'] } },
          { title: 'Bar bending schedule', status: 'todo', algorithm: 'bbs-generation', detail: { out: ['Shape code, dia, length, bends, count', 'Totals, mass, cutting list'] } },
        ] } },
      { title: 'Export PDF / DXF', status: 'todo' },
    ],
  },
];
