// Unit tests of the TALA engine and root package (public/d2/tala/{engine,layout,result,patch,stagepkgs}.js): ports of cheap Go tests (the stage plan,
// stage timing, the optional snapshot observer, seed selection, optional candidates) and the pieces that need no Go. The comparisons against Go
// itself are tools/d2ref/tala/rootcheck.mjs (replay, validate, driver, compound, wiring) and `node diff.mjs talafstages|talastages|talascores`
// once placement and routing are merged; a recorded set of Go traces replays here too (test/fixtures/tala-root-replay.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import markdownit from 'markdown-it';
import * as d2lib from '../public/d2/d2lib.js';
import * as context from '../public/d2/tala/context.js';
import { errorf, errorsNew } from '../public/d2/tala/goerrors.js';
import * as geo from '../public/d2/geo.js';
import * as lg from '../public/d2/tala/layoutgraph.js';
import * as engine from '../public/d2/tala/engine.js';
import * as talaLayout from '../public/d2/tala/layout.js';
import * as result from '../public/d2/tala/result.js';
import { NotPorted, registerPackage, hasStageFn } from '../public/d2/tala/stagepkgs.js';
import { layoutPlan } from '../public/d2/tala/d2talalayout.js';
import * as bigjson from '../public/d2/tala/bigjson.js';

await d2lib.init({ markdownit });

const ctx = () => context.background();

const WANT_NAMES = [
  'Prescale', 'PreprocessSequences', 'Preprocess', 'PreprocessTrees', 'PreprocessHierarchies', 'PreprocessClusters', 'PreprocessHubs',
  'NodePlacement', 'SwapStuff', 'Transpose', 'AlignAxes', 'GapNormalization', 'AlignAxes', 'OptimizeClusters', 'AlignAxes', 'BalanceSymmetry',
  'Equidistance', 'AlignAxes', 'BinPack', 'CleanupStuff', 'Rescale', 'EdgeRouting', 'Crosshatch', 'Dejitter', 'EdgeRouting', 'SimplifyEdgeRoutes',
  'SwapEdgePorts', 'StraightEdgesFallback', 'BalanceEdgeSegments', 'FixClusterEdgeBranching', 'TraceEdgesToShapeBorder', 'ReorderDuplicates',
  'BinPack', 'PlaceLabels', 'NudgeEdgeChannels', 'ShortcutEdgeRoutes', 'Normalize',
];

const oneNodeGraph = () => {
  const graph = lg.newGraph();
  const node = lg.newNode(1n, 1, 1);
  node.topLeft = geo.newPoint(0, 0);
  graph.addNode(node);
  return graph;
};

/** a pipeline whose stage plan is `stages` (Go's `&pipeline{graph, stages}`) */
const testPipeline = (stages) => {
  const p = new engine.Pipeline(oneNodeGraph(), 1n, false);
  p.stages = stages;
  return p;
};

test('engine: the default stage plan is the 37 stages of pipeline.go in order and is shared; overrides are private', () => {
  const first = engine.newPipeline(lg.newGraph(), 1n, false);
  const second = engine.newPipeline(lg.newGraph(), 1n, false);
  assert.equal(first.stagePlan(), second.stagePlan());
  assert.equal(first.stageDurations, null);
  assert.deepEqual(first.stagePlan().map((s) => s.name), WANT_NAMES);
  assert.equal(WANT_NAMES.length, 37);
  // the plan repeats stages: the index is what identifies one (docs/d2-tala-port.md)
  assert.deepEqual([...WANT_NAMES.entries()].filter(([, n]) => n === 'EdgeRouting').map(([i]) => i), [21, 24]);
  assert.deepEqual([...WANT_NAMES.entries()].filter(([, n]) => n === 'BinPack').map(([i]) => i), [18, 32]);
  assert.deepEqual([...WANT_NAMES.entries()].filter(([, n]) => n === 'AlignAxes').map(([i]) => i), [10, 12, 14, 17]);
  assert.ok(Object.isFrozen(engine.defaultPipelineStages));
  first.stages = engine.defaultPipelineStages.map((s) => ({ ...s }));
  first.stages[0].name = 'test override';
  assert.equal(second.stagePlan()[0].name, 'Prescale');
  const emptyOverride = new engine.Pipeline(lg.newGraph(), 1n, false);
  emptyOverride.stages = [];
  assert.equal(emptyOverride.stagePlan().length, 0);
  emptyOverride.runAllStages(ctx()); // a non-nil empty override runs no default stage
});

