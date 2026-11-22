// The replay half of the routing core check (see routingcheck.mjs): reconstructs a recorded Go RouteGraph call with the JS core and
// returns the facts to compare. No Go needed: the unit test (test/tala-routing.test.js) replays a recorded call from a fixture.
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as context from '../../../public/d2/tala/context.js';
import * as geo from '../../../public/d2/geo.js';
import * as routing from '../../../public/d2/tala/routing/core.js';
import { GoError } from '../../../public/d2/tala/goerrors.js';

routing.setDeterministicHierarchyLevels(true); // see ovg_hierarchy.js: Go's level order is random for equal X; xdump's routing modes order ties by ID too

export const stats = { maxWorkDeviation: 0 };

const idStr = (id) => BigInt(id).toString();
const pt = (p) => [p.x, p.y];

/** the OVG as Go's xDumpOVG prints it (IDs as strings; order independent parts sorted) */
export function dumpOVG(ovg) {
  const nodes = ovg.nodes.slice();
  nodes.sort((a, b) => (a.x !== b.x ? (a.x < b.x ? -1 : 1) : a.y !== b.y ? (a.y < b.y ? -1 : 1) : (a.isNodeCenter ? 0 : 1) - (b.isNodeCenter ? 0 : 1)));
  const out = { nodes: [], ports: [], centers: [], inside: [], edgeCount: ovg.edges.length };
  for (const n of nodes) {
    const xn = { p: pt(n.point), adj: n.edges.map((e) => pt(n.adjacent_(e).point)) };
    const owners = [...n.portOwners()].map(([owner, m]) => [idStr(owner.id), m.directions, m.isCenterPort ? 1 : 0]);
    owners.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0));
    if (owners.length) xn.owners = owners;
    if (n.isNearPort !== null && n.isNearPort.size > 0) xn.near = [...n.isNearPort].map((o) => idStr(o.id)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    xn.container = n.container === null ? null : idStr(n.container.id);
    xn.flags = (n.isNodeCenter ? 1 : 0) | (n.isTunnel ? 2 : 0);
    out.nodes.push(xn);
  }
  const owners = [...ovg.ports.keys()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const o of owners) out.ports.push({ owner: idStr(o.id), points: ovg.ports.get(o).map((p) => pt(p.point)) });
  const cowners = [...ovg.centers.keys()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const o of cowners) out.centers.push({ owner: idStr(o.id), p: pt(ovg.centers.get(o).point) });
  for (const n of ovg.nodesInsideBoundingBox) out.inside.push(idStr(n.id));
  return out;
}

function dumpRoute(ovg, r) {
  return {
    edge: idStr(r.gEdge.id),
    nodes: r.ovgNodes.map((n) => [n.x, n.y, ovg.occupiedPoints.get(n.point) === n ? 1 : 0]),
    fromPort: pt(r.fromPort),
    toPort: pt(r.toPort),
  };
}

/** Go's XSubgraph with the IDs as strings (the fields the JS core recomputes) */
function normGoSub(s) {
  const out = {
    nodes: (s.nodes ?? []).map(idStr),
    nearby: (s.nearby ?? []).map(idStr),
    guard: s.guard,
    ovgErr: s.ovgErr ?? '',
  };
  if (s.ovg) {
    out.ovg = {
      nodes: (s.ovg.nodes ?? []).map((n) => {
        const o = { p: n.p, adj: n.adj ?? [] };
        if (n.owners && n.owners.length) o.owners = n.owners.map((x) => [idStr(x[0]), Number(x[1]), Number(x[2])]);
        if (n.near && n.near.length) o.near = n.near.map(idStr);
        o.container = n.container === null || n.container === undefined ? null : idStr(n.container);
        o.flags = n.flags;
        return o;
      }),
      ports: (s.ovg.ports ?? []).map((p) => ({ owner: idStr(p.owner), points: p.points ?? [] })),
      centers: (s.ovg.centers ?? []).map((c) => ({ owner: idStr(c.owner), p: c.p })),
      inside: (s.ovg.inside ?? []).map(idStr),
      edgeCount: s.ovg.edgeCount,
    };
  }
  if (s.flavors) {
    out.flavors = s.flavors.map((f) => ({
      flavor: f.flavor,
      routes: (f.routes ?? []).map((r) => ({ edge: idStr(r.edge), nodes: r.nodes ?? [], fromPort: r.fromPort, toPort: r.toPort })),
      distance: f.distance,
      err: f.err ?? '',
      used: f.used,
    }));
  }
  return out;
}

