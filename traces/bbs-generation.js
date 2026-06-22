// Calc storyboard: bar bending schedule line for a closed shear link.
// Cut length from the bend dimensions + hook allowance, with shape code & mass.
// Indicative (BS 8666 / EN style) — bend deductions and hook rules are tabulated
// in the standard; confirm the exact figures and the national convention.

export const meta = {
  id: 'bbs-generation',
  code: 'ALG-06',
  name: 'Bar bending schedule',
  title: 'BBS — cut length & shape for a link',
  sub: 'Turn a detailed bar into a schedule line: bend dimensions, hook allowance, cut length, shape code and mass — the row a fabricator works from.',
  workflow: { sheet: 'drawings-bbs', label: 'Drawings & BBS › bar bending schedule' },
};

export const kind = 'calc';

export const params = [
  { key: 'b',     label: 'section width', sym: 'b', value: 300, unit: 'mm', min: 100, max: 1000, step: 10 },
  { key: 'h',     label: 'section depth', sym: 'h', value: 600, unit: 'mm', min: 100, max: 2000, step: 10 },
  { key: 'cover', label: 'nominal cover', sym: 'c', value: 30, unit: 'mm', min: 15, max: 75, step: 5 },
  { key: 'phi',   label: 'link diameter', sym: 'φ', value: 8, unit: 'mm', min: 6, max: 16, step: 2 },
  { key: 'count', label: 'number of links', sym: 'N', value: 24, unit: '', min: 1, max: 500, step: 1 },
];

export const code = [
  'scheduleLink(section, φ):',
  '  A = h − 2·cover ;  B = b − 2·cover     (leg dims)',
  '  hook = max(10·φ, 70 mm)   ×2  (135° hooks)',
  '  cut = 2·(A + B) + 2·hook − bend deductions',
  '  round to 25 mm ; shape code 51',
  '  mass = cut · (0.00617·φ²) /1000 · N',
];

const r0 = (x) => Math.round(x);

export function compute(p) {
  const { b, h, cover, phi, count } = p;
  const A = h - 2 * cover;
  const B = b - 2 * cover;
  const hook = Math.max(10 * phi, 70);
  const deduction = 3 * 2 * phi;                       // ~3 bends × 2φ (indicative BS 8666)
  const cutRaw = 2 * (A + B) + 2 * hook - deduction;
  const cut = Math.round(cutRaw / 25) * 25;            // nearest 25 mm
  const massPerM = 0.00617 * phi * phi / 1000 * 1000;  // kg/m  (= 0.00617·φ² ... per m, φ in mm)
  const massEach = cut / 1000 * (0.00617 * phi * phi); // kg
  const massTotal = massEach * count;

  return [
    { kind: 'input', label: 'Inputs', line: 0,
      sub: `b=${b} · h=${h} · cover=${cover} mm · link φ${phi} · ${count} off`,
      note: 'The section the closed link wraps, the cover, the bar size and how many.' },
    { label: 'Leg dimensions  A, B', expr: 'A = h − 2·cover ;  B = b − 2·cover', line: 1,
      sub: `A = ${h} − 2·${cover} ; B = ${b} − 2·${cover}`, result: `A=${r0(A)}, B=${r0(B)}`, unit: 'mm',
      note: 'Inside-of-bend dimensions of the rectangular link.' },
    { label: 'Hook allowance', expr: 'hook = max(10·φ, 70 mm), two 135° hooks', line: 2,
      sub: `= max(10·${phi}, 70)`, result: `2 × ${r0(hook)}`, unit: 'mm',
      note: 'Anchorage hooks at the link closure.',
      question: 'Hook angle/anchorage (135° seismic vs 90°) and the standard — BS 8666, EN, or a national BBS convention?' },
    { kind: 'result', label: 'Cut length', expr: 'cut = 2(A+B) + 2·hook − bend deductions, → 25 mm', line: 3,
      sub: `= 2(${r0(A)}+${r0(B)}) + 2·${r0(hook)} − ${deduction}`, result: cut, unit: 'mm',
      note: 'Straight length of bar to cut before bending. Deductions are indicative.' },
    { label: 'Shape code', expr: 'closed rectangular link', line: 4,
      sub: 'BS 8666 shape', result: '51',
      note: 'The standard shape that tells the bender how to form the bar.' },
    { kind: 'result', label: 'Mass', expr: 'mass = cut·0.00617·φ² /1000  × N', line: 5,
      sub: `each ${massEach.toFixed(2)} kg × ${count}`, result: massTotal.toFixed(1), unit: 'kg',
      note: `φ${phi} bar ≈ ${massPerM.toFixed(3)} kg/m. Total steel for this mark.` },
  ];
}

export function summary(p) {
  const rows = compute(p);
  const cut = rows.find((r) => r.label === 'Cut length');
  const mass = rows.find((r) => r.label === 'Mass');
  return `→ shape 51 · cut ${cut.result} mm · ${mass.result} kg total`;
}
