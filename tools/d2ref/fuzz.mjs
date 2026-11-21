// Mutation fuzzer for the differential harness: node fuzz.mjs corpus.jsonl [count] [seed] > fuzz.jsonl
// Takes corpus cases, applies a few random edits (drop/duplicate/swap lines, delete/insert characters taken from
// D2's syntax, splice two cases) and prints them as cases, for `node diff.mjs <stage> fuzz.jsonl`.
import fs from 'node:fs';

const [file, count = '2000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const syntax = ['*', '**', '***', '&', '!&', '_', '.', '->', '<-', '<->', '--', ':', ';', '{', '}', '[', ']', '(', ')', '${x}', '...${x}', '@x', '...@x', 'vars', 'layers', 'steps', 'scenarios', 'classes', 'class', 'style', 'label', 'shape', 'null', 'suspend', 'unsuspend', '"', "'", '|', '#', '\n', ' ', 'x', 'y', 'a', '1', '[*]', '[0]', 'link', 'icon', 'link: layers.x', 'near', 'sql_table', 'İ', 'é', '🙂'];

function mutate(t) {
  const lines = t.split('\n').map((l) => Array.from(l)); // code points, so an edit never splits a surrogate pair
  for (let n = 1 + Math.floor(rnd() * 3); n > 0; n--) {
    const r = rnd();
    const i = Math.floor(rnd() * lines.length);
    if (r < 0.15) lines.splice(i, 1);
    else if (r < 0.3) lines.splice(i, 0, lines[i] ?? []);
    else if (r < 0.4) { const j = Math.floor(rnd() * lines.length); [lines[i], lines[j]] = [lines[j], lines[i]]; }
    else if (r < 0.7) { const s = lines[i] ?? []; const k = Math.floor(rnd() * (s.length + 1)); lines[i] = [...s.slice(0, k), ...Array.from(pick(syntax)), ...s.slice(k)]; }
    else if (r < 0.85) { const s = lines[i] ?? []; const k = Math.floor(rnd() * s.length); lines[i] = [...s.slice(0, k), ...s.slice(k + 1 + Math.floor(rnd() * 3))]; }
    else lines.splice(i, 0, ...pick(cases).text.split('\n').slice(0, 1 + Math.floor(rnd() * 6)).map((l) => Array.from(l)));
  }
  return lines.map((l) => (l || []).join('')).join('\n');
}

for (let i = 0; i < Number(count); i++) {
  const c = pick(cases);
  const m = { from: `fuzz:${c.from}`, path: c.fs ? 'index.d2' : c.path, text: mutate(c.text) };
  if (c.fs) {
    m.fs = { ...c.fs };
    if (rnd() < 0.5) { const k = pick(Object.keys(m.fs)); if (k) m.fs[k] = mutate(m.fs[k]); }
  }
  console.log(JSON.stringify(m));
}
