// Builds the cases of the t1ops stage (direct calls of the T1 packages): graphs from the pipeline stages of Go (clusters, sequences, trees, hubs,
// positioned graphs) and the testdata fixtures, one case per graph and op.
//   node tala/t1opscases.mjs <cases.jsonl> [--max 300] [--stages -1,2,5,7,8,10,18,20] [--ops loops,resetClusters,...] [--fixtures] > t1ops.jsonl
//   node diff.mjs talat1ops t1ops.jsonl
// cases.jsonl: D2 programs (tala-corpus.jsonl, t1fuzz.jsonl); with --fixtures the lines are graph fixtures (tala-fixtures.jsonl) used as they are.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

const [file, ...flags] = process.argv.slice(2);
const flag = (name, def) => { const i = flags.indexOf(name); return i < 0 ? def : flags[i + 1] ?? true; };
const max = Number(flag('--max', 300));
const stages = String(flag('--stages', '-1,2,5,7,8,10,18,20')).split(',').map(Number);
const ops = String(flag('--ops', 'loops,resetClusters,seqEdges,cluster,join,commonUncle,hubs,nearsHerds,trees')).split(',');
const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
const emit = (name, graph) => { for (const op of ops) console.log(bigjson.stringify({ name: `${name}/${op}`, graph, args: { op } })); };

if (flags.includes('--fixtures')) {
  for (const c of cases.slice(0, max)) emit(c.name, c.graph);
} else {
  let used = 0;
  for (const [ci, c] of cases.entries()) {
    if (used >= max) break;
    if (c.text.length > 700 || c.fs) continue;
    let r;
    try {
      r = bigjson.parse(execFileSync(bin, ['t1stages'], { input: bigjson.stringify({ ...c, seeds: [1], args: { stages } }) + '\n', maxBuffer: 1 << 29, timeout: 60000 }).toString());
    } catch (e) { continue; }
    if (!r.runs) continue;
    used++;
    for (const run of r.runs) {
      for (const s of run.stages ?? []) {
        if (s.graph && !s.graph.serializeError) emit(`${c.name ?? 'case' + ci}/${run.inv ?? 0}/${s.index}`, s.graph);
      }
    }
  }
}
