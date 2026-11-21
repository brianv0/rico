// Greedy line reducer for an engine-level ELK mismatch (ELK.js vs elk-go on the graph the glue builds):
//   node elkshrink.mjs cases.jsonl index [d2ref binary]   (the index of the case in the file)
// Removes lines (and then pairs of lines, for `x: {` ... `}`) while ELK.js and elk-go still disagree, and prints the reduced D2 program and the
// first differing path.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile, loadLayout } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';
import { setObserver } from '../../public/d2/d2elklayout.js';

const [file, index, bin = '/tmp/d2ref'] = process.argv.slice(2);
setMarkdownIt(markdownit);
await initD2();
await loadLayout('elk');
const c = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[Number(index)]);

const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter((k) => k !== '$H').map((k) => [k, strip(v[k])])) : v);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
function firstDiff(a, b, p = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return `${p}: elkjs ${JSON.stringify(a)?.slice(0, 80)} elk-go ${JSON.stringify(b)?.slice(0, 80)}`;
}
function check(text) {
  const cap = [];
  setObserver((raw, out, err) => cap.push({ raw, out, err }));
  try { d2compile(text, { inputPath: 'f.d2', layout: 'elk' }, {}); } catch (e) { /* captured so far */ }
  setObserver(null);
  if (!cap.length) return null;
  const input = cap.map((x) => JSON.stringify({ diagram: JSON.parse(x.raw) }) + '\n').join('');
  const lines = execFileSync(bin, ['elk'], { input, maxBuffer: 1 << 30 }).toString().trim().split('\n');
  for (let k = 0; k < cap.length; k++) {
    const want = JSON.parse(lines[k]);
    if (cap[k].err !== null || want.err !== undefined) { if ((cap[k].err !== null) !== (want.err !== undefined)) return 'error mismatch'; continue; }
    const d = firstDiff(canon(strip(cap[k].out)), canon(strip(want.out)));
    if (d) return d;
  }
  return null;
}
let lines = c.text.split('\n');
let d = check(lines.join('\n'));
if (!d) { console.log('no difference'); process.exit(0); }
let changed = true;
while (changed) {
  changed = false;
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= lines.length; i++) {
      const cand = [...lines.slice(0, i), ...lines.slice(i + n)];
      const dd = check(cand.join('\n'));
      if (dd) { lines = cand; d = dd; changed = true; i--; }
    }
  }
}
console.log(lines.join('\n'));
console.log('--', d);
