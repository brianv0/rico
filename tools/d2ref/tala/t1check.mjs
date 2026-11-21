// JS side of the T1 diff stages of the TALA port: the packages loops, grouping, proximity and trees (public/d2/tala/{loops,grouping,proximity,trees}.js).
// The Go side is tools/d2ref/tala/xdump/t1_*.go (modes t1stages and t1ops, built by tala/setup.sh).
//
//   node tala/t1diff.mjs stages <cases.jsonl> [--seeds 1,2,3] [--batch 20] [--only N] [--show 5] [--stages 1,3,5,6,19]
//        every case (D2 text or graph fixture) is run through Go's pipeline; each target stage is recomputed in JS from Go's graph of the
//        previous stage (graphjson + the deep state: margins, loop offsets, herds, nears, ...) and compared with Go's graph of that stage
//   node diff.mjs talat1ops <fixtures-with-args.jsonl>      direct calls (loops, resetClusters, seqEdges, cluster, join, nears, herds, ...)
//
// `deepState` is the JS twin of t1Deep in xdump/t1_xdump.go: keep both in step.
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as context from '../../../public/d2/tala/context.js';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as geo from '../../../public/d2/geo.js';
import * as loops from '../../../public/d2/tala/loops.js';
import * as grouping from '../../../public/d2/tala/grouping.js';
import { newRand } from '../../../public/d2/gorand.js';

const ctx = () => context.background();
const O = geo.Orientation;
const idOrNull = (n) => (n === null ? null : n.id);
const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- deep state -------------------------------------------------------------------------------------------------------------------

/** every node reachable from the graph's records, once, sorted by ID (t1Nodes in Go) */
export function t1Nodes(g) {
  const seen = new Set();
  const out = [];
  const add = (n) => {
    if (n !== null && n !== undefined && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const n of g.nodes) add(n);
  for (const v of g.clusterOrder()) {
    add(v);
    const c = g.clusters.get(v);
    for (const n of c.nodes) add(n);
    add(c.container);
  }
  for (const v of g.sequenceOrder()) {
    add(v);
    const s = g.sequences.get(v);
    for (const n of s.nodes) add(n);
    add(s.container);
  }
  const walk = (t) => {
    if (t === null) return;
    add(t.node);
    for (const c of t.children) walk(c);
  };
  for (const s of g.treeOrder()) {
    add(s);
    for (const r of g.trees.get(s)) walk(r);
  }
  for (const [k, vs] of g.containers) {
    add(k);
    for (const v of vs) add(v);
  }
  for (const [k, vs] of g.hubs) {
    add(k);
    for (const v of vs) add(v);
  }
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    add(n.container);
    for (const near of n.nears) add(near);
    if (n.cluster !== null) add(n.cluster.vessel);
    if (n.sequence !== null) add(n.sequence.vessel);
  }
  out.sort((a, b) => cmpBig(a.id, b.id));
  return out;
}

const nodeIDList = (ns) => ns.map(idOrNull);
const P = (p) => (p === null || p === undefined ? null : { x: p.x, y: p.y });
const keyOf = (v) => (v === null ? -(2n ** 62n) : v);

function abductions(as, edgeIdx) {
  return as.map((a) => {
    if (a === null) return null;
    const ei = edgeIdx.has(a.edge) ? edgeIdx.get(a.edge) : -1;
    return [ei, idOrNull(a.originallyFrom), idOrNull(a.originallyTo), idOrNull(a.currentFrom), idOrNull(a.currentTo)];
  });
}

function treeRec(t, edgeIdx) {
  if (t === null) return null;
  return {
    node: idOrNull(t.node), o: t.orientation, edge: edgeIdx.has(t.sentinelEdge) ? edgeIdx.get(t.sentinelEdge) : -1,
    parent: t.parent !== null ? idOrNull(t.parent.node) : null, children: t.children.map((c) => treeRec(c, edgeIdx)),
  };
}