test('engine: stage timing is opt-in and not recorded for a stage that ended in cancellation', () => {
  const stage = { name: 'timed', run: () => { const t = performance.now(); while (performance.now() - t < 1.5); } };
  const untimed = testPipeline([stage]);
  untimed.runAllStages(ctx());
  assert.equal(untimed.stageDurations, null);

  const timed = testPipeline([stage]);
  timed.enableStageTiming();
  timed.runAllStages(ctx());
  assert.equal(timed.stageDurations.length, 1);
  assert.ok(timed.stageDurations[0] > 0);

  const [cctx, cancel] = context.withCancel(ctx());
  const canceled = testPipeline([{ name: 'cancel', run: () => cancel() }]);
  canceled.enableStageTiming();
  assert.throws(() => canceled.runAllStages(cctx), (e) => e.message === 'cancel: context canceled' && e.cause === context.Canceled);
  assert.equal(canceled.stageDurations[0], 0);
});

test('engine: the driver wraps context errors with the stage name, checks the size after every stage and resets routes before stage 0', () => {
  const [cctx, cancel] = context.withCancel(ctx());
  cancel();
  // a context that is canceled before the pipeline starts stops at the transaction work guard that runAllStages creates first
  assert.throws(() => testPipeline([{ name: 'first', run: () => {} }]).runAllStages(cctx), /AutolayoutTransactions: context canceled/);
  const [c2, cancel2] = context.withCancel(ctx());
  assert.throws(() => testPipeline([{ name: 'first', run: () => cancel2() }]).runAllStages(c2), (e) => e.message === 'first: context canceled' && e.cause === context.Canceled);
  const grow = testPipeline([{ name: 'grow', run: (p) => { p.graph.nodes[0].width = 30001; } }]);
  assert.throws(() => grow.runAllStages(ctx()), /layout invariant violated: Dimensions w:30001, h:1 reached after stage grow/);
  // stage 0: ResetClusters and the route state reset (explicitly locked label positions stay)
  const g = oneNodeGraph();
  const other = lg.newNode(2n, 1, 1);
  other.topLeft = geo.newPoint(50, 0);
  g.addNode(other);
  const edge = g.connect(g.nodes[0], other);
  edge.points = [geo.newPoint(1, 1), geo.newPoint(2, 2)];
  edge.labelPercentage = 0.5;
  edge.label = new lg.Label('x', 11, 3, 4); // 11: an unlocked label position of D2's label package
  const p = new engine.Pipeline(g, 1n, false);
  let seen = null;
  p.stages = [{ name: 'look', run: (q) => { seen = { points: q.graph.edges[0].points.length, pct: q.graph.edges[0].labelPercentage }; } }];
  p.runAllStages(ctx());
  assert.deepEqual(seen, { points: 0, pct: 0 });
});

test('engine: the route snapshot observer is opt-in', () => {
  const pipeline = engine.newPipeline(lg.newGraph(), 1n, false);
  assert.equal(pipeline.routeObserver(ctx()), pipeline);
  pipeline.storeSnapshots = true;
  assert.equal(pipeline.routeObserver(ctx()).constructor.name, 'RoutingSnapshotObserver');
});

test('engine: a stage function that is not ported throws NotPorted with the package, the function and the stage', () => {
  const g = oneNodeGraph();
  const missing = ['prescale', 'prepare', 'place', 'swap'].filter((f) => !hasStageFn('placement', f));
  if (missing.length === 0) return; // placement is merged: the pipeline is complete
  assert.throws(() => engine.layout(ctx(), g, { seed: 1n }), (e) => {
    assert.ok(e instanceof NotPorted);
    assert.equal(e.pkg, 'placement');
    assert.equal(e.fn, 'prescale');
    assert.deepEqual(e.stage, { index: 0, name: 'Prescale' });
    assert.equal(e.message, 'TALA placement.prescale is not ported (pipeline stage 0 Prescale)');
    return true;
  });
});

