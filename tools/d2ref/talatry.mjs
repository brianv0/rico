// Runs one JS TALA diff stage on one case and prints the result (or the stack of a bug), and with --go the Go side too.
//   node talatry.mjs <stage: adapter|graphjson|ops|rand|...> <cases.jsonl> <index> [--go] [--json]
// The stage names are the suffixes of diff.mjs's tala* stages (talaadapter -> adapter).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { init as initD2 } from '../../public/d2/d2lib.js';
import { setMarkdownIt, loadMetrics } from '../../public/d2/textmeasure.js';
import * as tc from './talacheck.mjs';
import * as bigjson from '../../public/d2/tala/bigjson.js';

setMarkdownIt(markdownit);
await loadMetrics();
await initD2();
const [stage, file, index, ...flags] = process.argv.slice(2);
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => bigjson.parse(l));
const c = cases[Number(index)];
const fn = tc[`${stage}Stage`];
if (!fn) throw new Error(`no stage ${stage}`);
const show = (v) => (flags.includes('--json') ? bigjson.stringify(v, true) : bigjson.stringify(v).slice(0, 2000));
try {
  console.log('js:', show(fn(c)));
  if (globalThis.__lastErr) console.log(globalThis.__lastErr.stack);
} catch (e) {
  console.log(e.stack);
}
if (flags.includes('--go')) {
  const modes = { adapter: 'adapter', graphjson: 'graphjson', ops: 'lgops', rand: 'rand', nodeshape: 'nodeshape', scores: 'scores', stages: 'stages', fstages: 'fstages' };
  const out = execFileSync((process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin', [modes[stage]], { input: bigjson.stringify(c) + '\n', maxBuffer: 1 << 30 });
  console.log('go:', show(bigjson.parse(out.toString().trim())));
}
