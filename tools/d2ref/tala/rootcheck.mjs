// Checks of the TALA engine and root package (public/d2/tala/{engine,layout,result,patch}.js). The Go side is the `root*` and `engine*` modes of
// tools/d2ref/tala/xdump/root_engine_xdump.go (built by tala/setup.sh; env TALA_REF points at the module copy).
//
//   node tala/rootcheck.mjs replay <cases.jsonl> [--batch 10] [--only N] [--show 5] [--golden]
//        Go runs the whole compile with the sequential trace of Layout and RouteEdges (xdump roottrace: the real plan, seeds, selection,
//        compound candidate, patch, d2lib.Compile). The JS compile (layout 'tala', real d2lib/layoutNested) runs the real JS code of
//        layout.js, result.js and patch.js with Go's pipeline outputs standing in for the unported stages: every seed's final graph comes from
//        Go (graphjson), is validated and scored by JS (evaluateSeedResult, compared with Go's score and error text), the seeds are selected by
//        JS (coordinateLocalSeeds), the compound candidate graph of Go is evaluated and considered by JS (considerSeedCandidate), the result is
//        patched onto the D2 graph by JS (applySeedResult) and the edge router calls are answered with Go's routed edges. The compared output is
//        the whole diagram (and the error text) of the compile. --golden also compares shapes and connections with the D2 e2e golden of the case
//        (tala-e2e.jsonl cases carry its path).
//   node tala/rootcheck.mjs validate [--n 400]     error injection: mutated result graphs (graphjson) against the input graph, every validation message
//   node tala/rootcheck.mjs score                  layoutScore.compare on edge values (NaN, Inf, negative, equal)
//   node tala/rootcheck.mjs driver <fixtures.jsonl> [--n 40]   the pipeline driver (runAllStages, runLayout, Layout) with scripted stage bodies
//   node tala/rootcheck.mjs compound <compound.jsonl>          CompoundCandidate up to the routing trial
//
// Full pipeline (when placement and routing are merged): node diff.mjs layout tala-corpus.jsonl (cases carry layout: 'tala'), and `rootcheck.mjs golden`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import markdownit from 'markdown-it';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import * as geo from '../../../public/d2/geo.js';
import * as d2lib from '../../../public/d2/d2lib.js';
import * as d2latex from '../../../public/d2/d2latex.js';
import { background } from '../../../public/d2/tala/context.js';
import { errorf } from '../../../public/d2/tala/goerrors.js';
import { registerPackage } from '../../../public/d2/tala/stagepkgs.js';
import { layoutPlan, newSeedInput } from '../../../public/d2/tala/d2talalayout.js';
import { coordinateLocalSeeds, considerSeedCandidate } from '../../../public/d2/tala/layout.js';
import * as talaLayout from '../../../public/d2/tala/layout.js';
import { evaluateSeedResult } from '../../../public/d2/tala/result.js';
import { applySeedResult } from '../../../public/d2/tala/patch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
import { runGo, loadCases, bin } from './rootlib.mjs';
export { runGo, loadCases, bin };

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const canon = (v) => JSON.stringify(sortKeys(v));
function firstDiff(a, b, p = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 200), want: JSON.stringify(b)?.slice(0, 200) };
}

const unmarshalGraph = (data) => {
  const g = lg.newGraph();
  graphjson.unmarshal(background(), data, g);
  return g;
};

// ---- replay ----------------------------------------------------------------------------------------------------------------------------

const stats = { layouts: 0, seeds: 0, seedErrs: 0, evalErrs: 0, scoreMismatch: 0, selectMismatch: 0, compoundMismatch: 0, routes: 0, compounds: { unchanged: 0, kept: 0, rejected: 0, error: 0, none: 0 }, notes: [] };

