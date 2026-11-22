// Builds the case files of the hierarchy and placementcost checks from the pipeline stages of Go's TALA (xdump `hiergen`), with the deep
// state (margins, paddings, herd assignments, loop offsets, common uncle siblings) that graphjson does not carry:
//
//   node tala/hiergen.mjs hier [cases.jsonl=tala-corpus.jsonl]   -> tala-hier.jsonl: per case, invocation and seed (default 1,2,3) the graph
//        after stage 3 (the input of PreprocessHierarchies) with its deep state and, as "golden", the graph after stage 4
//   node tala/hiergen.mjs compound [cases.jsonl] [out]            -> tala-compound.jsonl: stages 20 and 36 of the graphs with 3 to 64 top-level containers
//   node tala/hiergen.mjs pc [cases.jsonl] [out file name]                       -> tala-pc.jsonl: graphs of the placement stages with their deep state
//        (stages 6 7 8 9 10 11 13 15 16 20 23 of seed 1 and stage 7 of seeds 2 and 3), input of the placementcost checks
//
// The cases file holds D2 cases ({path, text}) or graphjson fixtures ({graph, seeds}: tala-fixtures.jsonl, the stages are those of Go's engine on it).
// Cases are {name, graph, seeds: [seed], args: {deep, golden?}}, printed with bigjson (IDs beyond 2^53).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const kind = process.argv[2] || 'hier';
const file = process.argv[3] || path.join(here, '..', 'tala-corpus.jsonl');
const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
const out = path.join(here, '..', process.argv[4] || { hier: 'tala-hier.jsonl', pc: 'tala-pc.jsonl', compound: 'tala-compound.jsonl' }[kind]);
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => bigjson.parse(l));

const plans = kind === 'hier'
  ? [{ stages: [3, 4], seeds: [1, 2, 3] }]
  : kind === 'compound' ? [{ stages: [20, 36], seeds: [1, 2, 3] }]
  : [{ stages: [6, 7, 8, 9, 10, 11, 13, 15, 16, 20, 23], seeds: [1] }, { stages: [7], seeds: [2, 3] }];

const fd = fs.openSync(out, 'w');
let n = 0, ncase = 0;
for (const [ci, c] of cases.entries()) {
  if (c.fs && !c.graph) continue;
  for (const plan of plans) {
    let r;
    try {
      r = bigjson.parse(execFileSync(bin, ['hiergen'], { input: bigjson.stringify({ ...c, ...(c.graph ? { seeds: [1, 2, 123] } : {}), args: { ...plan, seeds: c.graph ? [] : plan.seeds, deep: true } }) + '\n', maxBuffer: 1 << 30, timeout: 120000 }).toString());
    } catch (e) { continue; }
    if (!r.records) continue;
    const by = new Map();
    for (const rec of r.records) {
      if (!rec.graph || rec.graph.serializeError) continue;
      by.set(`${rec.inv}/${rec.seed}/${rec.index}`, rec);
    }
    for (const rec of r.records) {
      if (!rec.graph || rec.graph.serializeError) continue;
      if (kind === 'hier') {
        if (rec.index !== 3) continue;
        const gold = by.get(`${rec.inv}/${rec.seed}/4`);
        const args = { deep: rec.deep ?? null };
        if (gold) args.golden = gold.graph;
        fs.writeSync(fd, bigjson.stringify({ name: `hier/${c.name ?? ci}/${rec.inv}/s${rec.seed}`, graph: rec.graph, seeds: [rec.seed], args }) + '\n');
      } else if (kind === 'compound') {
        const k = rec.graph.containers?.['0']?.length ?? 0; // the compound candidate needs 3 to 64 top-level containers
        if (k < 3 || k > 64) continue;
        fs.writeSync(fd, bigjson.stringify({ name: `compound/${c.name ?? ci}/${rec.inv}/s${rec.seed}/${rec.index}`, graph: rec.graph, seeds: [rec.seed], args: { deep: rec.deep ?? null } }) + '\n');
      } else {
        fs.writeSync(fd, bigjson.stringify({ name: `pc/${c.name ?? ci}/${rec.inv}/s${rec.seed}/${rec.index}`, graph: rec.graph, seeds: [rec.seed], args: { deep: rec.deep ?? null } }) + '\n');
      }
      n++;
    }
  }
  ncase++;
}
fs.closeSync(fd);
console.log(path.basename(out), n, 'graphs from', ncase, 'cases');
