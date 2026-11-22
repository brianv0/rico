// Shared by the engine/root checks: running the Go harness (xdump) on case files.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as bigjson from '../../../public/d2/tala/bigjson.js';

export const bin = () => (process.env.TALA_REF || '/tmp/tala-ref') + '/xdump.bin';

/** runs `xdump <mode>` on the cases (objects, printed with bigjson) and returns the parsed outputs (bigjson) */
export function runGo(mode, cases, batch = 10) {
  const out = [];
  for (let i = 0; i < cases.length; i += batch) {
    const part = cases.slice(i, i + batch);
    let lines;
    try {
      lines = execFileSync(bin(), [mode], { input: part.map((c) => bigjson.stringify(c)).join('\n') + '\n', maxBuffer: 1 << 30, timeout: 120000 + 20000 * part.length, stdio: ['pipe', 'pipe', 'ignore'] })
        .toString().trim().split('\n');
    } catch (e) {
      if (part.length === 1) { out.push({ panic: 'Go crashed (fatal error)' }); continue; }
      const h = part.length >> 1;
      out.push(...runGo(mode, part.slice(0, h), 1), ...runGo(mode, part.slice(h), 1));
      continue;
    }
    for (const l of lines) out.push(bigjson.parse(l));
  }
  return out;
}

export const loadCases = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => bigjson.parse(l));

