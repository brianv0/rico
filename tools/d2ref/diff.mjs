// Differential test: the JS parser (public/d2/) against the Go reference (tools/d2ref, run via `go run`).
import { parse } from '../../public/d2/parser.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// inputs: D2's own test texts are inside Go source; use a mixed corpus of all .d2 testdata files + edge cases
// Usage: node tools/d2ref/diff.mjs <path to D2 v0.7.2 source, e.g. from proxy.golang.org/oss.terrastruct.com/d2/@v/v0.7.2.zip>
const root = process.argv[2];
const files = execFileSync('find', [root, '-name', '*.d2', '-size', '-200k']).toString().trim().split('\n');
const extra = ['', ';;;};;;', 'x -> y -> z', '(a -> b)[0].style: {x: 1}', 'a: |md\n  # hi\n|', 'a.*.b: 0.4', 'x: ${v}', 'x: [1; ...${a}; ...@f]', '"unterminated', 'a: 👋 -> b', 'x: |||`\n a | b\n`|||', '&a: 1\n!&b: 2', 'a -\\\n> b', 'x: 1e3', 'x: 0x1F', 'x: 1/3', 'x: NULL', "x: 'it''s'"];
const cases = [...extra.map((t, i) => ({ path: `e${i}.d2`, text: t })), ...files.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }))];
const all = [];
for (const u of [false, true]) for (const c of cases) all.push({ ...c, utf16: u });
const ref = execFileSync('go', ['run', '.', 'parse'], { cwd: path.dirname(fileURLToPath(import.meta.url)), input: all.map((c) => JSON.stringify(c)).join('\n'), maxBuffer: 1 << 30 }).toString().trim().split('\n');
let bad = 0; const t0 = performance.now();
all.forEach((c, i) => {
  const got = JSON.stringify(parse(c.path, c.text, { utf16: c.utf16 }));
  const want = JSON.stringify(JSON.parse(ref[i]));
  const norm = (s) => JSON.stringify(sortKeys(JSON.parse(s)));
  if (norm(got) !== norm(want)) { if (bad++ < 3) console.log('MISMATCH', c.path, c.utf16, '\n got', got.slice(0, 300), '\nwant', want.slice(0, 300)); }
});
function sortKeys(v) { return Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v; }
console.log(`${all.length - bad}/${all.length} identical to Go (${files.length} D2 testdata files + ${extra.length} edge cases, utf8+utf16)`, ((performance.now() - t0) | 0) + 'ms');