test('d2lib: layout tala loads on demand, reports NotPorted by name, and takes seeds from talaOpts and from the diagram data', async () => {
  const r = await d2lib.compile('a -> b', { layout: 'tala' });
  if (hasStageFn('placement', 'prescale')) {
    assert.equal(r.err, null);
    return;
  }
  assert.equal(r.err.message, 'TALA placement.prescale is not ported (pipeline stage 0 Prescale)');
  const viaConfig = await d2lib.compile('vars: {d2-config: {layout-engine: tala}}\na -> b');
  assert.equal(viaConfig.err.message, r.err.message);
  // the options are checked before any layout runs: Go's HydrateOpts and layoutPlan messages
  const bad = await d2lib.compile('a -> b', { layout: 'tala', talaOpts: { 'tala-seeds': 'x' } });
  assert.equal(bad.err.message, 'non-TALA layout options given for TALA');
  const noSeeds = await d2lib.compile('a -> b', { layout: 'tala', talaOpts: { 'tala-seeds': [] } });
  assert.equal(noSeeds.err.message, 'tala requires at least one seed');
  const dataSeed = await d2lib.compile('vars: {d2-config: {data: {tala-seeds: [x]}}}\na -> b', { layout: 'tala' });
  assert.equal(dataSeed.err.message, 'invalid tala seed at index 0 (x): must be a signed 64-bit integer');
  const tooMany = await d2lib.compile('a -> b', { layout: 'tala', talaOpts: { 'tala-seeds': Array.from({ length: 17 }, (_, i) => i) } });
  assert.equal(tooMany.err.message, 'tala supports at most 16 unique seeds');
});

test('layoutPlan: data seeds beat the options, seeds are deduplicated in first-seen order, concurrency is bounded', () => {
  const g = { data: { 'tala-seeds': [5, 5, '7', 5, 1] } };
  assert.deepEqual(layoutPlan(g, { seeds: [9n], maxConcurrency: 2 })[0], [5n, 7n, 1n]);
  assert.deepEqual(layoutPlan({ data: null }, null), [[1n, 2n, 3n], 3]);
  assert.deepEqual(layoutPlan({ data: null }, { seeds: [4n] , maxConcurrency: 0 }), [[4n], 1]);
  assert.throws(() => layoutPlan({ data: null }, { seeds: [1n], maxConcurrency: 17 }), /MaxConcurrency must be between 1 and 16/);
  assert.throws(() => layoutPlan({ data: null }, { seeds: [1n], maxConcurrency: -1 }), /MaxConcurrency must be between 1 and 16/);
  assert.throws(() => layoutPlan({ data: { 'tala-seeds': 3 } }, null), /tala-seeds must be a list of signed 64-bit integers/);
});

test('hydrateOpts: the plugin options', () => {
  assert.equal(talaLayout.hydrateOpts(null), null);
  assert.deepEqual(talaLayout.hydrateOpts({ 'tala-seeds': [3, 4] }), { seeds: [3n, 4n], maxConcurrency: 0 });
  assert.deepEqual(talaLayout.hydrateOpts({}), { seeds: null, maxConcurrency: 0 });
  assert.throws(() => talaLayout.hydrateOpts({ 'tala-seeds': [1.5] }), /non-TALA layout options given for TALA/);
  assert.throws(() => talaLayout.hydrateOpts([1]), /non-TALA layout options given for TALA/);
});

// ---- seed selection: seed_selection_test.go -----------------------------------------------------------------------------------------------

const score = (penalty, area) => new result.LayoutScore(penalty, area);
test('seed selection: near penalties are compared exactly, area breaks exact penalty ties, the later seed breaks exact score ties', () => {
  const cases = [
    ['near penalties', [score(1 - 1 / 115, 300), score(1 - 1 / 116, 200), score(1 - 1 / 117, 100)], 0],
    ['adjacent floating point penalties', [score(1 + Number.EPSILON * 2, 1), score(1, 300), score(2, 1)], 1],
    ['area breaks exact penalty ties', [score(1, 300), score(1, 100), score(1, 200)], 1],
    ['later seed breaks exact score ties', [score(1, 100), score(1, 100), score(1, 100)], 2],
  ];
  for (const [name, scores, want] of cases) {
    const graphs = scores.map(() => lg.newGraph());
    const best = talaLayout.coordinateLocalSeeds(ctx(), [1n, 2n, 3n], 3, (index, seed) => ({ index, seed, result: { graph: graphs[index], score: scores[index] }, err: null }));
    assert.equal(best.graph, graphs[want], name);
  }
});

