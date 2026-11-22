// Isolated stage check of the placement package: node tala/placecheck.mjs <cases.jsonl> [--seeds 1,2,3] [--stages 0,2,7,...] [--max N] [--batch 5] [--show 5] [--only i]
// Go's t1stages mode dumps graph + deep state after the stages; each JS placement stage runs on Go's graph of the stage before
// (through the engine's own stage method) and is compared with Go's graph after it (graph and deep state).
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import { background } from '../../../public/d2/tala/context.js';
import * as engine from '../../../public/d2/tala/engine.js';
import * as t1 from './t1check.mjs';
import { runGo, loadCases } from './rootlib.mjs';

const [file, ...flags] = process.argv.slice(2);
const flag = (n, d) => { const i = flags.indexOf(n); return i < 0 ? d : flags[i + 1] ?? true; };
// [stage, predecessor, pipeline method]
const ALL = [[0, -1, 'prescaleStage'], [2, 1, 'preprocessStage'], [7, 6, 'nodePlacementStage'], [8, 7, 'swapNodesStage'], [9, 8, 'transposeStage'],
  [10, 9, 'alignAxes'], [11, 10, 'gapNormalizationStage'], [12, 11, 'alignAxes'], [13, 12, 'optimizeClustersStage'], [14, 13, 'alignAxes'],
  [15, 14, 'balanceSymmetryStage'], [16, 15, 'equidistanceStage'], [17, 16, 'alignAxes'], [23, 22, 'dejitterStage']];
const want = String(flag('--stages', '')).split(',').filter(Boolean).map(Number);
const WIRED = want.length ? ALL.filter(([k]) => want.includes(k)) : ALL;
const seeds = String(flag('--seeds', '')).split(',').filter(Boolean).map(Number);
let cases = loadCases(file);
if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];
const max = Number(flag('--max', 100000));
if (cases.length > max) cases = cases.slice(0, max);
const stages = [-1, ...new Set(WIRED.flatMap(([k, pred]) => [k, pred]))];
let cacheNoise = 0, runs = 0, compared = 0, same = 0, unrecon = 0, skipped = 0, t0 = performance.now();
const bad = [];
const perStage = {};
const ctx = background();
const batch = Number(flag('--batch', 5));
for (let off = 0; off < cases.length; off += 50) {
  const sub = cases.slice(off, off + 50);
  const goOut = runGo('t1stages', sub.map((c) => ({ ...c, seeds: seeds.length ? seeds : c.seeds, args: { stages } })), batch);
  for (const [i, w] of goOut.entries()) {
    if (w.panic || !w.runs) { skipped++; continue; }
    const name = sub[i].name ?? String(off + i);
    for (const run of w.runs) {
      if (!run.stages) continue;
      runs++;
      const byIndex = new Map(run.stages.map((s) => [s.index, s]));
      if (flag('--chain')) {
        // chained: the stages 7..17 run one after the other on ONE JS graph (so the edge-length cache is warm as in Go)
        const start = byIndex.get(6);
        if (!start) continue;
        let g;
        try { g = t1.reconstruct(start); } catch (e) { if (e.name !== 'GoError') throw e; unrecon++; continue; }
        const p = new engine.Pipeline(g, BigInt(run.seed), false);
        p.graph = g;
        for (const [k, , method] of ALL.filter(([k]) => k >= 7 && k <= 17)) {
          const goK = byIndex.get(k);
          let jsErr = null;
          try { p[method](ctx); } catch (e) { jsErr = e.name === 'GoError' ? e.message : `JS ${e.stack}`.slice(0, 400); }
          compared++;
          perStage[k] = perStage[k] || [0, 0];
          perStage[k][1]++;
          const gotRec = jsErr === null ? { index: k, graph: graphjson.serialize(ctx, g), deep: t1.deepState(g) } : { err: jsErr };
          const wantRec = goK ? { index: goK.index, graph: goK.graph, deep: goK.deep } : { err: run.err ?? null };
          const d = t1.firstDiff(bigjson.plain(gotRec), bigjson.plain(wantRec));
          if (d) { bad.push({ name, tag: `seed${run.seed}/chain/stage${k}`, ...d }); break; }
          same++;
          perStage[k][0]++;
          if (!goK) break;
        }
        continue;
      }
      for (const [k, predIndex, method] of WIRED) {
        const pred = byIndex.get(predIndex), goK = byIndex.get(k);
        if (!pred) continue;
        let g;
        try { g = t1.reconstruct(pred); } catch (e) { if (e.name !== 'GoError') throw e; unrecon++; continue; }
        const p = new engine.Pipeline(g, BigInt(run.seed), false);
        p.graph = g;
        let jsErr = null;
        try { p[method](ctx); } catch (e) {
          if (e.name === 'GoError') jsErr = e.message;
          else { jsErr = `JS ${e.stack}`.slice(0, 400); }
        }
        compared++;
        perStage[k] = perStage[k] || [0, 0];
        perStage[k][1]++;
        const gotRec = jsErr === null ? { index: k, graph: graphjson.serialize(ctx, g), deep: t1.deepState(g) } : { err: jsErr };
        const wantRec = goK ? { index: goK.index, graph: goK.graph, deep: goK.deep } : { err: run.err ?? null };
        // Go's edge-length cache (not in the dump) survives from earlier stages, so Go may never need the turn cost that a cold JS
        // cache computes lazily: the cached graph.turnCost is then 0 in Go; it does not affect any other value.
        if (jsErr === null && goK && goK.graph.turnCost === 0 && gotRec.graph.turnCost !== 0 && !flag('--strict-cache')) { gotRec.graph.turnCost = 0; cacheNoise++; }
        const d = t1.firstDiff(bigjson.plain(gotRec), bigjson.plain(wantRec));
        if (d) { bad.push({ name, tag: `seed${run.seed}/stage${k}`, ...d }); continue; }
        same++;
        perStage[k][0]++;
      }
    }
  }
}
console.log(`placecheck ${file}: ${same}/${compared} stage runs identical (${runs} Go runs, ${unrecon} not rebuildable, ${skipped} skipped); ${Object.entries(perStage).map(([k, [a, b]]) => `${k}: ${a}/${b}`).join(', ')}${cacheNoise ? `; ${cacheNoise} runs differ only in the lazily cached turnCost (Go's warm edge-length cache)` : ''}; ${((performance.now() - t0) / 1000) | 0}s`);
for (const b of bad.slice(0, Number(flag('--show', 5)))) console.log(`\n${b.name} ${b.tag}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
process.exitCode = bad.length ? 1 : 0;
