// Fallback deploy without Workers Assets: the static app (dist/) is embedded in the Worker itself.
// For environments where the Workers Assets upload cannot be made (it authenticates with a short-lived upload key
// that some API proxies replace). Run after `npm run build`:  node scripts/build-embed.mjs
// then deploy with:  npx wrangler deploy -c wrangler.embed.toml
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'dist-embed');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const files = {};
const TEXT = new Set(['.js', '.mjs', '.json', '.css', '.html', '.svg', '.txt', '.md', '.map']); // everything else (fonts, images) is stored base64
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name !== '_headers') files['/' + path.relative(dist, p).split(path.sep).join('/')] = TEXT.has(path.extname(e.name)) ? fs.readFileSync(p, 'utf8') : { b64: fs.readFileSync(p).toString('base64') };
  }
};
walk(dist);
fs.writeFileSync(path.join(out, 'files.js'), 'export default ' + JSON.stringify(files) + ';\n');
console.log(`dist-embed/files.js: ${Object.keys(files).length} files, ${(fs.statSync(path.join(out, 'files.js')).size / 1e6).toFixed(1)} MB`);
