// Counts the compile errors the JS port reports on a cases file (to see how much of a generated input set reaches layout):
//   node errstats.mjs cases.jsonl
import fs from 'node:fs';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';

setMarkdownIt(markdownit);
await initD2();
const counts = new Map();
const examples = new Map();
let ok = 0, n = 0;
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const c = JSON.parse(l);
  n++;
  const r = d2compile(c.text, { fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'dagre' }, {});
  if (!r.err) { ok++; continue; }
  const m = r.err.message.split('\n')[0].replace(/^[^:]*:\d+:\d+: /, '');
  counts.set(m, (counts.get(m) || 0) + 1);
  if (!examples.has(m)) examples.set(m, `${r.err.message.split('\n')[0]}\n${c.text}`);
}
console.log(`${ok}/${n} compile without error`);
for (const [m, k] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(k).padStart(5), m.slice(0, 120));
if (process.argv[3]) console.log('\n' + examples.get([...counts.keys()].find((m) => m.includes(process.argv[3]))));
