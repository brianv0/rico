// Builds the TALA corpus files (gitignored, *.jsonl) next to corpus.jsonl:
//
//   tala-corpus.jsonl    every case of corpus.jsonl (D2's own tests) with layout 'tala'
//   tala-e2e.jsonl       the cases of e2e.jsonl that have a golden e2etests/testdata/<name>/tala/board.exp.json
//                        ({name, text, seeds: [1], golden: <path of the golden>}; the e2e tests run TALA with Seeds [1])
//   tala-fixtures.jsonl  graphjson fixtures of d2talalayout/internal/testdata: {name, graph, seeds?: [123], golden?}
//                        (layout/<n>/graph.input.json with its graph.exp.json, layout inputs' goldens as fixtures too,
//                        regression/*.json, benchmark/*.json)
//
//   node tala/corpus.mjs [d2 source dir]      (default: $D2_SRC, else $TALA_REF, else /tmp/tala-ref)
//
// corpus.jsonl comes from `go run . corpus <D2 source>`, e2e.jsonl from e2eenum/run.sh (see docs/d2-port.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = process.argv[2] || process.env.D2_SRC || process.env.TALA_REF || '/tmp/tala-ref';
const lines = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const write = (name, rows) => {
  fs.writeFileSync(path.join(root, name), rows.map((r) => bigjson.stringify(r)).join('\n') + '\n');
  console.log(name, rows.length);
};

write('tala-corpus.jsonl', lines(path.join(root, 'corpus.jsonl')).map((c) => ({ ...c, layout: 'tala' })));

const e2e = lines(path.join(root, 'e2e.jsonl'));
const rows = [];
for (const c of e2e) {
  const golden = path.join(src, 'e2etests/testdata', c.name, 'tala/board.exp.json');
  if (!fs.existsSync(golden)) continue;
  rows.push({ name: c.name, path: 'index.d2', text: c.text, layout: 'tala', seeds: [1], themeID: c.themeID, golden });
}
write('tala-e2e.jsonl', rows);

const td = path.join(src, 'd2layouts/d2talalayout/internal/testdata');
const fixtures = [];
const readJSON = (f) => bigjson.parse(fs.readFileSync(f, 'utf8')); // exact 64-bit IDs
for (const n of fs.readdirSync(path.join(td, 'layout')).sort()) {
  const dir = path.join(td, 'layout', n);
  const input = path.join(dir, 'graph.input.json');
  const exp = path.join(dir, 'graph.exp.json');
  if (fs.existsSync(input)) fixtures.push({ name: `layout/${n}`, graph: readJSON(input), seeds: [123], golden: fs.existsSync(exp) ? exp : undefined });
  if (fs.existsSync(exp)) fixtures.push({ name: `layout/${n}/exp`, graph: readJSON(exp) });
}
for (const sub of ['regression', 'benchmark']) {
  for (const f of fs.readdirSync(path.join(td, sub)).sort()) {
    if (f.endsWith('.json')) fixtures.push({ name: `${sub}/${f.slice(0, -5)}`, graph: readJSON(path.join(td, sub, f)), seeds: [123] });
  }
}
for (const n of fs.readdirSync(path.join(td, 'ovg')).sort()) {
  const input = path.join(td, 'ovg', n, 'graph.input.json');
  if (fs.existsSync(input)) fixtures.push({ name: `ovg/${n}`, graph: readJSON(input), seeds: [123] });
}
write('tala-fixtures.jsonl', fixtures);
