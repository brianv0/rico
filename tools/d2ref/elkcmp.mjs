// Engine-level diff: ELK.js 0.12.0 (vendor/elk.js, what the JS port runs) against elk-go (the native Go ELK D2 v0.9.0 calls), on the very graphs D2's glue builds.
//   node elkcmp.mjs cases.jsonl [d2ref binary] [--layout elk] [--dump file] [--show N]
// Runs the JS port on every case with the ELK engine, records the ELK JSON graph the glue marshals and the layout ELK.js returns for it (setObserver in
// d2elklayout.js), feeds the recorded graphs to `d2ref elk` (elk.LayoutJSON) and compares the two answers exactly: every field, every array in order
// (ELK.js's `$H` GWT hash codes are dropped; key order is compared separately and only reported). Errors of ELK.js and elk-go are counted as
// the same when both fail. Prints the first mismatches.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile, loadLayout } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';
import { setObserver } from '../../public/d2/d2elklayout.js';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i < 0 ? def : args[i + 1] ?? true; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--utf16'));
const [file, bin = '/tmp/d2ref'] = positional;
const show = Number(flag('--show', 8));
const layout = flag('--layout', 'elk');
setMarkdownIt(markdownit);
await initD2();
await loadLayout('elk');
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

let cur = 0;
const captured = [];
setObserver((raw, out, err) => captured.push({ raw, out, err, i: cur, from: cases[cur].from }));
for (; cur < cases.length; cur++) {
  const c = cases[cur];
  try {
    d2compile(c.text, { utf16: flag('--utf16', false) !== false, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: c.layout || layout, elkOpts: c.elkopts, measuredTexts: c.mtexts }, {});
  } catch (e) { /* the layout may have been captured already */ }
}
setObserver(null);

const input = captured.map((c) => JSON.stringify({ diagram: JSON.parse(c.raw) }) + '\n').join('');
const lines = execFileSync(bin, ['elk'], { input, maxBuffer: 1 << 30 }).toString().trim().split('\n');
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter((k) => k !== '$H').map((k) => [k, strip(v[k])])) : v);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
function firstDiff(a, b, p = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return `${p}: elkjs ${JSON.stringify(a)?.slice(0, 120)} elk-go ${JSON.stringify(b)?.slice(0, 120)}`;
}
let same = 0, bothErr = 0, keyOrder = 0;
const bad = [];
captured.forEach((c, k) => {
  const want = JSON.parse(lines[k]);
  if (c.err !== null || want.err !== undefined) {
    if (c.err !== null && want.err !== undefined) bothErr++;
    else bad.push({ k, i: c.i, from: c.from, d: `elkjs ${c.err !== null ? 'error ' + c.err : 'ok'}; elk-go ${want.err !== undefined ? 'error ' + want.err : 'ok'}` });
    return;
  }
  const a = strip(c.out), b = strip(want.out);
  const d = firstDiff(canon(a), canon(b));
  if (d) bad.push({ k, i: c.i, from: c.from, d }); else { same++; if (JSON.stringify(a) === JSON.stringify(b)) keyOrder++; }
});
console.log(`elk: ${same}/${captured.length - bothErr} ELK layouts identical to elk-go (${captured.length} layouts from ${cases.length} cases; ${keyOrder} also in the same key order)` + (bothErr ? `, ${bothErr} errors in both` : ''));
for (const b of bad.slice(0, show)) console.log(`\n#${b.i} ${b.from} (layout ${b.k})\n  ${b.d.slice(0, 500)}`);
if (flag('--dump', false) && bad.length) fs.writeFileSync(flag('--dump'), bad.map((b) => JSON.stringify({ diagram: JSON.parse(captured[b.k].raw) })).join('\n') + '\n');
process.exitCode = bad.length ? 1 : 0;
