// Direct per-function cases for the packing / labeling / quality checks (Go runs the function itself on the same input as the JS port):
//
//   node tala/pkgdirect.mjs [--mutants N] [--seed S] [--stage-sample K]
//
// Inputs: the graph fixtures of d2talalayout/internal/testdata (inputs and the expected graphs of layout/*), every K-th stage graph of
// tala-pkg-pack.jsonl (the graphs before and after the two BinPack stages, with no deep state: margins and loop offsets are zero) and N
// mutants of them (moved and resized nodes, stripped or partial routes, random label positions, fixed nodes). For each graph the cases:
//
//   tala-pkgd-pack.jsonl      Pack (with work limits used-1, used/2, 1, 0 and, for containers, with the container as root)
//   tala-pkgd-place.jsonl     Place (limits), PlaceNewEdges for random edge subsets, Initialize, PositionArrowheadLabel of every edge
//   tala-pkgd-quality.jsonl   EvaluateWithArea and Inspect (limits)
//   tala-pkgd-combine.jsonl   CombineSubgraphs of the split subgraphs, moved by random offsets, with random obstacles (also a repeated graph)
//   tala-pkgd-score.jsonl     Score.Compare of random score pairs incl. NaN, +-Inf, negative areas
//
// run with: node diff.mjs talapack tala-pkgd-pack.jsonl (talaplace, talaquality, talacombine, talascore).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : Number(argv[i + 1]); };
const nMut = opt('--mutants', 1500);
const sample = opt('--stage-sample', 25);
let seed = opt('--seed', 1) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const refDir = process.env.TALA_REF || '/tmp/tala-ref';
const src = process.env.D2_SRC || refDir;
const readJSON = (f) => bigjson.parse(fs.readFileSync(f, 'utf8'));
const graphs = [];
const td = path.join(src, 'd2layouts/d2talalayout/internal/testdata');
for (const n of fs.readdirSync(path.join(td, 'layout')).sort()) {
  for (const f of ['graph.input.json', 'graph.exp.json']) {
    const p = path.join(td, 'layout', n, f);
    if (fs.existsSync(p)) graphs.push({ name: `fixture/layout/${n}/${f.split('.')[1]}`, graph: readJSON(p) });
  }
}
for (const sub of ['regression', 'benchmark']) {
  for (const f of fs.readdirSync(path.join(td, sub)).sort()) if (f.endsWith('.json')) graphs.push({ name: `fixture/${sub}/${f.slice(0, -5)}`, graph: readJSON(path.join(td, sub, f)) });
}
for (const n of fs.readdirSync(path.join(td, 'ovg')).sort()) {
  const p = path.join(td, 'ovg', n, 'graph.input.json');
  if (fs.existsSync(p)) graphs.push({ name: `fixture/ovg/${n}`, graph: readJSON(p) });
}
const stageFile = path.join(root, 'tala-pkg-pack.jsonl');
if (fs.existsSync(stageFile)) {
  let clusterGraphs = 0;
  fs.readFileSync(stageFile, 'utf8').trim().split('\n').forEach((l, i) => {
    // every K-th graph, and up to 150 graphs with active clusters (cluster edge labels only exist there)
    if (i % sample && !(l.includes('"clusters"') && l.includes('"kind":"pack"') && clusterGraphs < 150 && ++clusterGraphs)) return;
    const c = bigjson.parse(l);
    graphs.push({ name: `${c.name}/pre`, graph: c.graph });
    graphs.push({ name: `${c.name}/post`, graph: c.args.expect.graph });
  });
}