test('seed selection: non-finite penalties lose, invalid areas lose, errors are joined in seed order, cancellation wins', () => {
  assert.equal(new result.LayoutScore(NaN, 1).compare(new result.LayoutScore(5, 1)), 1);
  assert.equal(new result.LayoutScore(Infinity, 1).compare(new result.LayoutScore(Infinity, 7)), -1); // both penalties non-finite: equal, the area decides
  assert.equal(new result.LayoutScore(1, -1).compare(new result.LayoutScore(1, 5)), 1);
  assert.equal(new result.LayoutScore(1, NaN).compare(new result.LayoutScore(1, NaN)), 0);
  const failing = (index, seed) => ({ index, seed, result: null, err: errorf(`failed ${seed}`) });
  assert.throws(() => talaLayout.coordinateLocalSeeds(ctx(), [1n, 2n], 2, failing), (e) => e.message === 'all TALA seed attempts failed: seed 1: failed 1\nseed 2: failed 2');
  const [c, cancel] = context.withCancel(ctx());
  assert.throws(() => talaLayout.coordinateLocalSeeds(c, [1n], 1, (i, s) => { cancel(); return failing(i, s); }), /^.*tala layout stopped before all seeds completed: context canceled/);
  assert.throws(() => talaLayout.coordinateLocalSeeds(ctx(), [], 1, failing), /tala requires at least one seed/);
  assert.throws(() => talaLayout.coordinateLocalSeeds(ctx(), [1n], 0, failing), /tala seed concurrency must be positive/);
});

// ---- candidate_test.go -------------------------------------------------------------------------------------------------------------------

test('optional seed candidate preserves a valid incumbent (error, panic, worse, tie) and takes a better one', () => {
  const incumbent = { graph: lg.newGraph(), score: score(10, 0) };
  for (const kind of ['error', 'panic', 'worse', 'tie', 'better']) {
    const other = { graph: lg.newGraph(), score: score(11, 0) };
    const selected = talaLayout.considerSeedCandidate(ctx(), incumbent, () => {
      switch (kind) {
        case 'error': throw errorsNew('optional search cannot route this geometry');
        case 'panic': throw new TypeError('optional invariant');
        case 'tie': other.score = incumbent.score; break;
        case 'better': other.score = score(9, 0); break;
        default:
      }
      return other;
    });
    assert.equal(selected.graph, kind === 'better' ? other.graph : incumbent.graph, kind);
  }
});

test('optional seed candidate: cancellation propagates, also behind a panic; a NotPorted stage is not swallowed', () => {
  const [c, cancel] = context.withCancel(ctx());
  assert.throws(() => talaLayout.considerSeedCandidate(c, { graph: null, score: score(0, 0) }, () => { cancel(); throw new TypeError('interrupted proposal'); }), (e) => e === context.Canceled);
  assert.throws(() => talaLayout.considerSeedCandidate(ctx(), { graph: null, score: score(0, 0) }, () => { throw new NotPorted('routing', 'routeGraph'); }), NotPorted);
  const [c2, cancel2] = context.withCancel(ctx());
  assert.throws(() => talaLayout.considerSeedCandidate(c2, { graph: null, score: score(0, 0) }, () => { throw errorf('x', context.Canceled); }), (e) => e.message === 'x');
  cancel2();
});

// ---- result validation ---------------------------------------------------------------------------------------------------------------------

/** a completed two-node graph with one edge (the "result") and the unplaced input it came from */
function pair() {
  const mk = (placed) => {
    const g = lg.newGraph();
    const a = lg.newNode(10n, 20, 20), b = lg.newNode(11n, 20, 20);
    if (placed) { a.topLeft = geo.newPoint(0, 0); b.topLeft = geo.newPoint(100, 0); }
    g.addNode(a);
    g.addNode(b);
    const e = g.connect(a, b);
    e.id = 12n;
    e.sourceArrowhead = 'none';
    e.targetArrowhead = 'triangle';
    if (placed) e.points = [geo.newPoint(20, 10), geo.newPoint(100, 10)];
    return g;
  };
  return [mk(false), mk(true)];
}

