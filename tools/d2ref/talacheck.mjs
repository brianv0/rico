// JS side of the TALA port's diff stages (see diff.mjs: talagraphjson, talaadapter, talarand, talaops, ...). Each function maps a case to the
// same JSON the Go mode of tala/xdump prints (build it with tala/setup.sh).
import fs from 'node:fs';
import * as bigjson from '../../public/d2/tala/bigjson.js';
import * as graphjson from '../../public/d2/tala/graphjson.js';
import * as lg from '../../public/d2/tala/layoutgraph.js';
import * as context from '../../public/d2/tala/context.js';
import * as d2talalayout from '../../public/d2/tala/d2talalayout.js';
import * as geo from '../../public/d2/geo.js';
import { compileSync as d2compile } from '../../public/d2/d2lib.js';

export const ctx = () => context.background();

/** a graphjson fixture ({graph: <value>}) -> reconstructed layout graph */
export function graphFromFixture(c) {
  const g = new lg.Graph();
  graphjson.unmarshal(ctx(), c.graph, g);
  return g;
}

const errMsg = (e) => (e && e.name === 'GoError' ? e.message : null);

/** run fn, mapping a GoError to {err} like the Go modes; any other exception is a bug of the port and propagates. */
export function guarded(fn) {
  try {
    return fn();
  } catch (e) {
    const m = errMsg(e);
    if (m === null) throw e;
    return { err: m };
  }
}

// graphjson: Unmarshal + Serialize
export function graphjsonStage(c) {
  return guarded(() => {
    const g = graphFromFixture(c);
    return { graph: graphjson.serialize(ctx(), g) };
  });
}

export { bigjson, graphjson, lg };

// adapter: D2 text -> the TALA graph the adapter builds for every layout call (no layout is run: objects and edges get a placeholder
// placement so that compile goes on, exactly like xdump's adapter mode).
export function adapterStage(c) {
  const invocations = [];
  const layoutFn = (g) => {
    const rec = { adapter: null };
    try {
      const tg = lg.newGraph();
      d2talalayout.translateGraph(ctx(), g, tg, false);
      rec.adapter = graphjson.serialize(ctx(), tg);
    } catch (e) {
      const m = errMsg(e);
      if (m === null) throw e;
      rec.err = m;
    }
    invocations.push(rec);
    for (const o of g.objects ?? []) {
      if (o.box) o.box.TopLeft = new geo.Point(0, 0);
    }
    for (const e of g.edges ?? []) e.route = [new geo.Point(0, 0), new geo.Point(1, 0)];
  };
  const r = d2compile(c.text, { utf16: c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'tala', layoutResolver: () => layoutFn, routerResolver: () => () => {}, measuredTexts: c.mtexts }, {});
  if (r.err && r.err.name !== 'Error' && r.err.name !== 'GoError') globalThis.__lastErr = r.err; // for talatry.mjs
  if (r.err && r.err instanceof TypeError) globalThis.__lastErr = r.err;
  if (r.err && r.err.name === 'LatexNotPorted') return { deferred: 'latex' };
  return { invocations: invocations.length ? invocations : null, err: r.err ? r.err.message : null };
}

// ---- gorand: replays a sequence of math/rand calls (xdump rand mode) ----
import { newRand } from '../../public/d2/gorand.js';
import * as limits from '../../public/d2/tala/limits.js';

