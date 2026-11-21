// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/engine (D2 v0.9.0, Copyright 2022 Terrastruct Inc.): pipeline.go (the
// flat list of 37 stages, the per-seed pipeline, Layout) and compound_candidate.go (CompoundCandidate).
//
// Each stage calls its package's function by name through stagepkgs.js: `placement.Prescale(g)` is `stageFn('placement', 'prescale')(g)`.
// grouping, proximity, trees, hierarchy, packing, labeling and layoutgraph are ported and imported here; placement and routing are looked
// up when they exist (a missing function throws NotPorted, naming the package, the function and the pipeline stage). Errors are exceptions
// (GoError), see docs/d2-tala-port.md. The stage durations are in milliseconds (performance.now()); Go's are time.Duration values.
//
// The routing stage functions are called with Go's signatures: routing.RouteGraph(ctx, g, options) -> routingComplete (boolean) with
// options {forceReroute, routesPreviouslyCompleted, observer, completionObserver} (Go's routing.GraphRouteOptions; the observer's methods are
// subgraphRouted(ovg) and routingCompleted()), routing.RouteGraphWithWorkLimit(ctx, g, options, workLimit), and
// routing.SimplifyEdgeRoutes / ShortcutEdgeRoutes / StraightEdgesFallback / TraceEdgesToShapeBorder / BalanceEdgeSegments / NudgeEdgeChannels /
// FixClusterEdgeBranching / ReorderDuplicates / SwapAllEdgePorts / Crosshatch (ctx, g). placement.NormalizeGaps / OptimizeClusters /
// Equidistance / Dejitter return their boolean, Place(ctx, g, seed) takes the seed as a BigInt.

import * as label from '../label.js';
import * as geo from '../geo.js';
import { goV } from '../gomath.js';
import { newRand } from '../gorand.js';
import { withCancel } from './context.js';
import { errorf, isPanic } from './goerrors.js';
import * as invariant from './invariant.js';
import * as limits from './limits.js';
import * as lg from './layoutgraph.js';
import * as grouping from './grouping.js';
import * as hierarchy from './hierarchy.js';
import * as labeling from './labeling.js';
import * as packing from './packing.js';
import * as proximity from './proximity.js';
import * as trees from './trees.js';
import { newOVG } from './routing/ovg.js';
import { NotPorted, registerPackage, stageFn } from './stagepkgs.js';

export { NotPorted };

// The packages that are ported before the engine (stagepkgs.js finds placement and routing).
registerPackage('grouping', grouping);
registerPackage('hierarchy', hierarchy);
registerPackage('labeling', labeling);
registerPackage('packing', packing);
registerPackage('proximity', proximity);
registerPackage('trees', trees);

const maxGraphSize = limits.MaxGraphSize;

const placement = (name) => stageFn('placement', name);
const routing = (name) => stageFn('routing', name);

// LayoutOptions configures one deterministic layout attempt: {seed} (the seed is a BigInt, Go's int64).

/** newRoutingSnapshot clones the OVG and the graph at the same point in the routing pipeline so tests and developer tooling can render a consistent snapshot. */
function newRoutingSnapshot(ctx, ovg, g) {
  const ovgCopy = newOVG(null);
  const ovgJSON = ovg.marshalJSON();
  ovgCopy.unmarshalJSON(ovgJSON);
  const graphCopy = lg.clone(ctx, g);
  return { ovg: ovgCopy, graph: graphCopy };
}