export function deepState(g) {
  const edgeIdx = new Map();
  g.edges.forEach((e, i) => edgeIdx.set(e, i));
  const nodes = [];
  for (const n of t1Nodes(g)) {
    const rec = { id: n.id };
    rec.margin = [n.margin.top, n.margin.bottom, n.margin.left, n.margin.right];
    rec.padding = [n.padding.top, n.padding.bottom, n.padding.left, n.padding.right];
    rec.loop = n.loopOffsets === null ? [] : [...n.loopOffsets.entries()].sort((a, b) => a[0] - b[0]).map(([o, v]) => [o, v]);
    if (n.herdAssignment !== null) {
      const h = n.herdAssignment;
      rec.herd = {
        o: h.orientation, val: h.val,
        opp: [...h.oppositeSidePaired].map((x) => x.id).sort(cmpBig), same: [...h.sameSidePaired].map((x) => x.id).sort(cmpBig),
      };
    } else rec.herd = null;
    rec.nears = [...n.nears].map((x) => x.id).sort(cmpBig);
    rec.ldn = n.longDistanceNeighborRequirements === null ? [] :
      [...n.longDistanceNeighborRequirements.entries()].map(([o, r]) => [o.id, r.edgeCount, r.maxWidth, r.maxHeight]).sort((a, b) => cmpBig(a[0], b[0]));
    rec.inGraph = n.graph !== null;
    rec.container = idOrNull(n.container);
    rec.cluster = n.cluster !== null ? idOrNull(n.cluster.vessel) : null;
    rec.sequence = n.sequence !== null ? idOrNull(n.sequence.vessel) : null;
    rec.fixed = P(n.fixedTopLeft);
    rec.tl = P(n.topLeft);
    rec.w = n.width;
    rec.h = n.height;
    rec.isContainer = n.isContainer();
    rec.isVessel = n.isClusterVessel();
    rec.edges = n.edges.map((e) => (edgeIdx.has(e) ? edgeIdx.get(e) : -1));
    nodes.push(rec);
  }
  const clusters = g.clusterOrder().map((v) => {
    const c = g.clusters.get(v);
    return {
      vessel: idOrNull(c.vessel), nodes: nodeIDList(c.nodes), arr: c.arrangement, desired: c.desiredArrangement, padding: c.padding, fixed: c.fixedSize,
      container: idOrNull(c.container), graphSet: c.graph !== null, abd: abductions(c.edgeAbductions, edgeIdx),
    };
  });
  const sequences = g.sequenceOrder().map((v) => {
    const s = g.sequences.get(v);
    return { vessel: idOrNull(s.vessel), nodes: nodeIDList(s.nodes), container: idOrNull(s.container), graphSet: s.graph !== null, abd: abductions(s.edgeAbductions, edgeIdx) };
  });
  const trees = g.treeOrder().map((s) => ({ sentinel: idOrNull(s), roots: g.trees.get(s).map((r) => treeRec(r, edgeIdx)) }));
  const nodeToTree = g.nodeToTree === null ? [] :
    [...g.nodeToTree.entries()].map(([n, t]) => [n.id, idOrNull(t.node), t.parent !== null ? idOrNull(t.parent.node) : null]).sort((a, b) => cmpBig(a[0], b[0]));
  const hubs = g.hubOrder().map((k) => [k.id, nodeIDList(g.hubs.get(k))]);
  const directions = [...g.directions.entries()].map(([k, o]) => [idOrNull(k), o]).sort((a, b) => cmpBig(keyOf(a[0]), keyOf(b[0])));
  const containers = [...g.containers.entries()].map(([k, vs]) => [idOrNull(k), nodeIDList(vs)]).sort((a, b) => cmpBig(keyOf(a[0]), keyOf(b[0])));
  const commonUncle = g.commonUncleSiblings === null ? null :
    [...g.commonUncleSiblings.entries()].map(([k, vs]) => [k.id, nodeIDList(vs)]).sort((a, b) => cmpBig(a[0], b[0]));
  const edges = g.edges.map((e) => ({
    from: idOrNull(e.from), to: idOrNull(e.to), points: e.points.map(P),
    label: e.label !== null ? [e.label.position, e.label.width, e.label.height, e.label.positionFixed()] : null, pct: e.labelPercentage, curve: e.isCurve,
  }));
  return { nodes, clusters, sequences, trees, nodeToTree, hubs, directions, containers, commonUncle, cellSize: g.cellSize, edges, isRootHierarchy: g.isRootHierarchy };
}

/** Puts the deep state of a Go record onto a graph reconstructed from its graphjson (the graph is changed). */
export function applyDeep(g, deep) {
  const byId = new Map(t1Nodes(g).map((n) => [n.id, n]));
  const get = (id) => {
    const n = byId.get(BigInt(id));
    if (n === undefined) throw new Error(`deep state names unknown node ${id}`);
    return n;
  };
  for (const rec of deep.nodes) {
    const n = get(rec.id);
    n.margin = new lg.Spacing(...rec.margin);
    n.padding = new lg.Spacing(...rec.padding);
    n.loopOffsets = rec.loop.length === 0 ? null : new Map(rec.loop.map(([o, v]) => [o, v]));
    n.nears = new Set(rec.nears.map(get));
    n.container = rec.container === null ? null : get(rec.container); // not all of it is implied by graph.containers (hierarchy members)
    // node.edges order is not in graphjson (the codec rebuilds adjacency in graph.edges order)
    n.edges = rec.edges.map((i) => {
      if (i < 0) throw new Error(`node ${rec.id} has an edge outside graph.edges`);
      return g.edges[i];
    });
    if (rec.herd !== null) {
      const h = lg.newHerdAssignment();
      h.orientation = rec.herd.o;
      h.val = rec.herd.val;
      h.oppositeSidePaired = new Set(rec.herd.opp.map(get));
      h.sameSidePaired = new Set(rec.herd.same.map(get));
      n.herdAssignment = h;
    } else n.herdAssignment = null;
    n.longDistanceNeighborRequirements = rec.ldn.length === 0 ? null :
      new Map(rec.ldn.map(([id, count, w, h]) => [get(id), new lg.LongDistanceNeighborRequirements(count, w, h)]));
  }
  if (deep.commonUncle !== null) g.commonUncleSiblings = new Map(deep.commonUncle.map(([id, vs]) => [get(id), vs.map(get)]));
  return g;
}

