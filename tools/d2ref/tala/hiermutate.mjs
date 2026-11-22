// Mutates the graphs of a hierarchy case file (perturbed fixtures: arrowheads flipped, edges removed or added between existing nodes, node sizes
// changed, a direction set, the root hierarchy forced), so that the hierarchy checks see topologies that D2 programs do not produce:
//   node tala/hiermutate.mjs tala-hier.jsonl [seed=1] [copies=1] > tala-hiermut.jsonl
// The result has no golden (the pipeline is not run on a mutant); every case runs through the same Go and JS code.
import fs from 'node:fs';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

let st = Number(process.argv[3] || 1) >>> 0;
const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const copies = Number(process.argv[4] || 1);

function mutate(c) {
  const g = c.graph;
  const m = JSON.parse(JSON.stringify(g, (k, v) => (typeof v === 'bigint' ? `__big${v}` : v)), (k, v) => (typeof v === 'string' && v.startsWith('__big') ? BigInt(v.slice(5)) : v));
  const edges = m.edges ?? [];
  const nodes = m.nodes ?? [];
  const n = 1 + int(3);
  for (let i = 0; i < n; i++) {
    switch (int(6)) {
      case 0: // flip an arrowhead
        if (edges.length) { const e = pick(edges); const a = pick(['sourceArrowhead', 'targetArrowhead']); e[a] = e[a] === 'none' ? 'triangle' : 'none'; }
        break;
      case 1: // reverse an edge
        if (edges.length) { const e = pick(edges); const t = e.from; e.from = e.to; e.to = t; }
        break;
      case 2: // remove an edge
        if (edges.length) edges.splice(int(edges.length), 1);
        break;
      case 3: // resize a node (keep containers as they are: their size comes from the children)
        if (nodes.length) { const nd = pick(nodes); nd.width = 20 + int(200); nd.height = 20 + int(120); }
        break;
      case 4: // a root direction
        m.directions = { ...(m.directions ?? {}), 0: pick(['up', 'down', 'left', 'right']) };
        break;
      default: // an extra edge between two leaf-looking nodes of the root level
        if (nodes.length > 1) {
          const a = pick(nodes), b = pick(nodes);
          if (a.id !== b.id && !a.id.toString().startsWith('-')) {
            const maxID = edges.reduce((mx, e) => (BigInt(e.id) > mx ? BigInt(e.id) : mx), 0n);
            edges.push({ id: maxID + 1n, d2id: `mut${i}`, from: a.id, to: b.id, points: [], minWidth: 10, minHeight: 10, labelPercentage: 0, style: {}, sourceArrowhead: 'none', targetArrowhead: pick(['none', 'triangle']) });
          }
        }
    }
  }
  return { name: `mut/${c.name}/${st}`, graph: m, seeds: c.seeds, args: { deep: c.args.deep } };
}

for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const c = bigjson.parse(l);
  for (let k = 0; k < copies; k++) console.log(bigjson.stringify(mutate(c)));
}
