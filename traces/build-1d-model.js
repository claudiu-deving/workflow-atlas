// Calc storyboard: reduce the isolated run + its supports to a 1D analysis model
// — a node at every support and member end, and a span between consecutive nodes.
// This is the line model the analysis (M/V/T) runs on.
//
// Geometric by nature; shown here as a derivation worksheet. A richer version
// would draw the nodes/spans on the beam stage (future enhancement).

export const meta = {
  id: 'build-1d-model',
  code: 'ALG-07',
  name: 'Build 1D model',
  title: 'Derive the 1D analysis model',
  sub: 'From the isolated run and its supports, place a node at each support and member end, and a span between consecutive nodes.',
  workflow: { sheet: 'select-isolate', label: 'Select & isolate › derive 1D model' },
};

export const kind = 'calc';

export const params = [
  { key: 'nSpans',  label: 'number of spans', sym: 'n', value: 2, unit: '', min: 1, max: 10, step: 1 },
  { key: 'spanLen', label: 'span length', sym: 'L', value: 6, unit: 'm', min: 1, max: 20, step: 0.5 },
  { key: 'overhang', label: 'end overhang', sym: 'o', value: 0, unit: 'm', min: 0, max: 5, step: 0.25 },
];

export const code = [
  'build1D(run, supports):',
  '  node at each support and each member end',
  '  span between consecutive nodes',
  '  classify: internal span | cantilever',
  '  → ordered nodes + spans for analysis',
];

const r1 = (x) => Math.round(x * 10) / 10;

export function compute(p) {
  const nSpans = Math.round(p.nSpans);
  const { spanLen, overhang } = p;
  const supports = nSpans + 1;
  const positions = [];
  for (let i = 0; i <= nSpans; i++) positions.push(r1(i * spanLen));
  const hasOver = overhang > 0;
  const nodes = supports + (hasOver ? 1 : 0);
  const totalLen = r1(nSpans * spanLen + overhang);
  const spanRows = [];
  for (let i = 1; i <= nSpans; i++) spanRows.push(`S${i} = N${i}–N${i + 1} = ${spanLen} m (internal)`);
  if (hasOver) spanRows.push(`S${nSpans + 1} = cantilever = ${overhang} m`);
  const nSpansTotal = nSpans + (hasOver ? 1 : 0);

  return [
    { kind: 'input', label: 'Inputs', line: 0,
      sub: `${nSpans} span(s) of ${spanLen} m${hasOver ? ` + ${overhang} m overhang` : ''}, total ${totalLen} m`,
      note: 'The run length, how many supports break it into spans, and any free overhang.' },
    { label: 'Support nodes', expr: 'node at each support', line: 1,
      sub: `positions: ${positions.map((x, i) => `N${i + 1}@${x}m`).join(' · ')}`, result: `${supports} nodes`,
      note: 'Each support becomes an analysis node.',
      question: 'Where do support fixities (pin / roller / fixed) come from — read from the Loads & constraints sheet, or inferred from the IFC connections?' },
    { label: 'End / overhang nodes', expr: 'node at each free member end', line: 1,
      sub: hasOver ? `+1 free end node beyond the last support` : 'no overhang — ends coincide with end supports', result: hasOver ? '+1 node' : '+0',
      note: 'A cantilever tip is a free-end node.' },
    { kind: 'result', label: 'Spans', expr: 'span between consecutive nodes', line: 2,
      sub: spanRows.join('  ·  '), result: `${nSpansTotal} span(s)`,
      note: 'Segments the analysis solves over; cantilevers are flagged.' },
    { kind: 'result', label: '1D model', expr: 'ordered nodes + spans', line: 4,
      sub: `${nodes} nodes, ${nSpansTotal} spans, length ${totalLen} m`, result: `${nodes}N / ${nSpansTotal}S`,
      note: 'The line model handed to beam analysis.' },
  ];
}

export function summary(p) {
  const rows = compute(p);
  const m = rows.find((r) => r.label === '1D model');
  return `→ ${m.result}`;
}
