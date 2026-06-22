// Hand-authored storyboard trace: binary search over a sorted array.
//
// kind: 'array' — the stage draws the array as a row of value cells, colouring
// each by state (lo/hi window, mid under test, eliminated half, found). The
// whole walk is recomputed from `params.target` at render time, so changing the
// target in the app re-runs the search live.

export const meta = {
  id: 'binary-search',
  code: 'ALG-01',
  name: 'Binary search',
  title: 'Binary search',
  sub: 'Halve a sorted array each step to locate a value in log₂n comparisons. Change the target to watch it re-run.',
  workflow: { sheet: 'build-verify', label: 'Build & verify › implement the algorithm' },
};

export const kind = 'array';

// Editable in the app. Changing `target` recomputes every frame below.
export const params = [
  { key: 'target', label: 'target value', sym: 'x', value: 33, unit: '', min: 1, max: 99, step: 1,
    hint: 'The value to search for. Change it to watch the search re-run live.' },
];

export const code = [
  'binarySearch(a, x):',
  '  lo = 0;  hi = n - 1',
  '  while lo <= hi:',
  '    mid = (lo + hi) / 2',
  '    if a[mid] == x: return mid',
  '    if a[mid] <  x: lo = mid + 1',
  '    else:           hi = mid - 1',
  '  return -1            // absent',
];

const ARR = [3, 9, 14, 21, 28, 33, 42, 55, 67, 80];   // must stay sorted

// helper: class map where everything outside [lo,hi] is eliminated
const window = (lo, hi) => {
  const c = {};
  for (let i = 0; i < ARR.length; i++) c[i] = (i < lo || i > hi) ? 'eliminated' : 'idle';
  return c;
};

export function compute(p) {
  const x = Math.round(p.target);
  const frames = [];
  let lo = 0, hi = ARR.length - 1, found = -1;

  frames.push({
    array: ARR, cls: window(lo, hi), ptr: { lo, hi }, line: [1],
    note: `Search for ${x}. The array is sorted, so each comparison lets us throw away half of what's left.`,
    question: 'If the array held duplicate values, should this return the first match or any match?',
  });

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cMid = window(lo, hi); cMid[mid] = 'mid';
    frames.push({
      array: ARR, cls: cMid, ptr: { lo, hi, mid }, line: [3, 4],
      note: `mid = (${lo} + ${hi}) / 2 = ${mid}. Compare a[${mid}] = ${ARR[mid]} against ${x}.`,
    });

    if (ARR[mid] === x) {
      const cFound = window(lo, hi); cFound[mid] = 'found';
      frames.push({
        array: ARR, cls: cFound, ptr: { mid }, line: [4],
        verdict: { ok: true, text: `a[${mid}] = ${x} — found at index ${mid}.` },
        note: 'Exact match. Return the index.',
      });
      found = mid; break;
    }

    if (ARR[mid] < x) {
      const cMid = window(lo, hi); cMid[mid] = 'compare';
      frames.push({
        array: ARR, cls: cMid, ptr: { lo, hi, mid }, line: [5],
        verdict: { text: `${ARR[mid]} < ${x} — discard the left half, move lo to ${mid + 1}.` },
        note: 'The target must be to the right of mid.',
      });
      lo = mid + 1;
    } else {
      const cMid = window(lo, hi); cMid[mid] = 'compare';
      frames.push({
        array: ARR, cls: cMid, ptr: { lo, hi, mid }, line: [6],
        verdict: { text: `${ARR[mid]} > ${x} — discard the right half, move hi to ${mid - 1}.` },
        note: 'The target must be to the left of mid.',
      });
      hi = mid - 1;
    }
  }

  if (found < 0) {
    const c = {}; for (let i = 0; i < ARR.length; i++) c[i] = 'eliminated';
    frames.push({
      array: ARR, cls: c, line: [7],
      verdict: { ok: false, text: `${x} is not in the array.` },
      note: 'lo passed hi with nothing left to check — the value is absent. Return −1.',
    });
  }

  return frames;
}
