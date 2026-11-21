// Checks that the Go harness reproduces D2's own TALA goldens: runs `xdump layout` (seeds [1], as the e2e tests do) on tala-e2e.jsonl and
// compares the shapes (id, position, size) and connections (route, label position) with e2etests/testdata/<name>/tala/board.exp.json.
//   node tala/e2egolden.mjs [tala-e2e.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, '..', 'tala-e2e.jsonl');
const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const out = execFileSync(bin, ['layout'], { input: cases.map((c) => JSON.stringify(c)).join('\n'), maxBuffer: 1 << 30 }).toString().trim().split('\n');
const pick = (d) => ({
  shapes: (d.shapes || []).map((s) => [s.id, s.pos.x, s.pos.y, s.width, s.height]),
  connections: (d.connections || []).map((c) => [c.id, c.route, c.labelPosition ?? null, c.labelPercentage ?? null]),
});
const boards = (d) => [d, ...(d.layers || []).flatMap(boards), ...(d.scenarios || []).flatMap(boards), ...(d.steps || []).flatMap(boards)];
let same = 0, errs = 0;
const bad = [];
cases.forEach((c, i) => {
  const r = JSON.parse(out[i]);
  if (r.err || r.panic || !r.diagram) { errs++; bad.push(`${c.name}: ${r.err || r.panic}`); return; }
  const want = JSON.parse(fs.readFileSync(c.golden, 'utf8'));
  const a = JSON.stringify(boards(r.diagram).map(pick)), b = JSON.stringify(boards(want).map(pick));
  if (a === b) same++; else bad.push(`${c.name}: differs`);
});
console.log(`${cases.length} e2e cases with a TALA golden: ${same} identical to the golden, ${errs} Go errors, ${cases.length - same - errs} differ`);
for (const b of bad.slice(0, 15)) console.log('  ' + b.slice(0, 200));
