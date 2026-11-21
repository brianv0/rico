// Differential test: the JS port (public/d2/) against the Go reference (this directory).
//
//   go run . corpus <D2 v0.7.2 source dir> > corpus.jsonl     # once; source: proxy.golang.org/oss.terrastruct.com/d2/@v/v0.7.2.zip
//   node diff.mjs parse corpus.jsonl [--utf16] [--only N] [--show 5]
//
// Each stage maps a case to the same JSON the Go mode prints. Add a stage here as each layer is ported.
// Output: counts, then the first --show mismatches with the JSON path of the first difference.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../public/d2/parser.js';

import markdownit from 'markdown-it';
import { setMarkdownIt, loadMetrics, newRuler, getTextDimensionsWithMono, measureMarkdown, renderMarkdown } from '../../public/d2/textmeasure.js';
import * as d2fonts from '../../public/d2/fonts.js';
import { shapeCheck } from './shapecheck.mjs';

setMarkdownIt(markdownit);
await loadMetrics();
const ruler = newRuler();

// measure: input lines {text, fontFamily?, monoFamily?, fontSize, bold?, italic?, language?, markdown?} (see measurecorpus.mjs)
function measure(c) {
  const family = c.fontFamily || null, mono = c.monoFamily || null;
  if (c.markdown) {
    const [width, height] = measureMarkdown(c.text, ruler, family, mono, c.fontSize);
    return { width, height, err: null };
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
};

const [mode, file, ...flags] = process.argv.slice(2);
const flag = (name, def) => { const i = flags.indexOf(name); return i < 0 ? def : flags[i + 1] ?? true; };
if (!STAGES[mode] || !file) {
  console.error(`usage: node diff.mjs <${Object.keys(STAGES).join('|')}> corpus.jsonl [--utf16] [--only N] [--show 5]`);
  process.exit(2);
}
const utf16 = flags.includes('--utf16');
let cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => ({ ...JSON.parse(l), utf16 }));
if (flag('--only') !== undefined) cases = [cases[Number(flag('--only'))]];

const here = path.dirname(fileURLToPath(import.meta.url));
const ref = execFileSync('go', ['run', '.', mode], { cwd: here, input: cases.map((c) => JSON.stringify(c)).join('\n'), maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
  .toString().trim().split('\n');

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
function firstDiff(a, b, p = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 200), want: JSON.stringify(b)?.slice(0, 200) };
}

let same = 0, panics = 0;
const bad = [];
const t0 = performance.now();
cases.forEach((c, i) => {
  const want = JSON.parse(ref[i]);
  if (want.panic) { panics++; return; } // Go itself panicked: nothing to match
  let got;
  try { got = canon(JSON.parse(JSON.stringify(STAGES[mode](c)))); } catch (e) { got = { threw: String(e.stack || e) }; }
  const d = firstDiff(got, canon(want));
  if (d) bad.push({ i, from: c.from ?? JSON.stringify(c).slice(0, 160), ...d }); else same++;
});
console.log(`${mode}${utf16 ? ' (utf16)' : ''}: ${same}/${cases.length - panics} identical to Go` + (panics ? `, ${panics} skipped (Go panicked)` : '') + `, JS ${(performance.now() - t0) | 0}ms`);
for (const b of bad.slice(0, Number(flag('--show', 5)))) console.log(`\n#${b.i} ${b.from}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
process.exitCode = bad.length ? 1 : 0;
