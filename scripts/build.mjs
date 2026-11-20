// Build the static assets for the Cloudflare Worker: public/ plus the vendored browser libraries, into dist/.
// Run: node scripts/build.mjs   (npm run build)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorFiles } from '../src/vendor-map.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });
let n = 0;
for (const [url, file] of Object.entries(vendorFiles(path.join(root, 'node_modules')))) {
  if (!fs.existsSync(file)) { console.warn('skipped (not installed):', url); continue; }
  const to = path.join(dist, url);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(file, to);
  n++;
}
console.log(`dist/ ready: public/ + ${n} vendor files`);