export function randStage(c) {
  const r = newRand(BigInt(c.seed));
  const values = [];
  for (const op of c.ops) {
    switch (op.op) {
      case 'Int63': values.push(r.int63().toString()); break;
      case 'Uint32': values.push(String(r.uint32())); break;
      case 'Uint64': values.push(r.uint64().toString()); break;
      case 'Int31': values.push(String(r.int31())); break;
      case 'Int': values.push(r.int().toString()); break;
      case 'Float64': values.push(r.float64()); break;
      case 'Float32': values.push(r.float32()); break;
      case 'Int63n': values.push(r.int63n(BigInt(op.n)).toString()); break;
      case 'Int31n': values.push(String(r.int31n(Number(op.n)))); break;
      case 'Intn': values.push(String(r.intn(Number(op.n)))); break;
      case 'Perm': values.push(r.perm(Number(op.n))); break;
      case 'Shuffle': {
        const p = Array.from({ length: Number(op.n) }, (_, i) => i);
        r.shuffle(p.length, (i, j) => { const t = p[i]; p[i] = p[j]; p[j] = t; });
        values.push(p);
        break;
      }
      case 'GuardShuffle': {
        const p = Array.from({ length: Number(op.n) }, (_, i) => i);
        const guard = limits.newOptimizationWorkGuard(ctx(), 'x', limits.MaxOptimizationWorkUnits);
        limits.shuffle(p, r, guard);
        values.push({ perm: p, used: guard.used(), err: null });
        break;
      }
      default: throw new Error('unknown op ' + op.op);
    }
  }
  return { values };
}

// ---- nodeshape: ports and label policy of every TALA shape (xdump nodeshape mode) ----
import * as nodeshape from '../../public/d2/tala/nodeshape.js';
import * as label from '../../public/d2/label.js';

export function nodeshapeStage(c) {
  const box = new geo.Box(new geo.Point(c.x, c.y), c.width, c.height);
  const r = nodeshape.newShape(c.shape, box);
  if (r === null) return { ok: false };
  const [s, kind] = r;
  nodeshape.setNumColumns(s, c.numColumns);
  const pt = (p) => ({ x: p.x, y: p.y });
  const out = { ok: true, kind, kindString: nodeshape.kindString(kind), numColumns: nodeshape.numColumns(s), type: s.getType() };
  out.snap = s.snapPointPercentages().map((side) => side.map((p) => ({ x: p.XPercentage, y: p.YPercentage })));
  const idx = {}, cidx = {};
  for (let o = 0; o <= 8; o++) {
    idx[o] = s.portIndices(o);
    cidx[o] = s.centerPortIndex(o);
  }
  out.portIndices = idx;
  out.centerPortIndex = cidx;
  const cpi = s.centerPortIndices();
  out.centerPortIndices = cpi.length ? cpi : null; // Go prints a nil slice as null
  const mir = s.mirroredPortIndices();
  out.mirrored = mir === null ? [] : [...mir.entries()].sort((a, b) => a[0] - b[0]);
  out.labelPrefs = {};
  for (const t of [nodeshape.Good, nodeshape.OK, nodeshape.Unideal, nodeshape.Bad]) {
    out.labelPrefs[t] = [...s.labelPositionPreferences(t)].map((p) => label.positionString(p)).sort();
  }
  const tp = [];
  for (const o of [geo.Orientation.Left, geo.Orientation.Right, geo.Orientation.Top]) {
    for (let col = 0; col < 4; col++) {
      try {
        const [p, ok] = nodeshape.tableColumnPortValue(s, o, col);
        const [i, ok2] = nodeshape.tablePortIndex(s, o, col);
        tp.push([pt(p), ok, i, ok2]);
      } catch (e) {
        if (e.name !== 'GoPanic') throw e;
        tp.push('panic');
      }
    }
  }
  out.tablePorts = tp;
  const ib = s.getInnerBox();
  out.innerBox = [pt(ib.TopLeft), ib.Width, ib.Height];
  out.insidePlacement = pt(s.getInsidePlacement(50, 30, 12, 8));
  const [w, h] = s.getDimensionsToFit(70, 40, 20, 20);
  out.dimsToFit = [w, h];
  return out;
}

