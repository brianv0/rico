// The ELK input graphs of the JS glue against those the Go glue really marshals.
//   sh elkdump/build.sh /tmp/d2ref_dump; D2REF_ELKDUMP=/tmp/dump.jsonl /tmp/d2ref_dump layout < cases.jsonl (cases with "layout": "elk"); node elkinputcmp.mjs cases.jsonl /tmp/dump.jsonl
import fs from 'node:fs';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile, loadLayout } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';
import { setObserver } from '../../public/d2/d2elklayout.js';
const [casesFile, dumpFile] = process.argv.slice(2);
setMarkdownIt(markdownit);
await initD2();
await loadLayout('elk');
const cases = fs.readFileSync(casesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const go = fs.readFileSync(dumpFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let cur = 0;
const js = [];
setObserver((raw) => js.push({ raw, i: cur }));
for (; cur < cases.length; cur++) {
  const c = cases[cur];
  try { d2compile(c.text, { fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'elk' }, {}); } catch (e) {}
}
// greedy alignment: JS captures are a subsequence of Go's (Go also lays out boards JS rejects before layout, e.g. latex)
let gi = 0, same = 0, bad = [];
const canon = (s) => JSON.stringify(JSON.parse(s));
for (const j of js) {
  const want = canon(j.raw);
  let k = gi;
  while (k < go.length && JSON.stringify(go[k].in) !== want) k++;
  if (k < go.length) { same++; gi = k + 1; } else bad.push(j.i);
}
console.log(`js ${js.length} go ${go.length}: ${same} JS inputs found in order in Go's; unmatched cases: ${bad.slice(0, 20)}`);
