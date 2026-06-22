// Calc storyboard: EC2 (EN 1992-1-1) shear design — does the section need shear
// links, and if so what size/spacing. Variable-strut-inclination method.
// Indicative/simplified; confirm against the National Annex.

export const meta = {
  id: 'shear-design',
  code: 'ALG-05',
  name: 'Shear design (EC2)',
  title: 'Shear design — links for the shear force',
  sub: 'EC2: shear resistance without links (V_Rd,c), strut crushing limit (V_Rd,max), and the link area/spacing if links are required.',
  workflow: { sheet: 'rebar-design', label: 'Rebar design › shear design' },
};

export const kind = 'calc';

export const params = [
  { key: 'V_Ed', label: 'design shear', sym: 'V_Ed', value: 85, unit: 'kN', min: 1, max: 2000, step: 5 },
  { key: 'bw',   label: 'web width', sym: 'b_w', value: 300, unit: 'mm', min: 100, max: 1000, step: 10 },
  { key: 'd',    label: 'effective depth', sym: 'd', value: 540, unit: 'mm', min: 100, max: 1500, step: 10 },
  { key: 'fck',  label: 'concrete strength', sym: 'f_ck', value: 30, unit: 'MPa', min: 12, max: 90, step: 1 },
  { key: 'fyk',  label: 'link steel strength', sym: 'f_yk', value: 500, unit: 'MPa', min: 400, max: 600, step: 10 },
  { key: 'Asl',  label: 'tension steel', sym: 'A_sl', value: 942, unit: 'mm²', min: 0, max: 20000, step: 1 },
  { key: 'link', label: 'link diameter', sym: 'φ_w', value: 8, unit: 'mm', min: 6, max: 16, step: 2 },
  { key: 'legs', label: 'link legs', sym: 'n', value: 2, unit: '', min: 2, max: 6, step: 1 },
];

export const code = [
  'shearDesign(V_Ed, section):',
  '  k = 1 + √(200/d) ≤ 2 ; ρ_l = A_sl/(b_w·d) ≤ 0.02',
  '  V_Rd,c = 0.12·k·(100·ρ_l·f_ck)^⅓·b_w·d  ≥  v_min·b_w·d',
  '  V_Rd,max = b_w·z·ν1·f_cd / (cotθ+tanθ)   (cotθ=2.5)',
  '  if V_Ed ≤ V_Rd,c: minimum links only',
  '  else: A_sw/s = V_Ed / (0.9·d·f_ywd·cotθ)',
  '  A_sw/s ≥ 0.08·√f_ck/f_yk·b_w ; s ≤ 0.75·d',
];

const r0 = (x) => Math.round(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

export function compute(p) {
  const { V_Ed, bw, d, fck, fyk, Asl, link, legs } = p;
  const V = V_Ed * 1e3;                                  // kN → N
  const k = Math.min(1 + Math.sqrt(200 / d), 2);
  const rho = Math.min(Asl / (bw * d), 0.02);
  const vmin = 0.035 * Math.pow(k, 1.5) * Math.sqrt(fck);
  const VRdc = Math.max(0.12 * k * Math.pow(100 * rho * fck, 1 / 3), vmin) * bw * d;  // N
  const z = 0.9 * d;
  const nu1 = 0.6 * (1 - fck / 250);
  const fcd = fck / 1.5;
  const cot = 2.5, tan = 1 / cot;
  const VRdmax = bw * z * nu1 * fcd / (cot + tan);       // N
  const needLinks = V > VRdc;
  const fywd = fyk / 1.15;
  const AswS_str = V / (0.9 * d * fywd * cot);           // mm²/mm (strength)
  const AswS_min = 0.08 * Math.sqrt(fck) / fyk * bw;     // mm²/mm (minimum)
  const AswS = Math.max(needLinks ? AswS_str : 0, AswS_min);
  const AswLink = legs * Math.PI / 4 * link * link;      // mm² per link set
  const sMax = 0.75 * d;
  const sReq = AswS > 0 ? Math.min(AswLink / AswS, sMax) : sMax;
  const s = Math.floor(sReq / 25) * 25;                  // round down to 25 mm

  return [
    { kind: 'input', label: 'Inputs', line: 0,
      sub: `V_Ed=${V_Ed} kN · b_w=${bw} · d=${d} mm · f_ck=${fck} · A_sl=${Asl} mm² · ${legs}×φ${link} links`,
      note: 'The design shear and section. A_sl is the tension steel crossing the section (from flexural design).' },
    { label: 'Depth factor k & ratio ρ_l', expr: 'k = 1+√(200/d) ≤ 2 ; ρ_l = A_sl/(b_w·d)', line: 1,
      sub: `k = 1+√(200/${d}) ; ρ_l = ${Asl}/(${bw}·${d})`, result: `k=${r3(k)}, ρ_l=${r3(rho)}`,
      note: 'Size effect and the longitudinal steel ratio both raise the concrete shear capacity.' },
    { kind: 'result', label: 'Concrete shear  V_Rd,c', expr: 'V_Rd,c = 0.12·k·(100·ρ_l·f_ck)^⅓·b_w·d ≥ v_min·b_w·d', line: 2,
      sub: `v_min = 0.035·k^1.5·√f_ck = ${r3(vmin)} MPa`, result: r1k(VRdc), unit: 'kN',
      note: 'Shear the section carries with no links.' },
    { label: 'Strut crushing limit  V_Rd,max', expr: 'V_Rd,max = b_w·z·ν1·f_cd/(cotθ+tanθ), θ=21.8°', line: 3,
      sub: `z=0.9d=${r0(z)} · ν1=${r3(nu1)} · f_cd=${r2(fcd)}`, result: r1k(VRdmax), unit: 'kN',
      note: 'Upper bound — if V_Ed exceeds this, the concrete strut crushes (deepen/widen the section).' },
    { kind: 'check', bad: needLinks, label: 'Links needed?', expr: 'V_Ed ≤ V_Rd,c ?', line: 4,
      sub: `${V_Ed} ${needLinks ? '>' : '≤'} ${r1k(VRdc)} kN`, result: needLinks ? 'yes — design links' : 'no — minimum links',
      note: needLinks ? 'Concrete alone is not enough; design shear links.' : 'Provide nominal minimum links only.' },
    { label: 'Link area / spacing  A_sw/s', expr: 'max( V_Ed/(0.9·d·f_ywd·cotθ),  0.08·√f_ck/f_yk·b_w )', line: 5,
      sub: `strength ${r3(AswS_str)} · min ${r3(AswS_min)} mm²/mm`, result: r3(AswS), unit: 'mm²/mm',
      note: 'The larger of strength demand and the EC2 minimum ratio governs.' },
    { kind: 'result', label: 'Provide links', expr: `s = ${legs}×φ${link} area / (A_sw/s) ≤ 0.75·d`, line: 6,
      sub: `A_sw=${r0(AswLink)} mm² · s ≤ 0.75·d=${r0(sMax)}`, result: `φ${link} @ ${s}`, unit: 'mm c/c',
      question: 'Strut angle fixed at θ=21.8° (cotθ=2.5). Optimise θ per V_Ed, or keep the economical default?',
      note: 'Largest standard spacing (≤ limits) that provides the required link area.' },
  ];
}
function r1k(N) { return Math.round(N / 100) / 10; }     // N → kN, 1 dp

export function summary(p) {
  const rows = compute(p);
  const prov = rows.find((r) => r.label === 'Provide links');
  return `→ shear links: ${prov.result} mm c/c`;
}
