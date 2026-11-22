// node linebreakcheck.mjs [N] [seed] [wide]: public/d2/linebreak.js against uniseg.FirstLineSegmentInString on random strings of U+0000..U+00FF
// (`wide`: characters from all of Unicode, weighted towards the blocks with line break rules of their own).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstLineSegmentInString, loadFullTables } from '../../public/d2/linebreak.js';

await loadFullTables();
const wide = process.argv[4] === 'wide';
const here = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 3000);
let seed = Number(process.argv[3] || 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const alphabet = 'ab AZ09 -./,:;!?()[]{}"\'%$+\\|*&#<>=_~`@^\t ­¡«»°é×\n\r\u0085\u000b';
const blocks = [[0x300, 0x36f], [0x400, 0x4ff], [0x590, 0x6ff], [0xe00, 0xe7f], [0x1100, 0x11ff], [0x2000, 0x206f], [0x20a0, 0x20cf], [0x2190, 0x23ff], [0x25a0, 0x27bf],
  [0x2e80, 0x2fdf], [0x3000, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xfe00, 0xfe0f], [0xff00, 0xffef], [0x1f1e6, 0x1f1ff], [0x1f300, 0x1faff],
  [0x20000, 0x2a6df], [0xe0000, 0xe007f], [0x0900, 0x0dff], [0x1000, 0x109f], [0x0, 0x10ffff]];
const wideChar = () => {
  if (rnd() < 0.3) return alphabet[(rnd() * alphabet.length) | 0];
  const b = blocks[(rnd() * blocks.length) | 0];
  let cp = b[0] + ((rnd() * (b[1] - b[0] + 1)) | 0);
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x4e00;
  if (rnd() < 0.08) cp = [0x200d, 0xfe0f, 0x200b, 0x00a0, 0x3000, 0x2060, 0x00ad, 0x20e3, 0x1f3fb, 0x1f468, 0xff08, 0xff09, 0x3008, 0x3009, 0x2e80][(rnd() * 15) | 0];
  return String.fromCodePoint(cp);
};
const inputs = [];
for (let i = 0; i < N; i++) {
  let s = '';
  const len = 1 + ((rnd() * 24) | 0);
  for (let k = 0; k < len; k++) if (wide) s += wideChar(); else s += rnd() < 0.9 ? alphabet[(rnd() * alphabet.length) | 0] : String.fromCharCode((rnd() * 256) | 0);
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
console.log(`linebreak${wide ? ' (wide)' : ''}: ${same}/${inputs.length} identical to uniseg`);
for (const b of bad.slice(0, 8)) console.log(b);
process.exitCode = bad.length ? 1 : 0;
