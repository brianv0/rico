// Differential test: the JS port (public/d2/) against the Go reference (this directory).
//
//   go run . corpus <D2 v0.7.2 source dir> > corpus.jsonl     # once; source: proxy.golang.org/oss.terrastruct.com/d2/@v/v0.7.2.zip
//   node diff.mjs <parse|ir|measure|shape|label|color|element|target|...> input.jsonl [--utf16] [--only N] [--show 5]
//
// Each stage maps a case to the same JSON the Go mode prints. Add a stage here as each layer is ported.
// Output: counts, then the first --show mismatches with the JSON path of the first difference.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../public/d2/parser.js';
import { compile } from '../../public/d2/d2ir.js';
import { compile as compileGraph } from '../../public/d2/d2compiler.js';

import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile, loadLayout } from '../../public/d2/d2lib.js';
import { setMarkdownIt, loadMetrics, newRuler, getTextDimensionsWithMono, measureMarkdown, renderMarkdown } from '../../public/d2/textmeasure.js';
import * as d2fonts from '../../public/d2/fonts.js';
import { shapeCheck } from './shapecheck.mjs';
import { labelCheck } from './labelcheck.mjs';
import { colorCheck } from './colorcheck.mjs';
import { elementCheck } from './elementcheck.mjs';
import { targetCheck, targetStatics } from './targetcheck.mjs';
import { urlCheck } from './urlcheck.mjs';
import { htmlUnescapeCheck } from './htmlcheck.mjs';
import { xmlCheck } from './xmlcheck.mjs';
import { sortCheck } from './sortcheck.mjs';
import { strconvCheck } from './strconvcheck.mjs';
import { sprintfCheck } from './sprintfcheck.mjs';
import { graphMethods } from './graphcheck.mjs';
import { dimsCheck } from './dimscheck.mjs';
import * as bigjson from '../../public/d2/tala/bigjson.js';
import * as talacheck from './talacheck.mjs';
import * as enginecheck from './tala/enginecheck.mjs';
import * as t1check from './tala/t1check.mjs';
import * as pkgcheck from './tala/pkgcheck.mjs';
import * as hierarchycheck from './tala/hierarchycheck.mjs';
import * as pccheck from './tala/placementcostcheck.mjs';
import { svgCheck, svgFullCheck, svgPrepare } from './svgcheck.mjs';
import { latexCheck } from './latexcheck.mjs';
import { loadLatex } from '../../public/d2/d2latex.js';

setMarkdownIt(markdownit);
await loadMetrics();
const ruler = newRuler();
await initD2();
await loadLayout('elk');
await loadLayout('tala'); // layout 'tala' (public/d2/tala/layout.js): the full pipeline needs the placement and routing stages (see docs/d2-tala-port.md)
await loadLatex(); // vendor/mathjax.js (the browser loads it only when a diagram has a LaTeX label)

// measure: input lines {text, fontFamily?, monoFamily?, fontSize, bold?, italic?, language?, markdown?} (see measurecorpus.mjs)
function measure(c) {
  const family = c.fontFamily || null, mono = c.monoFamily || null;
  if (c.markdown) {
    try {
      const [width, height] = measureMarkdown(c.text, ruler, family, mono, c.fontSize);
      return { width, height, err: null };
    } catch (e) {
      if (e.name === 'MarkdownError') return { width: 0, height: 0, err: e.message };
      throw e;
    }
  }
  const t = { text: c.text, fontSize: c.fontSize, isBold: !!c.bold, isItalic: !!c.italic, language: c.language || '' };
  const dims = getTextDimensionsWithMono(null, ruler, t, family, mono);
  const out = { width: dims.width, height: dims.height };
  if (!c.language) {
    const style = c.bold ? 'bold' : c.italic ? 'italic' : 'regular';
    const [pw, ph] = ruler.measurePrecise(d2fonts.font(family || 'SourceSansPro', c.fontSize, style), c.text);
    out.precise = [pw, ph];
  }
  return out;
}

// TALA stages: the Go side is tala/xdump.bin (tala/setup.sh builds it; env TALA_REF is the module copy, default /tmp/tala-ref), the mode is
// the Go mode name. Cases and results may hold int64 IDs beyond 2^53, so they are read and written with bigjson.
const TALA_MODES = {
  talagraphjson: 'graphjson',
  talaadapter: 'adapter',
  talarand: 'rand',
  talaops: 'lgops',
  talanodeshape: 'nodeshape',
  talascores: 'scores',
  talastages: 'stages',
  talafstages: 'fstages',
  ...t1check.MODES, // T1 packages (loops, grouping, proximity, trees): tala/t1check.mjs
  talapack: 'pkgpack', // packing, labeling, quality (tala/pkgcheck.mjs)
  talaplace: 'pkgplace',
  talaquality: 'pkgquality',
  talacombine: 'pkgcombine',
  talascore: 'pkgscore',
  talahierrank: 'hierrank',
  talahiersimple: 'hiersimple',
  talahierstage: 'hierstage',
  talahiercompound: 'hiercompound',
  talapcscore: 'pcscore',
  talapcunit: 'pcunit',
};