test('result validation: the messages of result_validate.go', () => {
  const [input, ok] = pair();
  const metadata = (g, edit) => { edit(g); try { result.validateLayoutResultMetadata(ctx(), input, g, new Set()); return null; } catch (e) { return e.message; } };
  const completed = (edit) => { const [, g] = pair(); edit(g); try { result.validateCompletedGraph(ctx(), g); return null; } catch (e) { return e.message; } };
  assert.equal(completed(() => {}), null);
  result.validateLayoutResultTopology(ctx(), input, ok);
  assert.equal(completed((g) => { g.nodes[0].topLeft = null; }), 'node 10 has no position');
  assert.equal(completed((g) => { g.nodes[0].width = 0; }), 'node 10: node width is outside the supported range: 0');
  assert.equal(completed((g) => { g.nodes[1].topLeft.x = 2e9; }), 'node 11: node x is outside the finite supported range: 2e+09');
  assert.equal(completed((g) => { g.edges[0].points.pop(); }), 'edge 12 has an incomplete route');
  assert.equal(completed((g) => { g.edges[0].labelPercentage = 2; }), 'edge 12 has invalid label percentage 2');
  assert.equal(completed((g) => { g.edges[0].points[1].y = NaN; }), 'edge 12 point 1: route y is outside the finite supported range: NaN');
  assert.equal(metadata(pair()[1], (g) => { g.nodes[0].is3D = true; }), 'node 10 3D outline metadata changed');
  assert.equal(metadata(pair()[1], (g) => { g.edges[0].minWidth = 4; }), 'edge 12 minimum geometry changed');
  assert.equal(metadata(pair()[1], (g) => { g.isRootHierarchy = true; }), 'root hierarchy metadata changed');
  assert.throws(() => result.validateLayoutResultTopology(ctx(), input, (() => { const g = pair()[1]; g.edges = []; g.nodes.forEach((n) => { n.edges = []; }); return g; })()), /result is missing edge ID 12/);
  assert.throws(() => result.validateLayoutResultTopology(ctx(), input, (() => { const g = pair()[1]; g.nodes.pop(); return g; })()), /node count changed from 2 to 1/);
  // evaluation wraps each failure with its stage
  const [, bad] = pair();
  bad.nodes[0].width = -1;
  assert.throws(() => result.evaluateSeedResult(ctx(), { graph: input, bindings: null }, bad), /^.*validate TALA seed result: node 10: node width is outside the supported range: -1/);
  const evaluated = result.evaluateSeedResult(ctx(), { graph: input, bindings: 'b' }, ok);
  assert.equal(evaluated.bindings, 'b');
  assert.ok(Number.isFinite(evaluated.score.penalty) && evaluated.score.area >= 0);
});

// ---- cancellation in the root package: the messages of layout.go and patch.go ----------------------------------------------------------------

test('root package: entry checks and the cancellation messages of Layout, the patch commits and RouteEdges', async () => {
  const [c, cancel] = context.withCancel(ctx());
  cancel();
  const g = { root: {}, data: null };
  assert.throws(() => talaLayout.layout(null, g, null), /^GoError: TALA layout requires a context$|TALA layout requires a context/);
  assert.throws(() => talaLayout.layout(c, g, null), (e) => e === context.Canceled);
  assert.throws(() => talaLayout.layout(ctx(), { root: null }, null), /tala requires a D2 graph with a root object/);
  assert.throws(() => talaLayout.layout(ctx(), null, null), /tala requires a D2 graph with a root object/);
  const patch = await import('../public/d2/tala/patch.js');
  assert.throws(() => patch.commitLayoutPatch(c, {}), (e) => e.message === 'tala layout stopped before commit: context canceled' && e.cause === context.Canceled);
  assert.throws(() => patch.commitRoutePatch(c, {}), (e) => e.message === 'tala edge routing canceled before commit: context canceled');
  assert.throws(() => patch.applySeedResult(c, g, {}), (e) => e.message === 'TALA layout canceled before apply: context canceled');
  assert.throws(() => patch.applySeedResult(ctx(), g, { graph: null }), /TALA evaluated seed is empty/);
  assert.throws(() => patch.applySeedResult(ctx(), g, { graph: lg.newGraph(), bindings: { objectIDs: null, edgeIDs: new Map(), edgeDestinations: new Map() } }), /TALA evaluated seed has no D2 bindings/);
  assert.equal(patch.preferContextError(c, 'edge routing', errorsNew('x')).message, 'tala edge routing stopped: context canceled');
  assert.equal(patch.preferContextError(ctx(), 'edge routing', errorsNew('x')).message, 'x');
  assert.throws(() => talaLayout.routeEdges(null, g, []), /TALA edge routing requires a context/);
});