/** the layout function of the JS compile for one Go record (mirrors layout.js's layout(): plan, input, seeds, candidate, patch) */
function replayLayout(ev, opts, g) {
  const ctx = background();
  const [seeds, concurrency] = layoutPlan(g, opts);
  const input = newSeedInput(ctx, g);
  stats.layouts++;
  if (ev.adapter && ev.adapter !== null) {
    const goA = lg.newGraph();
    graphjson.unmarshal(ctx, ev.adapter, goA);
    const d = firstDiff(bigjson.plain(graphjson.serialize(ctx, input.graph)), bigjson.plain(graphjson.serialize(ctx, goA)));
    if (d) stats.notes.push(`adapter graph differs at ${d.path}`);
  }
  const graphs = [];
  let best = coordinateLocalSeeds(ctx, seeds, concurrency, (index, seed) => {
    stats.seeds++;
    const attempt = { index, seed, result: null, err: null };
    const rec = ev.seeds[index];
    if (!rec || BigInt(rec.seed) !== seed) throw new Error(`replay: seed record ${index} is ${rec && rec.seed}, JS plans ${seed}`);
    if (!rec.hasGraph) {
      stats.seedErrs++;
      attempt.err = errorf(rec.err);
      return attempt;
    }
    graphs[index] = unmarshalGraph(rec.graph);
    try {
      attempt.result = evaluateSeedResult(ctx, input, graphs[index]);
    } catch (e) {
      if (!(e instanceof Error) || e.name !== 'GoError') throw e;
      attempt.err = e;
    }
    const jsErr = attempt.err ? attempt.err.message : '';
    if (jsErr !== (rec.err || '')) stats.notes.push(`seed ${seed}: evaluation error differs: js ${JSON.stringify(jsErr)} go ${JSON.stringify(rec.err)}`);
    if (attempt.err) stats.evalErrs++;
    else if (!Object.is(attempt.result.score.penalty, bigjson.plain(rec.penalty)) || !Object.is(attempt.result.score.area, bigjson.plain(rec.area))) {
      stats.scoreMismatch++;
      stats.notes.push(`seed ${seed}: score js ${attempt.result.score.penalty}/${attempt.result.score.area} go ${rec.penalty}/${rec.area}`);
    }
    return attempt;
  });
  if (ev.selected < 0 || best.graph !== graphs[ev.selected]) { stats.selectMismatch++; stats.notes.push(`selected seed differs (go index ${ev.selected})`); }
  const before = best.graph;
  let candidate = null;
  best = considerSeedCandidate(ctx, best, () => {
    if (ev.compound === 'unchanged') return best;
    if (ev.compound === 'error') throw errorf(ev.compoundErr);
    if (ev.compound === 'none') throw new Error('replay: compound candidate not recorded');
    candidate = unmarshalGraph(ev.compoundGraph);
    return evaluateSeedResult(ctx, input, candidate);
  });
  const jsCompound = best.graph !== before ? 'kept' : candidate !== null ? 'rejected' : 'unchanged';
  stats.compounds[ev.compound] = (stats.compounds[ev.compound] || 0) + 1;
  if (ev.compound !== 'error' && jsCompound !== ev.compound) { stats.compoundMismatch++; stats.notes.push(`compound ${jsCompound} vs go ${ev.compound}`); }
  applySeedResult(ctx, g, best);
}

/** the edge router of the JS compile: TALA's routeEdges with Go's routed graph standing in for routing.RouteEdges */
function replayRoute(ev, g, edges) {
  stats.routes++;
  const stub = (ctx, talaGraph, talaEdges) => {
    if (ev.graph === undefined || ev.graph === null) throw errorf(ev.err);
    const routed = unmarshalGraph(ev.graph);
    const byID = new Map(routed.edges.map((e) => [e.id, e]));
    const curves = new Map(ev.edges.map((e) => [e.id, e.isCurve]));
    for (const te of talaEdges) {
      const r = byID.get(te.id);
      te.points = r.points.map((p) => p.copy());
      te.labelPercentage = r.labelPercentage;
      if (te.label !== null && r.label !== null) te.label.position = r.label.position;
      te.isCurve = curves.get(te.id) === true;
    }
  };
  const off = registerPackage('routing', { routeEdges: stub });
  try {
    talaLayout.routeEdges(background(), g, edges);
  } finally {
    off();
  }
}

const pick = (d) => ({
  shapes: (d.shapes || []).map((s) => [s.id, s.pos.x, s.pos.y, s.width, s.height]),
  connections: (d.connections || []).map((c) => [c.id, c.route, c.labelPosition ?? null, c.labelPercentage ?? null]),
});
const boards = (d) => [d, ...(d.layers || []).flatMap(boards), ...(d.scenarios || []).flatMap(boards), ...(d.steps || []).flatMap(boards)];

export async function replayCompile(c, ev) {
  for (;;) {
    try {
      return replayCompileOnce(c, ev);
    } catch (e) {
      // a latex label and the MathJax engine is not loaded yet: load it (once) and run the replay again
      if (!(e instanceof d2latex.NeedLatex)) throw e;
      await d2latex.loadLatex();
    }
  }
}

