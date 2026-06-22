// Hand-authored storyboard trace: bubble sort with an optional early exit.
//
// kind: 'array' — bars whose height tracks value. Each frame shows the adjacent
// pair under comparison, the settled tail in green, and a swap when it happens.
// The `early_exit` toggle decides whether a clean pass ends the sort early — flip
// it and the number of frames changes, recomputed live.

export const meta = {
  id: 'bubble-sort',
  code: 'ALG-02',
  name: 'Bubble sort',
  title: 'Bubble sort',
  sub: 'Repeatedly swap adjacent out-of-order pairs; the largest value bubbles to the end each pass.',
  workflow: { sheet: 'build-verify', label: 'Build & verify › handle the edge cases' },
};

export const kind = 'array';

export const params = [
  { key: 'early_exit', label: 'early exit', sym: '', value: 1, unit: '', min: 0, max: 1, step: 1,
    hint: 'On = stop as soon as a full pass makes no swaps (the array is already sorted). Off = always run every pass.' },
];

export const code = [
  'bubbleSort(a):',
  '  for i in 0 .. n-1:',
  '    swapped = false',
  '    for j in 0 .. n-2-i:',
  '      if a[j] > a[j+1]:',
  '        swap(a[j], a[j+1])',
  '        swapped = true',
  '    if not swapped: break       // early exit',
  '  return a',
];

const START = [5, 2, 8, 1, 9, 3];

export function compute(p) {
  const a = START.slice();
  const n = a.length;
  const early = !!p.early_exit;
  const frames = [];

  // class map: sorted tail (last `done` cells) green, a compare pair highlighted
  const classes = (done, j) => {
    const c = {};
    for (let i = 0; i < n; i++) c[i] = i >= n - done ? 'sorted' : 'idle';
    if (j != null) { c[j] = 'compare'; c[j + 1] = 'compare'; }
    return c;
  };

  frames.push({
    array: a.slice(), cls: classes(0), line: [0],
    note: 'Start unsorted. Each pass walks left to right, swapping any pair that is out of order.',
    question: 'For nearly-sorted input, is the early-exit check worth one extra comparison per pass?',
  });

  for (let i = 0; i < n - 1; i++) {
    let swapped = false;
    for (let j = 0; j < n - 1 - i; j++) {
      frames.push({
        array: a.slice(), cls: classes(i, j), ptr: { j, 'j+1': j + 1 }, line: [4],
        note: `Pass ${i + 1}: compare a[${j}] = ${a[j]} and a[${j + 1}] = ${a[j + 1]}.`,
        verdict: a[j] > a[j + 1]
          ? { text: `${a[j]} > ${a[j + 1]} — swap.` }
          : { ok: true, text: `${a[j]} ≤ ${a[j + 1]} — already in order.` },
      });
      if (a[j] > a[j + 1]) {
        [a[j], a[j + 1]] = [a[j + 1], a[j]];
        swapped = true;
        frames.push({
          array: a.slice(), cls: classes(i, j), ptr: { j, 'j+1': j + 1 }, line: [5],
          note: `Swapped — ${a[j]} now sits before ${a[j + 1]}.`,
        });
      }
    }
    // largest remaining value is now parked at the tail
    frames.push({
      array: a.slice(), cls: classes(i + 1), line: [3],
      note: `End of pass ${i + 1}: a[${n - 1 - i}] = ${a[n - 1 - i]} is in its final place.`,
    });
    if (early && !swapped) {
      frames.push({
        array: a.slice(), cls: classes(n), line: [7],
        verdict: { ok: true, text: 'A full pass with no swaps — the array is sorted.' },
        note: 'Early exit: nothing moved this pass, so the remaining prefix is already ordered.',
      });
      return frames;
    }
  }

  frames.push({
    array: a.slice(), cls: classes(n), line: [8],
    verdict: { ok: true, text: `Sorted: ${a.join(', ')}.` },
    note: 'Every element is in its final position.',
  });
  return frames;
}