/** defaultPipelineStages is immutable after initialization. Tests that wrap or replace stages must first install a private stages override on their pipeline. */
export const defaultPipelineStages = Object.freeze([
  { name: 'Prescale', run: (p, ctx) => p.prescaleStage(ctx) },
  { name: 'PreprocessSequences', run: (p, ctx) => p.preprocessSequenceStage(ctx) },
  { name: 'Preprocess', run: (p, ctx) => p.preprocessStage(ctx) },
  { name: 'PreprocessTrees', run: (p, ctx) => p.preprocessTreesStage(ctx) },
  { name: 'PreprocessHierarchies', run: (p, ctx) => p.preprocessHierarchies(ctx) },
  { name: 'PreprocessClusters', run: (p, ctx) => p.preprocessClusters(ctx) },
  { name: 'PreprocessHubs', run: (p, ctx) => p.preprocessHubs(ctx) },
  { name: 'NodePlacement', run: (p, ctx) => p.nodePlacementStage(ctx) },
  { name: 'SwapStuff', run: (p, ctx) => p.swapNodesStage(ctx) },
  { name: 'Transpose', run: (p, ctx) => p.transposeStage(ctx) },
  { name: 'AlignAxes', run: (p, ctx) => p.alignAxes(ctx) },
  { name: 'GapNormalization', run: (p, ctx) => p.gapNormalizationStage(ctx) },
  { name: 'AlignAxes', run: (p, ctx) => p.alignAxes(ctx) },
  { name: 'OptimizeClusters', run: (p, ctx) => p.optimizeClustersStage(ctx) },
  { name: 'AlignAxes', run: (p, ctx) => p.alignAxes(ctx) },
  { name: 'BalanceSymmetry', run: (p, ctx) => p.balanceSymmetryStage(ctx) },
  { name: 'Equidistance', run: (p, ctx) => p.equidistanceStage(ctx) },
  { name: 'AlignAxes', run: (p, ctx) => p.alignAxes(ctx) },
  { name: 'BinPack', run: (p, ctx) => p.binPack(ctx) },
  { name: 'CleanupStuff', run: (p, ctx) => p.cleanupGroupsStage(ctx) },
  { name: 'Rescale', run: (p, ctx) => p.rescaleStage(ctx) },
  { name: 'EdgeRouting', run: (p, ctx) => p.edgeRoutingStage(ctx) },
  { name: 'Crosshatch', run: (p, ctx) => p.crosshatchStage(ctx) },
  { name: 'Dejitter', run: (p, ctx) => p.dejitterStage(ctx) },
  { name: 'EdgeRouting', run: (p, ctx) => p.edgeRoutingStage(ctx) },
  { name: 'SimplifyEdgeRoutes', run: (p, ctx) => p.simplifyEdgeRoutes(ctx) },
  { name: 'SwapEdgePorts', run: (p, ctx) => p.swapEdgePorts(ctx) },
  { name: 'StraightEdgesFallback', run: (p, ctx) => p.straightEdgesFallback(ctx) },
  { name: 'BalanceEdgeSegments', run: (p, ctx) => p.balanceEdgeSegments(ctx) },
  { name: 'FixClusterEdgeBranching', run: (p, ctx) => p.fixClusterEdgeBranching(ctx) },
  { name: 'TraceEdgesToShapeBorder', run: (p, ctx) => p.traceEdgesToShapeBorder(ctx) },
  { name: 'ReorderDuplicates', run: (p, ctx) => p.reorderDuplicates(ctx) },
  // Second binpack doesn't try to avoid edges.
  { name: 'BinPack', run: (p, ctx) => p.binPack(ctx) },
  { name: 'PlaceLabels', run: (p, ctx) => p.placeLabels(ctx) },
  { name: 'NudgeEdgeChannels', run: (p, ctx) => p.nudgeEdgeChannels(ctx) },
  { name: 'ShortcutEdgeRoutes', run: (p, ctx) => p.shortcutEdgeRoutes(ctx) },
  { name: 'Normalize', run: (p, ctx) => p.normalizeStage(ctx) },
]);

/** routingSnapshotObserver stores a snapshot after every routed subgraph (the instrumentation of tests and tools). */
class RoutingSnapshotObserver {
  constructor(pipeline, ctx) {
    this.pipeline = pipeline;
    this.ctx = ctx;
    this.started = false;
  }

  subgraphRouted(ovg) {
    if (!this.started) {
      this.pipeline.snapshots = null;
      this.started = true;
    }
    let snapshot;
    try {
      snapshot = newRoutingSnapshot(this.ctx, ovg, this.pipeline.graph);
    } catch (e) {
      throw errorf(`copy edge-routing snapshot: ${e.message}`, e);
    }
    (this.pipeline.snapshots ??= []).push(snapshot);
  }
}

export class Pipeline {
  /** newPipeline initializes one deterministic layout pipeline. */
  constructor(graph, randSeed, storeSnapshots) {
    this.graph = graph;
    this.seed = BigInt(randSeed);
    this.hierarchyPlacementRandom = newRand(this.seed);
    this.random = newRand(this.seed);
    this.stages = null;
    this.storeSnapshots = storeSnapshots;
    this.snapshots = null;
    this.stageDurations = null;
    this.forceReroute = false;
    this.edgeRoutingComplete = false;
    this.alignAxesNeeded = true;
  }

  stagePlan() {
    if (this.stages !== null) return this.stages;
    return defaultPipelineStages;
  }

  enableStageTiming() {
    this.stageDurations = new Array(this.stagePlan().length).fill(0);
  }

  simplifyEdgeRoutes(ctx) {
    routing('simplifyEdgeRoutes')(ctx, this.graph);
  }

  shortcutEdgeRoutes(ctx) {
    routing('shortcutEdgeRoutes')(ctx, this.graph);
  }

