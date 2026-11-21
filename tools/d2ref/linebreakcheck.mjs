// node linebreakcheck.mjs [N] [seed]: public/d2/linebreak.js against uniseg.FirstLineSegmentInString on random strings of U+0000..U+00FF.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstLineSegmentInString } from '../../public/d2/linebreak.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 3000);
let seed = Number(process.argv[3] || 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const alphabet = 'ab AZ09 -./,:;!?()[]{}"\'%$+\\|*&#<>=_~`@^\t ­¡«»°é×\n\r\u0085\u000b';
const inputs = [];
for (let i = 0; i < N; i++) {
  let s = '';
  const len = 1 + ((rnd() * 24) | 0);
  for (let k = 0; k < len; k++) s += rnd() < 0.9 ? alphabet[(rnd() * alphabet.length) | 0] : String.fromCharCode((rnd() * 256) | 0);
  inputs.push(s);
}
const out = execFileSync('go', ['run', '.', 'linebreak'], { cwd: here, input: inputs.map((t) => JSON.stringify({ text: t })).join('\n'), maxBuffer: 1 << 28 }).toString().trim().split('\n');
let same = 0;
const bad = [];
inputs.forEach((s, i) => {
  const want = JSON.parse(out[i]);
  const got = [];
  let rest = s, state = -1;
  while (rest) {
    const [seg, r, , ns] = firstLineSegmentInString(rest, state);
    if (!seg) break;
    got.push(seg);
    rest = r;
    state = ns;
  }
  if (JSON.stringify(got) === JSON.stringify(want.segments)) same++;
  else bad.push(`${JSON.stringify(s)}: got ${JSON.stringify(got)} want ${JSON.stringify(want.segments)}`);
});
console.log(`linebreak: ${same}/${inputs.length} identical to uniseg`);
for (const b of bad.slice(0, 8)) console.log(b);
process.exitCode = bad.length ? 1 : 0;
