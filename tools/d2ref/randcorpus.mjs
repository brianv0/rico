// Generates cases for the talarand stage (gorand.js against Go's math/rand): node randcorpus.mjs [n=400] [seed=1] > tala-rand.jsonl
import * as bigjson from '../../public/d2/tala/bigjson.js';
const n = Number(process.argv[2] || 400);
let s = BigInt(process.argv[3] || 1);
const next = () => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return s; };
const rnd = (m) => Number(next() >> 33n) % m;
const seeds = [0n, 1n, 2n, 3n, 123n, -1n, 89482311n, 2147483646n, 2147483647n, 2147483648n, 4294967296n, 9223372036854775807n, -9223372036854775808n, 5577006791947779410n];
const ops = ['Int63', 'Uint32', 'Uint64', 'Int31', 'Int', 'Float64', 'Float32', 'Int63n', 'Int31n', 'Intn', 'Perm', 'Shuffle', 'GuardShuffle'];
const out = [];
for (let i = 0; i < n; i++) {
  const seed = i < seeds.length ? seeds[i] : BigInt.asIntN(64, next());
  const list = [];
  const len = 1 + rnd(60);
  for (let k = 0; k < len; k++) {
    const op = ops[rnd(ops.length)];
    let nn = 0;
    if (op === 'Int63n') nn = [1, 2, 3, 7, 1000, 1 << 30, 2 ** 40 + 5, 2 ** 62][rnd(8)];
    if (op === 'Int31n') nn = [1, 2, 3, 6, 100, 1 << 30, 2147483647, 1000003][rnd(8)];
    if (op === 'Intn') nn = [1, 2, 5, 10, 1000, 2147483647, 2147483648, 2 ** 40][rnd(8)];
    if (op === 'Perm' || op === 'Shuffle' || op === 'GuardShuffle') nn = rnd(3) === 0 ? rnd(2) : 1 + rnd(200);
    list.push({ op, n: nn });
  }
  out.push({ seed, ops: list });
}
console.log(out.map((c) => bigjson.stringify(c)).join('\n'));
