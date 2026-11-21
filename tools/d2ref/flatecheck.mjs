// node flatecheck.mjs [N] [seed]: public/d2/flate.js against Go's compress/zlib (default level; Write, Flush, Close) on
// random, repetitive and real font data of many sizes. Prints the number of identical streams and the first difference.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zlibCompress } from '../../public/d2/flate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 300);
let seed = Number(process.argv[3] || 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

const inputs = [];
const sizes = [0, 1, 2, 5, 11, 12, 13, 31, 32, 33, 100, 127, 128, 129, 255, 256, 300, 1000, 1023, 1024, 1025, 4000, 20000, 65534, 65535, 65536, 70000, 140000, 200000];
const words = ['glyph', 'font', 'table', 'loca', 'cmap', 'hmtx', 'the quick brown fox', 'jumps', 'over', 'lazy dog', '\u0000\u0001\u0002', 'AAAAAAAA', '0123456789'];
function gen(kind, size) {
  const b = new Uint8Array(size);
  if (kind === 0) for (let i = 0; i < size; i++) b[i] = (rnd() * 256) | 0;
  else if (kind === 1) { // text
    let s = '';
    while (s.length < size) s += words[(rnd() * words.length) | 0] + ' ';
    for (let i = 0; i < size; i++) b[i] = s.charCodeAt(i);
  } else if (kind === 2) { // low entropy
    for (let i = 0; i < size; i++) b[i] = (rnd() * 4) | 0;
  } else if (kind === 3) { // sparse table-like (zeros with noise)
    for (let i = 0; i < size; i++) b[i] = rnd() < 0.1 ? (rnd() * 256) | 0 : 0;
  } else { // repeated blocks
    const blk = Uint8Array.from({ length: 1 + ((rnd() * 300) | 0) }, () => (rnd() * 256) | 0);
    for (let i = 0; i < size; i++) b[i] = rnd() < 0.02 ? (rnd() * 256) | 0 : blk[i % blk.length];
  }
  return b;
}
for (let i = 0; i < N; i++) inputs.push(gen(i % 5, i < sizes.length * 5 ? sizes[(i / 5) | 0] : ((rnd() * rnd() * 150000) | 0)));
// real font tables and whole fonts
const fontDir = process.env.D2FONTS;
if (fontDir) for (const f of fs.readdirSync(fontDir)) if (f.endsWith('.ttf')) inputs.push(new Uint8Array(fs.readFileSync(path.join(fontDir, f))));

const req = inputs.map((b) => JSON.stringify({ data: Buffer.from(b).toString('base64') })).join('\n');
const out = execFileSync('go', ['run', '.', 'zlib'], { cwd: here, input: req, maxBuffer: 1 << 30 }).toString().trim().split('\n');
let same = 0;
const bad = [];
inputs.forEach((b, i) => {
  const want = Buffer.from(JSON.parse(out[i]).out, 'base64');
  const got = Buffer.from(zlibCompress(b));
  if (Buffer.compare(want, got) === 0) same++;
  else {
    let k = 0;
    while (k < want.length && want[k] === got[k]) k++;
    bad.push(`#${i} size ${b.length} kind ${i % 5}: lengths ${got.length}/${want.length}, first difference at byte ${k}`);
  }
});
console.log(`flate: ${same}/${inputs.length} identical to Go`);
for (const b of bad.slice(0, 10)) console.log(b);
process.exitCode = bad.length ? 1 : 0;
