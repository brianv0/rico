// Adds the budget and cancellation variants to the cases of a hierarchy case file (the hierstage check then also compares the error of
// Assign/Place under a transaction work budget of small sizes and under a context failing in the middle, with the rolled-back graph):
//   node tala/hierlimits.mjs tala-hier.jsonl [every=3] [op] > tala-hierlim.jsonl
// (op assign | place | all selects the part of the stage that runs: `place` on the graphs of later stages, which already have hierarchies)
import fs from 'node:fs';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
const every = Number(process.argv[3] || 3);
const op = process.argv[4];
fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').forEach((l, i) => {
  if (i % every !== 0) return;
  const c = bigjson.parse(l);
  // Go's snapshots also charge the spare capacity of every edge's Points slice (accountSpareCapacity; JS arrays have none), which the budget
  // and poll counts of a graph with routes show: those graphs run without the budget variants
  const routed = (c.graph.edges ?? []).some((e) => e.points && e.points.length);
  c.args = routed ? { ...c.args } : { ...c.args, txLimits: [3, 20, 80, 300, 1000, 5000, 30000], polls: true };
  delete c.args.golden;
  if (op) c.op = op;
  console.log(bigjson.stringify(c));
});