  /** prescaleStage takes trivial time, so it does not poll the context itself. */
  prescaleStage(_ctx) {
    placement('prescale')(this.graph);
  }

  preprocessSequenceStage(ctx) {
    grouping.addSequences(ctx, this.graph, this.random);
  }

  preprocessHubs(ctx) {
    proximity.addHubs(ctx, this.graph);
  }

  preprocessClusters(ctx) {
    grouping.addClusters(ctx, this.graph, this.seed, this.random);
  }

  preprocessHierarchies(ctx) {
    hierarchy.assign(ctx, this.graph, null, hierarchy.candidates(this.graph));

    hierarchy.place(ctx, this.graph, null, this.hierarchyPlacementRandom);

    hierarchy.removeIsolatedMemberships(this.graph);
  }

  preprocessStage(_ctx) {
    placement('prepare')(this.graph);
  }

  preprocessTreesStage(ctx) {
    trees.preprocess(ctx, this.graph);
  }

  gapNormalizationStage(ctx) {
    // Go assigns the flag before it looks at the error: a failing stage still leaves it set
    let changed = false;
    try {
      changed = placement('normalizeGaps')(ctx, this.graph);
    } finally {
      this.alignAxesNeeded = changed;
    }
  }

  nodePlacementStage(ctx) {
    placement('place')(ctx, this.graph, this.seed);
  }

  optimizeClustersStage(ctx) {
    this.graph.computeCellSize();
    let changed = false;
    try {
      changed = placement('optimizeClusters')(ctx, this.graph);
    } finally {
      this.alignAxesNeeded = changed;
    }
  }

  balanceSymmetryStage(ctx) {
    placement('balanceSymmetry')(ctx, this.graph);
  }

  binPack(ctx) {
    packing.pack(ctx, this.graph, null);
  }

  swapNodesStage(ctx) {
    placement('swap')(ctx, this.graph);
  }

  transposeStage(ctx) {
    placement('transposeAll')(ctx, this.graph);
  }

  cleanupGroupsStage(_ctx) {
    grouping.cleanup(this.graph);
  }

  rescaleStage(_ctx) {
    this.graph.computeCellSize();
    placement('pad')(this.graph);
  }

  edgeRoutingStage(ctx) {
    this.runGraphRouting(ctx, null);
  }

  routingCompleted() {
    this.edgeRoutingComplete = true;
  }

  subgraphRouted(_ovg) {
    this.snapshots = null;
  }

  routeObserver(ctx) {
    if (!this.storeSnapshots) return this;
    return new RoutingSnapshotObserver(this, ctx);
  }

  runGraphRouting(ctx, workLimit) {
    if (this === null || this.graph === null) throw errorf('TALA EdgeRouting requires a graph');
    const originalSnapshots = this.snapshots;
    const originalRoutingComplete = this.edgeRoutingComplete;
    let succeeded = false;
    try {
      const options = {
        forceReroute: this.forceReroute,
        routesPreviouslyCompleted: this.edgeRoutingComplete,
        observer: this.routeObserver(ctx),
        completionObserver: this,
      };
      let routingComplete;
      if (workLimit === null) {
        routingComplete = routing('routeGraph')(ctx, this.graph, options);
      } else {
        routingComplete = routing('routeGraphWithWorkLimit')(ctx, this.graph, options, workLimit);
      }
      this.edgeRoutingComplete = routingComplete;
      succeeded = true;
    } finally {
      if (!succeeded) {
        this.snapshots = originalSnapshots;
        this.edgeRoutingComplete = originalRoutingComplete;
      }
    }
  }

  /** straightEdgesFallback replaces expensive orthogonal routes with suitable straight routes after the normal routing attempts have completed. */
  straightEdgesFallback(ctx) {
    routing('straightEdgesFallback')(ctx, this.graph);
  }

  traceEdgesToShapeBorder(ctx) {
    routing('traceEdgesToShapeBorder')(ctx, this.graph);
  }

  balanceEdgeSegments(ctx) {
    routing('balanceEdgeSegments')(ctx, this.graph);
  }

  nudgeEdgeChannels(ctx) {
    routing('nudgeEdgeChannels')(ctx, this.graph);
  }

  fixClusterEdgeBranching(ctx) {
    routing('fixClusterEdgeBranching')(ctx, this.graph);
  }

  dejitterStage(ctx) {
    let changed = false;
    try {
      changed = placement('dejitter')(ctx, this.graph);
    } finally {
      this.forceReroute = changed;
    }

    // TODO account for nearby nodes and cascading nested-container expansion
    // before expanding containers at this stage.
  }