// ---- layoutgraph ops (xdump lgops mode; keep in step with tala/xdump/ops.go) ----
const O = geo.Orientation;
const ALL_O = [O.Top, O.Right, O.Bottom, O.Left, O.TopLeft, O.TopRight, O.BottomLeft, O.BottomRight, O.NONE];
const P = (p) => (p === null || p === undefined ? null : { x: p.x, y: p.y });
const idsOf = (nodes) => nodes.map((n) => n.id);
const sortedIDsOf = (nodes) => idsOf(nodes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const nid = (n) => (n === null ? 0n : n.id);
const spacingOf = (s) => [s.top, s.bottom, s.left, s.right];
const positioned = (g) => g.nodes.length > 0 && g.nodes.every((n) => n.topLeft !== null);
const hasEveryRoute = (g) => g.edges.every((e) => e.points.length >= 2);
const eStr = (fn) => { try { fn(); return null; } catch (e) { if (e.name !== 'GoError') throw e; return e.message; } };
const ser = (g) => { try { return graphjson.serialize(ctx(), g); } catch (e) { if (e.name !== 'GoError') throw e; return { serializeError: e.message }; } };
const sameJSON = (a, b) => bigjson.stringify(a, true) === bigjson.stringify(b, true);
const ptCmp = (a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y);
const clusterIDs = (cs) => cs.map(idsOf);

function opOrders(g) {
  const guard = limits.newWorkGuard(ctx(), 'x', limits.MaxEngineWorkUnits);
  let rdfs = [], rerr = null;
  try { rdfs = g.containerRDFSOrder(null, guard); } catch (e) { if (e.name !== 'GoError') throw e; rerr = e.message; }
  const desc = [];
  g.nodes.slice(0, 40).forEach((n) => desc.push({ id: n.id, withAll: idsOf(g.allDescendantNodes(n, true)), without: idsOf(g.allDescendantNodes(n, false)), nears: idsOf(n.orderedNears()) }));
  return {
    cluster: idsOf(g.clusterOrder()), clusterRDFS: idsOf(g.clusterRDFSOrder()), tree: idsOf(g.treeOrder()), sequence: idsOf(g.sequenceOrder()), hub: idsOf(g.hubOrder()),
    containerRDFS: idsOf(rdfs), containerRDFSErr: rerr, unbounded: idsOf(g.containerRDFSOrderUnbounded(null)), descendants: desc,
    treeEdges: g.treeEdgeMap().size, fixed: idsOf(g.fixedNodes()), hasFixed: g.hasFixedNode(),
  };
}
import * as limitsMod from '../../public/d2/tala/limits.js';

function opClone(g) {
  let c;
  try { c = lg.clone(ctx(), g); } catch (e) { if (e.name !== 'GoError') throw e; return { err: e.message }; }
  const fixed = [];
  for (const n of c.nodes) fixed.push(n.label !== null && n.label.positionFixed(), n.icon !== null && n.icon.positionFixed());
  return { graph: ser(c), fixedFlags: fixed, nodeCount: c.nodes.length, edgeCount: c.edges.length };
}

function safePorts(n, o) { try { return n.portsByOrientation(o); } catch (e) { if (e.name === 'GoError') throw e; return []; } }

function opGeometry(g) {
  const out = {};
  let [tl, br] = g.boundingBox();
  out.bounds = [P(tl), P(br)];
  out.area = g.area();
  g.computeCellSize();
  out.cellSize = g.cellSize;
  out.turnCost = g.turnCost();
  out.crossingCost = g.crossingCost();
  out.nonCenterPortCost = g.nonCenterPortCost();
  const nodes = g.nodes;
  let [ftl, fbr] = lg.Nodes.fixedBoundingBox(nodes);
  out.fixedBounds = [P(ftl), P(fbr)];
  [tl, br] = lg.Nodes.boundingBox(nodes);
  out.nodesBounds = [P(tl), P(br)];
  out.center = P(lg.Nodes.center(nodes));
  out.adjacent = lg.Nodes.numAdjacent(nodes);
  out.clusters60 = clusterIDs(lg.Nodes.distanceClusters(nodes, 60));
  out.nodes = nodes.map((n) => {
    const o = { id: n.id };
    let [btl, bbr] = n.boundingBox(nodes);
    o.boundingBox = [P(btl), P(bbr)];
    [btl, bbr] = n.boundingBox(null);
    o.boundingBoxNoSiblings = [P(btl), P(bbr)];
    o.ports = n.ports().map(P);
    o.centerPorts = n.centerPorts().map(P);
    o.mirrored = [...n.mirroredPorts().entries()].map(([f, t]) => [P(f), P(t)]).sort((a, b) => ptCmp(a[0], b[0]));
    o.portsByOrientation = {};
    for (const ori of ALL_O) o.portsByOrientation[ori] = safePorts(n, ori).map(P);
    o.isContainer = n.isContainer();
    if (n.isContainer()) {
      o.padding = spacingOf(g.containerPadding(n, false));
      o.paddingChildren = spacingOf(g.containerPadding(n, true));
    }
    o.level = n.level();
    o.containerLevel = n.containerLevel();
    const ib = n.innerBox();
    o.innerBox = [P(ib.TopLeft), ib.Width, ib.Height];
    o.insidePlacement = P(n.insidePlacement(50, 30, lg.uniformSpacing(10)));
    o.canContain = n.canContain();
    o.modifier = n.modifierElementAdjustments();
    o.fixedOrigin = P(n.fixedOrigin());
    o.hasLeakyEdge = n.hasLeakyEdge();
    o.isMajorityTarget = n.isMajorityTarget();
    o.center = P(n.center());
    o.iconSizes = [n.iconSize(label.InsideMiddleCenter), n.iconSize(label.OutsideTopLeft), n.iconSize(label.InsideTopLeft)];
    o.containerDirection = n.containerDirection();
    if (n.label !== null) {
      o.labelTopLeft = P(n.labelTopLeft(n.label.position, n.label.width, n.label.height));
      o.labelTopLeftOutside = P(n.labelTopLeft(label.OutsideTopCenter, n.label.width, n.label.height));
    }
    o.shape = n.shapeType();
    return o;
  });
  return out;
}

function opPairs(g) {
  const out = [];
  const limit = Math.min(g.nodes.length, 36);
  for (let i = 0; i < limit; i++) {
    for (let j = 0; j < limit; j++) {
      if (i === j) continue;
      const a = g.nodes[i], b = g.nodes[j];
      const o = { a: a.id, b: b.id };
      o.deltaTo = a.deltaTo(b, a.topLeft);
      o.doesOverlap = a.doesOverlap(b);
      o.doesOverlapExact = a.doesOverlapExact(b);
      o.doesOverlapAt = a.doesOverlapAt(b, geo.newPoint(a.topLeft.x + 30, a.topLeft.y - 12));
      o.orientation = a.orientation(b);
      o.distanceTo = [a.distanceTo(b, true), a.distanceTo(b, false)];
      o.isAdjacentTo = [a.isAdjacentTo(b, true), a.isAdjacentTo(b, false)];
      o.overlapsAlong = [a.overlapsAlongDimension(b, true, true), a.overlapsAlongDimension(b, false, true), a.overlapsAlongDimension(b, true, false), a.overlapsAlongDimension(b, false, false)];
      o.visibility = [a.visibilityGraphCandidate(true, true, true, b, 20), a.visibilityGraphCandidate(false, false, true, b, 20), a.visibilityGraphCandidate(true, false, false, b, 20)];
      o.sharedAncestor = nid(a.nearestSharedAncestor(b));
      o.isDescendantOf = a.isDescendantOf(b);
      o.spillsOutOf = a.spillsOutOf(b);
      o.orthogonal = a.orthogonalDistanceTo(b);
      const ac = a.center(), bc = b.center();
      o.passesThrough = [b.passesThrough(ac, bc), b.passesThrough(geo.newPoint(a.topLeft.x, a.topLeft.y), geo.newPoint(bc.x, bc.y))];
      o.overlapsLine = b.overlapsLine(ac, geo.newPoint(bc.x, bc.y), 10);
      o.isBlocked = [a.isBlocked(b, a, true, true), a.isBlocked(b, a, false, false)];
      o.covers = a.covers(b);
      o.surrounds = a.surrounds(b, 5);
      o.contains = a.containsPoint(bc, 3);
      o.isWithin = a.isWithinBounds(b.topLeft, geo.newPoint(b.topLeft.x + b.width, b.topLeft.y + b.height));
      o.near = a.isPointNear(bc);
      o.onBox = a.containsPointOnBox(bc);
      o.overlapArea = null;
      const conn = a.connectionTo(b);
      o.connection = conn === null ? 0n : conn.id;
      o.nodeOverlapCount = a.nodeOverlapCount(g.nodes, 15);
      o.overlappingPorts = a.overlappingPorts(b).keys().sort(ptCmp).map(P);
      out.push(o);
    }
  }
  return out;
}

function opEdges(g) {
  const routed = hasEveryRoute(g);
  const out = g.edges.map((e) => {
    const o = { id: e.id };
    o.debugID = e.debugID();
    o.isDirected = e.isDirected();
    o.isBidirectional = e.isBidirectional();
    o.isUndirected = e.isUndirected();
    o.isLoop = e.isLoop();
    o.hasSourceArrow = e.hasSourceArrow();
    o.hasTargetArrow = e.hasTargetArrow();
    o.largeLabel = e.hasLargeArrowheadLabel();
    o.hasTableColumn = e.hasTableColumn();
    o.isBetweenTableColumns = e.isBetweenTableColumns();
    o.isClusterEdge = e.isClusterEdge();
    o.axisAligned = e.isAxisAligned();
    o.euclidean = e.euclideanDistance();
    o.isTreeEdge = e.isTreeEdge();
    const [from, to, hasFrom, hasTo, ori] = e.facingTablePortValues(null, null);
    o.facing = [P(from), P(to), hasFrom, hasTo, ori];
    const [etl, ebr] = e.boundingBoxValues();
    o.boundingBoxValues = [P(etl), P(ebr)];
    o.length = e.length();
    if (e.points.length >= 2) {
      o.straight = e.isStraight();
      o.segments = e.numSegments();
    }
    if (routed) o.overlappingEnd = e.hasOverlappingEnd();
    if (e.label !== null && e.points.length >= 2) {
      o.labelTopLeft = P(e.labelTopLeft(label.UnlockedTop, e.label.width, e.label.height));
      o.labelTopLeftOutside = P(e.labelTopLeft(label.OutsideTopCenter, e.label.width, e.label.height));
    }
    return o;
  });
  if (!routed) return { edges: out };
  const segs = [];
  for (const e of g.edges) for (let i = 0; i + 1 < e.points.length; i++) segs.push(lg.newCrossingSegment(e.points[i], e.points[i + 1]));
  let n = 0, cerr = null;
  try { n = lg.countSegmentCrossingsContext(ctx(), segs); } catch (e) { if (e.name !== 'GoError') throw e; cerr = e.message; }
  return { edges: out, crossings: n, crossingsErr: cerr, crossingsPlain: lg.countSegmentCrossings(segs) };
}

function opSplit(g) {
  const out = [];
  for (let mask = 0; mask < 8; mask++) {
    const opts = { includeContainers: (mask & 1) !== 0, includeNears: (mask & 2) !== 0, traverseTrees: (mask & 4) !== 0 };
    const before = ser(g);
    const o = { mask, err: null };
    try {
      const [graphs, journal] = g.splitSubgraphsTracked(ctx(), opts, null);
      o.graphs = graphs.map((sg) => ({ nodes: idsOf(sg.nodes), edges: sg.edges.map((e) => e.id) }));
      journal.restore();
    } catch (e) { if (e.name !== 'GoError') throw e; o.err = e.message; }
    o.restored = sameJSON(before, ser(g));
    out.push(o);
  }
  return out;
}

function opAbduct(g) {
  const out = [];
  const containers = [null, ...g.nodes.filter((n) => n.isContainer())];
  for (const c of containers) {
    let cl;
    try { cl = lg.clone(ctx(), g); } catch (e) { if (e.name !== 'GoError') throw e; return { err: e.message }; }
    let container = null;
    if (c !== null) container = cl.nodes.find((n) => n.id === c.id) ?? null;
    const to = lg.newGraph();
    const before = ser(cl);
    const abductions = cl.abductEdges(container, to);
    const list = abductions.map((a) => [a.edge.id, nid(a.originallyFrom), nid(a.originallyTo), nid(a.currentFrom), nid(a.currentTo)]);
    const toEdges = to.edges.map((e) => e.id);
    const mid = ser(cl);
    const remaining = cl.restoreEdgeAbductions(abductions);
    const after = ser(cl);
    out.push({ container: nid(c), abductions: list, toEdges, remaining: remaining.length, restored: sameJSON(before, after), changed: !sameJSON(before, mid), mid });
  }
  return out;
}

function opTransactions(g) {
  const out = [];
  let cl;
  try { cl = lg.clone(ctx(), g); } catch (e) { if (e.name !== 'GoError') throw e; return { err: e.message }; }
  const moves = [[10, 0], [0, -25], [200, 40], [-60, -60], [5000, 0]];
  for (let i = 0; i < Math.min(24, cl.nodes.length); i++) {
    const n = cl.nodes[i];
    if (n.topLeft === null) continue;
    for (let mi = 0; mi < moves.length; mi++) {
      if ((i + mi) % 2 === 1) continue;
      const [dx, dy] = moves[mi];
      const before = ser(cl);
      let tx;
      try { tx = cl.newRequestTransaction(ctx(), { affectContainers: mi % 2 === 0 }); } catch (e) { if (e.name !== 'GoError') throw e; out.push({ i, new: e.message }); continue; }
      tx.addOp(() => n.moveNodeWithChildren(dx, dy));
      let cerr = null;
      try { tx.commit(ctx()); } catch (e) { if (e.name !== 'GoError') throw e; cerr = e; }
      const o = { i, move: mi, id: n.id, commit: cerr === null ? null : cerr.message, invalid: cerr !== null && lg.isCandidateRejection(cerr) };
      if (cerr !== null) {
        o.rolledBack = sameJSON(before, ser(cl));
      } else {
        o.updated = eStr(() => tx.updateState());
        const tx2 = cl.newRequestTransaction(ctx(), {});
        tx2.addOp(() => n.moveNodeWithChildren(-dx, -dy));
        try { tx2.commit(ctx()); } catch (e) { if (e.name !== 'GoError') throw e; }
        tx2.rollback();
        o.afterRollback = [P(n.topLeft)];
      }
      out.push(o);
    }
  }
  return { steps: out, final: ser(cl) };
}

function opNodes(g) {
  const out = {};
  for (const t of [20, 60, 150, 400, 1000]) out[String(t)] = clusterIDs(lg.Nodes.distanceClusters(g.nodes, t));
  out.connected = g.nodes.slice(0, 20).map((n) => ({ id: n.id, set: sortedIDsOf(n.connectedNodeSet([], g)), nodes: sortedIDsOf(n.connectedNodes([], g)) }));
  return out;
}

export function opsStage(c) {
  let g;
  try { g = graphFromFixture(c); } catch (e) { if (e.name !== 'GoError') throw e; return { err: e.message }; }
  const want = c.args && c.args.length ? c.args : ['orders', 'validate', 'clone', 'geometry', 'pairs', 'edges', 'split', 'abduct', 'transactions', 'nodes'];
  const out = {};
  const geo_ = (fn) => (positioned(g) ? fn(g) : { skipped: true });
  const table = {
    orders: () => opOrders(g),
    validate: () => ({ graph: eStr(() => lg.validate(ctx(), 'x', g)), positioned: eStr(() => lg.validatePositionedGraph(ctx(), 'x', g)) }),
    clone: () => opClone(g),
    geometry: () => geo_(opGeometry),
    pairs: () => geo_(opPairs),
    edges: () => geo_(opEdges),
    split: () => opSplit(g),
    abduct: () => opAbduct(g),
    transactions: () => geo_(opTransactions),
    nodes: () => geo_(opNodes),
  };
  for (const op of want) {
    try { out[op] = table[op](); } catch (e) {
      if (e.name === 'GoError') throw e;
      if (e.name === 'GoPanic') { out[op] = { panic: e.message }; continue; }
      out[op] = { threw: String(e.stack || e).split('\n').slice(0, 3).join(' | ') };
    }
  }
  return out;
}
