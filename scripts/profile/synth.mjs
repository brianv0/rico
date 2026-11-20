// Synthetic GitHub for profiling: configurable PR size, per-request latency, ETag/304 support,
// GitHub-style rate-limit accounting (304s are free), and a request log for waterfalls.
import http from 'node:http';
import crypto from 'node:crypto';

export const SHA = 'abc1234def5678';
export const BASE = 'bbbb2222cccc3333';
export const MB = 'dddd0000eeee1111';

/** A markdown document with `lines` source lines: headings, wrapped paragraphs, lists, tables, code. */
export function makeDoc(lines, seed = 0) {
  const out = [`# Doc ${seed}`, ''];
  let i = 0;
  while (out.length < lines) {
    const k = i++ % 5;
    if (k === 0) out.push(`## Section ${i}`, '');
    else if (k === 1) out.push(`Paragraph ${i} lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do`, 'eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim.', '');
    else if (k === 2) out.push(`- item ${i}a with \`code\` and **bold**`, `- item ${i}b with [a link](https://example.com/${i})`, `- item ${i}c`, '');
    else if (k === 3) out.push('| a | b | c |', '|---|---|---|', `| ${i} | x | y |`, `| ${i + 1} | x | y |`, '');
    else out.push('```js', `const v${i} = ${i};`, `console.log(v${i});`, '```', '');
  }
  return out.slice(0, lines).join('\n') + '\n';
}
const addedPatch = (text) => {
  const l = text.replace(/\n$/, '').split('\n');
  return `@@ -0,0 +1,${l.length} @@\n` + l.map((x) => '+' + x).join('\n');
};
const AV = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/**
 * opts: files (markdown), lines per file, threads (review-comment roots spread over files), latencyMs,
 * extraNonMd (non-markdown changed files, which inflate /files pages), rateLimit
 */
export async function startSynth(opts = {}) {
  const o = { files: 3, lines: 400, threads: 0, latencyMs: 0, extraNonMd: 0, rateLimit: 5000, ...opts };
  const dia = (i) => '\n```mermaid\nflowchart LR\n  A' + i + '[Start] --> B' + i + '{Check}\n  B' + i + ' -->|yes| C' + i + '[Done]\n  B' + i + ' -->|no| A' + i + '\n```\n\n```d2\nx' + i + ': Client\ny' + i + ': Server\nx' + i + ' -> y' + i + ': request\n```\n';
  const docs = Array.from({ length: o.files }, (_, i) => makeDoc(o.lines, i) + Array.from({ length: o.diagrams || 0 }, (_, k) => dia(i * 100 + k)).join(''));
  const mdFiles = docs.map((d, i) => ({ filename: `docs/f${i}.md`, status: 'added', additions: o.lines, deletions: 0, patch: addedPatch(d) }));
  const nonMd = Array.from({ length: o.extraNonMd }, (_, i) => ({ filename: `src/x${i}.js`, status: 'modified', additions: 1, deletions: 0 }));
  const files = [...mdFiles, ...nonMd];
  const comments = [];
  for (let t = 0; t < o.threads; t++) {
    const f = mdFiles[t % Math.max(1, mdFiles.length)];
    const line = 3 + ((t * 7) % Math.max(4, o.lines - 4));
    comments.push({ id: 1000 + t, path: f.filename, side: 'RIGHT', line, original_line: line, user: { login: 'alice', avatar_url: AV }, author_association: 'MEMBER', created_at: '2026-11-18T10:00:00Z', html_url: 'https://github.com/acme/docs/pull/7#r' + t, body: `Comment ${t}: is this right?` });
  }
  const log = [];
  let remaining = o.rateLimit;
  const etagOf = (b) => '"' + crypto.createHash('sha1').update(b).digest('hex').slice(0, 16) + '"';
  const server = http.createServer((req, res) => {
    const t0 = performance.now();
    const u = new URL(req.url, 'http://x');
    const finish = (status, body, type = 'application/json') => {
      const buf = typeof body === 'string' ? body : JSON.stringify(body);
      const tag = etagOf(buf);
      const cond = req.headers['if-none-match'] === tag;
      const code = cond ? 304 : status;
      if (!cond) remaining--; // a conditional request answered 304 does not count against the primary rate limit
      setTimeout(() => {
        res.writeHead(code, { 'Content-Type': type, ETag: tag, 'x-ratelimit-limit': String(o.rateLimit), 'x-ratelimit-remaining': String(remaining) });
        res.end(cond ? undefined : buf);
        log.push({ method: req.method, path: u.pathname + u.search, status: code, bytes: cond ? 0 : Buffer.byteLength(buf), start: t0, end: performance.now(), conditional: !!req.headers['if-none-match'] });
      }, o.latencyMs);
    };
    const page = (list) => {
      const pp = Number(u.searchParams.get('per_page') || 30);
      const p = Number(u.searchParams.get('page') || 1);
      return list.slice((p - 1) * pp, p * pp);
    };
    const P = '/repos/acme/docs';
    if (u.pathname === `${P}/pulls/7`) return finish(200, { title: 'Synthetic', state: 'open', draft: false, merged: false, commits: 3, changed_files: files.length, additions: 1, deletions: 0, comments: 0, review_comments: comments.length, created_at: '2026-11-18T09:00:00Z', html_url: 'https://github.com/acme/docs/pull/7', user: { login: 'bob' }, head: { sha: SHA, ref: 'x' }, base: { ref: 'main', sha: BASE } });
    if (u.pathname === `${P}/compare/${BASE}...${SHA}`) return finish(200, { merge_base_commit: { sha: MB } });
    if (u.pathname === `${P}/pulls/7/files`) return finish(200, page(files));
    if (u.pathname === `${P}/pulls/7/comments`) return finish(200, page(comments));
    const m = /^\/repos\/acme\/docs\/contents\/docs\/f(\d+)\.md$/.exec(u.pathname);
    if (m && docs[+m[1]]) return finish(200, docs[+m[1]], 'text/plain');
    finish(404, { message: 'Not Found ' + u.pathname });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    log,
    docs,
    files,
    comments,
    reset: () => { log.length = 0; remaining = o.rateLimit; },
    remaining: () => remaining,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
