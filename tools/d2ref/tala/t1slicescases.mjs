// cases of the t1ops stage for goslices.js: random arrays sorted by slices.SortFunc / SortStableFunc with the comparators of the T1 packages
//   node tala/t1slicescases.mjs [count=600] [seed=1] > t1slices.jsonl; node diff.mjs talat1ops t1slices.jsonl
import * as bigjson from '../../../public/d2/tala/bigjson.js';

const [count = '600', seed = '1'] = process.argv.slice(2);
let x = (Number(seed) * 2654435761) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
for (let i = 0; i < Number(count); i++) {
  const n = [0, 1, 2, 3, 5, 12, 13, 20, 21, 40, 41, 100, 200, 500][int(14)] + int(3);
  const cmp = ['loops', 'num', 'cyc'][int(3)];
  const kind = ['stable', 'func'][int(2)];
  const classes = 1 + int(5);
  const areas = 1 + int(8);
  // NaN cannot be written as JSON: 'num' uses a huge value instead (cmp.Compare's NaN rule is covered by the unit tests)
  const items = Array.from({ length: n }, () => [int(classes), int(areas) * (rnd() < 0.5 ? 1 : 2.5)]);
  console.log(bigjson.stringify({ name: `slices:${seed}:${i}`, graph: { nodes: [] }, args: { op: 'slices', kind, cmp, items } }));
}