// ---- a recorded set of Go traces (tools/d2ref/tala/rootfixture.mjs) -------------------------------------------------------------------------

const fixturePath = new URL('./fixtures/tala-root-replay.json', import.meta.url);
test('replay of recorded Go traces: validated, scored, selected and patched by the JS root package give Go\'s diagram and errors', async () => {
  if (!fs.existsSync(fixturePath)) return;
  const { replayCompile } = await import('../tools/d2ref/tala/rootcheck.mjs');
  const rows = bigjson.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.ok(rows.length >= 5);
  for (const row of rows) {
    const r = await replayCompile({ ...row.case, utf16: false }, row.trace);
    const got = { diagram: r.diagram === null ? null : JSON.parse(JSON.stringify(r.diagram)), err: r.err ? r.err.message : null };
    const want = bigjson.plain({ diagram: row.trace.diagram ?? null, err: row.trace.err ?? null });
    assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(JSON.stringify(want)), row.label);
  }
});

// ---- the whole JS root package on a pipeline with trivial placement and routing stages -------------------------------------------------------

test('layout(): with stand-in placement and routing packages the real root package runs, selects a seed and patches the D2 graph', async () => {
  if (hasStageFn('placement', 'prescale') && hasStageFn('routing', 'routeGraph')) return; // the real packages are merged: nothing to stand in for
  const noop = () => {};
  const placement = {
    prescale: noop, prepare: noop, swap: noop, transposeAll: noop, align: noop, balanceSymmetry: noop, pad: noop, normalize: noop,
    normalizeGaps: () => false, optimizeClusters: () => false, equidistance: () => false, dejitter: () => false,
    place(_ctx, g) { g.nodes.forEach((n, i) => { n.topLeft = geo.newPoint(i * 150, 0); }); },
  };
  const routing = {
    routeGraph(_ctx, g, options) {
      for (const e of g.edges) e.points = [e.from.center(), e.to.center()];
      options.completionObserver.routingCompleted();
      return true;
    },
    routeGraphWithWorkLimit: noop, simplifyEdgeRoutes: noop, shortcutEdgeRoutes: noop, straightEdgesFallback: noop, traceEdgesToShapeBorder: noop,
    balanceEdgeSegments: noop, nudgeEdgeChannels: noop, fixClusterEdgeBranching: noop, reorderDuplicates: noop, swapAllEdgePorts: noop, crosshatch: noop,
  };
  const off = [registerPackage('placement', placement), registerPackage('routing', routing)];
  try {
    const r = await d2lib.compile('a -> b: hi\nb -> c', { layout: 'tala', talaOpts: { 'tala-seeds': [1, 2] } });
    assert.equal(r.err, null);
    assert.deepEqual(r.diagram.shapes.map((s) => [s.id, s.pos.x]), [['a', 0], ['b', 150], ['c', 300]]);
    assert.equal(r.diagram.connections.length, 2);
    assert.ok(r.diagram.connections.every((c) => c.route.length >= 2));
    assert.equal(r.diagram.connections[0].label, 'hi');
    assert.notEqual(r.diagram.connections[0].labelPosition, undefined);
    // an engine error of one seed does not stop the other; all failing seeds are listed in seed order
    const bad = { ...placement, place() { throw errorf('boom'); } };
    const off2 = registerPackage('placement', bad);
    try {
      const f = await d2lib.compile('a -> b', { layout: 'tala', talaOpts: { 'tala-seeds': [1, 2] } });
      assert.equal(f.err.message, 'all TALA seed attempts failed: seed 1: boom\nseed 2: boom');
    } finally {
      off2();
    }
    // a panic inside a stage is Go's internal-invariant error of that seed
    const off3 = registerPackage('placement', { ...placement, place() { throw new TypeError('nil'); } });
    try {
      const f = await d2lib.compile('a -> b', { layout: 'tala', talaOpts: { 'tala-seeds': [4] } });
      assert.equal(f.err.message, 'all TALA seed attempts failed: seed 4: TALA seed layout failed due to an internal invariant');
    } finally {
      off3();
    }
  } finally {
    off.forEach((f) => f());
  }
});
