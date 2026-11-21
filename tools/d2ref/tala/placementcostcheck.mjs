// JS side of the placementcost checks (diff.mjs stages talapcscore and talapcunit; the Go modes pcscore and pcunit are in
// tools/d2ref/tala/xdump/placementcost_xdump.go and must be kept in step with this file).
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as pc from '../../../public/d2/tala/placementcost.js';
import * as context from '../../../public/d2/tala/context.js';
import { errorf } from '../../../public/d2/tala/goerrors.js';
import { ctx } from '../talacheck.mjs';
import { loadCase } from './hierarchycheck.mjs';

const { goHypot, directionCompass, compassDelta, compassAxisDelta, sizelessOrientation, placementDistance, distanceBetweenTableColumns,
  clusterExactlyTwoExternalConnectedNodes, isMirrored, flowContinuityCost, prepareNodeEdgeLength, newEdgeScratch } = pc._internals;

// non-finite floats are strings in the Go output (xdump's sanitize)
// and a float64 that Go prints as an integer literal (2^53 <= |x| < 1e21) is a BigInt for bigjson, which reads every integer literal exactly
const F = (x) => {
  if (typeof x !== 'number') return x;
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? '+Inf' : '-Inf';
  if (Number.isInteger(x) && Math.abs(x) >= 2 ** 53 && Math.abs(x) < 1e21) return BigInt(String(x));
  return x;
};

/** pcTry: the value, {err} for a Go error, "panic" for anything else that throws */
function pcTry(f) {
  try {
    return F(f());
  } catch (e) {
    if (e.name === 'GoError') return { err: e.message };
    return 'panic';
  }
}

const pcOpts = (i, abductions) => ({
  edgeAbductions: abductions,
  includeNodeSizes: (i & 4) !== 0,
  enforceMinimumGap: (i & 2) !== 0,
  penalizeDirection: (i & 1) !== 0,
});
const pcKey = (i) => `s${(i >> 2) & 1}e${(i >> 1) & 1}p${i & 1}`;
const nid = (n) => (n === null ? 0n : n.id);
const containersOf = (g, node) => g.containers.get(node) ?? [];

function pcBattery(c, g, nodes, abductions) {
  const out = {};
  const limit = nodes.length > 24 ? nodes.slice(0, 24) : nodes;
  const nel = [], sym = [], ccc = [], flow = [];
  for (const n of limit) {
    const row = [];
    for (let i = 0; i < 8; i++) row.push(pcTry(() => pc.nodeEdgeLength(c, n, pcOpts(i, abductions))));
    nel.push(row);
    sym.push(pcTry(() => pc.nodeSymmetry(c, n, abductions)));
    ccc.push(pcTry(() => pc.columnCrossingCost(c, n, abductions)));
    flow.push(pcTry(() => flowContinuityCostOf(c, n, pcOpts(4, abductions))));
  }
  out.nodeEdgeLength = nel;
  out.symmetry = sym;
  out.columnCrossing = ccc;
  out.flow = flow;
  out.nodesSymmetry = pcTry(() => pc.nodesSymmetry(c, limit, abductions));
  out.nodesEdgeLength = pcTry(() => pc.nodesEdgeLength(c, limit, pcOpts(5, abductions)));
  return out;
}

/** XFlowContinuity: the preparation (for the incident-edge replacements), then flowContinuityCost */
function flowContinuityCostOf(c, node, options) {
  const s = newEdgeScratch();
  prepareNodeEdgeLength(c, node, options, s);
  return flowContinuityCost(node, s);
}

const positioned = (nodes) => nodes.every((n) => n.topLeft !== null);

