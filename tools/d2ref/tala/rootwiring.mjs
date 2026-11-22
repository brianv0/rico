// The `wiring` mode of tala/rootcheck.mjs: the stage methods of engine.js that call ported packages (stages 1, 3, 4, 5, 6, 19; 18, 32 and 33 are
// one-line calls of packing.pack and labeling.place, checked by their own packages with the same arguments) run on Go's graph (with its deep
// state) of the stage before, in ONE pipeline object per Go run, so the random streams (p.random: sequences, then clusters; the hierarchy's
// own generator) are consumed as in Go. Go's t1stages mode dumps graph + deep state after each stage; the result of each JS stage is
// compared with Go's.
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import { background } from '../../../public/d2/tala/context.js';
import * as engine from '../../../public/d2/tala/engine.js';
import * as t1 from './t1check.mjs';
import { runGo, loadCases } from './rootlib.mjs';

const flagOf = (flags) => (n, d) => { const i = flags.indexOf(n); return i < 0 ? d : flags[i + 1] ?? true; };

const WIRED = [[1, 0, 'preprocessSequenceStage'], [3, 2, 'preprocessTreesStage'], [4, 3, 'preprocessHierarchies'], [5, 4, 'preprocessClusters'], [6, 5, 'preprocessHubs'], [19, 18, 'cleanupGroupsStage']];

export async function wiring(file, flags) {
  const flag = flagOf(flags);
  const seeds = String(flag('--seeds', '')).split(',').filter(Boolean).map(Number);
  let cases = loadCases(file);
  const max = Number(flag('--max', 100000));
  if (cases.length > max) cases = cases.slice(0, max);
  const stages = [-1, ...new Set(WIRED.flatMap(([k, pred]) => [k, pred]))];
  const goOut = runGo('t1stages', cases.map((c) => ({ ...c, seeds: seeds.length ? seeds : c.seeds, args: { stages } })), Number(flag('--batch', 10)));
  let runs = 0, compared = 0, same = 0, unrecon = 0, skipped = 0;
  const bad = [];
  const perStage = {};
  const ctx = background();
  for (const [i, want] of goOut.entries()) {
    if (want.panic || !want.runs) { skipped++; continue; }
    const name = cases[i].name ?? String(i);
    for (const run of want.runs) {
      if (!run.stages) continue;
      runs++;
      const byIndex = new Map(run.stages.map((s) => [s.index, s]));
      let p = null;
      for (const [k, predIndex, method] of WIRED) {
        const pred = byIndex.get(predIndex), goK = byIndex.get(k);
        if (!pred) continue;
        let g;
        try {
          g = t1.reconstruct(pred);
        } catch (e) {
          if (e.name !== 'GoError') throw e;
          unrecon++;
          break; // the later stages depend on the random streams of this run: stop
        }
        if (p === null) p = new engine.Pipeline(g, BigInt(run.seed), false);
        p.graph = g;
        let jsErr = null;
        try {
          p[method](ctx);
        } catch (e) {
          if (e.name !== 'GoError') throw e;
          jsErr = e.message;
        }
        compared++;
        const gotRec = jsErr === null ? { index: k, graph: graphjson.serialize(ctx, g), deep: t1.deepState(g) } : { err: jsErr };
        const wantRec = goK ? { index: goK.index, graph: goK.graph, deep: goK.deep } : { err: run.err ?? null };
        const d = t1.firstDiff(bigjson.plain(gotRec), bigjson.plain(wantRec));
        perStage[k] = perStage[k] || [0, 0];
        perStage[k][1]++;
        if (d) { bad.push({ name, tag: `seed${run.seed}/stage${k}`, ...d }); break; }
        same++;
        perStage[k][0]++;
        if (jsErr !== null || !goK) break;
      }
    }
  }
  console.log(`wiring ${file}: ${same}/${compared} stage runs identical to Go (${runs} Go runs, ${unrecon} not rebuildable, ${skipped} cases skipped); per stage ${Object.entries(perStage).map(([k, [a, b]]) => `${k}: ${a}/${b}`).join(', ')}`);
  for (const b of bad.slice(0, Number(flag('--show', 5)))) console.log(`\n${b.name} ${b.tag}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
  process.exitCode = bad.length ? 1 : 0;
}
