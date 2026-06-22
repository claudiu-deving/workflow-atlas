// Hand-authored storyboard trace: Euclid's algorithm for the gcd.
//
// kind: 'calc' — the stage is a worksheet that reveals one computed row per
// step. Both operands are editable params, so the whole derivation (and the
// number of remainder rows) recomputes live as you change them.

export const meta = {
  id: 'euclid-gcd',
  code: 'ALG-03',
  name: 'Euclid’s GCD',
  title: 'Greatest common divisor (Euclid)',
  sub: 'Replace the larger number by its remainder against the smaller, until the remainder is zero.',
};

export const kind = 'calc';

export const params = [
  { key: 'a', label: 'first number', sym: 'a', value: 1071, unit: '', min: 1, max: 9999, step: 1,
    hint: 'First operand. The derivation recomputes as you change it.' },
  { key: 'b', label: 'second number', sym: 'b', value: 462, unit: '', min: 1, max: 9999, step: 1,
    hint: 'Second operand.' },
];

export const code = [
  'gcd(a, b):',
  '  while b != 0:',
  '    r = a mod b',
  '    a = b',
  '    b = r',
  '  return a',
];

export function compute(p) {
  let a = Math.max(1, Math.round(p.a));
  let b = Math.max(1, Math.round(p.b));
  const a0 = a, b0 = b;
  const rows = [];

  rows.push({ kind: 'input', label: 'a', result: a0, line: 0,
    note: `Find gcd(${a0}, ${b0}) by repeated remainders.`,
    question: 'Should gcd(0, 0) be defined as 0, or treated as an input error?' });
  rows.push({ kind: 'input', label: 'b', result: b0, line: 0,
    note: 'Each step replaces (a, b) with (b, a mod b) — the gcd never changes.' });

  let guard = 0;
  while (b !== 0 && guard++ < 100) {
    const q = Math.floor(a / b);
    const r = a % b;
    rows.push({
      label: `${a} mod ${b}`, result: r, expr: `r = ${a} − ${q}·${b}`,
      sub: r === 0 ? 'remainder 0 → b is the divisor we want' : `carry (${b}, ${r}) into the next step`,
      line: [2, 3, 4], note: `Remainder of ${a} ÷ ${b} is ${r}.`,
      kind: r === 0 ? 'result' : undefined,
    });
    a = b; b = r;
  }

  rows.push({ kind: 'result', label: 'gcd', result: a, line: [5],
    note: 'b reached 0 — the last non-zero remainder is the greatest common divisor.' });
  return rows;
}

export function summary(p) {
  let a = Math.max(1, Math.round(p.a)), b = Math.max(1, Math.round(p.b));
  const a0 = a, b0 = b, g = (() => { let x = a, y = b, n = 0; while (y && n++ < 100) { [x, y] = [y, x % y]; } return x; })();
  return `gcd(${a0}, ${b0}) = ${g}`;
}