// ---- mutations of a graphjson object ----
const clone = (g) => bigjson.parse(bigjson.stringify(g));
const NODE_POS = ['INSIDE_MIDDLE_CENTER', 'INSIDE_TOP_CENTER', 'INSIDE_BOTTOM_CENTER', 'INSIDE_MIDDLE_LEFT', 'INSIDE_TOP_LEFT', 'OUTSIDE_TOP_CENTER', 'OUTSIDE_BOTTOM_CENTER', 'OUTSIDE_LEFT_MIDDLE', 'OUTSIDE_RIGHT_TOP', 'OUTSIDE_BOTTOM_RIGHT', 'BORDER_TOP_LEFT', ''];
const EDGE_POS = ['', 'UNLOCKED_TOP', 'UNLOCKED_MIDDLE', 'UNLOCKED_BOTTOM', 'OUTSIDE_TOP_CENTER', 'INSIDE_MIDDLE_CENTER', 'OUTSIDE_BOTTOM_LEFT', 'INSIDE_MIDDLE_RIGHT'];
function mutate(g0) {
  const g = clone(g0);
  const nodes = g.nodes ?? [];
  const edges = g.edges ?? [];
  const steps = ri(1, 3);
  // records that graphjson repeats (tree nodes, cluster and sequence vessels, abductions) must stay consistent, and Go's message for an
  // inconsistent one depends on its map order: such graphs are not mutated
  const repeats = !!(g.trees || g.sequenceVessels || g.sequences);
  const clustered = !!(g.clusters || g.clusterVessels); // the vessel records stay as they are: only edges and labels change
  const kinds = clustered ? [2, 3, 4, 5, 7, 9, 10, 11, 11, 11] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11];
  for (let s = 0; s < steps; s++) {
    switch (repeats ? -1 : pick(kinds)) {
      case 11: // give the unrouted edges an L-shaped route between the node centers (routes on graphs with active clusters)
        for (const e of edges) {
          if ((e.points ?? []).length === 0) {
            const a = nodes.find((n) => n.id === e.from), b = nodes.find((n) => n.id === e.to);
            if (a?.topLeft && b?.topLeft) {
              const p = { x: a.topLeft.x + Math.trunc(a.width / 2), y: a.topLeft.y + Math.trunc(a.height / 2) };
              const q = { x: b.topLeft.x + Math.trunc(b.width / 2), y: b.topLeft.y + Math.trunc(b.height / 2) };
              e.points = rnd() < 0.5 ? [p, { x: q.x, y: p.y }, q] : [p, q];
            }
          }
        }
        break;
      case 0: // move some nodes
        for (const n of nodes) if (n.topLeft && rnd() < 0.3) { n.topLeft.x += ri(-6, 6) * 10; n.topLeft.y += ri(-6, 6) * 10; }
        break;
      case 1: // resize
        for (const n of nodes) if (rnd() < 0.25) { n.width = Math.max(10, n.width + ri(-4, 8) * 10); n.height = Math.max(10, n.height + ri(-4, 8) * 10); }
        break;
      case 2: // strip all routes
        for (const e of edges) e.points = [];
        break;
      case 3: // partial routes
        for (const e of edges) if (rnd() < 0.4) e.points = [];
        break;
      case 4: // node labels
        for (const n of nodes) if (n.label && rnd() < 0.7) n.label.Position = pick(NODE_POS);
        break;
      case 5: // edge labels
        for (const e of edges) {
          if (rnd() < 0.5) {
            if (!e.label) e.label = { Text: 'L' + ri(1, 99), Position: '', Width: ri(2, 12) * 10, Height: ri(1, 4) * 10 };
            e.label.Position = pick(EDGE_POS);
          }
        }
        break;
      case 6: // fixed nodes
        for (const n of nodes) if (n.topLeft && rnd() < 0.15) n.fixedTopLeft = { x: n.topLeft.x, y: n.topLeft.y };
        break;
      case 7: // arrowhead labels
        for (const e of edges) {
          if (rnd() < 0.3) e.sourceArrowheadLabel = { Text: 'a' + ri(1, 9), Position: '', Width: ri(2, 8) * 10, Height: 21 };
          if (rnd() < 0.3) e.targetArrowheadLabel = { Text: 'b' + ri(1, 9), Position: '', Width: ri(2, 8) * 10, Height: 21 };
        }
        break;
      case 8: // icons
        for (const n of nodes) if (rnd() < 0.3) n.icon = { Position: rnd() < 0.5 ? '' : pick(NODE_POS) };
        break;
      case 10: // edge border radius (the routed-container proof reads it)
        for (const e of edges) if (rnd() < 0.5) e.style = { ...(e.style ?? {}), borderRadius: { value: pick(['0', '5', '10', '20', '3.5', 'abc', '', '1e2', '-4', 'x'.repeat(70)]) } };
        break;
      case -1:
        break;
      default: // jitter route points
        for (const e of edges) for (const p of e.points ?? []) if (rnd() < 0.2) { p.x += ri(-3, 3) * 5; p.y += ri(-3, 3) * 5; }
    }
  }
  return g;
}

