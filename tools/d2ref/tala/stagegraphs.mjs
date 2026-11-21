// Builds graphjson fixtures from the pipeline stages of Go's TALA (mid-layout graphs have clusters, trees, sequences, hubs, hierarchies, abductions,
// routes): node tala/stagegraphs.mjs [cases.jsonl=tala-corpus.jsonl] [max cases=250] > tala-stagegraphs.jsonl
// Uses xdump `stages` (seed 1 only, a few stages per case). The result feeds talagraphjson and talaops.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, '..', 'tala-corpus.jsonl');
const max = Number(process.argv[3] || 250);
const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
const STAGES = new Set([0, 3, 4, 5, 6, 7, 8, 10, 15, 18, 20, 21, 22, 27, 33, 36]);
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
let used = 0;
for (const [ci, c] of cases.entries()) {
  if (used >= max) break;
  if (c.text.length > 600 || c.fs) continue;
  let r;
  try {
    r = bigjson.parse(execFileSync(bin, ['stages'], { input: bigjson.stringify({ ...c, seeds: [1] }) + '\n', maxBuffer: 1 << 29, timeout: 20000 }).toString());
  } catch (e) { continue; }
  if (!r.invocations) continue;
  used++;
  r.invocations.forEach((inv, ii) => {
    for (const s of inv.seeds ?? []) {
      for (const st of s.stages ?? []) {
        if (STAGES.has(st.index) && st.graph && !st.graph.serializeError) {
          console.log(bigjson.stringify({ name: `stage/${ci}/${ii}/${st.index}-${st.name}`, graph: st.graph }));
        }
      }
    }
  });
}
