// Engine-level diff: roughjs 4.6.6 (public/d2/vendor/rough.js, what d2sketch.js draws with) against rough-go (what D2 v0.9.0 draws with),
// on the very generator calls d2sketch makes.
//   node roughcmp.mjs cases.jsonl [d2ref binary] [--fuzz N seed] [--arcs]
// cases.jsonl: svg-stage inputs (text cases are compiled by the JS port, cases with a `diagram` such as e2esvg.jsonl are rendered as they are).
// Every case is rendered in sketch mode with the generator wrapped to record each call (kind, arguments, options) and the paths
// `toPaths` returned for it; the distinct calls go to `d2ref rough` (rough-go) and the answers are compared exactly: d, stroke,
// strokeWidth and fill of every path, before d2sketch's six-decimal truncation. --fuzz adds N random calls with D2's option profiles
// (shape strokes, arrowheads, connection roughness) on random geometry: rectangles, ellipses, lines, polygons and SVG paths (M L H V C Q l; D2
// never emits arcs, and with --arcs the SVG arc conversion shows differences up to 2e-5 against rough-go, which only claims D2's profile).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';
import { diagramFromJSON } from '../../public/d2/target.js';
import { URL as GoURL } from '../../public/d2/url.js';
import rough from '../../public/d2/vendor/rough.js';
import { render, hooks } from '../../public/d2/d2svg.js';
import * as d2sketch from '../../public/d2/d2sketch.js';
import { svgPrepare } from './svgcheck.mjs';

const args = process.argv.slice(2);
const file = args[0];
const bin = args[1] && !args[1].startsWith('--') ? args[1] : '/tmp/sk-d2ref';
const fi = args.indexOf('--fuzz');
const fuzzN = fi >= 0 ? Number(args[fi + 1]) : 0;
let seed = fi >= 0 ? Number(args[fi + 2] ?? 1) : 1;

setMarkdownIt(markdownit);
await initD2();
await svgPrepare(true);

const calls = []; // {kind, args|pts|path, opts, gen, js: [paths]}
const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
function record(g) {
  return new Proxy(g, {
    get(t, k) {
      const f = t[k];
      if (typeof f !== 'function') return f;
      if (k === 'toPaths') {
        return (d) => {
          const out = t.toPaths(d);
          const c = drawn.get(d);
          if (c) c.js = out.map((p) => ({ d: p.d, stroke: p.stroke, strokeWidth: String(p.strokeWidth), fill: p.fill }));
          return out;
        };
      }
      if (['line', 'rectangle', 'ellipse', 'circle', 'linearPath', 'polygon', 'path'].includes(k)) {
        return (...a) => {
          const opts = a[a.length - 1];
          const c = { kind: k, opts: clone(opts), gen: { seed: 1 } };
          if (k === 'path') c.path = a[0];
          else if (k === 'linearPath' || k === 'polygon') c.pts = a[0].map((p) => [...p]);
          else c.args = a.slice(0, -1);
          const d = t[k](...a);
          drawn.set(d, c);
          calls.push(c);
          return d;
        };
      }
      return f.bind(t);
    },
  });
}
const drawn = new Map();
d2sketch.debug.record = record;

let cases = file && !file.startsWith('--') ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const fixIcons = (d) => {
  const fix = (o) => { if (o.icon != null) o.icon = Object.assign(new GoURL(), o.icon); };
  (d.shapes ?? []).forEach(fix); (d.connections ?? []).forEach(fix); fix(d.root);
  for (const k of ['layers', 'scenarios', 'steps']) (d[k] ?? []).forEach(fixIcons);
  return d;
};
let rendered = 0;
for (const c of cases) {
  try {
    let diagram, ro = {};
    if (c.diagram) diagram = fixIcons(diagramFromJSON(JSON.parse(JSON.stringify(c.diagram))));
    else {
      const r = d2compile(c.text, { fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'dagre' }, ro = { sketch: true });
      if (r.err) continue;
      diagram = r.diagram;
    }
    render(diagram, { ...ro, sketch: true, fonts: 'embed' });
    rendered++;
  } catch (e) { /* deferred or invalid: its calls so far are still valid calls */ }
}
const fromCases = calls.length;

