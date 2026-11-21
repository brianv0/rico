// Checks the CORE of the TALA routing port (public/d2/tala/routing/*.js) against the Go package at the level of the router calls.
//
// Go side: tala/xdump.bin modes `routing` (D2 text, layout tala) and `frouting` (graphjson fixture through the engine pipeline). Both
// record every call of routing.RouteGraph (the EdgeRouting stages 21 and 24, and the compound candidate) with the hooks of
// routing_xdump.go: the whole graph before routing, then per routed subgraph the node IDs, the nearby obstacle nodes, the OVG that was
// built, the routes that existed before the flavors ran, the edges to route and the response of every flavor.
//
// JS side (this file): reconstructs the graph from its graphjson, splits it into the same subgraphs, builds the OVG with the JS core,
// recreates the existing routes and the routers and runs every flavor (generateRoutes), then compares OVG (nodes, adjacency in edge order,
// port owners and directions, near-port flags, containers, ports, centers), the work counters of the OVG build guard, and for every
// flavor the routes (OVG node coordinates), the distance, the error text and the work units used.
//
//   node tala/routingcheck.mjs routing  tala-corpus.jsonl [--chunk 10] [--from N] [--to N] [--seeds 1,2,3] [--show 3] [--only N]
//   node tala/routingcheck.mjs frouting tala-fixtures.jsonl [--only N]
//   node tala/routingcheck.mjs ovggolden                         (the 11 OVG goldens of internal/testdata/ovg, from Go's stage graphs)
//
// Needs tala/xdump.bin (env TALA_REF, default /tmp/tala-ref; tala/setup.sh builds it) and the corpus files (tala/corpus.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as context from '../../../public/d2/tala/context.js';
import * as geo from '../../../public/d2/geo.js';
import * as routing from '../../../public/d2/tala/routing/core.js';
import { GoError } from '../../../public/d2/tala/goerrors.js';

routing.setDeterministicHierarchyLevels(true); // see ovg_hierarchy.js: Go's level order is random for equal X; xdump's routing modes order ties by ID too
const here = path.dirname(fileURLToPath(import.meta.url));

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

