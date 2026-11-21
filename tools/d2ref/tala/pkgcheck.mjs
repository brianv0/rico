// JS side of the packing / labeling / quality checks (diff.mjs stages talapack, talaplace, talaquality, talacombine, talascore; the Go side is
// tala/xdump/{pkg,packing,labeling,quality}_xdump.go). Each function maps a case to the same JSON the Go mode prints.
//
// A case is {name, kind?, graph: <graphjson>, args: {deep?, expect?, ...}}. `args.deep` is the node state graphjson does not carry
// (margin, padding, loop offsets, label/icon positionFixed) of the stage graphs; the JS twin applies it to the unmarshalled graph.
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as context from '../../../public/d2/tala/context.js';
import * as limits from '../../../public/d2/tala/limits.js';
import * as packing from '../../../public/d2/tala/packing.js';
import * as labeling from '../../../public/d2/tala/labeling.js';
import * as quality from '../../../public/d2/tala/quality.js';
import * as geo from '../../../public/d2/geo.js';

const ctx = () => context.background();

// Go charges the spare capacity of slices (edge routes, node edge lists, ...) in its preflights and snapshots; JS arrays have none, so
// the JS work units are lower by that charge. Stage cases record the spare capacity of the pre-state (`args.spare`): when it is not 0 a
// JS count below Go's is accepted (and counted here); with spare 0 the counts must be equal. Direct cases run on clipped slices.
export const stats = { loose: 0, exact: 0 };
process.on('exit', () => { if (stats.loose) console.error(`pkgcheck: ${stats.loose} work-unit counts accepted below Go's (spare slice capacity), ${stats.exact} exact`); });
function loose(c, got, want, key = 'used') {
  if (want && typeof want[key] === 'number' && typeof got[key] === 'number') {
    if (got[key] === want[key]) stats.exact++;
    else if (c.args?.spare > 0 && got[key] < want[key]) { stats.loose++; got[key] = want[key]; }
  }
  return got;
}
/** the context the function under test runs with: already canceled when args.cancel is set */
function argsCtx(c) {
  if (!c.args?.cancel) return ctx();
  const [x, cancel] = context.withCancel(ctx());
  cancel();
  return x;
}
const msg = (e) => (e && e.name === 'GoError' ? e.message : null);

/** every node the graph reaches (the twin of graphNodes in xdump/pkg_xdump.go; the order is irrelevant here) */
export function graphNodes(g) {
  const seen = new Set();
  const out = [];
  const add = (n) => { if (n !== null && n !== undefined && !seen.has(n)) { seen.add(n); out.push(n); } };
  for (const n of g.nodes) add(n);
  for (const [k, children] of g.containers) { add(k); for (const c of children) add(c); }
  for (const [v, c] of g.clusters) { add(v); for (const n of c.nodes) add(n); }
  for (const [v, s] of g.sequences) { add(v); for (const n of s.nodes) add(n); }
  for (const e of g.edges) { add(e.from); add(e.to); }
  for (const n of [...out]) for (const near of n.nears) add(near);
  return out;
}

/** unmarshal the case's graph and apply args.deep */
export function loadGraph(c) {
  const g = new lg.Graph();
  graphjson.unmarshal(ctx(), c.graph, g);
  const deep = c.args?.deep;
  if (deep) {
    const byID = new Map(graphNodes(g).map((n) => [String(n.entityID()), n]));
    const edgeByID = new Map(g.edges.map((e) => [String(e.entityID()), e]));
    for (const [id, d] of Object.entries(deep)) {
      const n = byID.get(id);
      if (!n) throw new Error(`deep state of node ${id}: the JS graph has no such node`);
      n.margin = new lg.Spacing(d.m[0], d.m[1], d.m[2], d.m[3]);
      n.padding = new lg.Spacing(d.p[0], d.p[1], d.p[2], d.p[3]);
      if (d.loop) n.loopOffsets = new Map(Object.entries(d.loop).map(([o, v]) => [Number(o), v]));
      if (d.n) { // the exact nears (Unmarshal adds each near to both nodes)
        n.nears = new Set(d.n.map((id) => byID.get(String(id))));
      }
      if (d.e) { // the node's own edge order (Unmarshal rebuilds the lists in graph.edges order; early exits depend on the order)
        n.edges = d.e.map((eid) => edgeByID.get(String(eid)));
      }
      if (d.lf) n.label.fixPosition();
      if (d.if) n.icon.fixPosition();
    }
  }
  return g;
}

const ser = (g) => graphjson.serialize(ctx(), g);

/** limits of the Go modes (limitList): used-1, used/2, 1, 0 below used, each once */
function limitList(used) {
  const out = [];
  for (const l of [used - 1, Math.trunc(used / 2), 1, 0]) if (l >= 0 && l < used && !out.includes(l)) out.push(l);
  return out;
}

/** run fn(limit) -> used on a fresh copy of the case's graph; {err, used, graph} like the Go modes */
function runOn(c, fn) {
  let g;
  try { g = loadGraph(c); } catch (e) { if (msg(e) === null) throw e; return { err: msg(e) }; }
  let used = 0, err = null;
  try { used = fn(g); } catch (e) { if (msg(e) === null) throw e; err = msg(e); used = e.used ?? 0; }
  return { err, used, graph: ser(g) };
}

function withLimits(c, run, res) {
  if (c.args?.limits?.length) {
    res.limits = limitList(res.used).map((l) => ({ ...run(l), limit: l }));
  }
  return res;
}

export function packStage(c, want) {
  const rootID = c.args?.root;
  const run = (limit) => runOn(c, (g) => {
    const root = rootID ? graphNodes(g).find((n) => String(n.entityID()) === rootID) ?? null : null;
    return packing.packWithLimit(argsCtx(c), g, root, limit);
  });
  return loose(c, withLimits(c, run, run(limits.MaxBinPackWorkUnits)), want);
}