const STAGES = {
  talagraphjson: talacheck.graphjsonStage,
  talaadapter: talacheck.adapterStage,
  talarand: talacheck.randStage,
  talaops: talacheck.opsStage,
  talanodeshape: talacheck.nodeshapeStage,
  talascores: enginecheck.scoresStage, // the full JS pipeline against Go's per-seed dumps (tala/enginecheck.mjs; deferred while stages are not ported)
  talastages: enginecheck.stagesStage,
  talafstages: enginecheck.fstagesStage,
  ...t1check.STAGES,
  talapack: pkgcheck.packStage,
  talaplace: pkgcheck.placeStage,
  talaquality: pkgcheck.qualityStage,
  talacombine: pkgcheck.combineStage,
  talascore: pkgcheck.scoreStage,
  talahierrank: hierarchycheck.hierrankStage,
  talahiersimple: hierarchycheck.hiersimpleStage,
  talahierstage: hierarchycheck.hierstageStage,
  talahiercompound: hierarchycheck.hiercompoundStage,
  talapcscore: pccheck.pcscoreStage,
  talapcunit: pccheck.pcunitStage,
  parse: (c) => parse(c.path, c.text, { utf16: c.utf16 }),
  measure,
  mdhtml: (c) => ({ html: renderMarkdown(c.text), err: null }),
  shape: shapeCheck,
  label: labelCheck,
  color: colorCheck,
  element: elementCheck,
  target: targetCheck,
  targetstatics: targetStatics,
  url: urlCheck,
  htmlunescape: htmlUnescapeCheck,
  xml: xmlCheck,
  sortslice: sortCheck,
  strconv: strconvCheck,
  sprintf: sprintfCheck,
  graphmethods: graphMethods,
  dims: (c) => dimsCheck(c, ruler),
  // d2ref's `latex` mode: d2latex.Render and d2latex.Measure of the TeX source in `text` (see latexfuzz.mjs, latexformulas.mjs)
  latex: latexCheck,
  // d2ref's `svgfromdiagram` mode: the JS renderer takes Go's own diagram JSON (and the render options Go ended up with) and
  // must print Go's SVG byte for byte. `svg` is the full SVG (fonts embedded), `svgnofonts` blanks the font data on both sides.
  svg: (c, want, flags) => svgCheck(c, want, { fonts: 'embed', flags }),
  svgnofonts: (c, want, flags) => svgCheck(c, want, { fonts: 'embed', nofonts: true, flags }),
  // the whole JS pipeline (compile with the case's render options, then render) against Go's: use with --sketch for sketch mode
  svgfull: (c, want, flags) => svgFullCheck(c, want, { flags }),
  svgfullnofonts: (c, want, flags) => svgFullCheck(c, want, { nofonts: true, flags }),
  // d2ref's `layout` mode: {diagram, err} from d2lib.Compile with the dagre layout.
  layout: (c) => {
    const r = d2compile(c.text, { utf16: c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: c.layout || 'dagre', elkOpts: c.elkopts, talaOpts: c.seeds ? { 'tala-seeds': c.seeds } : undefined, measuredTexts: c.mtexts, ...(c.themeID != null ? {} : {}) }, c.themeID != null ? { themeID: c.themeID } : {});
    return { diagram: r.diagram, err: r.err ? r.err.message : null };
  },
  // d2ref's `graph` mode: {graph, config, err} from d2compiler.Compile, err as its text.
  graph: (c) => {
    const r = compileGraph(c.path, c.text, { utf16: c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs } });
    return { graph: r.g, config: r.config, err: r.err ? r.err.message : null };
  },
  // d2ref's `ir` mode: a parse error is {err} alone; otherwise {ir, err} from d2ir.Compile.
  ir: (c) => {
    const { ast, err } = parse(c.path, c.text, { utf16: c.utf16 });
    if (err) return { err };
    const r = compile(ast, { utf16: c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs } });
    return { ir: r.m, err: r.err };
  },
};

