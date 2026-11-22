// Pure-function inputs of the pcunit check (math.Hypot of Go against the JS port's goHypot, the worker counts, the compass helpers):
//   node tala/pcunitcases.mjs [lines=40] [seed=1] > tala-pcunit.jsonl     (each line holds 500 pairs)
const lines = Number(process.argv[2] || 40);
let st = Number(process.argv[3] || 1) >>> 0;
const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sign = () => (rnd() < 0.5 ? -1 : 1);
function value() {
  switch (pick(['int', 'frac', 'big', 'tiny', 'zero', 'cell', 'unit'])) {
    case 'int': return sign() * Math.floor(rnd() * 3000);
    case 'frac': return sign() * rnd() * 2000;
    case 'big': return sign() * rnd() * 10 ** (20 + Math.floor(rnd() * 280));
    case 'tiny': return sign() * rnd() * 10 ** -(20 + Math.floor(rnd() * 280));
    case 'zero': return 0;
    case 'cell': return sign() * 20 * Math.floor(rnd() * 100);
    default: return sign() * (0.1 + Math.floor(rnd() * 10) / 10);
  }
}
for (let i = 0; i < lines; i++) {
  const pairs = [];
  for (let k = 0; k < 500; k++) pairs.push([value(), value()]);
  console.log(JSON.stringify({ name: `pcunit/${i}`, args: { pairs } }));
}
