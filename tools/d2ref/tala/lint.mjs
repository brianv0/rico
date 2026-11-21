// Lint for the naming rule of the TALA port (docs/d2-tala-port.md, "Names"): where a Go type has a field and a method whose names differ only in
// the case of the first letter, the plain name is the exported member and the unexported one gets a trailing underscore. A method used without
// a call, or a field used as a function, is a silent bug (a function is always truthy), so check the known pairs. Also checks for literal U+2028/9.
//   node tala/lint.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../public/d2/tala');
// [plain name that is a METHOD, ...]: `.name` must be followed by `(`; `.name_` (the unexported FIELD) must not be.
const methodsPlain = ['isContainer', 'isClusterVessel', 'shapeType', 'crossingCost', 'turnCost', 'nonCenterPortCost', 'hierarchyRankWeight', 'positionFixed'];
// [`name_` that is a METHOD while the plain `name` is a FIELD]: `.container_` must be called, `.container(` must never be called.
const methodsUnderscored = ['container'];
let bad = 0;
// the field/method pairs exist in layoutgraph.js (and its users); other files hold plain records with the same property names
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, '');
    const record = f !== 'layoutgraph.js' || /this\.(crossingCost|turnCost|nonCenterPortCost)\b|snapshot\./.test(code); // PlacementCostSnapshot is a record
    for (const m of record ? [] : methodsPlain) {
      if (new RegExp(`\\.${m}\\b(?!_|\\()`).test(code) && !new RegExp(`^\\s*${m}\\(`).test(code)) { console.log(`${f}:${i + 1}: .${m} is a method (call it) -- ${l.trim()}`); bad++; }
      if (new RegExp(`\\.${m}_\\(`).test(code)) { console.log(`${f}:${i + 1}: .${m}_ is a field, not a method -- ${l.trim()}`); bad++; }
    }
    for (const m of methodsUnderscored) {
      if (new RegExp(`\\.${m}_\\b(?!\\()`).test(code)) { console.log(`${f}:${i + 1}: .${m}_ is a method (call it) -- ${l.trim()}`); bad++; }
      if (new RegExp(`\\.${m}\\(`).test(code)) { console.log(`${f}:${i + 1}: .${m} is a field, the method is ${m}_() -- ${l.trim()}`); bad++; }
    }
    if (/[\u2028\u2029]/.test(l)) { console.log(`${f}:${i + 1}: literal U+2028/U+2029`); bad++; }
  });
}
console.log(bad ? `${bad} problems` : 'tala lint: clean');
process.exitCode = bad ? 1 : 0;
