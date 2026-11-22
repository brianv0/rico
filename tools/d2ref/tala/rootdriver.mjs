// The `driver` and `compound` modes of tala/rootcheck.mjs.
//
// driver: the real pipeline driver (engine.js: runAllStages, runLayout, layout) against Go's (xdump enginedrive) with SCRIPTED stage bodies: both
// sides replace the body of every stage by a stub that records the graph it is entered with (= the state after the previous stage, including what
// stage 0's reset does) and then does what the script says: nothing, fail, cancel the context, widen a node, move the nodes. What is compared:
// the stages that ran and the graph each was entered with, the final graph, the error text (stage-name prefixes, context errors, the
// "Dimensions ... reached after stage" invariant), the pipeline instrumentation (stage timing slots) and the empty-graph / canceled-context /
// validation entry paths.
//
// compound: engine.compoundCandidate up to the routing trial (the routing package is stubbed with a function that throws a sentinel) against
// xdump enginecompound: the decision (size/containers/fixed nodes, PlaceCompound changed nothing, worse alignment) and the detour counts.
import fs from 'node:fs';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import { background, withCancel } from '../../../public/d2/tala/context.js';
import { registerPackage } from '../../../public/d2/tala/stagepkgs.js';
import * as engine from '../../../public/d2/tala/engine.js';
import { runGo, loadCases } from './rootlib.mjs';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const flagOf = (flags) => (n, d) => { const i = flags.indexOf(n); return i < 0 ? d : flags[i + 1] ?? true; };

function firstDiff(a, b, p = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 300), want: JSON.stringify(b)?.slice(0, 300) };
}

const STAGES = engine.defaultPipelineStages.length;

/** the JS twin of XInstallScript: replaces the `run` of every default stage by the scripted stub; returns the restore function */
function installScript(script, record, cancel) {
  const originals = engine.defaultPipelineStages.map((s) => s.run);
  engine.defaultPipelineStages.forEach((stage, index) => {
    stage.run = (p) => {
      record(index, stage.name, p.graph);
      const step = script[index] ?? { op: '' };
      switch (step.op) {
        case 'err': throw errorsNew(step.msg);
        case 'errf': throw errorf('scripted: context canceled', Canceled);
        case 'cancel': cancel(); break;
        case 'grow':
          if (p.graph.nodes.length > 0) { p.graph.nodes[0].width = step.w; p.graph.nodes[0].height = step.h; }
          break;
        case 'move':
          for (const n of p.graph.nodes) if (n.topLeft !== null) { n.topLeft.x += step.dx; n.topLeft.y += step.dy; }
          break;
        default:
      }
    };
  });
  return () => engine.defaultPipelineStages.forEach((stage, i) => { stage.run = originals[i]; });
}

import { errorf, errorsNew } from '../../../public/d2/tala/goerrors.js';
import { Canceled } from '../../../public/d2/tala/context.js';
function jsDrive(c) {
  const args = c.args || {};
  const g = lg.newGraph();
  try {
    graphjson.unmarshal(background(), c.graph, g);
  } catch (e) {
    return { unmarshalErr: e.message };
  }
  const script = {};
  for (const [k, v] of Object.entries(args.script || {})) script[Number(k)] = v;
  const stages = [];
  const [ctx, cancel] = withCancel(background());
  if (args.precancel) cancel();
  const restore = installScript(script, (index, name, tg) => stages.push({ index, name, graph: graphjson.serialize(background(), tg) }), cancel);
  const res = {};
  const seed = c.seeds && c.seeds.length ? BigInt(c.seeds[0]) : 1n;
  const errText = (e) => { if (e instanceof Error && e.name === 'GoError') return e.message; throw e; };
  try {
    if (args.kind === 'run') {
      let ws = null, p = null;
      try {
        ws = lg.clone(ctx, g);
        p = engine.runLayout(ctx, ws, { seed }, { storeSnapshots: false, measureStageDurations: !!args.timing }, !!args.validate);
        res.err = null;
      } catch (e) {
        res.err = errText(e);
        p = e.pipeline ?? null;
      }
      // Go's XDrive reports NilPipeline false and no durations when the clone failed
      res.nilPipeline = ws === null ? false : p === null;
      res.durationsLen = p === null || p.stageDurations === null ? 0 : p.stageDurations.length;
      res.durationsUsed = p === null || p.stageDurations === null ? null : p.stageDurations.map((d) => d > 0);
      if (ws !== null) res.final = graphjson.serialize(background(), ws);
    } else {
      try {
        const out = engine.layout(ctx, g, { seed });
        res.err = null;
        res.final = graphjson.serialize(background(), out);
      } catch (e) {
        res.err = errText(e);
      }
    }
  } finally {
    restore();
  }
  res.stages = stages;
  return res;
}

