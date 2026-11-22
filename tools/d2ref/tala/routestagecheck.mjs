// Checks the STAGE half of the TALA routing port (public/d2/tala/routing/: graph_stage, coordinator, postprocess, swap_ports, edge_simplify,
// nudge_channels, shortcut_routes, standalone_router, trace_stage ...) against Go, stage by stage, in isolation.
//
// Go side: tala/xdump.bin `routecases` (xdump/routestage_xdump.go): for every pipeline stage in 21 (EdgeRouting), 22 (Crosshatch), 24
// (EdgeRouting again), 25 (SimplifyEdgeRoutes), 26 (SwapEdgePorts), 27 (StraightEdgesFallback), 28 (BalanceEdgeSegments), 29
// (FixClusterEdgeBranching), 30 (TraceEdgesToShapeBorder), 31 (ReorderDuplicates), 34 (NudgeEdgeChannels), 35 (ShortcutEdgeRoutes) a case
// holding Go's graph after stage k-1 (graphjson + the deep state graphjson does not carry + the pipeline flags) and Go's graph and deep
// state after stage k. JS side (this file): rebuilds the graph, runs the JS stage, and compares graph and deep state.
//
//   node tala/routestagecheck.mjs check tala-corpus.jsonl [--seeds 1,2,3] [--from N] [--to N] [--kind route,swap] [--show 3] [--save f.jsonl]
//   node tala/routestagecheck.mjs check tala-fixtures.jsonl           (graphjson fixtures; seed 123)
//   node tala/routestagecheck.mjs replay saved.jsonl [--kind ..]      (a file written with --save: no Go needed)
//   node tala/routestagecheck.mjs limits saved.jsonl [--every 5]      (the work-limit boundary of every stage against Go)
//
// Needs tala/xdump.bin (env TALA_REF; tala/setup.sh builds it) and the corpus files (tala/corpus.mjs).
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as context from '../../../public/d2/tala/context.js';
import * as routing from '../../../public/d2/tala/routing/index.js';
import { graphNodes, loadGraph } from './pkgcheck.mjs';

routing.setDeterministicHierarchyLevels(true); // Go's level order is random for equal X; the Go harness orders ties by ID too

const ctx = () => context.background();
const argv = process.argv.slice(2);
const [mode, file] = argv;
const flags = argv.slice(2);
const flag = (n, d) => { const i = flags.indexOf(n); return i < 0 ? d : flags[i + 1] ?? true; };

/** the stage functions by case kind (the engine's own calls) */
export const STAGES = {
  route: (g, a) => routing.routeGraph(ctx(), g, { forceReroute: a.force, routesPreviouslyCompleted: a.complete }),
  route2: (g, a) => routing.routeGraph(ctx(), g, { forceReroute: a.force, routesPreviouslyCompleted: a.complete }),
  crosshatch: (g) => routing.crosshatch(ctx(), g),
  simplify: (g) => routing.simplifyEdgeRoutes(ctx(), g),
  swap: (g) => routing.swapAllEdgePorts(ctx(), g),
  straight: (g) => routing.straightEdgesFallback(ctx(), g),
  balance: (g) => routing.balanceEdgeSegments(ctx(), g),
  fixcluster: (g) => routing.fixClusterEdgeBranching(ctx(), g),
  trace: (g) => routing.traceEdgesToShapeBorder(ctx(), g),
  reorder: (g) => routing.reorderDuplicates(ctx(), g),
  nudge: (g) => routing.nudgeEdgeChannels(ctx(), g),
  shortcut: (g) => routing.shortcutEdgeRoutes(ctx(), g),
  routeedges: (g, a) => {
    const byID = new Map(g.edges.map((e) => [String(e.id), e]));
    routing.routeEdges(ctx(), g, a.edges.map((id) => byID.get(String(id))));
  },
};

/** the stage with an explicit work limit and context (the optional stages raw: no swallowing of the work-limit error) */
const LIMITED = {
  route: (g, a, l, c) => routing.routeGraphWithWorkLimit(c, g, { forceReroute: a.force, routesPreviouslyCompleted: a.complete }, l),
  crosshatch: (g, a, l, c) => routing.crosshatchWithWorkLimit(c, g, l),
  simplify: (g, a, l, c) => routing.simplifyEdgeRoutesWithLimit(c, g, l),
  swap: (g, a, l, c) => routing.swapAllEdgePortsWithWorkLimit(c, g, l),
  balance: (g, a, l, c) => routing.balanceEdgeSegmentsWithLimit(c, g, l),
  fixcluster: (g, a, l, c) => routing.fixClusterEdgeBranchingWithLimit(c, g, l),
  trace: (g, a, l, c) => routing.traceEdgesToShapeBorderWithWorkLimit(c, g, l),
  nudge: (g, a, l, c) => routing.nudgeChannelsWithLimit(c, g, l),
  shortcut: (g, a, l, c) => routing.shortcutRoutesWithLimit(c, g, l),
};
LIMITED.route2 = LIMITED.route;

