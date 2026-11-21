// Builds the corpora of the packing / labeling / quality checks (gitignored *.jsonl in tools/d2ref):
//
//   node tala/pkgcorpus.mjs [--cases tala-corpus.jsonl] [--max N] [--no-fixtures]
//
// (--tag .fuzz writes tala-pkg-pack.fuzz.jsonl etc. instead; --cases takes any file of D2 cases, e.g. one made by fuzzlayout.mjs)
// runs xdump `pkgcases` (Go; see tala/xdump/pkg_xdump.go) on the TALA corpus (all seeds {1,2,3}) and on the graph fixtures of
// d2talalayout/internal/testdata (seed 123) and writes the isolated-stage cases:
//
//   tala-pkg-pack.jsonl      BinPack (pipeline stages 18 and 32): graph after stage k-1 + deep state, Go's graph after stage k + work units
//   tala-pkg-place.jsonl     PlaceLabels (stage 33)
//   tala-pkg-quality.jsonl   the evaluators on the graphs after stages 17, 24, 32, 33 and 36: Go's penalty, area, metrics, work units
// (the direct per-function cases, where Go runs the function itself, are made by tala/pkgdirect.mjs)
//
// The stage cases carry no Go run: `expect` in args is the recording. Needs tala/setup.sh (xdump.bin) and `node tala/corpus.mjs` (tala-corpus.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const casesFile = path.resolve(root, opt('--cases', 'tala-corpus.jsonl'));
const max = Number(opt('--max', 1e9));
const tag = opt('--tag', ''); // output suffix: tala-pkg-pack<tag>.jsonl (for the fuzz corpora)
const refDir = process.env.TALA_REF || '/tmp/tala-ref';
const bin = refDir + '/xdump.bin';
const src = process.env.D2_SRC || refDir;

const out = {
  pack: fs.openSync(path.join(root, `tala-pkg-pack${tag}.jsonl`), 'w'),
  place: fs.openSync(path.join(root, `tala-pkg-place${tag}.jsonl`), 'w'),
  quality: fs.openSync(path.join(root, `tala-pkg-quality${tag}.jsonl`), 'w'),
};
const counts = { pack: 0, place: 0, quality: 0, errs: 0, seedErrs: 0, inputs: 0 };

function run(inputs) {
  const stdout = execFileSync('nice', [bin, 'pkgcases'], { input: inputs.map((c) => bigjson.stringify(c)).join('\n') + '\n', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  for (const line of stdout.trim().split('\n')) {
    const r = bigjson.parse(line);
    counts.inputs++;
    if (r.panic) { counts.errs++; continue; }
    counts.seedErrs += (r.seedErrs ?? []).length; // seeds whose pipeline failed (they give no cases after the failing stage)
    for (const c of r.cases ?? []) {
      fs.writeSync(out[c.kind], bigjson.stringify(c) + '\n');
      counts[c.kind]++;
    }
  }
}

const cases = fs.readFileSync(casesFile, 'utf8').trim().split('\n').slice(0, max).map((l) => bigjson.parse(l));
for (let i = 0; i < cases.length; i += 20) {
  run(cases.slice(i, i + 20).map((c, j) => ({ ...c, path: `corpus/${i + j}` })));
  process.stderr.write(`\r${Math.min(i + 20, cases.length)}/${cases.length} ${JSON.stringify(counts)}`);
}

if (!argv.includes('--no-fixtures')) {
  const td = path.join(src, 'd2layouts/d2talalayout/internal/testdata');
  const readJSON = (f) => bigjson.parse(fs.readFileSync(f, 'utf8'));
  const fixtures = [];
  for (const n of fs.readdirSync(path.join(td, 'layout')).sort()) {
    const input = path.join(td, 'layout', n, 'graph.input.json');
    if (fs.existsSync(input)) fixtures.push({ path: `fixture/layout/${n}`, graph: readJSON(input), seeds: [123] });
  }
  for (const sub of ['regression', 'benchmark']) {
    for (const f of fs.readdirSync(path.join(td, sub)).sort()) {
      if (f.endsWith('.json')) fixtures.push({ path: `fixture/${sub}/${f.slice(0, -5)}`, graph: readJSON(path.join(td, sub, f)), seeds: [123] });
    }
  }
  for (const n of fs.readdirSync(path.join(td, 'ovg')).sort()) {
    const input = path.join(td, 'ovg', n, 'graph.input.json');
    if (fs.existsSync(input)) fixtures.push({ path: `fixture/ovg/${n}`, graph: readJSON(input), seeds: [123] });
  }
  for (const f of fixtures) {
    try { run([f]); } catch (e) { counts.errs++; }
    process.stderr.write(`\rfixture ${f.path} ${JSON.stringify(counts)}      `);
  }
}
process.stderr.write('\n');
console.log(JSON.stringify(counts));
