// D2's own sketch goldens: d2renderers/d2sketch/testdata/<case>/sketch.exp.svg (the TestSketch cases of sketch_test.go).
//   node sketche2e.mjs <D2 source dir> [--show N]
// Each case is compiled by the JS port exactly as the Go test does (RenderOpts{Sketch: true, ThemeID}, FontFamily HandDrawn, dagre; the ELK case is
// skipped), rendered with `fonts: 'embed'` and compared byte for byte with the golden. This tests the whole JS pipeline in sketch mode (layout with the
// HandDrawn font, SVG, rough drawing), not just the renderer. (The e2etests' `sketch.exp.svg` files are NOT sketch renders: the name is historical and
// those tests render without the Sketch option, which `diff.mjs svg e2esvg.jsonl` covers.)
import fs from 'node:fs';
import path from 'node:path';
import markdownit from 'markdown-it';
import { init as initD2, compile } from '../../public/d2/d2lib.js';
import { renderAsync } from '../../public/d2/d2svg.js';
import * as d2fonts from '../../public/d2/fonts.js';
import * as themes from '../../public/d2/themes.js';

const src = process.argv[2];
const show = process.argv.includes('--show') ? Number(process.argv[process.argv.indexOf('--show') + 1]) : 3;
const dir = path.join(src, 'd2renderers/d2sketch');
const text = fs.readFileSync(path.join(dir, 'sketch_test.go'), 'utf8');

await initD2({ markdownit });

// the test table: {name: "...", [themeID: ...,] [engine: "elk",] script: `...`}
const cases = [];
const re = /\{\s*name:\s*"((?:[^"\\]|\\.)*)",(?:\s*(?:themeID:\s*([\w.]+),|engine:\s*"(\w+)",|skip:\s*(\w+),))*\s*script:\s*`([^`]*)`/g;
for (let m; (m = re.exec(text));) cases.push({ name: m[1], themeID: m[2], engine: m[3] ?? '', skip: m[4] === 'true', script: m[5] });

// runa's names: t.Run replaces spaces with underscores; "_dark" variants are generated from the table below the cases? (none: they are explicit)
const themeID = (s) => {
  if (s == null) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const name = s.replace(/^d2themescatalog\./, '').replace(/\.ID$/, '');
  const t = Object.values(themes).find((x) => x && x.name === name.replace(/([a-z])([A-Z])/g, '$1 $2'));
  if (!t) throw new Error(`theme ${s}`);
  return t.id;
};

let same = 0, skipped = 0, nogolden = 0;
const bad = [];
for (const c of cases) {
  const dirName = c.name.replace(/ /g, '_');
  const gold = path.join(dir, 'testdata', dirName, 'sketch.exp.svg');
  if (c.skip || c.engine === 'elk') { skipped++; continue; }
  if (!fs.existsSync(gold)) { nogolden++; continue; }
  const ro = { sketch: true, themeID: themeID(c.themeID) };
  let got;
  try {
    const r = await compile(c.script, { layout: 'dagre', fontFamily: d2fonts.HandDrawn }, ro);
    if (r.err) { bad.push({ name: c.name, d: `compile: ${r.err.message}` }); continue; }
    got = await renderAsync(r.diagram, { ...ro, fonts: 'embed' });
  } catch (e) { bad.push({ name: c.name, d: String(e.stack || e) }); continue; }
  const want = fs.readFileSync(gold, 'utf8');
  if (got === want) { same++; continue; }
  let i = 0;
  while (i < got.length && got[i] === want[i]) i++;
  bad.push({ name: c.name, d: `first difference at char ${i} of ${got.length}/${want.length}\n  got  ${JSON.stringify(got.slice(Math.max(0, i - 80), i + 120))}\n  want ${JSON.stringify(want.slice(Math.max(0, i - 80), i + 120))}` });
}
console.log(`sketch goldens: ${same}/${cases.length - skipped - nogolden} identical to D2's sketch.exp.svg (${skipped} skipped: elk, ${nogolden} without golden)`);
for (const b of bad.slice(0, show)) console.log(`\n${b.name}: ${b.d}`);
process.exitCode = bad.length ? 1 : 0;