const [mode, file, ...flags] = process.argv.slice(2);
if (mode === 'e2e') await e2e(file, flags);
const flag = (name, def) => { const i = flags.indexOf(name); return i < 0 ? def : flags[i + 1] ?? true; };
if (!STAGES[mode] || !file) {
  console.error(`usage: node diff.mjs <${Object.keys(STAGES).join('|')}> corpus.jsonl [--utf16] [--only N] [--show 5]`);
  process.exit(2);
}
const utf16 = flags.includes('--utf16');
// --layout elk (or dagre, tala): the layout engine of every case (the Go runner takes it from the case's `layout` field)
const layoutFlag = flag('--layout');
const isTala = mode in TALA_MODES;
let cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => ({ ...(isTala ? bigjson.parse(l) : JSON.parse(l)), utf16, ...(layoutFlag ? { layout: layoutFlag } : {}) }));
// --sketch: render every case of the svg stages in sketch mode (Go compiles with the sketch option too, so the diagram has the HandDrawn font)
if (flags.includes('--sketch')) cases = cases.map((c) => ({ ...c, ropts: { ...c.ropts, sketch: true } }));
if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];

const here = path.dirname(fileURLToPath(import.meta.url));
// A Go fatal error (such as the stack overflow on a self-referential `vars`) kills the whole process and cannot be
// recovered, so on failure the batch is bisected and the crashing case is reported like a panic.
function runRef(batch) {
  try {
    const [cmd, args, opts] = isTala
      ? [(process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin', [TALA_MODES[mode]], {}]
      : process.env.D2REF_BIN // D2REF_BIN: a prebuilt runner (go build -o /tmp/d2ref .) instead of `go run .`
        ? [process.env.D2REF_BIN, [/^svg/.test(mode) ? 'svgfromdiagram' : mode], { cwd: here }]
        : ['go', ['run', '.', /^svg/.test(mode) ? 'svgfromdiagram' : mode], { cwd: here }];
    // a chroma lexer can loop forever (code labels): the batch is bisected on a timeout like a Go crash
    return execFileSync(cmd, args, { ...opts, input: batch.map((c) => (isTala ? bigjson.stringify(c) : JSON.stringify(c))).join('\n'), maxBuffer: 1 << 30, timeout: 15000 + 150 * batch.length, stdio: ['pipe', 'pipe', 'ignore'] })
      .toString().trim().split('\n');
  } catch (e) {
    if (batch.length === 1) return [JSON.stringify({ panic: 'Go crashed (fatal error)' })];
    const h = batch.length >> 1;
    return [...runRef(batch.slice(0, h)), ...runRef(batch.slice(h))];
  }
}
if (/^svg/.test(mode)) await svgPrepare(/nofonts$/.test(mode));
const ref = runRef(cases);

// Go prints pointers inside one error message (`import key %q ...` formats a []d2ast.String with %q, which dumps
// *string addresses); those differ on every run, so addresses are blanked in error messages (`errmsg` of an AST error, `err` of the graph stage) and nowhere else.
const canon = (v, k) => (Array.isArray(v) ? v.map((x) => canon(x)) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k2) => [k2, canon(v[k2], k2)])) : (k === 'errmsg' || k === 'err') && typeof v === 'string' ? v.replace(/0x[0-9a-f]{9,12}\b/g, '0xc000000000') : v);
const tol = Number(flag('--tol', 0)); // --tol 1e-9: numbers within a relative tolerance count as equal-within-tolerance
function firstDiff(a, b, p = '$', t = 0) {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (t && typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t * Math.max(1, Math.abs(a), Math.abs(b))) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`, t); if (d) return d; }
    if (t) return null; // every leaf is within tolerance
  }
  if (typeof a === 'string' && typeof b === 'string' && a.length > 200) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const ctx = (x) => JSON.stringify(x.slice(Math.max(0, i - 100), i + 100));
    return { path: `${p} (first difference at char ${i} of ${a.length}/${b.length})`, got: ctx(a), want: ctx(b) };
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 200), want: JSON.stringify(b)?.slice(0, 200) };
}

let same = 0, panics = 0, withinTol = 0, deferred = 0, unstable = 0;
const deferredBy = {};
const bad = [];
const t0 = performance.now();
for (const [i, c] of cases.entries()) {
  const want = isTala ? bigjson.plain(bigjson.parse(ref[i])) : JSON.parse(ref[i]);
  if (want.panic) { panics++; continue; } // Go itself panicked: nothing to match
  let got;
  try { got = canon(isTala ? bigjson.plain(await STAGES[mode](c, want, flags)) : JSON.parse(JSON.stringify(await STAGES[mode](c, want, flags)))); } catch (e) { got = { threw: String(e.stack || e) }; }
  if (got.deferred) { deferred++; deferredBy[got.deferred] = (deferredBy[got.deferred] || 0) + 1; if (flags.includes('--defer')) console.log(`deferred #${i} ${got.deferred} ${c.from ?? ''}`); continue; }
  let d = firstDiff(got, canon(want));
  if (d && (mode === 'layout' || mode === 'svgfull' || mode === 'talat1ops')) {
    // Go iterates maps in random order in d2dagrelayout (shiftReachableDown, adjustRankSpacing), so its own output can vary
    // between runs. If Go gives the JS answer in some of 100 more runs, the case is Go-unstable, not a mismatch.
    const again = runRef(Array(100).fill(c)).map((l) => canon(isTala ? bigjson.plain(bigjson.parse(l)) : JSON.parse(l)));
    if (again.some((w) => !firstDiff(got, w))) { unstable++; d = null; }
  }
  if (d) { const dt = tol ? firstDiff(got, canon(want), '$', tol) : d; if (dt) bad.push({ i, from: c.name ?? c.from ?? (isTala ? bigjson.stringify(c) : JSON.stringify(c)).slice(0, 160), ...dt, errs: got.err || want.err ? `js: ${JSON.stringify(got.err)?.slice(0, 200)} go: ${JSON.stringify(want.err)?.slice(0, 200)}` : '' }); else withinTol++; } else same++;
}
console.log(`${mode}${utf16 ? ' (utf16)' : ''}: ${same}/${cases.length - panics - deferred} identical to Go` + (tol ? `, ${withinTol} more within relative ${tol}` : '') + (panics ? `, ${panics} skipped (Go panicked)` : '') + (deferred ? `, ${deferred} deferred (${Object.entries(deferredBy).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '') + (unstable ? `, ${unstable} of the identical are Go-unstable (Go's own output varies between runs; JS equals one of them)` : '') + `, JS ${(performance.now() - t0) | 0}ms`);
for (const b of bad.slice(0, Number(flag('--show', 5)))) console.log(`\n#${b.i} ${b.from}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}` + (b.errs ? `\n  err  ${b.errs}` : ''));
process.exitCode = bad.length ? 1 : 0;

// e2e: D2's own end-to-end goldens. Inputs come from e2eenum/run.sh (the testCases that e2etests' run() compiles, recorded
// from the Go test sources) and the files testdata/<name>/dagre/board.exp.json of the D2 source. run() compiles with
// Layout dagre, Pad 0, the test's themeID, its measured texts (and then no ruler) and compares json.MarshalIndent(diagram).
async function e2e(file, flags) {
  const { execFileSync } = await import('node:child_process');
  const src = (flags.includes('--src') ? flags[flags.indexOf('--src') + 1] : null) ||
    execFileSync('go', ['list', '-m', '-f', '{{.Dir}}', 'github.com/d2lang/d2'], { cwd: path.dirname(fileURLToPath(import.meta.url)) }).toString().trim();
  const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let same = 0, noGolden = 0, errSame = 0;
  const bad = [];
  // --layout elk: the goldens are testdata/<name>/elk/board.exp.json (cases marked justDagre have none; elkFeatureError cases are expected to fail the plugin's feature check, which is not part of d2lib.Compile)
  const engine = flags.includes('--layout') ? flags[flags.indexOf('--layout') + 1] : 'dagre';
  const tolv = Number(flags.includes('--tol') ? flags[flags.indexOf('--tol') + 1] : 0);
  for (const c of cases) {
    const gp = path.join(src, 'e2etests/testdata', c.name, `${engine}/board.exp.json`);
    const copts = { utf16: false, layout: engine, ruler: c.mtexts ? null : undefined, measuredTexts: c.mtexts || undefined, talaOpts: engine === 'tala' ? { 'tala-seeds': [1] } : undefined }; // D2's e2e tests run TALA with Seeds {1}
    const r = d2compile(c.text, copts, c.themeID != null ? { themeID: c.themeID } : {});
    if (c.expErr) { if (r.err && r.err.message === c.expErr) errSame++; else bad.push({ name: c.name, path: '$err', got: r.err && r.err.message, want: c.expErr }); continue; }
    if ((engine === 'dagre' ? c.dagreFeatureError : engine === 'elk' ? c.elkFeatureError || c.justDagre : false) || !fs.existsSync(gp)) { noGolden++; continue; }
    if (r.err) { bad.push({ name: c.name, path: '$err', got: r.err.message, want: 'a diagram' }); continue; }
    const want = JSON.parse(fs.readFileSync(gp, 'utf8'));
    const got = JSON.parse(JSON.stringify(r.diagram));
    const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
    const d = firstDiff(sortKeys(got), sortKeys(want), "$", tolv); // key order is not compared (v0.9.0 goldens write url.URL fields in another order)
    if (d) bad.push({ name: c.name, ...d }); else same++;
  }
  console.log(`e2e: ${same}/${same + bad.length} ${engine} goldens identical, ${errSame} expected errors identical, ${noGolden} without golden`);
  for (const b of bad.slice(0, Number(flags.includes('--show') ? flags[flags.indexOf('--show') + 1] : 8))) console.log(`\n${b.name}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
  process.exit(bad.length ? 1 : 0);
}
