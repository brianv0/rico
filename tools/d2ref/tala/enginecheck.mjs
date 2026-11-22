// diff.mjs stages of the FULL pipeline (the JS engine, public/d2/tala/engine.js, against Go's xdump modes `scores`, `stages`, `fstages`):
//
//   node diff.mjs talafstages tala-fixtures.jsonl     the engine pipeline on a graphjson fixture (seed 123, as the engine's own golden tests): the graph after
//                                                     every one of the 37 stages, the final graph, penalty and area, the error
//   node diff.mjs talastages  tala-corpus.jsonl       a D2 program: per call of the layout function, per seed the graph after every stage, the score, the
//                                                     selected seed, the compound candidate and the final graph (heavy: 4560 graphs for 250 cases)
//   node diff.mjs talascores  tala-corpus.jsonl       the same without the per-stage graphs (penalty and area per seed, selection, compound, final graph)
//
// They need the placement and routing stage modules: while a stage function is missing the engine throws NotPorted and the case is DEFERRED
// (diff.mjs prints "N deferred (notported: placement.prescale: N)"), so this file works unchanged when those packages land. The stage graphs are
// recorded by wrapping the `run` of the default pipeline stages (the JS twin of engine.XLayoutObserved of the Go overlay): the observer sees the
// graph after each stage, inside the real driver.
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as d2lib from '../../../public/d2/d2lib.js';
import { background } from '../../../public/d2/tala/context.js';
import { isPanic } from '../../../public/d2/tala/goerrors.js';
import * as engine from '../../../public/d2/tala/engine.js';
import { NotPorted } from '../../../public/d2/tala/stagepkgs.js';
import { layoutPlan, newSeedInput } from '../../../public/d2/tala/d2talalayout.js';
import { considerSeedCandidate } from '../../../public/d2/tala/layout.js';
import { evaluateSeedResult } from '../../../public/d2/tala/result.js';
import { applySeedResult } from '../../../public/d2/tala/patch.js';
import * as quality from '../../../public/d2/tala/quality.js';
import * as talaLayout from '../../../public/d2/tala/layout.js';

const ser = (g) => graphjson.serialize(background(), g);

/** wraps every default stage so that `observe(index, name, graph)` runs after it succeeded (XLayoutObserved of the Go overlay); returns the restore function */
export function observeStages(observe) {
  const originals = engine.defaultPipelineStages.map((s) => s.run);
  engine.defaultPipelineStages.forEach((stage, index) => {
    const run = originals[index];
    stage.run = (p, ctx) => {
      run(p, ctx);
      // the driver checks the context after the stage; the Go observer runs after that check and the size check, which only matter on error paths
      observe(index, stage.name, p.graph);
    };
  });
  return () => engine.defaultPipelineStages.forEach((stage, i) => { stage.run = originals[i]; });
}

const deferred = (e) => ({ deferred: `notported: ${e.pkg}.${e.fn}` });

/** fstages: {graph, seeds: [123]} */
export function fstagesStage(c) {
  const ctx = background();
  const g = lg.newGraph();
  try {
    graphjson.unmarshal(ctx, c.graph, g);
  } catch (e) {
    if (isPanic(e)) throw e;
    return { err: e.message };
  }
  const seed = c.seeds && c.seeds.length ? BigInt(c.seeds[0]) : 123n;
  const stages = [];
  const res = { err: null, stages: null };
  let restore = null;
  try {
    // XLayoutObserved: the cloned workspace is "input" (index -1); an empty graph is returned without any stage
    const workspace = lg.clone(ctx, g);
    if (workspace.nodes.length > 0) stages.push({ index: -1, name: 'input', graph: ser(workspace) });
    restore = observeStages((index, name, graph) => stages.push({ index, name, graph: ser(graph) }));
    let out = workspace;
    if (workspace.nodes.length > 0) {
      const p = engine.newPipeline(workspace, seed, false);
      p.runAllStages(ctx);
    }
    res.stages = stages;
    const [penalty, area] = quality.evaluateWithArea(ctx, out);
    res.penalty = penalty;
    res.area = area;
    res.scoreErr = null;
    res.final = ser(out);
  } catch (e) {
    if (e instanceof NotPorted) return deferred(e);
    if (isPanic(e)) throw e;
    res.err = e.message;
    res.stages = stages;
  } finally {
    if (restore) restore();
  }
  return res;
}