export function placeStage(c, want) {
  const op = c.args?.op ?? '';
  if (op === 'init') {
    let g;
    try { g = loadGraph(c); } catch (e) { if (msg(e) === null) throw e; return { err: msg(e) }; }
    labeling.initialize(g);
    const fixed = [];
    for (const n of g.nodes) fixed.push(n.label !== null && n.label.positionFixed(), n.icon !== null && n.icon.positionFixed());
    return { graph: ser(g), fixed };
  }
  if (op === 'arrowheads') {
    let g;
    try { g = loadGraph(c); } catch (e) { if (msg(e) === null) throw e; return { err: msg(e) }; }
    const boxes = [];
    for (const e of g.edges) {
      for (const isTarget of [false, true]) {
        const pal = labeling.positionArrowheadLabel(e, isTarget, e.points);
        boxes.push(pal === null ? null : { x: pal.topLeft.x, y: pal.topLeft.y, w: pal.width, h: pal.height, target: pal.isTarget, text: pal.text });
      }
    }
    return { boxes };
  }
  const run = (limit) => runOn(c, (g) => {
    if (op === 'new') {
      const edges = [];
      for (const i of c.args.edges ?? []) if (i >= 0 && i < g.edges.length) edges.push(g.edges[i]);
      return labeling.placeNewEdgesWithLimit(argsCtx(c), g, edges, limit);
    }
    return labeling.placeWithLimit(argsCtx(c), g, limit);
  });
  return loose(c, withLimits(c, run, run(50_000_000)), want);
}

const metricsOut = (m) => ({ nodeOverlaps: m.nodeOverlaps, routeObstructions: m.routeObstructions, textOcclusions: m.textOcclusions, crossings: m.crossings, detour: m.detour, routeLength: m.routeLength });

function evalBoth(c, limit) {
  let g;
  try { g = loadGraph(c); } catch (e) { if (msg(e) === null) throw e; return { err: msg(e) }; }
  const out = {};
  try {
    const [penalty, area, used] = quality.evaluateWithAreaLimit(argsCtx(c), g, limit);
    Object.assign(out, { penalty, area, used, err: null });
  } catch (e) {
    if (msg(e) === null) throw e;
    Object.assign(out, { penalty: 0, area: 0, used: e.used ?? 0, err: msg(e) });
  }
  try {
    const [metrics, mused] = quality.inspectWithLimit(argsCtx(c), g, limit);
    Object.assign(out, { metrics: metricsOut(metrics), mused, merr: null });
  } catch (e) {
    if (msg(e) === null) throw e;
    Object.assign(out, { metrics: metricsOut({ nodeOverlaps: 0, routeObstructions: 0, textOcclusions: 0, crossings: 0, detour: 0, routeLength: 0 }), mused: e.used ?? 0, merr: msg(e) });
  }
  return out;
}

export function qualityStage(c, want) {
  const res = evalBoth(c, 50_000_000);
  loose(c, res, want, 'used');
  loose(c, res, want, 'mused');
  if (c.args?.limits?.length) {
    const used = Math.max(res.used ?? 0, res.mused ?? 0);
    res.limits = limitList(used).map((l) => ({ ...evalBoth(c, l), limit: l }));
  }
  return res;
}

const num = (v) => (v === 'NaN' ? NaN : v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : v);

export function scoreStage(c) {
  return { compare: (c.args.scores ?? []).map((r) => new quality.Score(num(r[0]), num(r[1])).compare(new quality.Score(num(r[2]), num(r[3])))) };
}

const P = (p) => (p === null ? null : { x: p.x, y: p.y });

export function combineStage(c) {
  const a = c.args ?? {};
  let g;
  try { g = loadGraph(c); } catch (e) { if (msg(e) === null) throw e; return { err: msg(e) }; }
  if (!(g.nodes.length > 0 && g.nodes.every((n) => n.topLeft !== null))) return { skipped: true };
  const split = a.split ?? [false, false, false];
  let subgraphs, journal;
  try {
    [subgraphs, journal] = g.splitSubgraphsTracked(ctx(), { includeContainers: split[0], includeNears: split[1], traverseTrees: split[2] }, null);
  } catch (e) { if (msg(e) === null) throw e; return { splitErr: msg(e) }; }
  const offsets = a.offsets ?? [];
  subgraphs.forEach((sg, i) => {
    lg.Nodes.setGraphReference(sg.nodes, sg);
    if (offsets.length > 0) {
      const off = offsets[i % offsets.length];
      for (const n of sg.nodes) n.moveWithChildren(off[0], off[1]);
      for (const e of sg.edges) for (const p of e.points) { p.x += off[0]; p.y += off[1]; }
    }
  });
  const obstacles = (a.obstacles ?? []).map((o) => new geo.Box(geo.newPoint(o[0], o[1]), o[2], o[3]));
  const arg = a.dupe && subgraphs.length > 0 ? [...subgraphs, subgraphs[0]] : subgraphs;
  const out = { err: null, subgraphs: subgraphs.length };
  let combined = null;
  try { combined = packing.combineSubgraphs(ctx(), g, arg, obstacles); } catch (e) { if (msg(e) === null) throw e; out.err = msg(e); }
  if (combined !== null) {
    out.nodes = combined.nodes.map((n) => n.entityID());
    out.edges = combined.edges.map((e) => e.entityID());
    const [tl, br] = combined.boundingBox();
    out.bounds = [P(tl), P(br)];
  }
  journal.restore();
  out.master = ser(g);
  return out;
}

export { bigjson };