export async function driver(file, flags) {
  const flag = flagOf(flags);
  const per = Number(flag('--per', 6));
  const R = rng(Number(flag('--seed', 1)));
  const fixtures = loadCases(file).filter((c) => c.graph);
  const pick = (list) => list[Math.floor(R() * list.length)];
  const cases = [];
  for (const f of fixtures) {
    const base = { name: f.name, graph: f.graph, seeds: [123] };
    const sc = (args) => cases.push({ ...base, args: { kind: 'layout', ...args } });
    sc({ script: {} });
    sc({ kind: 'run', script: {}, timing: true });
    sc({ kind: 'run', script: {}, timing: false, validate: true });
    sc({ kind: 'run', precancel: true, script: {} });
    sc({ precancel: true, script: {} });
    for (let t = 0; t < per; t++) {
      const k = Math.floor(R() * STAGES);
      const kind = R() < 0.5 ? 'run' : 'layout';
      const timing = R() < 0.5;
      const choose = R();
      if (choose < 0.2) sc({ kind, timing, script: { [k]: { op: 'err', msg: `boom ${k}` } } });
      else if (choose < 0.4) sc({ kind, timing, script: { [k]: { op: 'cancel' } } });
      else if (choose < 0.55) sc({ kind, timing, script: { [k]: { op: 'grow', w: 30001, h: 50 } } });
      else if (choose < 0.65) sc({ kind, timing, script: { [k]: { op: 'grow', w: 29999, h: 29999 } } });
      else if (choose < 0.75) sc({ kind, timing, script: { [k]: { op: 'move', dx: 17.5, dy: -3 } } });
      else if (choose < 0.82) sc({ kind, timing, script: { [k]: { op: 'errf' } } });
      else {
        const script = {};
        for (let s = 0; s < 3; s++) script[Math.floor(R() * STAGES)] = pick([{ op: 'move', dx: 3, dy: 4 }, { op: 'grow', w: 200, h: 100 }, { op: '' }]);
        script[Math.floor(R() * STAGES)] = pick([{ op: 'err', msg: 'late failure' }, { op: 'cancel' }]);
        sc({ kind, timing, script });
      }
    }
  }
  // the engine's input graph validation path (runLayout with validate) on defective graphs: duplicate node, dangling edge
  for (const f of fixtures.slice(0, 20)) {
    const dupNode = bigjson.parse(bigjson.stringify(f.graph));
    if (dupNode.nodes.length) dupNode.nodes.push(dupNode.nodes[0]);
    cases.push({ name: `${f.name}#dupnode`, graph: dupNode, seeds: [1], args: { kind: 'run', validate: true, script: {} } });
    const noPos = bigjson.parse(bigjson.stringify(f.graph));
    cases.push({ name: `${f.name}#noedges`, graph: { ...noPos, edges: [] }, seeds: [1], args: { kind: 'run', validate: true, timing: true, script: { 3: { op: 'cancel' } } } });
  }
  // the empty graph
  cases.push({ name: 'empty', graph: { nodes: [], edges: [] }, seeds: [1], args: { kind: 'run', timing: true, script: {} } });
  cases.push({ name: 'empty-layout', graph: { nodes: [], edges: [] }, seeds: [1], args: { kind: 'layout', script: {} } });
  const goOut = runGo('enginedrive', cases, 5);
  let same = 0, skipped = 0, unmarshal = 0;
  const bad = [];
  const outcomes = {};
  for (const [k, c] of cases.entries()) {
    const want = goOut[k];
    if (want.panic) { skipped++; continue; }
    const got = bigjson.plain(jsDrive(c));
    const w = bigjson.plain(want);
    if (w.unmarshalErr !== undefined) { unmarshal++; if (got.unmarshalErr === undefined) bad.push({ k, name: c.name, path: 'unmarshalErr', got: 'ok', want: w.unmarshalErr }); continue; }
    // Go omits fields that are nil/empty in its output map
    const norm = (r) => ({ err: r.err ?? null, stages: r.stages ?? [], final: r.final ?? null, nilPipeline: r.nilPipeline ?? null, durationsLen: r.durationsLen ?? 0, durationsUsed: r.durationsUsed ?? null });
    const d = firstDiff(norm(got), norm(w));
    const key = w.err ? String(w.err).replace(/\d+/g, 'N').slice(0, 60) : 'ok';
    outcomes[key] = (outcomes[key] || 0) + 1;
    if (d) bad.push({ k, name: `${c.name} ${JSON.stringify(c.args).slice(0, 120)}`, ...d }); else same++;
  }
  console.log(`driver: ${same}/${cases.length - skipped - unmarshal} identical to Go (${cases.length} scripted runs on ${fixtures.length} fixtures; ${unmarshal} unmarshal errors alike, ${skipped} skipped)`);
  console.log('  outcomes: ' + Object.entries(outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} x ${JSON.stringify(k)}`).join('; '));
  for (const b of bad.slice(0, Number(flag('--show', 6)))) console.log(`\n#${b.k} ${b.name}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
  process.exitCode = bad.length ? 1 : 0;
}

// ---- compound ----------------------------------------------------------------------------------------------------------------------------

export async function compound(file, flags) {
  const flag = flagOf(flags);
  let cases = loadCases(file).filter((c) => c.graph);
  const max = Number(flag('--max', 400));
  if (cases.length > max) cases = cases.slice(0, max);
  const goOut = runGo('enginecompound', cases, 10);
  const SENTINEL = new Error('reached the routing trial');
  const stub = () => { throw SENTINEL; };
  const off = registerPackage('routing', { routeGraph: stub, routeGraphWithWorkLimit: stub });
  let same = 0, skipped = 0;
  const bad = [];
  const reasons = {};
  try {
    for (const [k, c] of cases.entries()) {
      const want = bigjson.plain(goOut[k]);
      if (goOut[k].panic) { skipped++; continue; }
      if (want.unmarshalErr) { skipped++; continue; }
      const ctx = background();
      const g = lg.newGraph();
      graphjson.unmarshal(ctx, c.graph, g);
      let outcome;
      try {
        const out = engine.compoundCandidate(ctx, g);
        outcome = out === g ? 'same' : 'candidate';
      } catch (e) {
        outcome = e === SENTINEL ? 'route' : `error: ${e.message}`;
      }
      const goOutcome = want.reason === 'route' ? 'route' : want.err ? `error: ${want.err}` : 'same';
      reasons[want.reason] = (reasons[want.reason] || 0) + 1;
      let d = outcome === goOutcome ? null : { path: 'outcome', got: outcome, want: goOutcome };
      if (!d && want.reason === 'route') {
        // the full CompoundCandidate in Go routes the candidate: it ends as the candidate unless the routed bounding box is too big
        if (want.full.same) reasons['route-but-same'] = (reasons['route-but-same'] || 0) + 1;
      }
      if (!d && (want.reason === 'route' || want.reason === 'worse')) {
        // detour counts on the original graph and on the placed candidate
        const g2 = lg.newGraph();
        graphjson.unmarshal(ctx, c.graph, g2);
        const cand = lg.clone(ctx, g2);
        const { newRand } = await import('../../../public/d2/gorand.js');
        const { placeCompound } = await import('../../../public/d2/tala/hierarchy.js');
        placeCompound(ctx, cand, newRand(0n));
        const before = engine.compoundCrossAxisDetours(g2), after = engine.compoundCrossAxisDetours(cand);
        if (before !== want.detoursBefore || after !== want.detoursAfter) d = { path: 'detours', got: `${before}/${after}`, want: `${want.detoursBefore}/${want.detoursAfter}` };
      }
      if (d) bad.push({ k, name: c.name ?? String(k), ...d }); else same++;
    }
  } finally {
    off();
  }
  console.log(`compound: ${same}/${cases.length - skipped} identical to Go (CompoundCandidate up to the routing trial; Go reasons ${JSON.stringify(reasons)}), ${skipped} skipped`);
  for (const b of bad.slice(0, Number(flag('--show', 6)))) console.log(`\n#${b.k} ${b.name}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
  process.exitCode = bad.length ? 1 : 0;
}
