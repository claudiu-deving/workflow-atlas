// Built-in algorithm generators — pure functions, no DOM or Node APIs, so the
// same module runs in the browser (to draw frames live) and in the server (to
// read authored questions). A JSON algorithm with `"builtin": "<key>"` is driven
// by the matching generator below; the generator turns (params, data) into the
// ordered frames/rows the renderer consumes. Agent-authored algorithms instead
// ship explicit `steps`, so they need no generator at all.

/* ---------- binary search (array stage) ---------- */
export function binarySearch(p, data) {
  const ARR = (data && data.array) || [];
  const x = Math.round(p.target);
  const win = (lo, hi) => {
    const c = {};
    for (let i = 0; i < ARR.length; i++) c[i] = (i < lo || i > hi) ? 'eliminated' : 'idle';
    return c;
  };
  const frames = [];
  let lo = 0, hi = ARR.length - 1, found = -1;

  frames.push({ array: ARR, cls: win(lo, hi), ptr: { lo, hi }, line: [1],
    note: `Search for ${x}. The array is sorted, so each comparison lets us throw away half of what's left.` });

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cMid = win(lo, hi); cMid[mid] = 'mid';
    frames.push({ array: ARR, cls: cMid, ptr: { lo, hi, mid }, line: [3, 4],
      note: `mid = (${lo} + ${hi}) / 2 = ${mid}. Compare a[${mid}] = ${ARR[mid]} against ${x}.` });

    if (ARR[mid] === x) {
      const c = win(lo, hi); c[mid] = 'found';
      frames.push({ array: ARR, cls: c, ptr: { mid }, line: [4],
        verdict: { ok: true, text: `a[${mid}] = ${x} — found at index ${mid}.` },
        note: 'Exact match. Return the index.' });
      found = mid; break;
    }
    if (ARR[mid] < x) {
      const c = win(lo, hi); c[mid] = 'compare';
      frames.push({ array: ARR, cls: c, ptr: { lo, hi, mid }, line: [5],
        verdict: { text: `${ARR[mid]} < ${x} — discard the left half, move lo to ${mid + 1}.` },
        note: 'The target must be to the right of mid.' });
      lo = mid + 1;
    } else {
      const c = win(lo, hi); c[mid] = 'compare';
      frames.push({ array: ARR, cls: c, ptr: { lo, hi, mid }, line: [6],
        verdict: { text: `${ARR[mid]} > ${x} — discard the right half, move hi to ${mid - 1}.` },
        note: 'The target must be to the left of mid.' });
      hi = mid - 1;
    }
  }

  if (found < 0) {
    const c = {}; for (let i = 0; i < ARR.length; i++) c[i] = 'eliminated';
    frames.push({ array: ARR, cls: c, line: [7],
      verdict: { ok: false, text: `${x} is not in the array.` },
      note: 'lo passed hi with nothing left to check — the value is absent. Return −1.' });
  }
  return frames;
}

/* ---------- bubble sort (array stage) ---------- */
export function bubbleSort(p, data) {
  const a = ((data && data.array) || []).slice();
  const n = a.length;
  const early = !!p.early_exit;
  const frames = [];
  const classes = (done, j) => {
    const c = {};
    for (let i = 0; i < n; i++) c[i] = i >= n - done ? 'sorted' : 'idle';
    if (j != null) { c[j] = 'compare'; c[j + 1] = 'compare'; }
    return c;
  };

  frames.push({ array: a.slice(), cls: classes(0), line: [0],
    note: 'Start unsorted. Each pass walks left to right, swapping any pair that is out of order.' });

  for (let i = 0; i < n - 1; i++) {
    let swapped = false;
    for (let j = 0; j < n - 1 - i; j++) {
      frames.push({ array: a.slice(), cls: classes(i, j), ptr: { j, 'j+1': j + 1 }, line: [4],
        note: `Pass ${i + 1}: compare a[${j}] = ${a[j]} and a[${j + 1}] = ${a[j + 1]}.`,
        verdict: a[j] > a[j + 1]
          ? { text: `${a[j]} > ${a[j + 1]} — swap.` }
          : { ok: true, text: `${a[j]} ≤ ${a[j + 1]} — already in order.` } });
      if (a[j] > a[j + 1]) {
        [a[j], a[j + 1]] = [a[j + 1], a[j]];
        swapped = true;
        frames.push({ array: a.slice(), cls: classes(i, j), ptr: { j, 'j+1': j + 1 }, line: [5],
          note: `Swapped — ${a[j]} now sits before ${a[j + 1]}.` });
      }
    }
    frames.push({ array: a.slice(), cls: classes(i + 1), line: [3],
      note: `End of pass ${i + 1}: a[${n - 1 - i}] = ${a[n - 1 - i]} is in its final place.` });
    if (early && !swapped) {
      frames.push({ array: a.slice(), cls: classes(n), line: [7],
        verdict: { ok: true, text: 'A full pass with no swaps — the array is sorted.' },
        note: 'Early exit: nothing moved this pass, so the remaining prefix is already ordered.' });
      return frames;
    }
  }
  frames.push({ array: a.slice(), cls: classes(n), line: [8],
    verdict: { ok: true, text: `Sorted: ${a.join(', ')}.` },
    note: 'Every element is in its final position.' });
  return frames;
}

/* ---------- Euclid's gcd (worksheet stage) ---------- */
export function euclidGcd(p) {
  let a = Math.max(1, Math.round(p.a));
  let b = Math.max(1, Math.round(p.b));
  const a0 = a, b0 = b;
  const rows = [];
  rows.push({ kind: 'input', label: 'a', result: a0, line: 0,
    note: `Find gcd(${a0}, ${b0}) by repeated remainders.` });
  rows.push({ kind: 'input', label: 'b', result: b0, line: 0,
    note: 'Each step replaces (a, b) with (b, a mod b) — the gcd never changes.' });

  let guard = 0;
  while (b !== 0 && guard++ < 200) {
    const q = Math.floor(a / b);
    const r = a % b;
    rows.push({ label: `${a} mod ${b}`, result: r, expr: `r = ${a} − ${q}·${b}`,
      sub: r === 0 ? 'remainder 0 → b is the divisor we want' : `carry (${b}, ${r}) into the next step`,
      line: [2, 3, 4], note: `Remainder of ${a} ÷ ${b} is ${r}.`,
      kind: r === 0 ? 'result' : undefined });
    a = b; b = r;
  }
  rows.push({ kind: 'result', label: 'gcd', result: a, line: [5],
    note: 'b reached 0 — the last non-zero remainder is the greatest common divisor.' });
  return rows;
}

export const GENERATORS = {
  'binary-search': binarySearch,
  'bubble-sort': bubbleSort,
  'euclid-gcd': euclidGcd,
};