// ---- cases ----
const files = ['pack', 'place', 'quality', 'combine', 'score'];
const fds = Object.fromEntries(files.map((f) => [f, fs.openSync(path.join(root, `tala-pkgd-${f}.jsonl`), 'w')]));
const counts = Object.fromEntries(files.map((f) => [f, 0]));
const emit = (kind, c) => { fs.writeSync(fds[kind], bigjson.stringify(c) + '\n'); counts[kind]++; };

function casesFor(name, graph) {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  emit('pack', { name: `${name}/pack`, graph, args: { limits: [1] } });
  const containers = Object.keys(graph.containers ?? {}).filter((k) => k !== '0');
  for (const k of containers.slice(0, 2)) emit('pack', { name: `${name}/pack-root-${k}`, graph, args: { root: String(k) } });
  emit('place', { name: `${name}/place`, graph, args: { limits: [1] } });
  if (edges.length) {
    const idx = edges.map((_, i) => i).filter(() => rnd() < 0.5);
    emit('place', { name: `${name}/placenew`, graph, args: { op: 'new', edges: idx, limits: [1] } });
  }
  emit('place', { name: `${name}/init`, graph, args: { op: 'init' } });
  emit('place', { name: `${name}/arrowheads`, graph, args: { op: 'arrowheads' } });
  emit('quality', { name: `${name}/quality`, graph, args: { limits: [1] } });
  if (rnd() < 0.15) { // an already canceled context
    emit('pack', { name: `${name}/pack-canceled`, graph, args: { cancel: true } });
    emit('place', { name: `${name}/place-canceled`, graph, args: { cancel: true } });
    emit('quality', { name: `${name}/quality-canceled`, graph, args: { cancel: true } });
  }
  if (nodes.length && nodes.every((n) => n.topLeft)) {
    const k = ri(1, 3);
    const offsets = Array.from({ length: k }, () => [ri(-30, 30) * 10, ri(-30, 30) * 10]);
    const obstacles = Array.from({ length: ri(0, 3) }, () => [ri(-20, 60) * 10, ri(-20, 60) * 10, ri(2, 30) * 10, ri(2, 30) * 10]);
    for (const split of [[false, true, true], [false, false, false], [true, false, false]]) {
      emit('combine', { name: `${name}/combine${split.map((b) => (b ? 1 : 0)).join('')}`, graph, args: { offsets, obstacles, split, dupe: rnd() < 0.1 } });
    }
  }
}

for (const { name, graph } of graphs) casesFor(name, graph);
const total = graphs.length;
for (let i = 0; i < nMut; i++) {
  const base = pick(graphs);
  casesFor(`mut${i}/${base.name}`, mutate(base.graph));
}

const SPECIAL = ['NaN', '+Inf', '-Inf', 0, -1, 1, 2.5, 100, 99, 1e308, -0.5];
const sc = () => (rnd() < 0.3 ? pick(SPECIAL) : Math.round(rnd() * 400) / 4);
const rows = [];
for (let i = 0; i < 400; i++) rows.push([sc(), sc(), rnd() < 0.3 ? null : sc(), sc()].map((v, j) => (v === null ? [0][0] : v)));
for (let i = 0; i < 100; i++) { const r = [sc(), sc()]; rows.push([...r, ...(rnd() < 0.5 ? r : [sc(), sc()])]); }
for (let i = 0; i < rows.length; i += 50) emit('score', { name: `score/${i}`, args: { scores: rows.slice(i, i + 50) } });
console.log(JSON.stringify({ graphs: total, mutants: nMut, ...counts }));