const canceledCtx = () => { const [x, cancel] = context.withCancel(ctx()); cancel(); return x; };
const msg = (e) => (e && e.name === 'GoError' ? e.message : null);

/** the twin of deepState in xdump/pkg_xdump.go */
export function deepState(g) {
  const out = {};
  for (const n of graphNodes(g)) {
    const d = { m: [n.margin.top, n.margin.bottom, n.margin.left, n.margin.right], p: [n.padding.top, n.padding.bottom, n.padding.left, n.padding.right] };
    if (n.loopOffsets && n.loopOffsets.size > 0) d.loop = Object.fromEntries([...n.loopOffsets].map(([o, v]) => [String(o), v]));
    d.n = [...n.nears].map((x) => BigInt(x.id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    d.e = n.edges.map((e) => BigInt(e.id));
    if (n.label !== null && n.label.positionFixed()) d.lf = true;
    if (n.icon !== null && n.icon.positionFixed()) d.if = true;
    out[String(n.id)] = d;
  }
  return out;
}

const nonFinite = (v) => (typeof v === 'number' ? (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : v) : v);
/** the serialized graph with non-finite numbers as strings (the Go dump's convention) */
function normalize(v) {
  if (typeof v === 'number') return nonFinite(v);
  if (typeof v === 'bigint') return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

/** the first difference between two JSON values, as a path, or null */
export function firstDiff(a, b, path = '') {
  if (typeof a === 'bigint' || typeof b === 'bigint') return BigInt(a) === BigInt(b) ? null : `${path}: ${a} != ${b}`;
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${path}: ${JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? String(v) : v))} != ${JSON.stringify(b, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
  return null;
}

/** runs one case (as written by `routecases`) with the JS stage: null when identical to Go, else a description */
export function checkCase(c) {
  let g;
  try { g = loadGraph(c); } catch (e) { if (msg(e) === null) throw e; return `load: ${msg(e)}`; }
  let err = null;
  const changedGo = firstDiff(normalize(c.graph), c.args.expect.graph) !== null;
  stats.byKind[c.kind].changed = (stats.byKind[c.kind].changed ?? 0) + (changedGo ? 1 : 0);
  try { if (!process.env.ROUTECHECK_NOOP) STAGES[c.kind](g, c.args); } catch (e) { if (msg(e) === null) { e.message = `${c.name}: ${e.message}`; throw e; } err = msg(e); }
  const want = c.args.expect;
  if (err !== (want.err ?? null)) return `error: JS ${err} / Go ${want.err}`;
  if (err !== null) return null;
  const gotGraph = normalize(graphjson.serialize(ctx(), g));
  let d = firstDiff(gotGraph, want.graph, 'graph');
  if (d) return d;
  d = firstDiff(normalize(deepState(g)), want.deep, 'deep');
  return d;
}

const stats = { cases: 0, same: 0, bad: [], byKind: {}, goErr: 0, goPanic: 0, inputs: 0 };

function visit(c) {
  const kinds = flag('--kind', '');
  if (kinds && !kinds.split(',').includes(c.kind)) return;
  stats.cases++;
  const k = (stats.byKind[c.kind] ??= { n: 0, same: 0 });
  k.n++;
  let d;
  try { d = checkCase(c); } catch (e) { d = `JS exception: ${e.stack ?? e}`; }
  if (d) stats.bad.push({ name: c.name, kind: c.kind, diff: d });
  else { stats.same++; k.same++; }
}

function report() {
  console.log(`inputs ${stats.inputs}, stage cases ${stats.cases}: identical ${stats.same}, different ${stats.bad.length} (Go panics ${stats.goPanic}, Go errors ${stats.goErr})`);
  for (const [kind, v] of Object.entries(stats.byKind)) console.log(`  ${kind}: ${v.same}/${v.n} (stage changed the graph in ${v.changed ?? 0})`);
  const show = Number(flag('--show', 5));
  for (const b of stats.bad.slice(0, show)) console.log('DIFF', b.name, b.kind, b.diff.slice(0, 600));
  process.exitCode = stats.bad.length ? 1 : 0;
}

async function check() {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  let cases = lines.map((l) => bigjson.parse(l));
  const from = Number(flag('--from', 0)), to = Number(flag('--to', cases.length));
  const seeds = flag('--seeds', '');
  cases = cases.map((c, i) => ({ ...c, i })).filter((c) => c.i >= from && c.i < to);
  const only = flag('--only', '');
  if (only) cases = cases.filter((c) => String(c.i) === only);
  const saveTo = flag('--save', '');
  const save = saveTo ? fs.createWriteStream(saveTo) : null;
  const chunk = Number(flag('--chunk', 20));
  const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
  for (let i = 0; i < cases.length; i += chunk) {
    const part = cases.slice(i, i + chunk);
    const input = part.map((c) => bigjson.stringify({ ...c, ...(seeds ? { seeds: seeds.split(',').map(Number) } : {}) })).join('\n') + '\n';
    const child = spawn(bin, ['routecases'], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.end(input);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let k = 0;
    for await (const line of rl) {
      const rec = bigjson.parse(line);
      stats.inputs++;
      k++;
      if (rec.panic) { stats.goPanic++; continue; }
      if (rec.err) stats.goErr++;
      for (const c of rec.cases ?? []) {
        if (save) save.write(bigjson.stringify(c) + '\n');
        visit(c);
      }
    }
    await new Promise((r) => child.on('close', r));
    if (k !== part.length) console.error(`xdump returned ${k} of ${part.length} records (chunk at ${i})`);
  }
  if (save) save.end();
  report();
}

function replay() {
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) { stats.inputs++; visit(bigjson.parse(line)); }
  report();
}

/** the smallest limit with which `run(limit)` succeeds (null when it never does below max), by bisection */
function minLimit(run, max) {
  if (run(max) !== null) return null;
  let lo = 0, hi = max; // run(hi) ok
  if (run(0) === null) return 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (run(mid) === null) hi = mid; else lo = mid;
  }
  return hi;
}

function limits() {
  const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
  const every = Number(flag('--every', 5));
  const kinds = flag('--kind', '');
  const res = { n: 0, same: 0, loose: 0, bad: [] };
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.forEach((line, idx) => {
    if (idx % every !== 0) return;
    const c = bigjson.parse(line);
    if (!LIMITED[c.kind] || (kinds && !kinds.split(',').includes(c.kind))) return;
    const run = (limit, canceled = false) => {
      const g = loadGraph(c);
      try { LIMITED[c.kind](g, c.args, limit, canceled ? canceledCtx() : ctx()); return null; } catch (e) {
        const m = msg(e);
        if (m === null) throw e;
        // the atomic stage restores the graph on every error
        const d = firstDiff(normalize(graphjson.serialize(ctx(), g)), normalize(c.graph), 'graph') ?? firstDiff(normalize(deepState(g)), normalize(c.args.deep), 'deep');
        if (d) res.bad.push({ name: c.name, diff: `not rolled back after "${m}": ${d}` });
        return m;
      }
    };
    const max = 1 << 28;
    const js = minLimit(run, max);
    const errAt = js === null ? null : js > 0 ? run(js - 1) : null;
    const goRun = (limit, cancel = false) => {
      const out = spawnSync(bin, ['routestage'], { input: bigjson.stringify({ graph: c.graph, args: { deep: c.args.deep, kind: c.kind, force: c.args.force, complete: c.args.complete, limits: [limit], cancel } }) + '\n', maxBuffer: 2 ** 30 });
      const r = bigjson.parse(out.stdout.toString().trim());
      if (!r.results) throw new Error(`routestage: ${JSON.stringify(r)}`);
      return r.results[0].err;
    };
    res.n++;
    {
      const jsCancel = run(max, true), goCancel = goRun(max, true);
      if (jsCancel !== goCancel) res.bad.push({ name: c.name, diff: `canceled context: JS ${jsCancel} / Go ${goCancel}` });
      else res.cancel = (res.cancel ?? 0) + 1;
    }
    if (js === null) { res.bad.push({ name: c.name, diff: 'JS never succeeds' }); return; }
    const goAt = goRun(js);
    const goBelow = js > 0 ? goRun(js - 1) : 'n/a';
    if (goAt === null && (js === 0 || goBelow === errAt)) res.same++;
    else if (goAt !== null && c.args.spare > 0) { // Go charges the spare slice capacity: JS may need less; find Go's minimum above
      let lo = js, hi = js * 2 + 64;
      while (goRun(hi) !== null) hi *= 2;
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (goRun(mid) === null) hi = mid; else lo = mid; }
      res.loose++;
    } else res.bad.push({ name: c.name, diff: `JS min ${js}: Go at ${goAt}, below ${goBelow} / JS ${errAt}` });
  });
  console.log(`work-limit boundary: ${res.n} stage cases, exact ${res.same}, loose (spare capacity) ${res.loose}, canceled-context errors identical ${res.cancel ?? 0}, different ${res.bad.length}`);
  for (const b of res.bad.slice(0, 5)) console.log('DIFF', b.name, b.diff);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (mode === 'check') await check();
  else if (mode === 'replay') replay();
  else if (mode === 'limits') limits();
  else { console.error('usage: routestagecheck.mjs check|replay|limits <cases.jsonl> [flags]'); process.exit(2); }
}
