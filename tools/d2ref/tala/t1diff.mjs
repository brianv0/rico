// Runner of the T1 stage check (see t1check.mjs): node tala/t1diff.mjs stages <cases.jsonl> [--seeds 1,2,3] [--batch 20] [--only N] [--show 5] [--stages 1,3,5,6,19]
// Cases: D2 programs ({path, text, ...}: tala-corpus.jsonl, fuzz files) or graph fixtures ({name, graph}: tala-fixtures.jsonl, stage graphs).
// Go runs in batches (a pipeline dump is big); every target stage is recomputed in JS from Go's graph of the previous stage.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as t1 from './t1check.mjs';

const [mode, file, ...flags] = process.argv.slice(2);
const flag = (name, def) => { const i = flags.indexOf(name); return i < 0 ? def : flags[i + 1] ?? true; };
if (mode !== 'stages' || !file) {
  console.error('usage: node tala/t1diff.mjs stages <cases.jsonl> [--seeds 1,2,3] [--batch 20] [--only N] [--show 5] [--stages 1,3,5,6,19]');
  process.exit(2);
}
await t1.loadModules();
const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
const seeds = String(flag('--seeds', '')).split(',').filter(Boolean).map(Number);
const targets = String(flag('--stages', '1,3,5,6,19')).split(',').map(Number);
const batchSize = Number(flag('--batch', 20));
let cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];
const allStages = [...new Set([-1, ...targets, ...targets.map((k) => t1.STAGE_PRED[k])])];

const nontrivial = {};
let same = 0, differ = 0, recon = 0, goPanics = 0, noRuns = 0, stageCount = 0;
const bad = [];
const t0 = performance.now();
for (let b = 0; b < cases.length; b += batchSize) {
  const batch = cases.slice(b, b + batchSize);
  const input = batch.map((c) => bigjson.stringify({ ...c, seeds: seeds.length ? seeds : c.seeds, args: { stages: allStages } })).join('\n');
  let lines;
  try {
    lines = execFileSync(bin, ['t1stages'], { input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim().split('\n');
  } catch (e) {
    console.error(`Go crashed on batch ${b}`);
    continue;
  }
  for (const [i, line] of lines.entries()) {
    const c = batch[i];
    const name = c.name ?? `#${b + i}`;
    const want = bigjson.parse(line);
    if (want.panic) { goPanics++; continue; }
    if (!want.runs || want.runs.length === 0) { noRuns++; continue; }
    let res;
    try {
      res = t1.stagesCheck(want, targets);
    } catch (e) {
      differ++;
      bad.push({ name, path: 'threw', got: String(e.stack || e).slice(0, 600), want: '' });
      continue;
    }
    for (const r of res.bad) { recon++; bad.push({ name, ...r }); }
    stageCount += res.exp.length;
    for (const x of res.exp) {
      if (!x.deep) continue;
      const k = Number(/stage(\d+)$/.exec(x.tag)[1]);
      const n = { 1: x.deep.sequences.length, 3: x.deep.trees.length, 5: x.deep.clusters.length, 6: x.deep.hubs.length, 19: x.deep.nodes.filter((q) => q.herd === null && q.isVessel).length + 1 }[k];
      if (n > 0 && k !== 19) nontrivial[k] = (nontrivial[k] ?? 0) + 1;
    }
    const d = t1.firstDiff(res.got, res.exp);
    if (d) { differ++; bad.push({ name: `${name} (${b + i})`, ...d }); } else same++;
  }
}
console.log(`t1 stages ${file}: ${same}/${same + differ} cases identical to Go (${stageCount} stage comparisons; targets ${targets.join(',')})` +
  (Object.keys(nontrivial).length ? ` [with groups: ${Object.entries(nontrivial).map(([k, v]) => `stage ${k}: ${v}`).join(', ')}]` : '') +
  (recon ? `, ${recon} reconstruction mismatches` : '') + (goPanics ? `, ${goPanics} skipped (Go panicked)` : '') + (noRuns ? `, ${noRuns} without runs` : '') + `, ${((performance.now() - t0) / 1000) | 0}s`);
for (const x of bad.slice(0, Number(flag('--show', 5)))) console.log(`\n${x.name}${x.tag ? " " + x.tag : ""}\n  at ${x.path}\n  got  ${x.got}\n  want ${x.want}`);
process.exitCode = differ || recon ? 1 : 0;
