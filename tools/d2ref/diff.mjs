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
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
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

setMarkdownIt(markdownit);
await loadMetrics();
const ruler = newRuler();
await initD2();

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

const STAGES = {
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
  // d2ref's `layout` mode: {diagram, err} from d2lib.Compile with the dagre layout. A case that needs latex (d2latex is not
  // ported) is reported as deferred.
  layout: (c) => {
    const r = d2compile(c.text, { utf16: c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: c.layout || 'dagre', measuredTexts: c.mtexts, ...(c.themeID != null ? {} : {}) }, c.themeID != null ? { themeID: c.themeID } : {});
    if (r.err && r.err.name === 'LatexNotPorted') return { deferred: 'latex' };
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
let cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => ({ ...JSON.parse(l), utf16 }));
if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];

const here = path.dirname(fileURLToPath(import.meta.url));
// A Go fatal error (such as the stack overflow on a self-referential `vars`) kills the whole process and cannot be
// recovered, so on failure the batch is bisected and the crashing case is reported like a panic.
function runRef(batch) {
  try {
    return execFileSync('go', ['run', '.', mode], { cwd: here, input: batch.map((c) => JSON.stringify(c)).join('\n'), maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
      .toString().trim().split('\n');
  } catch (e) {
    if (batch.length === 1) return [JSON.stringify({ panic: 'Go crashed (fatal error)' })];
    const h = batch.length >> 1;
    return [...runRef(batch.slice(0, h)), ...runRef(batch.slice(h))];
  }
}
const ref = runRef(cases);

// Go prints pointers inside one error message (`import key %q ...` formats a []d2ast.String with %q, which dumps
// *string addresses); those differ on every run, so addresses are blanked in error messages (`errmsg` of an AST error, `err` of the graph stage) and nowhere else.
const canon = (v, k) => (Array.isArray(v) ? v.map((x) => canon(x)) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k2) => [k2, canon(v[k2], k2)])) : (k === 'errmsg' || k === 'err') && typeof v === 'string' ? v.replace(/0xc[0-9a-f]{9}/g, '0xc000000000') : v);
const tol = Number(flag('--tol', 0)); // --tol 1e-9: numbers within a relative tolerance count as equal-within-tolerance
function firstDiff(a, b, p = '$', t = 0) {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (t && typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t * Math.max(1, Math.abs(a), Math.abs(b))) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`, t); if (d) return d; }
    if (t) return null; // every leaf is within tolerance
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 200), want: JSON.stringify(b)?.slice(0, 200) };
}

let same = 0, panics = 0, withinTol = 0, deferred = 0, unstable = 0;
const bad = [];
const t0 = performance.now();
cases.forEach((c, i) => {
  const want = JSON.parse(ref[i]);
  if (want.panic) { panics++; return; } // Go itself panicked: nothing to match
  let got;
  try { got = canon(JSON.parse(JSON.stringify(STAGES[mode](c)))); } catch (e) { got = { threw: String(e.stack || e) }; }
  if (got.deferred) { deferred++; return; }
  let d = firstDiff(got, canon(want));
  if (d && mode === 'layout') {
    // Go iterates maps in random order in d2dagrelayout (shiftReachableDown, adjustRankSpacing), so its own output can vary
    // between runs. If Go gives the JS answer in some of 30 more runs, the case is Go-unstable, not a mismatch.
    const again = runRef(Array(30).fill(c)).map((l) => canon(JSON.parse(l)));
    if (again.some((w) => !firstDiff(got, w))) { unstable++; d = null; }
  }
  if (d) { const dt = tol ? firstDiff(got, canon(want), '$', tol) : d; if (dt) bad.push({ i, from: c.from ?? JSON.stringify(c).slice(0, 160), ...dt }); else withinTol++; } else same++;
});
console.log(`${mode}${utf16 ? ' (utf16)' : ''}: ${same}/${cases.length - panics - deferred} identical to Go` + (tol ? `, ${withinTol} more within relative ${tol}` : '') + (panics ? `, ${panics} skipped (Go panicked)` : '') + (deferred ? `, ${deferred} deferred (latex)` : '') + (unstable ? `, ${unstable} of the identical are Go-unstable (Go's own output varies between runs; JS equals one of them)` : '') + `, JS ${(performance.now() - t0) | 0}ms`);
for (const b of bad.slice(0, Number(flag('--show', 5)))) console.log(`\n#${b.i} ${b.from}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
process.exitCode = bad.length ? 1 : 0;

// e2e: D2's own end-to-end goldens. Inputs come from e2eenum/run.sh (the testCases that e2etests' run() compiles, recorded
// from the Go test sources) and the files testdata/<name>/dagre/board.exp.json of the D2 source. run() compiles with
// Layout dagre, Pad 0, the test's themeID, its measured texts (and then no ruler) and compares json.MarshalIndent(diagram).
async function e2e(file, flags) {
  const { execFileSync } = await import('node:child_process');
  const src = (flags.includes('--src') ? flags[flags.indexOf('--src') + 1] : null) ||
    execFileSync('go', ['list', '-m', '-f', '{{.Dir}}', 'github.com/d2lang/d2'], { cwd: path.dirname(fileURLToPath(import.meta.url)) }).toString().trim();
  const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let same = 0, noGolden = 0, deferred = 0, errSame = 0;
  const bad = [];
  const tolv = Number(flags.includes('--tol') ? flags[flags.indexOf('--tol') + 1] : 0);
  for (const c of cases) {
    const gp = path.join(src, 'e2etests/testdata', c.name, 'dagre/board.exp.json');
    const copts = { utf16: false, layout: 'dagre', ruler: c.mtexts ? null : undefined, measuredTexts: c.mtexts || undefined };
    const r = d2compile(c.text, copts, c.themeID != null ? { themeID: c.themeID } : {});
    if (r.err && r.err.name === 'LatexNotPorted') { deferred++; continue; }
    if (c.expErr) { if (r.err && r.err.message === c.expErr) errSame++; else bad.push({ name: c.name, path: '$err', got: r.err && r.err.message, want: c.expErr }); continue; }
    if (c.dagreFeatureError || !fs.existsSync(gp)) { noGolden++; continue; }
    if (r.err) { bad.push({ name: c.name, path: '$err', got: r.err.message, want: 'a diagram' }); continue; }
    const want = JSON.parse(fs.readFileSync(gp, 'utf8'));
    const got = JSON.parse(JSON.stringify(r.diagram));
    const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
    const d = firstDiff(sortKeys(got), sortKeys(want), "$", tolv); // key order is not compared (v0.9.0 goldens write url.URL fields in another order)
    if (d) bad.push({ name: c.name, ...d }); else same++;
  }
  console.log(`e2e: ${same}/${same + bad.length} dagre goldens identical, ${errSame} expected errors identical, ${noGolden} without golden, ${deferred} deferred (latex)`);
  for (const b of bad.slice(0, Number(flags.includes('--show') ? flags[flags.indexOf('--show') + 1] : 8))) console.log(`\n${b.name}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
  process.exit(bad.length ? 1 : 0);
}
