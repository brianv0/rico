// Prints the dagre input graphs the JS glue builds for each case, one JSON line per dagre.layout call, in the shape
// `dagrocmp.mjs` sends to dagro (and that a patched d2dagrelayout/layout.go can dump, see docs): node dagroinput.mjs cases.jsonl > in.jsonl
import fs from 'node:fs';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';
import dagre from '../../public/d2/vendor/dagre.js';

setMarkdownIt(markdownit);
await initD2();
const origLayout = dagre.layout;
dagre.layout = (g, ...a) => {
  const attrs = g.graph();
  console.log(JSON.stringify({
    ranksep: attrs.ranksep, edgesep: attrs.edgesep, nodesep: attrs.nodesep, rankdir: attrs.rankdir,
    nodes: g.nodes().map((id) => ({ id, width: g.node(id).width, height: g.node(id).height, parent: g.parent(id) || '' })),
    edges: g.edges().map((e) => ({ v: e.v, w: e.w, name: e.name, width: g.edge(e).width, height: g.edge(e).height })),
  }));
  return origLayout(g, ...a);
};
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const c = JSON.parse(l);
  try { d2compile(c.text, { fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'dagre' }, {}); } catch (e) { /* ignore */ }
}
