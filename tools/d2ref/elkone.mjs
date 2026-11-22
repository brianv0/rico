// Engine-level check of one D2 program (from a file, or - for stdin): node elkone.mjs file.d2 [d2ref binary] [--show]
// Prints "same" or the first differing path between ELK.js (the JS port's engine) and elk-go for every ELK graph the glue builds; --show prints the ELK graph too.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile, loadLayout } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';
import { setObserver } from '../../public/d2/d2elklayout.js';

const args = process.argv.slice(2);
const show = args.includes('--show');
const [file, bin = '/tmp/d2ref'] = args.filter((a) => !a.startsWith('--'));
setMarkdownIt(markdownit);
await initD2();
await loadLayout('elk');
// env ELK_ALT=path/to/another/elk.js: run that build of the engine (see elkbuild/build.py, ELK_COMPAT) on the recorded graphs instead of the vendored one
const alt = process.env.ELK_ALT ? await import(process.env.ELK_ALT) : null;
function altLayout(raw) {
  let last;
  const d = new alt.Dispatcher({ postMessage: (m) => { last = m; } });
  d.saveDispatch({ data: { id: 0, cmd: 'register', algorithms: ['layered', 'stress', 'mrtree', 'radial', 'force', 'sporeOverlap', 'sporeCompaction', 'rectpacking'] } });
  d.saveDispatch({ data: { id: 1, cmd: 'layout', graph: JSON.parse(raw), layoutOptions: {}, options: {} } });
  return last.error ? { out: null, err: String(last.error.message || last.error) } : { out: last.data, err: null };
}
const all = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
// several programs in one file, separated by a line of three dashes
for (const text of all.split(/^---$/m)) await one(text.replace(/^\n/, ''));
async function one(text) {
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter((k) => k !== '$H').map((k) => [k, strip(v[k])])) : v);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
function diffs(a, b, p, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], `${p}.${k}`, out); return; }
  out.push(`${p}: elkjs ${JSON.stringify(a)} elk-go ${JSON.stringify(b)}`);
}
console.log('### ' + text.trim().split('\n').join(' | '));
const cap = [];
setObserver((raw, out, err) => cap.push({ raw, out, err }));
const r = d2compile(text, { inputPath: 'f.d2', layout: 'elk' }, {});
setObserver(null);
if (r.err) console.log('compile error:', r.err.message);
const input = cap.map((x) => JSON.stringify({ diagram: JSON.parse(x.raw) }) + '\n').join('');
const lines = execFileSync(bin, ['elk'], { input, maxBuffer: 1 << 30 }).toString().trim().split('\n');
cap.forEach((x0, k) => {
  let x = x0;
  const want = JSON.parse(lines[k]);
  if (alt) { const r = altLayout(x.raw); x = { ...x, out: r.out, err: r.err }; }
  if (show) console.log(JSON.stringify(JSON.parse(x.raw)));
  if (x.err !== null || want.err !== undefined) { console.log(`layout ${k}: elkjs ${x.err ?? 'ok'}; elk-go ${want.err ?? 'ok'}`); return; }
  const out = [];
  diffs(canon(strip(x.out)), canon(strip(want.out)), '$', out);
  console.log(`layout ${k}: ${out.length ? out.slice(0, 8).join('\n  ') : 'same'}`);
});
}
