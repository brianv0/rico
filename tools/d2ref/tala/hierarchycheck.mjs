// JS side of the hierarchy checks (diff.mjs stages talahierrank, talahiersimple, talahierstage, talahiercompound; the Go modes are in
// tools/d2ref/tala/xdump/hierarchy_xdump.go and must be kept in step with this file).
import * as geo from '../../../public/d2/geo.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as hierarchy from '../../../public/d2/tala/hierarchy.js';
import * as rank from '../../../public/d2/tala/hierarchyrank.js';
import * as context from '../../../public/d2/tala/context.js';
import * as limits from '../../../public/d2/tala/limits.js';
import { newRand } from '../../../public/d2/gorand.js';
import { ctx, graphFromFixture } from '../talacheck.mjs';

/** an error that Go would return, as the string of the Go modes: null when none; anything else is a bug of the port and propagates. */
function errOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    if (e.name !== 'GoError') throw e;
    return e.message;
  }
}

export function ser(g) {
  try {
    return graphjson.serialize(ctx(), g);
  } catch (e) {
    if (e.name !== 'GoError') throw e;
    return { serializeError: e.message };
  }
}

/** every node reachable from the graph's records (hierAllNodes of hierarchy_xdump.go); only the set matters here. */
export function allNodes(g) {
  const seen = new Set();
  const out = [];
  const add = (n) => {
    if (n !== null && n !== undefined && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const n of g.nodes) add(n);
  for (const [v, c] of g.clusters) { add(v); for (const n of c.nodes) add(n); }
  for (const [v, s] of g.sequences) { add(v); for (const n of s.nodes) add(n); }
  const walk = (t) => { if (t) { add(t.node); for (const c of t.children) walk(c); } };
  for (const [r, ts] of g.trees) { add(r); for (const t of ts) walk(t); }
  for (let i = 0; i < out.length; i++) {
    for (const e of out[i].edges) { add(e.from); add(e.to); }
    add(out[i].container);
    for (const n of out[i].nears) add(n);
  }
  return out;
}

/** applies the deep state of a case ("args.deep": margins, paddings, loop offsets, herd assignments, LDNR, common uncle siblings). */
export function applyDeep(g, d) {
  if (!d) return;
  const byID = new Map();
  for (const n of allNodes(g)) byID.set(BigInt(n.id), n);
  for (const dn of d.nodes ?? []) {
    const n = byID.get(BigInt(dn.id));
    if (!n) continue;
    if (dn.margin) n.margin = new lg.Spacing(...dn.margin);
    if (dn.padding) n.padding = new lg.Spacing(...dn.padding);
    if (dn.loopOffsets) {
      n.loopOffsets = new Map();
      for (const [k, v] of Object.entries(dn.loopOffsets)) n.loopOffsets.set(Number(k), v);
    }
    if (dn.herd) {
      const h = lg.newHerdAssignment();
      h.orientation = dn.herd.orientation;
      h.val = dn.herd.val;
      n.herdAssignment = h;
    }
    if (dn.ldnr) {
      n.longDistanceNeighborRequirements = new Map();
      for (const [k, v] of Object.entries(dn.ldnr)) {
        const o = byID.get(BigInt(k));
        if (o) n.longDistanceNeighborRequirements.set(o, new lg.LongDistanceNeighborRequirements(v[0], v[1], v[2]));
      }
    }
  }
  if (d.commonUncle) {
    g.commonUncleSiblings = new Map();
    for (const [k, ids] of Object.entries(d.commonUncle)) {
      const n = byID.get(BigInt(k));
      if (!n) continue;
      g.commonUncleSiblings.set(n, ids.map((id) => byID.get(BigInt(id))).filter((x) => x));
    }
  }
}

/** graphFromFixture + deep state */
export function loadCase(c) {
  const g = graphFromFixture(c);
  applyDeep(g, c.args && c.args.deep);
  return g;
}

const levelPairs = (levels) => [...levels].map(([n, l]) => [n.id, l]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

// ---- hierrank ----
export function hierrankStage(c) {
  const a = c.args;
  const results = [];
  for (const limit of [0, ...(a.limits ?? [])]) {
    const g = lg.newGraph();
    const byID = new Map();
    for (const id of a.nodes) byID.set(BigInt(id), g.addNode(lg.newNode(BigInt(id), 10, 10)));
    for (const e of a.edges) {
      const ed = g.connect(byID.get(BigInt(e.from)), byID.get(BigInt(e.to)));
      ed.sourceArrowhead = lg.NoArrowhead;
      ed.targetArrowhead = lg.TriangleArrowhead;
      ed.id = BigInt(e.id);
      ed.setHierarchyRankWeight(e.weight);
    }
    const res = { limit, err: null };
    let r = null;
    res.err = errOf(() => { r = limit === 0 ? rank.rankDAG(ctx(), g) : wrapLimit(g, limit); });
    if (res.err === null) {
      res.levels = levelPairs(r.nodeToLevel);
      res.count = r.levelCount;
    }
    results.push(res);
  }
  return { results };
}

function wrapLimit(g, limit) {
  try {
    return rank.rankDAGWithLimit(ctx(), g, limit);
  } catch (e) {
    if (e.name !== 'GoError') throw e;
    const w = new Error(`TALA RankDAG failed: ${e.message}`);
    w.name = 'GoError';
    throw w;
  }
}

// ---- hiersimple ----
const hlevels = (h) => (h === null ? null : { levels: levelPairs(h.levels()), count: h.levelCount });

export function hiersimpleStage(c) {
  const g = loadCase(c);
  const out = {};
  let dag = null;
  const e = errOf(() => { dag = hierarchy.makeSimpleDAG(ctx(), g); });
  if (e !== null) out.dag = { err: e };
  else {
    out.dag = {
      nodes: dag.nodes.map((n) => n.id),
      edges: dag.edges.map((x) => ({ id: x.id, from: x.from.id, to: x.to.id, weight: x.hierarchyRankWeight() })),
    };
    if (out.dag.nodes.length === 0) out.dag.nodes = null;
    if (out.dag.edges.length === 0) out.dag.edges = null;
  }
  for (const force of [false, true]) {
    const all = new Set(g.nodes);
    let h = null;
    const err = errOf(() => { h = hierarchy.build(ctx(), g, force, all, null); });
    out[`build${force}`] = err !== null ? { err } : { hierarchy: hlevels(h) };
  }
  return out;
}

// ---- hierstage ----
/** a context whose Err() calls are counted (the count is state.n) and which fails from the failAt-th call on, like pcCtx of the Go side */
export function countingCtx(state, failAt = 0) {
  const base = new context.Context(null);
  Object.defineProperty(base, 'cancelErr', {
    get() {
      state.n++;
      return failAt > 0 && state.n >= failAt ? context.Canceled : null;
    },
  });
  return base;
}

/** the body of the PreprocessHierarchies stage (op all), or only its Assign or Place part (hierRunOp of the Go side) */
function hierRunOp(c, g, op, seed) {
  const rnd = newRand(BigInt(seed));
  const cands = hierarchy.candidates(g);
  if (op === 'assign') return hierarchy.assign(c, g, null, cands);
  if (op === 'place') return hierarchy.place(c, g, null, rnd);
  hierarchy.assign(c, g, null, cands);
  hierarchy.place(c, g, null, rnd);
  hierarchy.removeIsolatedMemberships(g);
}

export function hierstageStage(c, want) {
  const g = loadCase(c);
  const seed = c.seeds && c.seeds.length ? c.seeds[0] : 1;
  const op = c.op || 'all';
  const a = c.args ?? {};
  const cands = hierarchy.candidates(g);
  const ids = g.nodes.filter((n) => cands.has(n)).map((n) => n.id);
  const out = { candidates: ids.length ? ids : null, horizontal: hierarchy.isHorizontal(g.nodes) };

  if (a.txLimits && a.txLimits.length) {
    out.limited = [];
    for (const lim of a.txLimits) {
      const g2 = loadCase(c);
      const guard = limits.newWorkGuard(ctx(), 'hierarchy check', lim);
      const rec = { limit: lim };
      rec.err = errOf(() => hierRunOp(lg.contextWithTransactionWorkGuard(ctx(), guard), g2, op, seed));
      if (rec.err !== null) rec.graph = ser(g2);
      out.limited.push(rec);
    }
  }
  if (a.polls && want && want.pollsUnstable) {
    out.pollsUnstable = true; // Go's own count varies between runs (map order in findCycleEdges)
  } else if (a.polls) {
    const g2 = loadCase(c);
    const st = { n: 0 };
    const err = errOf(() => hierRunOp(countingCtx(st), g2, op, seed));
    const rec = [st.n, err];
    if (st.n > 1) {
      const g3 = loadCase(c);
      const st2 = { n: 0 };
      const err2 = errOf(() => hierRunOp(countingCtx(st2, Math.trunc(st.n / 2) + 1), g3, op, seed));
      rec.push(st2.n, err2, ser(g3));
    }
    out.polls = rec;
  }

  out.err = errOf(() => hierRunOp(ctx(), g, op, seed));
  out.graph = ser(g);
  return out;
}

// ---- hiercompound ----
export function hiercompoundStage(c) {
  const g = loadCase(c);
  let cl = null;
  const cerr = errOf(() => { cl = lg.clone(ctx(), g); });
  if (cerr !== null) return { cloneErr: cerr };
  let changed = false;
  const err = errOf(() => { changed = hierarchy.placeCompound(ctx(), cl, newRand(0n)); });
  return { changed, err, graph: ser(cl) };
}

export { geo };