const guardState = (guard) => ({ candidates: guard.candidates, nodes: guard.nodes, edges: guard.edges, work: guard.work });

/**
 * Replays one recorded RouteGraph call with the JS core. Returns [got, want] arrays of per-subgraph facts (IDs as strings), or
 * throws on a harness problem.
 */
export function replayCall(call, opts = {}) {
  const ctx0 = context.background();
  const g = new lg.Graph();
  graphjson.unmarshal(ctx0, call.graph, g);
  // the order of node.Edges (adjacency) is live state of Go's graph that graphjson does not carry
  {
    const nodes = new Map();
    const edges = new Map();
    const visit = (n) => {
      if (n === null || nodes.has(idStr(n.id))) return;
      nodes.set(idStr(n.id), n);
      for (const c of g.containers.get(n) ?? []) visit(c);
      const cl = g.clusters.get(n);
      if (cl) for (const c of cl.nodes) visit(c);
      const sq = g.sequences.get(n);
      if (sq) for (const c of sq.nodes) visit(c);
    };
    for (const n of g.nodes) visit(n);
    for (const list of g.containers.values()) for (const c of list) visit(c);
    for (const e of g.edges) { edges.set(idStr(e.id), e); visit(e.from); visit(e.to); }
    for (const row of call.loopOffsets ?? []) {
      const n = nodes.get(idStr(row[0]));
      if (n === undefined) continue;
      n.loopOffsets = new Map();
      for (let o = 0; o <= 8; o++) if (row[1 + o] !== 0) n.loopOffsets.set(o, row[1 + o]);
    }
    for (const row of call.nodeEdges ?? []) {
      const n = nodes.get(idStr(row[0]));
      if (n === undefined) continue;
      const list = row.slice(1).map((id) => edges.get(idStr(id)));
      if (list.length === n.edges.length && list.every((e) => e !== undefined)) n.edges = list;
    }
  }
  const aggregate = routing.newRouteWorkGuard(ctx0, 'EdgeRouting', routing.maxEdgeRoutingStageWorkUnits);
  const routingCtx = routing.contextWithRouteAggregateWork(ctx0, aggregate);
  const ovgGuard = routing.newOVGBuildGuard(routingCtx, routing.defaultOVGBuildLimits());
  const [subgraphs, journal] = g.splitSubgraphsTracked(ctx0, { includeContainers: true, includeNears: true }, null);
  const got = [];
  const want = [];
  try {
    const allNodes = new Map();
    for (const sg of subgraphs) for (const n of sg.nodes) allNodes.set(idStr(n.id), n);
    let k = 0;
    for (const sub of subgraphs) {
      if (sub.edges.length === 0) continue;
      const rec = (call.subgraphs ?? [])[k++];
      if (rec === undefined) throw new Error('Go recorded fewer subgraphs than JS splits');
      const w = normGoSub(rec);
      want.push(w);
      const gt = { nodes: sub.nodes.map((n) => idStr(n.id)), nearby: w.nearby, ovgErr: '' };
      got.push(gt);
      sub.computeCellSize();
      const byId = new Map(sub.edges.map((e) => [idStr(e.id), e]));
      const nearby = w.nearby.map((id) => {
        const n = allNodes.get(id);
        if (n === undefined) throw new Error(`nearby node ${id} not found`);
        return n;
      });
      let ovg;
      try {
        ovg = routing.buildOVGFromGraphWithGuard(sub, nearby, ovgGuard);
      } catch (e) {
        if (!(e instanceof GoError)) throw e;
        gt.ovgErr = e.message;
        gt.guard = guardState(ovgGuard);
        continue;
      }
      gt.guard = guardState(ovgGuard);
      gt.ovg = dumpOVG(ovg);
      if (!opts.ovgOnly) {
        // the routes that existed before the flavors (tree routes, loops: built by the stage half of the package in Go)
        const existingRoutes = (rec.existing ?? []).map((r) => new routing.Route({
          gEdge: byId.get(idStr(r.edge)),
          ovgNodes: r.nodes.map(([x, y, inOvg]) => (inOvg ? ovg.occupiedPoints.get(new geo.Point(x, y)) : new routing.OVGNode(new geo.Point(x, y)))),
          fromPort: new geo.Point(r.fromPort[0], r.fromPort[1]),
          toPort: new geo.Point(r.toPort[0], r.toPort[1]),
        }));
        const unrouted = (rec.unrouted ?? []).map((id) => byId.get(idStr(id)));
        sub.crossingCostValue(); sub.turnCostValue(); sub.nonCenterPortCostValue();
        let flavors = [routing.ShortestToLongest, routing.LongestToShortest, routing.Default];
        if (sub.nodes[0].hierarchy !== null) flavors = [routing.TopDownLeftRight];
        const routers = [];
        let createErr = null;
        for (const flavor of flavors) {
          try {
            routers.push(routing.newOVGEdgeRouterWithWorkLimit(routingCtx, flavor, ovg, sub, existingRoutes, unrouted, routing.maxRouteSearchWorkUnits));
          } catch (e) {
            if (!(e instanceof GoError)) throw e;
            createErr = e;
            break;
          }
        }
        for (const router of routers) router.considerNodeLabels = !!call.considerNodeLabels;
        if (createErr === null) {
          const [workerCtx, cancel] = context.withCancel(routingCtx);
          gt.flavors = routers.map((router) => {
            const resp = router.generateRoutes(workerCtx, true);
            return {
              flavor: resp.flavor,
              routes: (resp.routes ?? []).map((r) => dumpRoute(ovg, r)),
              distance: resp.distance,
              err: resp.err ? resp.err.message : '',
              used: resp.work ? resp.work.used : (router.work ? router.work.used : 0),
            };
          });
          cancel();
        } else {
          gt.createErr = createErr.message;
        }
      }
    }
    if (k !== (call.subgraphs ?? []).length) throw new Error(`Go recorded ${call.subgraphs.length} subgraphs, JS split gives ${k}`);
  } finally {
    journal.restore();
  }
  // compare only what each side computed
  if (opts.ovgOnly) for (const w of want) delete w.flavors;
  for (const [i, w] of want.entries()) if (!got[i].flavors) delete w.flavors;
  return [got, want];
}

export function firstDiff(a, b, p = '$') {
  if (bigjson.stringify(a, true) === bigjson.stringify(b, true)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 160), want: JSON.stringify(b)?.slice(0, 160) };
}

/** compares one record of Go with the replay; returns null or a description */
export function checkCall(call, opts) {
  let got, want;
  try {
    [got, want] = replayCall(call, opts);
  } catch (e) {
    return { path: 'replay', got: String(e.stack || e).split('\n').slice(0, 4).join(' | '), want: '' };
  }
  // The work counter of the OVG build guard is not deterministic in Go itself (the order of Go's map iteration changes how early
  // hasUnobstructedLineToPorts finds its ports: 3 runs of the same input gave 92374, 92080 and 92012): compare it by deviation only.
  for (const [i, w] of want.entries()) {
    if (w.guard && got[i].guard) {
      const dev = Math.abs(got[i].guard.work - w.guard.work) / Math.max(1, w.guard.work);
      stats.maxWorkDeviation = Math.max(stats.maxWorkDeviation, dev);
      delete w.guard.work;
      delete got[i].guard.work;
    }
  }
  return firstDiff(bigjson.plain(got), bigjson.plain(want));
}