export function pcscoreStage(c0) {
  const g = loadCase(c0);
  const c = ctx();
  const out = {};
  const isPositioned = positioned(g.nodes);
  out.positioned = isPositioned;

  const states = {};
  for (let i = 0; i < 8; i++) states[pcKey(i)] = String(pc.placementEdgeLengthState(g, g.routingCosts(), pcOpts(i, null)));
  out.state = states;
  if (!isPositioned) return out;

  const el = {};
  for (let i = 0; i < 8; i++) {
    const first = pcTry(() => pc.edgeLength(c, g, pcOpts(i, null)));
    const entries = g.edgeLengthCacheEntries();
    const second = pcTry(() => pc.edgeLength(c, g, pcOpts(i, null)));
    el[pcKey(i)] = [first, entries, second, g.edgeLengthCacheEntries(), String(pc.placementEdgeLengthState(g, g.routingCosts(), pcOpts(i, null)))];
  }
  out.edgeLength = el;

  out.crossings = pcTry(() => pc.graphEdgeCrossings(c, g));
  out.containerAlignment = pcTry(() => pc.containerAlignmentCost(c, g));
  Object.assign(out, pcBattery(c, g, g.nodes, null));

  const axis = [];
  for (let size = 2; size <= 5; size++) {
    for (let start = 0; start + size <= g.nodes.length && start < 12; start++) axis.push(F(pc.axisScore(g.nodes.slice(start, start + size))));
  }
  out.axis = axis;

  const pairs = [];
  const lim = g.nodes.length > 8 ? g.nodes.slice(0, 8) : g.nodes;
  for (const a of lim) {
    for (const b of lim) {
      if (a === b) continue;
      pairs.push({
        mirror: [isMirrored(a, b, true, a.topLeft.x + a.width / 2), isMirrored(a, b, false, a.topLeft.y + a.height / 2)],
        sizeless: sizelessOrientation(a, b),
        distance: [F(placementDistance(a, b, true)), F(placementDistance(a, b, false))],
      });
    }
  }
  out.pairs = pairs;

  const tables = [];
  for (const e of g.edges) {
    if (tables.length >= 12) break;
    if (e.hasTableColumn()) tables.push(pcTry(() => distanceBetweenTableColumns(g, e, e.from, e.to)));
  }
  out.tableDistance = tables;

  const clusters = [];
  for (const v of g.clusterOrder()) {
    const cl = g.clusters.get(v);
    if (cl && cl.nodes.length > 0 && cl.nodes[0].graph !== null) {
      const [f, s, ok] = clusterExactlyTwoExternalConnectedNodes(cl);
      clusters.push([v.id, nid(f), nid(s), ok]);
    }
  }
  out.clusters = clusters;

  const abducted = [];
  const roots = [null];
  for (const n of g.nodes) if (n.isContainer() && roots.length < 4) roots.push(n);
  for (const root of roots) {
    const rec = { root: nid(root) };
    let abductions = null;
    try {
      const children = containersOf(g, root);
      if (children.length > 0) {
        const to = lg.newGraph();
        to.copyEntitiesFrom(g);
        for (const child of children) to.addNodeUnchecked(child);
        abductions = g.abductEdges(root, to);
        to.computeCellSize();
        rec.abductions = abductions.length;
        const els = {};
        for (let i = 0; i < 8; i++) els[pcKey(i)] = pcTry(() => pc.edgeLength(c, to, pcOpts(i, abductions)));
        rec.edgeLength = els;
        rec.state = String(pc.placementEdgeLengthState(to, to.routingCosts(), pcOpts(7, abductions)));
        Object.assign(rec, pcBattery(c, to, to.nodes, abductions));
      }
    } catch (e) {
      if (e.name === 'GoError') throw e;
      rec.panic = true;
    } finally {
      if (abductions !== null) g.restoreEdgeAbductions(abductions);
      lg.Nodes.setGraphReference(g.nodes, g);
    }
    abducted.push(rec);
  }
  out.abducted = abducted;

  const scorers = [];
  for (const n of g.nodes) {
    if (scorers.length >= 3) break;
    if (n.edges.length === 0 || n.topLeft === null) continue;
    const rec = { id: n.id };
    for (const oi of [5, 7]) {
      const sc = pc.newNodeEdgeLengthScorer(n, pcOpts(oi, null));
      const vals = [];
      vals.push(pcTry(() => sc.score(c)));
      n.translate(25, -10);
      vals.push(pcTry(() => sc.score(c)));
      n.translate(-25, 10);
      vals.push(pcTry(() => sc.score(c)));
      sc.close();
      vals.push(pcTry(() => sc.score(c)));
      rec[String(oi)] = vals;
    }
    scorers.push(rec);
  }
  out.scorers = scorers;

  // context polls
  const cands = [];
  for (const n of g.nodes) if (n.edges.length > 0 && cands.length < 3) cands.push(n);
  const fns = [];
  for (const n of cands) {
    fns.push(
      [`nel5/${n.id}`, (cc) => pc.nodeEdgeLength(cc, n, pcOpts(5, null))],
      [`nel7/${n.id}`, (cc) => pc.nodeEdgeLength(cc, n, pcOpts(7, null))],
      [`sym/${n.id}`, (cc) => pc.nodeSymmetry(cc, n, null)],
      [`ccc/${n.id}`, (cc) => pc.columnCrossingCost(cc, n, null)],
      [`scorer/${n.id}`, (cc) => {
        const sc = pc.newNodeEdgeLengthScorer(n, pcOpts(5, null));
        try {
          sc.score(cc);
          sc.score(cc);
        } finally {
          sc.close();
        }
      }],
    );
  }
  fns.push(
    ['edgeLength', (cc) => { g.resetPlacementCosts(); pc.edgeLength(cc, g, pcOpts(5, null)); }],
    ['crossings', (cc) => { pc.graphEdgeCrossings(cc, g); }],
    ['alignment', (cc) => { pc.containerAlignmentCost(cc, g); }],
  );
  const run = (fn, failAt) => {
    const state = { n: 0 };
    const cc = { err() { state.n++; if (failAt > 0 && state.n >= failAt) return context.Canceled; return null; } };
    let err = null;
    try {
      fn(cc);
    } catch (e) {
      err = e.name === 'GoError' ? e.message : 'panic';
    }
    return [state.n, err];
  };
  const polls = [];
  for (const [name, fn] of fns) {
    const [n, err] = run(fn, 0);
    const rec = [name, n, err];
    if (n > 1) {
      const [m, err2] = run(fn, Math.trunc(n / 2) + 1);
      rec.push(m, err2);
    }
    polls.push(rec);
  }
  out.polls = polls;
  return out;
}

export function pcunitStage(c) {
  const out = {};
  out.hypot = c.args.pairs.map(([x, y]) => F(goHypot(Number(x), Number(y))));
  const workers = [];
  for (let n = 0; n <= 40; n++) {
    const row = [];
    for (let p = 0; p <= 8; p++) row.push(pc.edgeLengthWorkerCount(n, p));
    workers.push(row);
  }
  out.workers = workers;
  const compass = [];
  for (let a = 0; a <= 8; a++) {
    for (let b = 0; b <= 8; b++) {
      const first = directionCompass(a);
      const second = directionCompass(b);
      compass.push([first, compassDelta(first, second), compassAxisDelta(first, second)]);
    }
  }
  out.compass = compass;
  return out;
}

void errorf;
