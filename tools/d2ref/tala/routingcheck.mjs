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
import * as routing from '../../../public/d2/tala/routing/core.js';
import { replayCall, checkCall, stats as replayStats } from './routingreplay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function runGo(mode, cases, seeds) {
  const input = cases.map((c) => bigjson.stringify(seeds ? { ...c, seeds } : c)).join('\n');
  const r = spawnSync((process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin', [mode], { input, maxBuffer: 2 ** 31 - 1, stdio: ['pipe', 'pipe', 'ignore'] });
  if (r.status !== 0 && !r.stdout.length) return null;
  return r.stdout.toString().trim().split('\n');
}

const stats = { calls: 0, subgraphs: 0, edges: 0, flavors: 0, routes: 0, same: 0, bad: [], goPanic: 0, goErr: 0, cases: 0 };

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
  } else if (mode === 'trace') {
    await traceCheck();
  } else if (['routing', 'frouting', 'routinglabels', 'froutinglabels'].includes(mode)) {
    let cases = fs.readFileSync(path.resolve(file), 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
    if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];
    const from = Number(flag('--from', 0)), to = Number(flag('--to', cases.length));
    const chunk = Number(flag('--chunk', mode.startsWith('routing') ? 8 : 4));
    const seeds = flag('--seeds') ? String(flag('--seeds')).split(',').map(Number) : (mode.startsWith('routing') ? [1] : undefined);
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
        if (mode.startsWith('frouting')) visitCase(name, rec, (r) => (r.calls ?? []).map((x) => [`stage ${x.stage}`, x.call]), opts);
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
    console.log(`\n${mode} ${file}: ${stats.cases} cases, ${stats.calls} RouteGraph calls, ${stats.subgraphs} subgraphs, ${stats.edges} edges routed, ${stats.flavors} flavor runs (${stats.routes} routes); identical ${stats.same}/${stats.calls}; Go panics ${stats.goPanic}; Go errors without calls ${stats.goErr}; max deviation of the (Go-nondeterministic) OVG work counter ${(replayStats.maxWorkDeviation * 100).toFixed(2)}%; ${((performance.now() - t0) / 1000).toFixed(0)}s`);
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

// traceToShapeBorder (trace.js) against stage 30 (TraceEdgesToShapeBorder): Go's `stages` dump gives the graph after stage 29 and after
// stage 30; the JS function runs on every edge of the first and must print the second (this is the whole stage: it only moves route ends).
async function traceCheck() {
  const cases = fs.readFileSync(path.resolve(file), 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
  const from = Number(flag('--from', 0)), to = Number(flag('--to', cases.length)), chunk = Number(flag('--chunk', 6));
  const seeds = flag('--seeds') ? String(flag('--seeds')).split(',').map(Number) : [1];
  const ctx0 = context.background();
  let graphs = 0, same = 0, edges = 0, moved = 0;
  const bad = [];
  for (let i = from; i < Math.min(to, cases.length); i += chunk) {
    const batch = cases.slice(i, Math.min(i + chunk, to, cases.length));
    const lines = runGo('stages', batch, seeds);
    if (lines === null) continue;
    for (const [j, line] of lines.entries()) {
      const rec = bigjson.parse(line);
      for (const inv of rec.invocations ?? []) {
        for (const sd of inv.seeds ?? []) {
          const before = (sd.stages ?? []).find((x) => x.index === 29);
          const after = (sd.stages ?? []).find((x) => x.index === 30);
          if (!before || !after || before.graph.serializeError || after.graph.serializeError) continue;
          graphs++;
          const g = new lg.Graph();
          graphjson.unmarshal(ctx0, before.graph, g);
          for (const e of g.edges) { routing.traceToShapeBorder(e); edges++; }
          const got = bigjson.stringify(graphjson.serialize(ctx0, g), true);
          const want = bigjson.stringify(after.graph, true);
          if (got === want) same++;
          else bad.push({ name: batch[j].name ?? `case ${i + j}`, seed: sd.seed });
          if (bigjson.stringify(before.graph, true) !== want) moved++;
        }
      }
    }
    process.stderr.write(`\r${Math.min(i + chunk, cases.length)}/${cases.length} cases, ${same}/${graphs} stage-30 graphs identical   `);
  }
  console.log(`\ntrace ${file}: ${graphs} stage graphs (${edges} edges; ${moved} graphs changed by the stage), identical ${same}/${graphs}`);
  for (const b of bad.slice(0, 10)) console.log(JSON.stringify(b));
  process.exit(bad.length ? 1 : 0);
}
