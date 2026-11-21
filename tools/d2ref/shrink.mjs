// Shrinks a failing layout case: node shrink.mjs cases.jsonl index [d2ref binary]   (or: node shrink.mjs case.d2 0 [d2ref binary])
// Greedily removes lines (and then whole {} blocks) of the D2 text while the JS port and the Go reference still disagree on the
// `layout` result, and prints the smallest text found. The Go reference is run from a prebuilt binary (`go build -o /tmp/d2ref .`).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';

const [file, index, bin = '/tmp/d2ref'] = process.argv.slice(2);
setMarkdownIt(markdownit);
await initD2();
const c0 = file.endsWith('.d2') ? { path: 'f.d2', text: fs.readFileSync(file, 'utf8') } : JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[Number(index)]);

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
function differs(text) {
  const c = { ...c0, text };
  const want = JSON.parse(execFileSync(bin, ['layout'], { input: JSON.stringify(c) + '\n', maxBuffer: 1 << 28 }).toString());
  if (want.panic) return false;
  const r = d2compile(text, { fs: c.fs && { [c.path]: text, ...c.fs }, inputPath: c.path, layout: 'dagre' }, {});
  if (r.err && r.err.name === 'LatexNotPorted') return false;
  const got = canon(JSON.parse(JSON.stringify({ diagram: r.diagram, err: r.err ? r.err.message : null })));
  return JSON.stringify(got) !== JSON.stringify(canon(want));
}

let lines = c0.text.split('\n');
if (!differs(lines.join('\n'))) { console.log('case does not differ'); process.exit(1); }
let changed = true;
while (changed) {
  changed = false;
  // try removing balanced {} blocks, then single lines
  for (let i = 0; i < lines.length; i++) {
    if (/\{\s*$/.test(lines[i])) {
      let depth = 0, j = i;
      for (; j < lines.length; j++) {
        depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
        if (depth <= 0) break;
      }
      const cand = [...lines.slice(0, i), ...lines.slice(j + 1)];
      if (cand.length && differs(cand.join('\n'))) { lines = cand; changed = true; i--; continue; }
    }
    const cand = [...lines.slice(0, i), ...lines.slice(i + 1)];
    if (cand.length && differs(cand.join('\n'))) { lines = cand; changed = true; i--; }
  }
}
console.log(lines.join('\n'));
