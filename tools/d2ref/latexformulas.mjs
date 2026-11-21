// Prints every LaTeX label of the D2 inputs as {"text", "src"} lines for the `latex` stage of diff.mjs:
//   node latexformulas.mjs corpus.jsonl extra.jsonl e2e.jsonl [e2esvg.jsonl]
// Corpus-like files ({text, path, fs}) are compiled with the graph stage (shapes with `language: latex`, edge labels, every board);
// e2e.jsonl lines are the recorded e2e cases ({"msg":"case","name","text"}); e2esvg.jsonl lines carry Go's diagrams (shape/connection
// `language` and `label`), so formulas that only exist in generated inputs are found too.
import fs from 'node:fs';
import markdownit from 'markdown-it';
import { compile as compileGraph } from '../../public/d2/d2compiler.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';

setMarkdownIt(markdownit);
const seen = new Map();
const add = (text, src) => { if (!seen.has(text)) seen.set(text, src); };

function boards(g, fn) {
  fn(g);
  for (const k of ['layers', 'scenarios', 'steps']) for (const b of g[k] || []) boards(b, fn);
}

function fromSource(text, path, files, src) {
  const r = compileGraph(path || 'index.d2', text, { fs: files && { [path || 'index.d2']: text, ...files } });
  if (r.err || !r.g) return;
  boards(r.g, (g) => {
    for (const o of g.objects || []) if (o.attributes.language === 'latex') add(o.text().text, src);
    for (const e of g.edges || []) if (e.attributes.language === 'latex') add(e.text().text, src);
  });
}

function fromDiagram(d, src) {
  for (const s of d.shapes || []) if (s.language === 'latex') add(s.label, src);
  for (const c of d.connections || []) if (c.language === 'latex') add(c.label, src);
  for (const k of ['layers', 'scenarios', 'steps']) for (const b of d[k] || []) fromDiagram(b, src);
}

for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.forEach((l, i) => {
    const c = JSON.parse(l);
    if (c.diagram) fromDiagram(c.diagram, `${file}:${c.path ?? i}`);
    else if (typeof c.text === 'string' && c.text.includes('latex') || c.text?.includes('tex')) fromSource(c.text, c.path, c.fs, `${file}:${c.name ?? c.path ?? i}`);
  });
}
for (const [text, src] of seen) console.log(JSON.stringify({ text, src }));
console.error(`${seen.size} formulas`);
