// Grid-only generator (stresses d2grid's bounded search: getBestLayout, iterDivisions, row measurements): node fuzzgrid.mjs [count] [seed]
const [count = '1000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
for (let i = 0; i < Number(count); i++) {
  const n = 3 + int(i % 5 === 0 ? 70 : 28);
  const lines = [];
  const mode = int(3);
  if (mode !== 1) lines.push(`grid-rows: ${1 + int(9)}`);
  if (mode !== 0) lines.push(`grid-columns: ${1 + int(9)}`);
  if (rnd() < 0.3) lines.push(`grid-gap: ${int(50)}`);
  if (rnd() < 0.2) lines.push(`vertical-gap: ${int(50)}`);
  if (rnd() < 0.2) lines.push(`horizontal-gap: ${int(50)}`);
  const uniform = rnd() < 0.2;
  const spread = [20, 60, 200][int(3)];
  for (let k = 0; k < n; k++) {
    const w = uniform ? 60 : 20 + int(spread), h = uniform ? 40 : 20 + int(spread / 2);
    lines.push(rnd() < 0.15 ? `c${k}: ${'long label '.repeat(1 + int(4))}` : `c${k}: {width: ${w}; height: ${h}}`);
  }
  if (rnd() < 0.3) lines.push(`c0 -> c${1 + int(n - 1)}`);
  const text = rnd() < 0.3 ? `outer: {\n${lines.map((l) => '  ' + l).join('\n')}\n}\nx -> outer` : lines.join('\n');
  console.log(JSON.stringify({ from: `fuzzgrid:${seed}:${i}`, path: 'f.d2', text: text + '\n' }));
}