/** scores / stages on a D2 program: the JS twin of the `scores` and `stages` modes (XDumpLayout records per call of the layout function) */
function d2Records(c, withStages) {
  const invocations = [];
  const talaOpts = c.seeds ? talaLayout.hydrateOpts({ 'tala-seeds': c.seeds.map(Number) }) : null;
  const layoutFn = (g) => {
    const ctx = background();
    const rec = { adapter: null };
    invocations.push(rec);
    let err = null;
    try {
      const [seeds] = layoutPlan(g, talaOpts);
      const input = newSeedInput(ctx, g);
      rec.adapter = ser(input.graph);
      rec.seeds = [];
      let bestIndex = -1;
      let best = null;
      const results = [];
      seeds.forEach((seed, i) => {
        const run = { seed, err: undefined };
        const stages = [];
        let restore = null;
        try {
          if (withStages) {
            const workspace = lg.clone(ctx, input.graph);
            if (workspace.nodes.length > 0) stages.push({ index: -1, name: 'input', graph: ser(workspace) });
          }
          restore = observeStages((index, name, graph) => { if (withStages) stages.push({ index, name, graph: ser(graph) }); });
          const laidOut = talaLayout.runSeed(ctx, input, seed);
          const res = evaluateSeedResult(ctx, input, laidOut);
          run.penalty = res.score.penalty;
          run.area = res.score.area;
          results[i] = res;
          const comparison = bestIndex >= 0 ? res.score.compare(best.score) : 0;
          if (bestIndex < 0 || comparison < 0 || (comparison === 0 && i > bestIndex)) {
            bestIndex = i;
            best = res;
          }
        } catch (e) {
          if (e instanceof NotPorted) throw e;
          run.err = isPanic(e) ? 'TALA seed layout failed due to an internal invariant' : e.message;
        } finally {
          if (restore) restore();
        }
        if (withStages) run.stages = stages;
        rec.seeds.push(run);
      });
      if (bestIndex >= 0) rec.selected = bestIndex;
      if (bestIndex < 0) throw new Error('all TALA seed attempts failed');
      const before = best.graph;
      let candidateGraph = null;
      best = considerSeedCandidate(ctx, best, () => {
        const candidate = engine.compoundCandidate(ctx, best.graph);
        if (candidate === best.graph) return best;
        candidateGraph = candidate;
        return evaluateSeedResult(ctx, input, candidate);
      });
      rec.compound = best.graph !== before ? 'kept' : candidateGraph !== null ? 'rejected' : 'unchanged';
      rec.final = ser(best.graph);
      applySeedResult(ctx, g, best);
    } catch (e) {
      if (e instanceof NotPorted) throw e;
      if (isPanic(e) && !(e instanceof Error && e.message === 'all TALA seed attempts failed')) throw e;
      err = e;
      rec.err = e.message;
    }
    if (err) throw err;
  };
  return { invocations, layoutFn };
}

const goKeys = (rec) => {
  // Go's omitempty: the seed record has no err when it passed, no penalty/area when it failed
  const seeds = (rec.seeds ?? []).map((s) => {
    const o = { seed: s.seed };
    if (s.err !== undefined) o.err = s.err;
    if (s.penalty !== undefined) { o.penalty = s.penalty; o.area = s.area; }
    if (s.stages !== undefined) o.stages = s.stages;
    return o;
  });
  const out = { adapter: rec.adapter };
  if (rec.err !== undefined) out.err = rec.err;
  if (seeds.length) out.seeds = seeds;
  if (rec.selected !== undefined) out.selected = rec.selected;
  if (rec.compound !== undefined) out.compound = rec.compound;
  if (rec.final !== undefined) out.final = rec.final;
  return out;
};

async function d2Stage(c, withStages) {
  const { invocations, layoutFn } = d2Records(c, withStages);
  const r = d2lib.compileSync(c.text, {
    utf16: !!c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'tala',
    layoutResolver: () => layoutFn,
    routerResolver: () => talaLayout.routeEdgesDefault,
  }, c.themeID != null ? { themeID: c.themeID } : {});
  if (r.err instanceof NotPorted) return deferred(r.err);
  return { invocations: invocations.length ? invocations.map(goKeys) : null, err: r.err ? r.err.message : null };
}

export const stagesStage = (c) => d2Stage(c, true);
export const scoresStage = (c) => d2Stage(c, false);
