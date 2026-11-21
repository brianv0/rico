// Summarises the output of `xdump.bin times < cases.jsonl`: how many cases lay out, which errors, wall time per case.
//   node tala/stats.mjs times.jsonl [cases.jsonl]
// A layout error is an error that does not come from the D2 compiler (those start with a "file:line:col:" position).
import fs from 'node:fs';

const [file, casesFile] = process.argv.slice(2);
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cases = casesFile ? fs.readFileSync(casesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
let ok = 0, compileErr = 0, layoutErr = 0, panic = 0;
const layoutErrs = [];
const ms = [];
rows.forEach((r, i) => {
  if (r.panic) { panic++; return; }
  if (!r.err) { ok++; ms.push([r.ms, i]); return; }
  if (/^[^\s:]+:\d+:\d+: /.test(r.err) || /\.d2:\d+:\d+/.test(r.err)) { compileErr++; return; }
  layoutErr++;
  layoutErrs.push([i, r.err.slice(0, 160)]);
});
ms.sort((a, b) => a[0] - b[0]);
const q = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))]?.[0];
console.log(`cases ${rows.length}: laid out ${ok}, compile errors ${compileErr}, layout errors ${layoutErr}, Go panics ${panic}`);
console.log(`ms per case (laid out): median ${q(0.5)}, p90 ${q(0.9)}, p99 ${q(0.99)}, max ${ms.at(-1)?.[0]} (case ${ms.at(-1)?.[1]}), total ${ms.reduce((a, b) => a + b[0], 0).toFixed(0)}`);
for (const [i, e] of layoutErrs.slice(0, 30)) console.log(`  #${i} ${cases[i]?.from ?? cases[i]?.name ?? ''}: ${e}`);