// ---- reconstruct + run one stage -------------------------------------------------------------------------------------------------

export function reconstruct(rec) {
  const g = new lg.Graph();
  graphjson.unmarshal(ctx(), rec.graph, g);
  applyDeep(g, rec.deep);
  return g;
}

const ser = (g) => graphjson.serialize(ctx(), g);
const record = (g, index, name) => ({ graph: ser(g), deep: deepState(g), index, name });

let proximity = null;
let trees = null;
export async function loadModules() {
  proximity = await import('../../../public/d2/tala/proximity.js').catch(() => null);
  trees = await import('../../../public/d2/tala/trees.js').catch(() => null);
}

/** the JS function of each target stage and the stage whose graph is its input */
export const STAGE_PRED = { 1: 0, 3: 2, 5: 4, 6: 5, 19: 18 };
const STAGE_FN = {
  1: (g, run) => grouping.addSequences(ctx(), g, newRand(BigInt(run.seed))),
  3: (g) => trees.preprocess(ctx(), g),
  5: (g, run, pred) => {
    // stage 1 consumed one Int63 per sequence from the pipeline's generator; nothing else draws from it before stage 5
    const r = newRand(BigInt(run.seed));
    for (let i = 0; i < pred.deep.sequences.length; i++) r.int63();
    grouping.addClusters(ctx(), g, BigInt(run.seed), r);
  },
  6: (g) => proximity.addHubs(ctx(), g),
  19: (g) => grouping.cleanup(g),
};

const goErr = (e) => (e && e.name === 'GoError' ? e.message : null);

/**
 * want: the parsed Go output of t1stages (exact BigInts). Returns {got, exp, reconstruct, skipped}: per run the JS records of the target
 * stages and Go's, so the caller compares them; `reconstruct` lists the runs whose input state could not be rebuilt faithfully.
 */
export function stagesCheck(want, targets) {
  const got = [];
  const exp = [];
  const bad = [];
  for (const run of want.runs ?? []) {
    if (!run.stages) continue;
    const byIndex = new Map(run.stages.map((s) => [s.index, s]));
    for (const k of targets) {
      const pred = byIndex.get(STAGE_PRED[k]);
      if (!pred) continue;
      const want_k = byIndex.get(k);
      const tag = `inv${run.inv ?? 0}/seed${run.seed}/stage${k}`;
      let g;
      try {
        g = reconstruct(pred);
        const back = bigjson.plain({ graph: ser(g), deep: deepState(g) });
        const had = bigjson.plain({ graph: pred.graph, deep: pred.deep });
        const d = firstDiff(back, had);
        if (d) bad.push({ tag, ...d });
      } catch (e) {
        if (!goErr(e)) throw e;
        bad.push({ tag, path: 'reconstruct', got: e.message, want: '' });
        continue;
      }
      let jsErr = null;
      try {
        STAGE_FN[k](g, run, pred);
      } catch (e) {
        jsErr = goErr(e);
        if (jsErr === null) throw e;
      }
      if (want_k) {
        exp.push({ tag, ...stripName(want_k) });
        got.push({ tag, ...(jsErr === null ? stripName(record(g, k, want_k.name)) : { err: jsErr }) });
      } else {
        // Go stopped with an error at this stage (or the pipeline ended before it)
        exp.push({ tag, err: run.err ?? null });
        got.push({ tag, err: jsErr });
      }
    }
  }
  return { got: bigjson.plain(got), exp: bigjson.plain(exp), bad };
}

const stripName = (r) => ({ index: r.index, graph: r.graph, deep: r.deep });

export function firstDiff(a, b, p = '$') {
  if (JSON.stringify(canon(a)) === JSON.stringify(canon(b))) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 300), want: JSON.stringify(b)?.slice(0, 300) };
}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

// ---- direct calls (t1ops) -------------------------------------------------------------------------------------------------------

const positioned = (g) => g.nodes.length > 0 && g.nodes.every((n) => n.topLeft !== null);

