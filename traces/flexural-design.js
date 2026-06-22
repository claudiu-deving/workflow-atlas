// Calc storyboard: EC2 (EN 1992-1-1) flexural design of a singly-reinforced
// rectangular section — how much tension steel a section needs for a moment.
// kind:'calc' → the engine reveals `compute(params)` row by row; editing the
// inputs above recomputes the whole worksheet live.
//
// NB: simplified/indicative method (αcc=1.0, no redistribution). Confirm against
// the project's National Annex before trusting numbers.

export const meta = {
  id: 'flexural-design',
  code: 'ALG-03',
  name: 'Flexural design (EC2)',
  title: 'Flexural design — tension steel for a moment',
  sub: 'EC2 simplified method: from a design moment and a rectangular section, find the required tension reinforcement and a bar arrangement.',
  workflow: { sheet: 'rebar-design', label: 'Rebar design › flexural design' },
};

export const kind = 'calc';

export const params = [
  { key: 'M_Ed', label: 'design moment', sym: 'M_Ed', value: 180, unit: 'kNm', min: 1,   max: 2000, step: 5 },
  { key: 'fck',  label: 'concrete strength', sym: 'f_ck', value: 30, unit: 'MPa', min: 12,  max: 90,   step: 1 },
  { key: 'fyk',  label: 'steel strength', sym: 'f_yk', value: 500, unit: 'MPa', min: 400, max: 600,  step: 10 },
  { key: 'b',    label: 'section width', sym: 'b', value: 300, unit: 'mm', min: 100, max: 1000, step: 10 },
  { key: 'd',    label: 'effective depth', sym: 'd', value: 540, unit: 'mm', min: 100, max: 1500, step: 10 },
  { key: 'phi',  label: 'bar diameter', sym: 'φ', value: 20, unit: 'mm', min: 8, max: 40, step: 2 },
];

export const code = [
  'flexuralDesign(M_Ed, section):',
  '  K = M_Ed / (b·d²·f_ck)',
  '  if K > K′(0.168): add compression steel',
  '  z = d(0.5 + √(0.25 − K/1.134)) ≤ 0.95·d',
  '  A_s,req = M_Ed / (0.87·f_yk·z)',
  '  A_s,min = max(0.26·f_ctm/f_yk·b·d, 0.0013·b·d)',
  '  provide n·φ ≥ max(A_s,req, A_s,min); check',
];

const r0 = (x) => Math.round(x);
const r3 = (x) => Math.round(x * 1000) / 1000;

export function compute(p) {
  const { M_Ed, fck, fyk, b, d, phi } = p;
  const M = M_Ed * 1e6;                         // kNm → Nmm
  const K = M / (b * d * d * fck);
  const Kp = 0.168;
  const singly = K <= Kp;
  const zRaw = d * (0.5 + Math.sqrt(Math.max(0, 0.25 - K / 1.134)));
  const z = Math.min(zRaw, 0.95 * d);
  const AsReq = M / (0.87 * fyk * z);
  const fctm = 0.30 * Math.pow(fck, 2 / 3);     // ≤ C50/60
  const AsMin = Math.max(0.26 * fctm / fyk * b * d, 0.0013 * b * d);
  const Asgov = Math.max(AsReq, AsMin);
  const barA = Math.PI / 4 * phi * phi;
  const n = Math.max(2, Math.ceil(Asgov / barA));
  const AsProv = n * barA;

  return [
    { kind: 'input', label: 'Inputs', line: 0,
      sub: `M_Ed=${M_Ed} kNm · f_ck=${fck} · f_yk=${fyk} MPa · b=${b} · d=${d} mm`,
      note: 'The design moment and the rectangular section. Edit any of them above and the worksheet recomputes.' },
    { label: 'Relative moment K', expr: 'K = M_Ed / (b·d²·f_ck)', line: 1,
      sub: `= ${M_Ed}e6 / (${b}·${d}²·${fck})`, result: r3(K),
      note: 'How hard the section is worked in bending — drives the lever arm.' },
    { kind: 'check', bad: !singly, label: 'Compression steel needed?', expr: 'K ≤ K′ = 0.168 ?', line: 2,
      sub: `K = ${r3(K)} ${singly ? '≤' : '>'} 0.168`, result: singly ? 'no — singly reinforced' : 'yes — add compression steel',
      note: singly ? 'Tension steel alone is enough.' : 'K exceeds the limit: this simplified path stops; design as doubly-reinforced or deepen the section.' },
    { label: 'Lever arm z', expr: 'z = d(0.5 + √(0.25 − K/1.134)) ≤ 0.95·d', line: 3,
      sub: `= ${d}(0.5 + √(0.25 − ${r3(K)}/1.134)),  cap 0.95·d = ${r0(0.95 * d)}`, result: r0(z), unit: 'mm',
      note: 'Internal lever arm between the concrete compression and the steel tension.' },
    { kind: 'result', label: 'Steel required  A_s,req', expr: 'A_s,req = M_Ed / (0.87·f_yk·z)', line: 4,
      sub: `= ${M_Ed}e6 / (0.87·${fyk}·${r0(z)})`, result: r0(AsReq), unit: 'mm²',
      note: 'Tension reinforcement to resist the moment (0.87·f_yk = f_yk/γs, γs=1.15).' },
    { label: 'Minimum steel  A_s,min', expr: 'A_s,min = max(0.26·f_ctm/f_yk·b·d, 0.0013·b·d)', line: 5,
      sub: `f_ctm = 0.30·${fck}^⅔ = ${r3(fctm)} MPa`, result: r0(AsMin), unit: 'mm²',
      note: 'EC2 9.2.1.1 crack-control minimum. The larger of this and A_s,req governs.' },
    { kind: 'result', label: 'Provide bars', expr: `n·φ${phi} (${r0(barA)} mm² each) ≥ ${r0(Asgov)}`, line: 6,
      sub: `n = ⌈${r0(Asgov)} / ${r0(barA)}⌉ = ${n}`, result: `${n}H${phi} = ${r0(AsProv)}`, unit: 'mm²',
      question: 'Fix the longitudinal bar diameter (e.g. H20), or let it vary per span / cover / spacing limits?',
      note: 'Smallest bar count of the chosen diameter that meets the governing area.' },
    { kind: 'check', bad: AsProv < AsReq, label: 'Check', expr: 'A_s,prov ≥ A_s,req', line: 6,
      sub: `${r0(AsProv)} ≥ ${r0(AsReq)} mm²`, result: AsProv >= AsReq ? 'OK ✓' : 'add bars',
      note: 'Provided area must cover the requirement.' },
  ];
}

export function summary(p) {
  const rows = compute(p);
  const prov = rows.find((r) => r.label === 'Provide bars');
  const req = rows.find((r) => r.label.startsWith('Steel required'));
  return `→ A_s,req = ${req.result} mm²  →  ${prov.result} mm²`;
}
