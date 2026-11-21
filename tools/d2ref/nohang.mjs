// Drops the cases on which the Go reference does not finish in a few seconds (D2's glob evaluation can loop or explode on
// adversarial input), so that a fuzz file can go through diff.mjs:  node nohang.mjs <stage> in.jsonl > out.jsonl
// Needs the reference built once: `go build -o /tmp/d2refbin .`  (pass its path as D2REF).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const [stage, file] = process.argv.slice(2);
const bin = process.env.D2REF || '/tmp/d2refbin';
let dropped = 0;
for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
  const r = spawnSync(bin, [stage], { input: line, timeout: 4000, maxBuffer: 1 << 28 });
  if (r.error || r.signal) { dropped++; continue; }
  console.log(line);
}
console.error(`dropped ${dropped}`);
