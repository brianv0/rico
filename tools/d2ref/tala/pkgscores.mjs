// The per-seed `scores` dump of the whole corpus against the JS quality port, and the seed selection that follows from it:
//
//   node tala/pkgscores.mjs [tala-corpus.jsonl] [tala-pkg-quality.jsonl]
//
// Runs xdump `scores` (the real engine, seeds {1,2,3}: per invocation and seed the penalty and area of the completed layout, and
// `selected`, the index of the seed the real selection keeps before the compound candidate) on every case of the corpus; the completed
// layout of every seed (the graph after the last pipeline stage, recorded by tala/pkgcorpus.mjs as the `/36-quality` cases) is evaluated
// by the JS port (quality.evaluateWithArea, with the deep state) and must give exactly Go's penalty and area; Score.compare with "the
// later seed wins a tie" must pick Go's `selected`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as quality from '../../../public/d2/tala/quality.js';
import * as context from '../../../public/d2/tala/context.js';
import { loadGraph } from './pkgcheck.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const casesFile = path.join(root, process.argv[2] || 'tala-corpus.jsonl');
const qualityFile = path.join(root, process.argv[3] || 'tala-pkg-quality.jsonl');
const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';

// the stage-36 graphs by case path, invocation and seed
const finals = new Map();
for (const line of fs.readFileSync(qualityFile, 'utf8').trim().split('\n')) {
  if (!line.includes('/36-quality"')) continue;
  const c = bigjson.parse(line);
  const m = /^(corpus\/\d+(?:\.d2)?)\/(\d+)\/s(-?\d+)\/36-quality$/.exec(c.name);
  if (m) finals.set(`${m[1]}/${m[2]}/${m[3]}`, c);
}

const cases = fs.readFileSync(casesFile, 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
let seeds = 0, identical = 0, selections = 0, selectionOK = 0, missing = 0, empty = 0;
const bad = [];
const num = (v) => (v === 'NaN' ? NaN : v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : v);
for (let i = 0; i < cases.length; i += 20) {
  const batch = cases.slice(i, i + 20).map((c, j) => ({ ...c, path: `corpus/${i + j}` }));
  const out = execFileSync('nice', [bin, 'scores'], { input: batch.map((c) => bigjson.stringify(c)).join('\n') + '\n', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim().split('\n');
  out.forEach((line, j) => {
    const r = bigjson.plain(bigjson.parse(line));
    (r.invocations ?? []).forEach((inv, ii) => {
      const scores = [];
      for (const s of inv.seeds ?? []) {
        if (s.err !== undefined || s.penalty === undefined) { scores.push(null); continue; }
        const c = finals.get(`${batch[j].path}/${ii}/${s.seed}`);
        if (!c) {
          // a diagram without nodes never enters the pipeline (no stage graphs): its score is (0, 0)
          if (num(s.penalty) === 0 && num(s.area) === 0) { empty++; scores.push(new quality.Score(0, 0)); } else { missing++; scores.push(null); bad.push(`${batch[j].path}/${ii}/s${s.seed}: no recorded final graph, Go ${s.penalty} ${s.area}`); }
          continue;
        }
        seeds++;
        const [penalty, area] = quality.evaluateWithArea(context.background(), loadGraph(c));
        if (Object.is(penalty, num(s.penalty)) && Object.is(area, num(s.area))) identical++;
        else bad.push(`${batch[j].path}/${ii}/s${s.seed}: JS ${penalty} ${area} Go ${s.penalty} ${s.area}`);
        scores.push(new quality.Score(penalty, area));
      }
      if (inv.selected !== undefined && scores.every((s) => s !== null) && scores.length) {
        selections++;
        let best = -1;
        scores.forEach((s, k) => { if (best < 0 || s.compare(scores[best]) < 0 || (s.compare(scores[best]) === 0 && k > best)) best = k; });
        if (best === inv.selected) selectionOK++;
        else bad.push(`${batch[j].path}/${ii}: JS selects seed index ${best}, Go ${inv.selected}`);
      }
    });
  });
}
console.log(`scores: ${identical}/${seeds} per-seed (penalty, area) identical (+ ${empty} empty layouts scoring 0, ${missing} seeds without a recorded final graph); seed selection ${selectionOK}/${selections} identical`);
for (const b of bad.slice(0, 10)) console.log('  ' + b);
