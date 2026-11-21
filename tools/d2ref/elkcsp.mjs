// Does the ELK engine run in a browser under a CSP without 'unsafe-eval' / 'wasm-unsafe-eval' (and without worker-src / blob:)?
//   node elkcsp.mjs [csp]      (needs Playwright's Chromium: NODE_PATH=/opt/node-tools/node_modules or the preinstalled global one)
// Serves public/ with `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'` (the only things a page that imports d2lib.js
// needs), checks that the policy really forbids eval, then compiles a diagram with layout elk in the page and prints the first connection's route.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };
const csp = process.argv[2] || "default-src 'none'; script-src 'self'; connect-src 'self'";
const html = '<!doctype html><meta charset=utf-8><title>elk csp</title><pre id=out>starting</pre><script type=module src="/test-page.js"></script>';
const script = `
const out = (s) => { document.getElementById('out').textContent = s; };
const res = {};
try { eval('1'); res.eval = 'allowed'; } catch (e) { res.eval = 'blocked'; }
try { new Function('return 1'); res.newFunction = 'allowed'; } catch (e) { res.newFunction = 'blocked'; }
try {
  const { compile, init } = await import('/d2/d2lib.js');
  await init();
  const t0 = performance.now();
  const r = await compile('a -> b: hi\\nc: {d; e}\\nb -> c.d', { layout: 'elk' });
  res.err = r.err && r.err.message;
  res.route = r.diagram && r.diagram.connections[0].route.map((p) => p.x + ',' + p.y).join(' ');
  res.ms = Math.round(performance.now() - t0);
} catch (e) { res.failed = String((e && e.stack) || e).slice(0, 300); }
out(JSON.stringify(res));
`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const headers = { 'Content-Security-Policy': csp };
  if (url.pathname === '/') { res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); res.end(html); return; }
  if (url.pathname === '/test-page.js') { res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); res.end(script); return; }
  const f = path.join(root, url.pathname);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await browser.newPage();
const violations = [];
p.on('console', (m) => { if (process.env.VERBOSE) console.log('console:', m.text().slice(0, 300)); if (/Content Security Policy|CSP/i.test(m.text())) violations.push(m.text().slice(0, 200)); });
p.on('pageerror', (e) => violations.push('pageerror: ' + e.message.slice(0, 200)));
await p.goto(`http://127.0.0.1:${server.address().port}/`);
let text = 'starting';
for (let i = 0; i < 300 && text === 'starting'; i++) { await new Promise((r) => setTimeout(r, 200)); text = await p.textContent('#out'); }
console.log('CSP:', csp);
console.log(text);
console.log('violations:', violations.length ? violations : 'none');
await browser.close();
server.close();