function firstDiff(a, b, p = '$') {
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

function runGo(mode, cases, seeds) {
  const input = cases.map((c) => bigjson.stringify(seeds ? { ...c, seeds } : c)).join('\n');
  const r = spawnSync((process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin', [mode], { input, maxBuffer: 2 ** 31 - 1, stdio: ['pipe', 'pipe', 'ignore'] });
  if (r.status !== 0 && !r.stdout.length) return null;
  return r.stdout.toString().trim().split('\n');
}

const stats = { maxWorkDeviation: 0, calls: 0, subgraphs: 0, edges: 0, flavors: 0, routes: 0, same: 0, bad: [], goPanic: 0, goErr: 0, cases: 0 };

function visitCase(name, rec, callsOf, opts) {
  if (rec.panic) { stats.goPanic++; return; }
  if (rec.err && !callsOf(rec).length) { stats.goErr++; }
  for (const [label, call] of callsOf(rec)) {
    stats.calls++;
    for (const s of call.subgraphs ?? []) {
      stats.subgraphs++;
      stats.edges += s.unrouted?.length ?? 0;
      for (const f of s.flavors ?? []) { stats.flavors++; stats.routes += f.routes?.length ?? 0; }
    }
    const d = checkCall(call, opts);
    if (d) stats.bad.push({ name, label, ...d });
    else stats.same++;
  }
}

const argv = process.argv.slice(2);
const [mode, file] = argv;
const flags = argv.slice(2);
const flag = (n, d) => { const i = flags.indexOf(n); return i < 0 ? d : flags[i + 1] ?? true; };

if (import.meta.url === `file://${process.argv[1]}`) {
  if (mode === 'ovggolden') {
    await ovgGolden();
  } else if (mode === 'routing' || mode === 'frouting') {
    let cases = fs.readFileSync(path.resolve(file), 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
    if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];
    const from = Number(flag('--from', 0)), to = Number(flag('--to', cases.length));
    const chunk = Number(flag('--chunk', mode === 'routing' ? 8 : 4));
    const seeds = flag('--seeds') ? String(flag('--seeds')).split(',').map(Number) : (mode === 'routing' ? [1] : undefined);
    const opts = { ovgOnly: flags.includes('--ovg-only') };
    const t0 = performance.now();
    for (let i = from; i < Math.min(to, cases.length); i += chunk) {
      const batch = cases.slice(i, Math.min(i + chunk, to, cases.length));
      let lines = runGo(mode, batch, seeds);
      if (lines === null) { for (const c of batch) stats.bad.push({ name: c.name ?? '?', path: 'go', got: 'Go crashed', want: '' }); continue; }
      for (const [j, line] of lines.entries()) {
        const rec = bigjson.parse(line);
        const c = batch[j];
        const name = c.name ?? `case ${i + j}`;
        stats.cases++;
        if (mode === 'frouting') visitCase(name, rec, (r) => (r.calls ?? []).map((x) => [`stage ${x.stage}`, x.call]), opts);
        else {
          visitCase(name, rec, (r) => {
            const calls = [];
            for (const [ii, inv] of (r.invocations ?? []).entries()) {
              for (const s of inv.seeds ?? []) for (const x of s.calls ?? []) calls.push([`inv ${ii} seed ${s.seed} stage ${x.stage}`, x.call]);
              for (const x of inv.compound ?? []) calls.push([`inv ${ii} compound`, x.call]);
            }
            return calls;
          }, opts);
        }
      }
      process.stderr.write(`\r${Math.min(i + chunk, cases.length)}/${cases.length} cases, ${stats.same}/${stats.calls} calls identical, ${stats.bad.length} different   `);
    }
    console.log(`\n${mode} ${file}: ${stats.cases} cases, ${stats.calls} RouteGraph calls, ${stats.subgraphs} subgraphs, ${stats.edges} edges routed, ${stats.flavors} flavor runs (${stats.routes} routes); identical ${stats.same}/${stats.calls}; Go panics ${stats.goPanic}; Go errors without calls ${stats.goErr}; max deviation of the (Go-nondeterministic) OVG work counter ${(stats.maxWorkDeviation * 100).toFixed(2)}%; ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    for (const b of stats.bad.slice(0, Number(flag('--show', 5)))) console.log(JSON.stringify(b));
    process.exit(stats.bad.length ? 1 : 0);
  } else {
    console.error('usage: routingcheck.mjs <routing|frouting|ovggolden> cases.jsonl [--chunk N] [--only N] [--seeds 1,2] [--ovg-only] [--show N]');
    process.exit(2);
  }
}

// The golden OVGs of internal/testdata/ovg (ovg_<k>.exp.json: Go's own snapshots of the OVGs of a layout of graph.input.json with seed 123):
// the JS core builds the OVGs of the graph Go's pipeline hands to EdgeRouting and must print the same nodes and edges.
async function ovgGolden() {
  const td = (process.env.D2_SRC || process.env.TALA_REF || '/tmp/tala-ref') + '/d2layouts/d2talalayout/internal/testdata/ovg';
  const fixtures = fs.readFileSync(path.join(here, '..', 'tala-fixtures.jsonl'), 'utf8').trim().split('\n').map((l) => bigjson.parse(l)).filter((c) => c.name.startsWith('ovg/'));
  const lines = runGo('frouting', fixtures);
  let ok = 0, total = 0;
  for (const [i, c] of fixtures.entries()) {
    const rec = bigjson.parse(lines[i]);
    const dir = path.join(td, c.name.slice(4));
    const goldens = fs.readdirSync(dir).filter((f) => /^ovg_\d+\.exp\.json$/.test(f)).sort();
    const first = (rec.calls ?? []).filter((x) => x.stage === 21 || x.stage === 24).pop(); // the goldens are the snapshots of the last EdgeRouting run
    if (!first) { console.log(c.name, 'no EdgeRouting call'); continue; }
    const [got] = replayCall(first.call, { ovgOnly: true });
    for (const [k, f] of goldens.entries()) {
      total++;
      const exp = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const ovg = got[k]?.ovg;
      let same = false;
      if (ovg) {
        // the golden lists nodes sorted by (x, y) and the edges as (from, to) coordinate pairs sorted by node order
        const nodes = ovg.nodes.map((n) => ({ x: n.p[0], y: n.p[1] }));
        const edges = [];
        for (const n of ovg.nodes) for (const a of n.adj) edges.push([n.p, a]);
        const key = (e) => `${e[0][0]},${e[0][1]}>${e[1][0]},${e[1][1]}`;
        const wantEdges = new Set(exp.edges.map((e) => `${e.from.x},${e.from.y}>${e.to.x},${e.to.y}`));
        const wantEdgesRev = new Set(exp.edges.map((e) => `${e.to.x},${e.to.y}>${e.from.x},${e.from.y}`));
        const gotSet = new Set(edges.map(key));
        const wantNodes = new Set(exp.nodes.map((n) => `${n.x},${n.y}`));
        same = nodes.length === exp.nodes.length && nodes.every((n) => wantNodes.has(`${n.x},${n.y}`)) &&
          exp.edges.length * 2 === edges.length &&
          [...wantEdges].every((e) => gotSet.has(e)) && [...wantEdgesRev].every((e) => gotSet.has(e));
      }
      if (same) ok++;
      console.log(c.name, f, same ? 'identical' : 'DIFFERENT');
    }
  }
  console.log(`ovg goldens: ${ok}/${total} identical`);
  process.exit(ok === total ? 0 : 1);
}
