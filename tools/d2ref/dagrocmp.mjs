// Engine-level diff: the dagre.js the JS port uses against dagro (the Go dagre D2 v0.9.0 calls), on the very graphs D2's glue builds.
//   node dagrocmp.mjs cases.jsonl [d2ref binary] [--dump dir]
// Runs the JS port on every case with `dagre.layout` wrapped to record its input graph and result, feeds the recorded graphs to
// `d2ref dagro`, and compares nodes (x, y, width, height) and edges (points) exactly. Prints the first mismatches.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';
import dagre from '../../public/d2/vendor/dagre.js';

const [file, bin = '/tmp/d2ref', ...rest] = process.argv.slice(2);
setMarkdownIt(markdownit);
await initD2();
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const captured = [];
const origLayout = dagre.layout;
dagre.layout = (g, ...a) => {
  const attrs = g.graph();
  const nodes = g.nodes().map((id) => ({ id, width: g.node(id).width, height: g.node(id).height, parent: g.parent(id) || '' }));
  const edges = g.edges().map((e) => ({ v: e.v, w: e.w, name: e.name, width: g.edge(e).width, height: g.edge(e).height }));
  const desc = { ranksep: attrs.ranksep, edgesep: attrs.edgesep, nodesep: attrs.nodesep, rankdir: attrs.rankdir, nodes, edges };
  const res = origLayout(g, ...a);
  captured.push({ desc, from: cases[cur].from, i: cur, js: { nodes: g.nodes().map((id) => { const n = g.node(id); return { id, x: n.x, y: n.y, width: n.width, height: n.height }; }), edges: g.edges().map((e) => ({ v: e.v, w: e.w, name: e.name, points: g.edge(e).points.map((p) => [p.x, p.y]) })) } });
  return res;
};
let cur = 0;
for (; cur < cases.length; cur++) {
  const c = cases[cur];
  try {
    d2compile(c.text, { fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'dagre' }, {});
  } catch (e) { /* the layout call may have been captured already */ }
}
dagre.layout = origLayout;

const input = captured.map((c) => JSON.stringify({ diagram: c.desc }) + '\n').join('');
const out = execFileSync(bin, ['dagro'], { input, maxBuffer: 1 << 30 }).toString().trim().split('\n');
let same = 0, panics = 0;
const bad = [];
captured.forEach((c, k) => {
  const want = JSON.parse(out[k]);
  if (want.panic || want.err) { panics++; return; }
  const sameNum = (a, b) => a === b || (a == null && b == null);
  let d = null;
  for (const n of want.nodes || []) {
    const j = c.js.nodes.find((m) => m.id === n.id);
    for (const key of ['x', 'y', 'width', 'height']) if (!d && !sameNum(j[key], n[key])) d = `node ${n.id}.${key}: js ${j[key]} go ${n[key]}`;
  }
  (want.edges || []).forEach((e, i) => {
    const j = c.js.edges[i];
    if (!d && (j.v !== e.v || j.w !== e.w || j.name !== e.name)) d = `edge ${i} order: js ${j.v}->${j.w} ${j.name} go ${e.v}->${e.w} ${e.name}`;
    if (!d && JSON.stringify(j.points) !== JSON.stringify(e.points)) d = `edge ${i} (${e.v}->${e.w}) points: js ${JSON.stringify(j.points)} go ${JSON.stringify(e.points)}`;
  });
  if (d) bad.push({ k, from: c.from, i: c.i, d }); else same++;
});
console.log(`dagro: ${same}/${captured.length - panics} dagre layouts identical to dagro (${captured.length} layouts from ${cases.length} cases)` + (panics ? `, ${panics} skipped (dagro error)` : ''));
for (const b of bad.slice(0, 10)) console.log(`\n#${b.i} ${b.from} (layout ${b.k})\n  ${b.d.slice(0, 400)}`);
if (rest.includes('--dump') && bad.length) fs.writeFileSync(rest[rest.indexOf('--dump') + 1], bad.map((b) => JSON.stringify({ diagram: captured[b.k].desc })).join('\n') + '\n');
process.exitCode = bad.length ? 1 : 0;
