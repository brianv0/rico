// Builds the input of `node diff.mjs target target.jsonl`: the `diagram` of every corpus case that lays out in Go.
//   node targetcorpus.mjs corpus.jsonl > target.jsonl     (runs `go run . layout`, a few minutes)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] || 'corpus.jsonl';
const here = path.dirname(fileURLToPath(import.meta.url));
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
const ref = execFileSync('go', ['run', '.', 'layout'], { cwd: here, input: lines.join('\n'), maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
  .toString().trim().split('\n');
const out = [];
for (const r of ref) {
  let j;
  try { j = JSON.parse(r); } catch { continue; }
  if (j.diagram) out.push(JSON.stringify({ diagram: j.diagram }));
}
process.stdout.write(out.join('\n') + '\n');
