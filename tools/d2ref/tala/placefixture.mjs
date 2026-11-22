// Records test/fixtures/tala-placement-stages.json: Go's graphs (with deep state) after stages -1..20 for a handful of small corpus cases that
// exercise the placement stages (containers, clusters, trees, hierarchies, tables, fixed positions, nears). Replayed by test/tala-placement.test.js.
//   node tala/placefixture.mjs [tala-corpus.jsonl]
import fs from 'node:fs';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import { runGo, loadCases } from './rootlib.mjs';

const cases = loadCases(process.argv[2] || 'tala-corpus.jsonl');
const out = runGo('t1stages', cases.map((c) => ({ ...c, seeds: [1], args: { stages: [-1, ...Array.from({ length: 21 }, (_, i) => i)] } })), 20);
const want = [];
let bytes = 0;
const kinds = new Set();
for (const [i, w] of out.entries()) {
  if (!w.runs || w.panic) continue;
  const run = w.runs.find((r) => r.stages && r.stages.length === 22);
  if (!run) continue;
  const n = run.stages[0].graph.nodes.length;
  if (n < 4 || n > 14) continue;
  const g = run.stages[7].graph;
  // a variety: containers, clusters, trees, hierarchies, fixed positions, nears
  const kind = [(g.containers ?? []).length > 1 ? 'containers' : '', Object.keys(g.clusters ?? {}).length ? 'clusters' : '', (g.trees ?? []).length ? 'trees' : '',
    (g.hierarchies ?? []).length ? 'hierarchy' : '', g.nodes.some((x) => x.fixedTopLeft) ? 'fixed' : ''].filter(Boolean).join('+') || 'plain';
  const size = bigjson.stringify(run).length;
  if (kinds.has(kind) && want.filter((x) => x.kind === kind).length >= 2) continue;
  if (bytes + size > 700000) continue;
  kinds.add(kind);
  bytes += size;
  want.push({ name: cases[i].name ?? cases[i].path ?? String(i), kind, seed: run.seed, stages: run.stages.map(({ index, graph, deep }) => ({ index, graph, deep })) });
}
fs.writeFileSync('../../test/fixtures/tala-placement-stages.json', bigjson.stringify(want));
console.log(`${want.length} cases, ${bytes} bytes, kinds: ${want.map((x) => x.kind).join(', ')}`);
