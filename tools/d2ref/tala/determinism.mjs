// Runs Go's TALA (d2talalayout.Layout with its goroutines: seeds in parallel, routing workers, placementcost workers)
// N times on the same cases and reports the cases whose output differs between runs.
//
//   node tala/determinism.mjs cases.jsonl [runs=50] [--load]     (--load: also keeps all CPUs busy, so goroutine scheduling varies)
//
// Needs $TALA_REF/xdump.bin (tala/setup.sh). Prints one line per nondeterministic case and a summary.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const [file, runsArg, ...flags] = process.argv.slice(2);
const runs = Number(runsArg || 50);
const bin = (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';
const input = fs.readFileSync(file);
const hashes = []; // hashes[run][case]

let burners = [];
if (flags.includes('--load')) {
  for (let i = 0; i < os.cpus().length; i++) burners.push(spawn('sh', ['-c', 'while :; do :; done'], { stdio: 'ignore' }));
}

for (let r = 0; r < runs; r++) {
  const out = execFileSync(bin, ['layout'], { input, maxBuffer: 1 << 30 }).toString().trim().split('\n');
  hashes.push(out.map((l) => createHash('sha1').update(l).digest('hex').slice(0, 12)));
  process.stderr.write(`run ${r + 1}/${runs}\r`);
}
for (const b of burners) b.kill();
const n = hashes[0].length;
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let diff = 0;
for (let i = 0; i < n; i++) {
  const distinct = new Set(hashes.map((h) => h[i]));
  if (distinct.size > 1) {
    diff++;
    console.log(`#${i} ${cases[i].from ?? cases[i].name ?? ''}: ${distinct.size} distinct outputs in ${runs} runs`);
  }
}
console.log(`${n} cases x ${runs} runs: ${diff} cases with differing output${flags.includes('--load') ? ' (under full CPU load)' : ''}`);