function opLoops(c, g) {
  const out = {};
  for (const n of g.nodes) {
    const nilTL = n.topLeft === null;
    if (nilTL) n.topLeft = new geo.Point(0, 0);
    loops.route(n);
    if (nilTL) n.topLeft = null;
  }
  out.route = deepState(g);
  loops.computeOffsets(g);
  out.offsets = deepState(g);
  const g2 = new lg.Graph();
  graphjson.unmarshal(ctx(), c.graph, g2);
  for (const n of g2.nodes) n.topLeft = null;
  for (const n of g2.nodes) loops.updateOffsets(n);
  out.nilTL = deepState(g2);
  return out;
}

function opCluster(g) {
  const out = [];
  const allPositioned = (cl) => cl.nodes.every((n) => n.topLeft !== null);
  for (const v of g.clusterOrder()) {
    const cl = g.clusters.get(v);
    const rec = { vessel: v.id };
    rec.padding = grouping.paddingBetween(cl, false);
    if (allPositioned(cl) && cl.nodes.length > 1) rec.paddingPositions = grouping.paddingBetween(cl, true);
    const arr = [];
    for (const seq of [false, true]) {
      for (const seed of [1n, 2n, 3n]) {
        const r = newRand(seed);
        const a = grouping.assignArrangement(cl, seq, r);
        arr.push([a, r.float64()]);
      }
    }
    rec.arrangements = arr;
    out.push(rec);
  }
  return out;
}

export function opsT1Stage(c) {
  let g;
  try {
    g = new lg.Graph();
    graphjson.unmarshal(ctx(), c.graph, g);
  } catch (e) {
    if (!goErr(e)) throw e;
    return { err: e.message };
  }
  const op = c.args.op;
  try {
    switch (op) {
      case 'loops': return opLoops(c, g);
      case 'resetClusters':
        grouping.resetClusters(g);
        return { graph: ser(g), deep: deepState(g) };
      case 'seqEdges': {
        let err = null;
        let ids = [];
        try {
          ids = [...grouping.sequenceDefiningEdges(ctx(), g)].sort(cmpBig);
        } catch (e) {
          err = goErr(e);
          if (err === null) throw e;
        }
        return { ids, err };
      }
      case 'cluster': return opCluster(g);
      case 'join': {
        if (!positioned(g)) return { skipped: true };
        let err = null;
        try {
          grouping.joinDistancedClusters(ctx(), g);
        } catch (e) {
          err = goErr(e);
          if (err === null) throw e;
        }
        return { graph: ser(g), deep: deepState(g), err };
      }
      default: {
        const more = opsMore(op, c, g);
        if (more !== undefined) return more;
        throw new Error(`unknown t1 op ${op}`);
      }
    }
  } catch (e) {
    if (e.name === 'GoPanic') return { panic: e.message };
    throw e;
  }
}

// ops of the proximity and trees packages
function opsMore(op, c, g) {
  switch (op) {
    case 'commonUncle': {
      const common = proximity.commonUncleSiblings(g);
      return { commonUncle: [...common.entries()].map(([k, vs]) => [k.id, vs.map(idOrNull)]).sort((a, b) => cmpBig(a[0], b[0])) };
    }
    case 'hubs': {
      let err = null;
      try {
        proximity.addHubs(ctx(), g);
      } catch (e) {
        err = goErr(e);
        if (err === null) throw e;
      }
      return { graph: ser(g), deep: deepState(g), err };
    }
    case 'nearsHerds': return nearsHerds(g);
  }
  return undefined;
}

const tryErr = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    const m = goErr(e);
    if (m === null) throw e;
    return m;
  }
};

function nearsHerds(g) {
  const steps = [];
  const edgeIdx = new Map();
  g.edges.forEach((e, i) => edgeIdx.set(e, i));
  const visit = (root, prev) => {
    const children = (g.containers.get(root) ?? []).slice();
    if (children.length === 0) return;
    const childrenGraph = lg.newGraph();
    childrenGraph.copyEntitiesFrom(g);
    for (const child of children) childrenGraph.addNodeUnchecked(child);
    const abds = g.abductEdges(root, childrenGraph);
    for (const child of children) {
      if (child.isContainer()) {
        visit(child, abds);
        childrenGraph.containers = g.containers;
      }
    }
    const err1 = tryErr(() => proximity.assignNears(ctx(), childrenGraph, root, prev));
    const err2 = tryErr(() => proximity.assignHerds(ctx(), childrenGraph, root, prev));
    steps.push({ root: idOrNull(root), nears: err1, herds: err2, abductions: abductions(abds, edgeIdx) });
    g.restoreEdgeAbductions(abds);
    lg.Nodes.setGraphReference(g.nodes, g);
  };
  visit(null, []);
  if (positioned(g)) proximity.syncHerdFences(g);
  return { steps, deep: deepState(g) };
}

export const MODES = { talat1ops: 't1ops' };
export const STAGES = { talat1ops: opsT1Stage };
await loadModules();
