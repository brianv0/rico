// Compares the JS port and the Go reference on one D2 file: node cmp.mjs file.d2 [bin] [runs]
// Prints the first differing path and a compact table of shapes (id, x, y, w, h) and the first points of every route for JS and for Go
// (bin = a prebuilt d2ref: `go build -o /tmp/d2ref .`; runs = how many times to run Go, to see Go-unstable output).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';

const [file, bin = '/tmp/d2ref', runs = '1'] = process.argv.slice(2);
setMarkdownIt(markdownit);
await initD2();
const text = fs.readFileSync(file, 'utf8');
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const r = d2compile(text, { inputPath: 'f.d2', layout: 'dagre' }, {});
const got = canon(JSON.parse(JSON.stringify({ diagram: r.diagram, err: r.err ? r.err.message : null })));
const summary = (d) => {
  if (!d) return '(no diagram)';
  const out = [];
  for (const s of d.shapes) out.push(`  ${s.id}: ${s.pos.x},${s.pos.y} ${s.width}x${s.height}`);
  for (const c of d.connections) out.push(`  ${c.id}: ${c.route.map((p) => `${p.x},${p.y}`).join(' ')}`);
  return out.join('\n');
};
function firstDiff(a, b, p = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return `${p}: js ${JSON.stringify(a)?.slice(0, 100)} go ${JSON.stringify(b)?.slice(0, 100)}`;
}
console.log('JS err:', got.err);
console.log('JS:\n' + summary(got.diagram));
const seen = new Set();
for (let i = 0; i < Number(runs); i++) {
  const want = canon(JSON.parse(execFileSync(bin, ['layout'], { input: JSON.stringify({ path: 'f.d2', text }) + '\n', maxBuffer: 1 << 28 }).toString()));
  const key = JSON.stringify(want);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`Go (run ${i}):\n` + summary(want.diagram));
  console.log('first diff:', firstDiff(got, want) ?? 'none');
}