  equidistanceStage(ctx) {
    this.graph.computeCellSize();
    let changed = false;
    try {
      changed = placement('equidistance')(ctx, this.graph);
    } finally {
      this.alignAxesNeeded = changed;
    }
  }

  alignAxes(ctx) {
    if (!this.alignAxesNeeded) return;
    this.alignAxesNeeded = false;
    placement('align')(ctx, this.graph);
  }

  normalizeStage(_ctx) {
    placement('normalize')(this.graph);
  }

  reorderDuplicates(ctx) {
    routing('reorderDuplicates')(ctx, this.graph);
  }

  placeLabels(ctx) {
    labeling.place(ctx, this.graph);
  }

  swapEdgePorts(ctx) {
    routing('swapAllEdgePorts')(ctx, this.graph);
  }

  crosshatchStage(ctx) {
    routing('crosshatch')(ctx, this.graph);
  }

  resetFullLayoutRouteState() {
    for (const edge of this.graph.edges) {
      if (edge === null) continue;
      edge.points = [];
      if (edge.label === null || !edge.label.positionFixed()) {
        edge.labelPercentage = 0;
        if (edge.label !== null && label.isUnlocked(edge.label.position)) {
          edge.label.position = label.Unset;
        }
      }
      edge.isCurve = false;
    }
    this.graph.resetPlacementCosts();
  }

  /** runAllStages executes the layout stages in order against the pipeline graph. */
  runAllStages(ctx) {
    [ctx] = lg.ensureTransactionWorkGuard(ctx, 'AutolayoutTransactions');
    const stages = this.stagePlan();
    const timed = this.stageDurations !== null;
    if (timed && this.stageDurations.length !== stages.length) {
      this.stageDurations = new Array(stages.length).fill(0);
    }
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      const stage = stages[stageIndex];
      let err = ctx.err();
      if (err) throw errorf(`${stage.name}: ${err.message}`, err);
      if (stageIndex === 0) {
        grouping.resetClusters(this.graph);
        // A full layout owns geometry, routing, and route-derived presentation.
        // An incoming route cannot remain authoritative once node placement, obstacle
        // sizing, and padding may change its coordinate space. Invalidate its
        // auto-placed label and cost state too, while retaining explicit locked
        // label positions. None of that stale state should influence the first,
        // pre-routing BinPack or the new route search.
        this.resetFullLayoutRouteState();
      }
      let start = 0;
      if (timed) start = performance.now();
      try {
        stage.run(this, ctx);
      } catch (e) {
        if (e instanceof NotPorted) e.atStage(stageIndex, stage.name);
        throw e;
      }
      err = ctx.err();
      if (err) throw errorf(`${stage.name}: ${err.message}`, err);
      if (timed) this.stageDurations[stageIndex] = performance.now() - start;

      // Only check overflow if nodes have been placed
      const [tl, br] = this.graph.boundingBox();
      if (tl !== null && br !== null) {
        const width = br.x - tl.x;
        const height = br.y - tl.y;
        if (width > maxGraphSize || height > maxGraphSize) {
          throw invariant.errorf(`Dimensions w:${goV(width)}, h:${goV(height)} reached after stage ${stage.name}`);
        }
      }
    }
  }
}

/** newPipeline initializes one deterministic layout pipeline. */
export const newPipeline = (graph, randSeed, storeSnapshots) => new Pipeline(graph, randSeed, storeSnapshots);

/**
 * Layout returns one complete deterministic layout in a new graph. Input is validated and remains unchanged, so callers may safely reuse it
 * for other layout attempts.
 */
export function layout(ctx, graph, options) {
  if (ctx == null) throw errorf('TALA Autolayout requires a context');
  let err = ctx.err();
  if (err) throw errorf(`Autolayout: ${err.message}`, err);
  if (graph == null) throw errorf('TALA Autolayout requires a graph');
  let workspace;
  try {
    workspace = lg.clone(ctx, graph);
  } catch (e) {
    const contextErr = ctx.err();
    if (contextErr && !isPanic(e)) throw errorf(`Autolayout: ${contextErr.message}`, contextErr);
    throw e;
  }
  runLayout(ctx, workspace, options, { storeSnapshots: false, measureStageDurations: false }, false);
  err = ctx.err();
  if (err) throw errorf(`Autolayout: ${err.message}`, err);
  return workspace;
}

