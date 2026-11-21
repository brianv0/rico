// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of Go's slices.SortFunc and slices.SortStableFunc (Go 1.27, BSD-3-Clause, Copyright 2023 The Go Authors:
// slices/zsortanyfunc.go) and cmp.Compare. TALA sorts with comparators that are not always strict weak orderings (the loop
// edges of `loops` compare arrowhead classes and label areas separately), so the result depends on the algorithm: these
// are the exact algorithms. slices.SortFunc is the same pattern-defeating quicksort as sort.Slice (gosort.js), so it is
// that code with less(i, j) = cmp(x[i], x[j]) < 0; the stable sort (insertion sort blocks of 20 + SymMerge) is ported here.

import { sortSlice } from '../gosort.js';

/** slices.SortFunc(x, cmp): sorts the array x in place; cmp returns a negative, zero or positive number. */
export function sortFunc(x, cmp) {
  sortSlice(x, (i, j) => cmp(x[i], x[j]) < 0);
}

/** cmp.Compare for numbers (NaN sorts before every other value and equals NaN) and BigInts. */
export function compare(x, y) {
  const xNaN = x !== x;
  const yNaN = y !== y;
  if (xNaN) return yNaN ? 0 : -1;
  if (yNaN) return +1;
  if (x < y) return -1;
  if (x > y) return +1;
  return 0;
}

function insertionSortCmpFunc(data, a, b, cmp) {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && cmp(data[j], data[j - 1]) < 0; j--) {
      const t = data[j]; data[j] = data[j - 1]; data[j - 1] = t;
    }
  }
}

function swapRangeCmpFunc(data, a, b, n) {
  for (let i = 0; i < n; i++) {
    const t = data[a + i]; data[a + i] = data[b + i]; data[b + i] = t;
  }
}

function rotateCmpFunc(data, a, m, b) {
  let i = m - a;
  let j = b - m;
  while (i !== j) {
    if (i > j) {
      swapRangeCmpFunc(data, m - i, m, j);
      i -= j;
    } else {
      swapRangeCmpFunc(data, m - i, m + j - i, i);
      j -= i;
    }
  }
  swapRangeCmpFunc(data, m - i, m, i);
}

function symMergeCmpFunc(data, a, m, b, cmp) {
  if (m - a === 1) {
    let i = m;
    let j = b;
    while (i < j) {
      const h = (i + j) >>> 1;
      if (cmp(data[h], data[a]) < 0) i = h + 1;
      else j = h;
    }
    for (let k = a; k < i - 1; k++) {
      const t = data[k]; data[k] = data[k + 1]; data[k + 1] = t;
    }
    return;
  }
  if (b - m === 1) {
    let i = a;
    let j = m;
    while (i < j) {
      const h = (i + j) >>> 1;
      if (!(cmp(data[m], data[h]) < 0)) i = h + 1;
      else j = h;
    }
    for (let k = m; k > i; k--) {
      const t = data[k]; data[k] = data[k - 1]; data[k - 1] = t;
    }
    return;
  }
  const mid = (a + b) >>> 1;
  const n = mid + m;
  let start;
  let r;
  if (m > mid) {
    start = n - b;
    r = mid;
  } else {
    start = a;
    r = m;
  }
  const p = n - 1;
  while (start < r) {
    const c = (start + r) >>> 1;
    if (!(cmp(data[p - c], data[c]) < 0)) start = c + 1;
    else r = c;
  }
  const end = n - start;
  if (start < m && m < end) rotateCmpFunc(data, start, m, end);
  if (a < start && start < mid) symMergeCmpFunc(data, a, start, mid, cmp);
  if (mid < end && end < b) symMergeCmpFunc(data, mid, end, b, cmp);
}

/** slices.SortStableFunc(x, cmp): sorts the array x in place, keeping the order of elements cmp calls equal. */
export function sortStableFunc(x, cmp) {
  const n = x.length;
  let blockSize = 20;
  let a = 0;
  let b = blockSize;
  while (b <= n) {
    insertionSortCmpFunc(x, a, b, cmp);
    a = b;
    b += blockSize;
  }
  insertionSortCmpFunc(x, a, n, cmp);
  while (blockSize < n) {
    a = 0;
    b = 2 * blockSize;
    while (b <= n) {
      symMergeCmpFunc(x, a, a + blockSize, b, cmp);
      a = b;
      b += 2 * blockSize;
    }
    const m = a + blockSize;
    if (m < n) symMergeCmpFunc(x, a, m, n, cmp);
    blockSize *= 2;
  }
}
