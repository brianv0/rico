#!/usr/bin/env node
// Rico server: serves the UI and proxies a handful of GitHub API calls so the token never
// reaches the browser. Node >= 18, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createGithub, HttpError } from './src/github.js';
import { vendorFiles } from './src/vendor-map.js';
import { SEC, secure } from './src/security.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

let cachedToken = null;
function token() {
  if (cachedToken) return cachedToken;
  let t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!t) {
    try {
      t = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      /* no gh */
    }
  }
  if (!t) throw new HttpError(401, 'No GitHub token. Set GITHUB_TOKEN (or GH_TOKEN), or run `gh auth login`, then retry.');
  return (cachedToken = t);
}

const github = createGithub({ getToken: token, apiUrl: API });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Diagram renderers are optional dependencies, served from node_modules when installed.
const VENDOR = vendorFiles(path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules'));

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = url.pathname; } // malformed escapes just 404 below
  if (rel === '/') rel = '/index.html';
  const vendor = Object.hasOwn(VENDOR, rel) ? VENDOR[rel] : null;
  const file = vendor || path.normalize(path.join(ROOT, rel));
  const stream = (f) => fs.createReadStream(f).on('error', () => res.destroy()).pipe(res); // a vanished file must not crash the server
  if ((!vendor && !file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // a linkable PR path like /github.com/o/r/7@abc1234 is the single-page app; a missing asset stays a 404
    if (!path.extname(rel) && !rel.startsWith('/api/') && !rel.startsWith('/vendor/')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SEC });
      stream(path.join(ROOT, 'index.html'));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC }).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
  stream(file);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    // Defend the local token against DNS rebinding and cross-site requests.
    if (!HOST_OK.test(req.headers.host || '')) throw new HttpError(403, 'bad host');
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    if (req.method === 'POST' && req.headers['x-rico'] !== '1') throw new HttpError(403, 'missing X-Rico header');
    if (url.pathname === '/api/me') { // local: the server's own token, nothing to sign into; its login is "you" for edit/delete
      const me = await github.route('GET', url, async () => ({}));
      return send(200, { hosted: false, ...(me.ok ? await me.json() : {}) });
    }
    const out = secure(await github.route(req.method, url, () => readJson(req))); // the route's own headers (e.g. /api/raw's stricter CSP) win
    res.writeHead(out.status, Object.fromEntries(out.headers));
    return res.end(Buffer.from(await out.arrayBuffer()));
    throw new HttpError(404, 'not found');
  } catch (e) {
    send(e.status || 500, { error: e.message || String(e) });
  }
});

const argPort = process.argv.indexOf('--port');
const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT || 4317);
server.listen(port, '127.0.0.1', () => {
  console.log(`Rico running at http://localhost:${port}`);
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) console.log('Using `gh auth token` for GitHub access (or set GITHUB_TOKEN).');
});