/** runLayout runs the pipeline on `graph` itself (instrumentation: {storeSnapshots, measureStageDurations}); returns the pipeline, or null for an empty graph. */
export function runLayout(ctx, graph, options, instrumentation, validate) {
  if (ctx == null) throw errorf('TALA Autolayout requires a context');
  const err = ctx.err();
  if (err) throw errorf(`Autolayout: ${err.message}`, err);
  if (graph == null) throw errorf('TALA Autolayout requires a graph');
  if (validate) lg.validate(ctx, 'Autolayout', graph);
  if (graph.nodes.length === 0) return null;
  let workCtx = ctx;
  let cancelWork = () => {};
  if (!ctx.hasDone()) [workCtx, cancelWork] = withCancel(ctx);
  try {
    const pipeline = new Pipeline(graph, options.seed, instrumentation.storeSnapshots);
    if (instrumentation.measureStageDurations) pipeline.enableStageTiming();
    pipeline.runAllStages(workCtx);
    return pipeline;
  } finally {
    cancelWork();
  }
}

// ---- compound_candidate.go ----

/**
 * CompoundCandidate gives the selected drawing at most one rigid-container placement trial. It never runs another full seed pipeline. The
 * adapter must validate and compare the completed proposal against the ordinary incumbent. Returns `graph` itself when there is no candidate.
 */
export function compoundCandidate(ctx, graph) {
  if (ctx == null || graph == null) throw errorf('TALA compound candidate requires a context and graph');
  let err = ctx.err();
  if (err) throw err;
  const roots = graph.containers.get(null) ?? [];
  if (graph.nodes.length > 128 || graph.edges.length > 256 || roots.length < 3 || roots.length > 64) return graph;
  let detailed = false;
  for (const node of roots) detailed = detailed || node.isContainer();
  if (!detailed || graph.hasFixedNode()) return graph;
  const candidate = lg.clone(ctx, graph);
  // This is a deterministic post-selection proposal, independent of seed
  // completion order. Requested seeds still run exactly once each.
  const changed = hierarchy.placeCompound(ctx, candidate, newRand(0n));
  if (!changed) return graph;
  // This is an outer-flow refinement. Avoid a routing trial when its block
  // arrangement makes more external connections cross between disjoint lanes.
  // This is an admission heuristic, not a bound on the completed layout score:
  // routing and labels still determine whether an admitted proposal is kept.
  const worseAlignment = compoundCrossAxisDetours(candidate) > compoundCrossAxisDetours(graph);
  err = ctx.err();
  if (err) throw err;
  if (worseAlignment) return graph;
  reroutePlaced(ctx, candidate);
  const [tl, br] = candidate.boundingBox();
  if (tl !== null && br !== null && (br.x - tl.x > maxGraphSize || br.y - tl.y > maxGraphSize)) return graph;
  return candidate;
}

/**
 * compoundCrossAxisDetours counts external connections whose outer blocks have disjoint projections perpendicular to the flow. Their logical
 * blocks offer no shared lane along that flow; labels and visual modifiers are not included. Endpoints inside the same rigid block do not
 * participate: their arrangement is unchanged by this proposal.
 */
export function compoundCrossAxisDetours(g) {
  const rootOf = new Map();
  for (const n of g.nodes) {
    let root = n;
    while (root.container !== null) root = root.container;
    rootOf.set(n, root);
  }
  const horizontal = geo.isHorizontal(g.direction(null));
  let detours = 0;
  for (const edge of g.edges) {
    const from = rootOf.get(edge.from);
    const to = rootOf.get(edge.to);
    if (from === to) continue;
    if (horizontal) {
      if (from.topLeft.y + from.height < to.topLeft.y || to.topLeft.y + to.height < from.topLeft.y) detours++;
    } else if (from.topLeft.x + from.width < to.topLeft.x || to.topLeft.x + to.width < from.topLeft.x) {
      detours++;
    }
  }
  return detours;
}

export function reroutePlaced(ctx, g) {
  const p = newPipeline(g, 0n, false);
  p.resetFullLayoutRouteState();
  // Reuse routing and label cleanup on placed nodes without regrouping,
  // rescaling, or invoking another full seed attempt.
  const stages = [
    (c) => p.edgeRoutingStage(c), (c) => p.simplifyEdgeRoutes(c), (c) => p.swapEdgePorts(c),
    (c) => p.straightEdgesFallback(c), (c) => p.balanceEdgeSegments(c),
    (c) => p.fixClusterEdgeBranching(c), (c) => p.traceEdgesToShapeBorder(c),
    (c) => p.reorderDuplicates(c), (c) => p.placeLabels(c),
  ];
  for (const stage of stages) {
    const err = ctx.err();
    if (err) throw err;
    stage(ctx);
  }
  // Authored fixed origins have already had prescale padding removed.
  if (!g.hasFixedNode()) {
    placement('normalize')(g);
  }
  const err = ctx.err();
  if (err) throw err;
}
