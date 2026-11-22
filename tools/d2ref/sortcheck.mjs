// JS side of `sortslice` mode (tools/d2ref/urlcheck.go): sort.Slice with SortObjectsByAST-like comparators.
//   node sortcheck.mjs [seed] > sort.jsonl
import { sortSlice } from '../../public/d2/gosort.js';

export function sortCheck(c) {
  const xs = c.route.map((r) => r.slice());
  sortSlice(xs, (i, j) => (xs[i][2] !== 0 || xs[j][2] !== 0 ? i < j : xs[i][1] < xs[j][1]));
  return { ids: xs.map((x) => x[0]) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let x = Number(process.argv[2] || 7) >>> 0 || 1;
  const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const list = [];
  for (let t = 0; t < 3000; t++) {
    const n = rnd(t < 1500 ? 30 : 300);
    const keys = rnd(4) === 0 ? 3 : 1000; // many ties or few
    const flagRate = [0, 0, 3, 10, 50][rnd(5)];
    const mode = rnd(4); // random, sorted, reversed, sawtooth
    const route = [];
    for (let i = 0; i < n; i++) {
      let k = rnd(keys);
      if (mode === 1) k = i; else if (mode === 2) k = n - i; else if (mode === 3) k = i % 7;
      route.push([i, k, flagRate && rnd(100) < flagRate ? 1 : 0]);
    }
    list.push({ route });
  }
  process.stdout.write(list.map((c) => JSON.stringify(c)).join('\n') + '\n');
}
