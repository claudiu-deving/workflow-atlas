// Calc storyboard: internal forces on the beam (EC2 ULS).
// Simply-supported single span under a uniformly distributed load — factors the
// loads and returns the design moment and shear the section is designed for.
// Indicative: continuous spans use moment coefficients (see the open question).

export const meta = {
  id: 'beam-analysis',
  code: 'ALG-04',
  name: 'Beam analysis',
  title: 'Internal forces — M and V from the loads',
  sub: 'Factor the loads to ULS (EC2) and get the design moment M_Ed and shear V_Ed that feed flexural and shear design.',
  workflow: { sheet: 'rebar-design', label: 'Rebar design › analyse internal forces' },
};

export const kind = 'calc';

export const params = [
  { key: 'g', label: 'dead load', sym: 'g', value: 12, unit: 'kN/m', min: 0, max: 200, step: 1 },
  { key: 'q', label: 'live load', sym: 'q', value: 8,  unit: 'kN/m', min: 0, max: 200, step: 1 },
  { key: 'L', label: 'span', sym: 'L', value: 6,  unit: 'm',    min: 1, max: 20,  step: 0.5 },
];

export const code = [
  'analyse(span L, loads g, q):',
  '  w_Ed = 1.35·g + 1.5·q        (ULS combination)',
  '  M_Ed = w_Ed·L² / 8           (simply supported, UDL)',
  '  V_Ed = w_Ed·L / 2',
];

const r1 = (x) => Math.round(x * 10) / 10;

export function compute(p) {
  const { g, q, L } = p;
  const wEd = 1.35 * g + 1.5 * q;
  const MEd = wEd * L * L / 8;
  const VEd = wEd * L / 2;
  return [
    { kind: 'input', label: 'Inputs', line: 0,
      sub: `g = ${g} kN/m · q = ${q} kN/m · L = ${L} m  (simply supported, UDL)`,
      note: 'Permanent and variable line loads on the beam, and the span. Edit them above.' },
    { label: 'Design load  w_Ed', expr: 'w_Ed = 1.35·g + 1.5·q', line: 1,
      sub: `= 1.35·${g} + 1.5·${q}`, result: r1(wEd), unit: 'kN/m',
      note: 'EC2 ULS combination — 1.35 on permanent, 1.5 on variable.' },
    { kind: 'result', label: 'Design moment  M_Ed', expr: 'M_Ed = w_Ed·L² / 8', line: 2,
      sub: `= ${r1(wEd)}·${L}² / 8`, result: r1(MEd), unit: 'kNm',
      note: 'Mid-span sagging moment — the input to flexural design.',
      question: 'Single simply-supported span here. Continuous beams need moment coefficients (e.g. −w·L²/12 at interior supports, redistribution). Which case(s) should the real solver cover?' },
    { kind: 'result', label: 'Design shear  V_Ed', expr: 'V_Ed = w_Ed·L / 2', line: 3,
      sub: `= ${r1(wEd)}·${L} / 2`, result: r1(VEd), unit: 'kN',
      note: 'Support reaction / peak shear — the input to shear design.' },
  ];
}

export function summary(p) {
  const wEd = 1.35 * p.g + 1.5 * p.q;
  return `→ M_Ed = ${r1(wEd * p.L * p.L / 8)} kNm · V_Ed = ${r1(wEd * p.L / 2)} kN`;
}
