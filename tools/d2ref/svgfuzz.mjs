// node svgfuzz.mjs <corpus.jsonl|e2esvg.jsonl> N seed > svgfuzz.jsonl: N cases from the input with random render options (ropts) of
// d2svg.RenderOpts: pad (also invalid ones), scale, center, theme and dark theme ids, salt, noXMLTag, omitVersion, masterID (collapsed
// multiboard rendering), theme overrides. Use with `node diff.mjs svg svgfuzz.jsonl`.
import fs from 'node:fs';

const [file, n, seed0] = process.argv.slice(2);
let seed = Number(seed0 || 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[(rnd() * a.length) | 0];
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
const lightThemes = [0, 1, 3, 4, 5, 6, 7, 8, 100, 101, 102, 103, 104, 105, 300, 301, 302, 303];
const darkThemes = [200, 201];
const colors = ['#ff0000', '#00aa33', 'rebeccapurple', '#123', 'rgb(10, 20, 30)'];
for (let i = 0; i < Number(n); i++) {
  const c = JSON.parse(lines[(rnd() * lines.length) | 0]);
  const r = {};
  if (rnd() < 0.3) r.pad = pick([0, 1, 5, 20, 50, 100, 200, -10, -1000, 9007199254740, 3000000000]);
  if (rnd() < 0.3) r.scale = pick([0.5, 1, 1.5, 2, 0.333, 0.1]);
  if (rnd() < 0.3) r.center = rnd() < 0.5;
  if (rnd() < 0.4) r.themeID = pick(lightThemes.concat(darkThemes));
  if (rnd() < 0.3) r.darkThemeID = pick(darkThemes.concat(lightThemes.slice(0, 3)));
  if (rnd() < 0.2) r.salt = pick(['', 'salt', 'a b', 'é']);
  if (rnd() < 0.2) r.noXMLTag = rnd() < 0.5;
  if (rnd() < 0.2) r.omitVersion = rnd() < 0.5;
  if (rnd() < 0.15) r.masterID = pick(['d2-master', 'x']);
  if (rnd() < 0.2) r.themeOverrides = Object.fromEntries(['n1', 'b2', 'b5', 'aa2', 'n7'].filter(() => rnd() < 0.5).map((k) => [k, pick(colors)]));
  if (rnd() < 0.1) r.darkThemeOverrides = { n1: pick(colors) };
  if (c.ropts) Object.assign(r, c.ropts);
  c.ropts = r;
  c.from = `${c.from || c.path || ''} ${JSON.stringify(r)}`;
  process.stdout.write(JSON.stringify(c) + '\n');
}