// random calls in D2's option profiles
function rnd() { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[ri(0, a.length - 1)];
const dim = () => (rnd() < 0.5 ? ri(1, 400) : Math.round(rnd() * 80000) / 100);
const base = (sw) => ({ fill: '#000', stroke: '#000', strokeWidth: sw, fillWeight: 2, hachureGap: 16, fillStyle: 'solid', bowing: 2, seed: 1 });
const arrow = (stroke, sw, seed2, fill, fw, style) => ({ strokeWidth: sw, stroke, seed: seed2, ...(fill ? { fill, fillStyle: style ?? 'solid', ...(fw >= 0 ? { fillWeight: fw } : {}) } : {}) });
function pathData() {
  const n = ri(1, 8);
  let d = `M${dim()} ${dim()}`;
  for (let i = 0; i < n; i++) {
    switch (ri(0, 6)) {
      case 0: d += ` L${dim()} ${dim()}`; break;
      case 1: d += ` H${dim()}`; break;
      case 2: d += ` V${dim()}`; break;
      case 3: d += ` C${dim()} ${dim()} ${dim()} ${dim()} ${dim()} ${dim()}`; break;
      case 4: d += ` Q${dim()} ${dim()} ${dim()} ${dim()}`; break;
      case 5: if (!args.includes('--arcs')) { d += ` Q${dim()} ${dim()} ${dim()} ${dim()}`; break; } d += ` A${ri(1, 80)} ${ri(1, 80)} ${ri(0, 90)} ${ri(0, 1)} ${ri(0, 1)} ${dim()} ${dim()}`; break;
      default: d += ` l${ri(-50, 50)} ${ri(-50, 50)}`;
    }
  }
  return rnd() < 0.5 ? d + ' Z' : d;
}
for (let i = 0; i < fuzzN; i++) {
  const g = record(rough.generator({ options: { seed: 1 } }));
  const sw = pick([1, 2, 3, 4, 5, 6, 8, 10, 15]);
  const stroke = pick(['#0A0F25', 'B1', '#fff', 'red']);
  let d;
  switch (ri(0, 9)) {
    case 0: d = g.rectangle(0, 0, dim(), dim(), base(sw)); break;
    case 1: { const w = dim(), h = dim(); d = g.ellipse(Math.trunc(w / 2), Math.trunc(h / 2), w, h, base(sw)); break; }
    case 2: d = g.line(ri(0, 300), ri(0, 300), dim(), dim(), base(1)); break;
    case 3: d = g.path(pathData(), base(sw)); break;
    case 4: d = g.path(pathData(), { roughness: 0.5, seed: 1 }); break;
    case 5: d = g.polygon([[-20, 0], [-10, 5], [0, 0], [-10, -5], [-20, 0]], { ...arrow(stroke, sw, ri(1, 8), '#fff', -1), ...(rnd() < 0.5 ? { fillStyle: 'zigzag', fillWeight: 4 } : {}) }); break;
    case 6: d = g.linearPath([[-10, -4], [0, 0], [-10, 4]], arrow(stroke, sw, ri(1, 8))); break;
    case 7: d = g.circle(ri(-30, 0), ri(-3, 3), 8, arrow(stroke, sw, ri(1, 8), '#fff', 1)); break;
    case 8: d = g.path(pick(['M-15,-10 -15,10 M0,10 -15,0 M0,-10 -15,0', 'M0,10 -15,0 M0,-10 -15,0', 'M-10,-10 -10,10']), arrow(stroke, sw, ri(1, 8), stroke, 4)); break;
    default: { const pts = Array.from({ length: ri(3, 7) }, () => [ri(-30, 30), ri(-30, 30)]); d = g.polygon(pts, arrow(stroke, sw, ri(1, 8), stroke, -1)); }
  }
  g.toPaths(d);
}

// distinct calls
const uniq = new Map();
for (const c of calls) { const k = JSON.stringify([c.kind, c.args, c.pts, c.path, c.opts]); if (!uniq.has(k)) uniq.set(k, c); }
const list = [...uniq.values()].filter((c) => c.js);
const input = list.map((c) => JSON.stringify({ rough: { kind: c.kind, args: c.args, pts: c.pts, path: c.path, opts: c.opts, gen: c.gen } }) + '\n').join('');
const out = execFileSync(bin, ['rough'], { input, maxBuffer: 1 << 30 }).toString().trim().split('\n');
let same = 0, truncSame = 0, tolSame = 0, goErr = 0;
const bad = [], tolBy = {}, badBy = {}, truncBy = {};
const trunc = (d) => d.replace(/(\d+)\.(\d+)/g, (m) => { const i = m.indexOf('.'); return m.slice(0, i + 1 + Math.min(m.length - i - 1, 6)); }); // d2sketch.truncatePathData
const numRE = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g;
// libm: roughjs gets sin/cos from V8's fdlibm, rough-go from Go's, so an ellipse can differ in the last bit; d2sketch cuts every number to six decimals
function within(a, b, tol) {
  const ta = a.split(numRE), tb = b.split(numRE);
  if (JSON.stringify(ta) !== JSON.stringify(tb)) return false;
  const na = a.match(numRE) ?? [], nb = b.match(numRE) ?? [];
  return na.length === nb.length && na.every((x, i) => Math.abs(x - nb[i]) <= tol * Math.max(1, Math.abs(x)));
}
list.forEach((c, i) => {
  const want = JSON.parse(out[i]);
  if (want.panic || want.err) { goErr++; return; }
  const norm = (ps, f = (d) => d) => JSON.stringify(ps.map((p) => [f(p.d), p.stroke, p.strokeWidth, p.fill]));
  const a = norm(c.js), b = norm(want.paths);
  if (a === b) { same++; return; }
  if (norm(c.js, trunc) === norm(want.paths, trunc)) { truncSame++; truncBy[c.kind] = (truncBy[c.kind] || 0) + 1; return; }
  const cat = c.kind + (c.path && /A/.test(c.path) ? '+arc' : '');
  if (c.js.length === want.paths.length && c.js.every((p, k) => p.stroke === want.paths[k].stroke && p.strokeWidth === want.paths[k].strokeWidth && p.fill === want.paths[k].fill && within(p.d, want.paths[k].d, 1e-12))) { tolSame++; tolBy[cat] = (tolBy[cat] || 0) + 1; return; }
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  badBy[cat] = (badBy[cat] || 0) + 1;
  bad.push({ c, at: k, js: a.slice(Math.max(0, k - 60), k + 100), go: b.slice(Math.max(0, k - 60), k + 100) });
});
console.log(`rough: ${same}/${list.length - goErr} distinct calls identical to rough-go` + `, ${truncSame} more identical after d2sketch's six-decimal truncation (last-bit libm differences), ${tolSame} more within 1e-12 only (${bad.length} different)`
  + ` (${calls.length} calls: ${fromCases} from ${rendered} rendered cases, ${calls.length - fromCases} fuzzed)` + (goErr ? `, ${goErr} skipped (rough-go error/panic)` : ''));
console.log('last-bit only, by kind: ' + JSON.stringify(truncBy));
console.log('within 1e-12 only, by kind: ' + JSON.stringify(tolBy) + '; different, by kind: ' + JSON.stringify(badBy));
const by = {};
for (const c of list) by[c.kind] = (by[c.kind] || 0) + 1;
console.log('calls by kind: ' + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', '));
for (const b of bad.slice(0, 8)) console.log(`\n${b.c.kind} ${JSON.stringify(b.c.args ?? b.c.pts ?? b.c.path)} ${JSON.stringify(b.c.opts)}\n  at ${b.at}\n  js ${b.js}\n  go ${b.go}`);
process.exitCode = bad.length ? 1 : 0;
