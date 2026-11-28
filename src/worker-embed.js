// The Worker with the static app embedded (see scripts/build-embed.mjs): stands in for the Workers Assets binding,
// with the same single-page-app fallback. The real Worker adds the security headers to every response.
import worker from './worker.js';
import FILES from '../dist-embed/files.js';

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json', ttf: 'font/ttf', txt: 'text/plain; charset=utf-8' };
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); // binary files (fonts) are embedded as base64

export const ASSETS = {
  async fetch(request) {
    let p = new URL(request.url).pathname;
    try { p = decodeURIComponent(p); } catch { /* keep as is */ }
    if (p.endsWith('/')) p += 'index.html';
    if (!/\.[A-Za-z0-9]+$/.test(p) && Object.hasOwn(FILES, p + '.html')) p += '.html'; // /privacy is privacy.html, like Workers Assets
    let body = Object.hasOwn(FILES, p) ? FILES[p] : undefined;
    if (body && typeof body === 'object') body = bytes(body.b64);
    if (body === undefined && !/\.[A-Za-z0-9]+$/.test(p)) { p = '/index.html'; body = FILES[p]; } // a PR path is the app
    if (body === undefined) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const ext = p.split('.').pop();
    const cache = p.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache';
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache } });
  },
};

export default { fetch: (request, env, ctx) => worker.fetch(request, { ...env, ASSETS }, ctx) };
