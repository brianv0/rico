// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of Go's sort.Slice (Go 1.24, BSD-3-Clause, Copyright 2009 The Go Authors): the pattern-defeating
// quicksort of zsortfunc.go. D2 sorts with comparators that are not strict weak orderings (SortObjectsByAST returns
// `i < j` for objects it cannot compare), so the result depends on the algorithm, not just on the order: it has to be the
// same algorithm. less(i, j) compares the elements currently at positions i and j of the array being sorted, as in Go.

const increasingHint = 1, decreasingHint = 2, unknownHint = 0;

const bitsLen = (n) => (n === 0 ? 0 : 32 - Math.clz32(n));

/** sort.Slice(x, less): sorts the array x in place. less(i, j) reads x[i], x[j]. */
export function sortSlice(x, less) {
  const data = { less, swap: (i, j) => { const t = x[i]; x[i] = x[j]; x[j] = t; } };
  const length = x.length;
  const limit = bitsLen(length);
  pdqsort(data, 0, length, limit);
}

function insertionSort(data, a, b) {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && data.less(j, j - 1); j--) data.swap(j, j - 1);
  }
}

function siftDown(data, lo, hi, first) {
  let root = lo;
  for (;;) {
    let child = 2 * root + 1;
    if (child >= hi) break;
    if (child + 1 < hi && data.less(first + child, first + child + 1)) child++;
    if (!data.less(first + root, first + child)) return;
    data.swap(first + root, first + child);
    root = child;
  }
}

function heapSort(data, a, b) {
  const first = a;
  const lo = 0;
  const hi = b - a;
  for (let i = Math.trunc((hi - 1) / 2); i >= 0; i--) siftDown(data, i, hi, first);
  for (let i = hi - 1; i >= 0; i--) {
    data.swap(first, first + i);
    siftDown(data, lo, i, first);
  }
}

function pdqsort(data, a, b, limit) {
  const maxInsertion = 12;
  let wasBalanced = true;
  let wasPartitioned = true;

  for (;;) {
    const length = b - a;

    if (length <= maxInsertion) {
      insertionSort(data, a, b);
      return;
    }

    if (limit === 0) {
      heapSort(data, a, b);
      return;
    }

    if (!wasBalanced) {
      breakPatterns(data, a, b);
      limit--;
    }

    let [pivot, hint] = choosePivot(data, a, b);
    if (hint === decreasingHint) {
      reverseRange(data, a, b);
      pivot = (b - 1) - (pivot - a);
      hint = increasingHint;
    }

    if (wasBalanced && wasPartitioned && hint === increasingHint) {
      if (partialInsertionSort(data, a, b)) return;
    }

    if (a > 0 && !data.less(a - 1, pivot)) {
      const mid = partitionEqual(data, a, b, pivot);
      a = mid;
      continue;
    }

    const [mid, alreadyPartitioned] = partition(data, a, b, pivot);
    wasPartitioned = alreadyPartitioned;

    const leftLen = mid - a, rightLen = b - mid;
    const balanceThreshold = Math.trunc(length / 8);
    if (leftLen < rightLen) {
      wasBalanced = leftLen >= balanceThreshold;
      pdqsort(data, a, mid, limit);
      a = mid + 1;
    } else {
      wasBalanced = rightLen >= balanceThreshold;
      pdqsort(data, mid + 1, b, limit);
      b = mid;
    }
  }
}

function partition(data, a, b, pivot) {
  data.swap(a, pivot);
  let i = a + 1, j = b - 1;

  while (i <= j && data.less(i, a)) i++;
  while (i <= j && !data.less(j, a)) j--;
  if (i > j) {
    data.swap(j, a);
    return [j, true];
  }
  data.swap(i, j);
  i++;
  j--;

  for (;;) {
    while (i <= j && data.less(i, a)) i++;
    while (i <= j && !data.less(j, a)) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  data.swap(j, a);
  return [j, false];
}

function partitionEqual(data, a, b, pivot) {
  data.swap(a, pivot);
  let i = a + 1, j = b - 1;

  for (;;) {
    while (i <= j && !data.less(a, i)) i++;
    while (i <= j && data.less(a, j)) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  return i;
}

function partialInsertionSort(data, a, b) {
  const maxSteps = 5;
  const shortestShifting = 50;
  let i = a + 1;
  for (let j = 0; j < maxSteps; j++) {
    while (i < b && !data.less(i, i - 1)) i++;

    if (i === b) return true;

    if (b - a < shortestShifting) return false;

    data.swap(i, i - 1);

    if (i - a >= 2) {
      for (let j = i - 1; j >= 1; j--) {
        if (!data.less(j, j - 1)) break;
        data.swap(j, j - 1);
      }
    }
    if (b - i >= 2) {
      for (let j = i + 1; j < b; j++) {
        if (!data.less(j, j - 1)) break;
        data.swap(j, j - 1);
      }
    }
  }
  return false;
}

const MASK64 = (1n << 64n) - 1n;
function breakPatterns(data, a, b) {
  const length = b - a;
  if (length >= 8) {
    let random = BigInt(length); // xorshift(length)
    const next = () => {
      random ^= (random << 13n) & MASK64;
      random ^= random >> 7n;
      random ^= (random << 17n) & MASK64;
      return random;
    };
    const modulus = 2 ** bitsLen(length); // nextPowerOfTwo

    for (let idx = a + Math.trunc(length / 4) * 2 - 1; idx <= a + Math.trunc(length / 4) * 2 + 1; idx++) {
      let other = Number(next() & BigInt(modulus - 1));
      if (other >= length) other -= length;
      data.swap(idx, a + other);
    }
  }
}

function choosePivot(data, a, b) {
  const shortestNinther = 50;
  const maxSwaps = 4 * 3;

  const l = b - a;
  const swaps = { n: 0 };
  const q = Math.trunc(l / 4);
  let i = a + q * 1;
  let j = a + q * 2;
  let k = a + q * 3;

  if (l >= 8) {
    if (l >= shortestNinther) {
      i = medianAdjacent(data, i, swaps);
      j = medianAdjacent(data, j, swaps);
      k = medianAdjacent(data, k, swaps);
    }
    j = median(data, i, j, k, swaps);
  }

  switch (swaps.n) {
    case 0: return [j, increasingHint];
    case maxSwaps: return [j, decreasingHint];
    default: return [j, unknownHint];
  }
}

function order2(data, a, b, swaps) {
  if (data.less(b, a)) {
    swaps.n++;
    return [b, a];
  }
  return [a, b];
}

function median(data, a, b, c, swaps) {
  [a, b] = order2(data, a, b, swaps);
  [b, c] = order2(data, b, c, swaps);
  [a, b] = order2(data, a, b, swaps);
  return b;
}

const medianAdjacent = (data, a, swaps) => median(data, a - 1, a, a + 1, swaps);

function reverseRange(data, a, b) {
  let i = a;
  let j = b - 1;
  while (i < j) {
    data.swap(i, j);
    i++;
    j--;
  }
}