function replayCompileOnce(c, ev) {
  let k = 0;
  const events = ev.events ?? [];
  const next = (kind) => {
    const e = events[k++];
    if (!e || e.kind !== kind) throw new Error(`replay: event ${k - 1} is ${e && e.kind}, JS asked for ${kind}`);
    return e;
  };
  const talaOpts = c.seeds ? { 'tala-seeds': c.seeds.map((s) => Number(s)) } : undefined;
  const opts = talaOpts ? talaLayout.hydrateOpts(talaOpts) : null;
  const r = d2lib.compileSync(c.text, {
    utf16: !!c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'tala',
    layoutResolver: () => (g) => { const e = next('layout'); const out = replayLayoutCatch(e, opts, g); if (out) throw out; },
    routerResolver: () => (g, edges) => replayRoute(next('route'), g, edges),
  }, c.themeID != null ? { themeID: c.themeID } : {});
  if (k !== events.length) throw new Error(`replay: ${events.length - k} unused events (js err: ${r.err && r.err.message})`);
  return r;
}

// a layout error is the compile's error: replayLayout throws GoErrors like layout() does
const replayLayoutCatch = (e, opts, g) => {
  try {
    replayLayout(e, opts, g);
    if (e.err) return new Error(`replay: Go failed (${e.err}) but JS did not`);
    return null;
  } catch (err) {
    if (err instanceof Error && err.name === 'GoError') {
      if (e.err === undefined) stats.notes.push(`JS failed (${err.message}) but Go did not`);
      return err;
    }
    throw err;
  }
};

async function replay(file, flags) {
  await d2lib.init({ markdownit });
  const flag = (n, d) => { const i = flags.indexOf(n); return i < 0 ? d : flags[i + 1] ?? true; };
  let cases = loadCases(file);
  if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];
  const goOut = runGo('roottrace', cases, Number(flag('--batch', 10)));
  let same = 0, goErr = 0, skipped = 0, goldenSame = 0, goldenN = 0;
  const bad = [];
  const t0 = performance.now();
  for (const [i, c] of cases.entries()) {
    const want = goOut[i];
    if (want.panic) { skipped++; continue; }
    const before = stats.notes.length;
    let got;
    try {
      const r = await replayCompile(c, want);
      got = { diagram: r.diagram === null ? null : JSON.parse(JSON.stringify(r.diagram)), err: r.err ? r.err.message : null };
    } catch (e) {
      got = { threw: String(e.stack || e) };
    }
    const expected = bigjson.plain({ diagram: want.diagram ?? null, err: want.err ?? null });
    const d = firstDiff(sortKeys(got), sortKeys(expected));
    if (d || stats.notes.length > before) bad.push({ i, name: c.name ?? c.path, ...(d || { path: 'notes', got: stats.notes.slice(before).join('; '), want: '' }), errs: JSON.stringify(got.err) });
    else same++;
    if (want.err) goErr++;
    if (flags.includes('--golden') && c.golden && !d && got.diagram) {
      goldenN++;
      const golden = JSON.parse(fs.readFileSync(String(c.golden), 'utf8'));
      if (canon(boards(got.diagram).map(pick)) === canon(boards(golden).map(pick))) goldenSame++;
      else bad.push({ i, name: c.name, path: 'golden', got: 'differs', want: '' });
    }
  }
  console.log(`replay ${path.basename(file)}: ${same}/${cases.length - skipped} identical to Go (diagram and error text); ${goErr} are Go errors${skipped ? `, ${skipped} skipped (Go panicked)` : ''}` +
    (goldenN ? `; e2e goldens: ${goldenSame}/${goldenN}` : '') + `, JS ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  layout calls ${stats.layouts}, seeds ${stats.seeds} (engine errors ${stats.seedErrs}, evaluation errors ${stats.evalErrs}), score mismatches ${stats.scoreMismatch}, selection mismatches ${stats.selectMismatch}, ` +
    `compound ${JSON.stringify(stats.compounds)} (mismatches ${stats.compoundMismatch}), route calls ${stats.routes}`);
  for (const b of bad.slice(0, Number(flag('--show', 5)))) console.log(`\n#${b.i} ${b.name}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}` + (b.errs ? `\n  js err ${b.errs}` : ""));
  process.exitCode = bad.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, file, ...flags] = process.argv.slice(2);
  if (mode === 'replay') await replay(file, flags);
  else {
    const m = await import('./rootcheck_more.mjs');
    await m.run(mode, file, flags);
  }
}
