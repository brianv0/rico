// A tiny fake of the GitHub REST endpoints Rico uses. Shared by the server tests and the e2e run.
import http from 'node:http';
import fs from 'node:fs';

export const COMPLEX = fs.readFileSync(new URL('./fixtures/complex.md', import.meta.url), 'utf8');
export const DIAGRAMS = fs.readFileSync(new URL('./fixtures/diagrams.md', import.meta.url), 'utf8');
const DIAGRAM_LINES = DIAGRAMS.replace(/\n$/, '').split('\n');
const DIAGRAM_PATCH = `@@ -0,0 +1,${DIAGRAM_LINES.length} @@\n` + DIAGRAM_LINES.map((l) => '+' + l).join('\n');
export const GITHUBMD = fs.readFileSync(new URL('./fixtures/github.md', import.meta.url), 'utf8');
const GH_LINES = GITHUBMD.replace(/\n$/, '').split('\n');
const GH_PATCH = `@@ -0,0 +1,${GH_LINES.length} @@\n` + GH_LINES.map((l) => '+' + l).join('\n');
const COMPLEX_LINES = COMPLEX.replace(/\n$/, '').split('\n');
const COMPLEX_PATCH = `@@ -0,0 +1,${COMPLEX_LINES.length} @@\n` + COMPLEX_LINES.map((l) => '+' + l).join('\n');
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
// a real 1x1 PNG as a data: URL, so avatars never trigger a request
export const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
export const SHA = 'abc1234def5678';
// GitHub diffs against the merge base, which is not the base branch tip: keep them different on purpose
export const BASE_SHA = 'bbbb2222cccc3333';
export const MERGE_BASE = 'dddd0000eeee1111';
const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
export const REMOVED_NEW = fx('removed.new.md');
export const REMOVED_OLD = fx('removed.old.md');
export const REMOVED_PATCH = fx('removed.patch');
export const PLAN_OLD = fx('plan.old.md');
export const FILE = [
  '# Plan', '', 'First paragraph here.', '', 'Second paragraph is hard wrapped', 'across two lines for testing.', '',
  '- item one', '- item two', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', 'Far away paragraph outside the diff.', '',
].join('\n');
export const PATCH = [
  '@@ -1,8 +1,10 @@', ' # Plan', '-Old subtitle that was removed', ' ', '+First paragraph here.', ' ', '+Second paragraph is hard wrapped',
  '+across two lines for testing.', ' ', ' - item one', ' - item two', ' ',
  '@@ -11,2 +12,3 @@', ' const a = 1;', '+const b = 2;', ' ```',
].join('\n');

const C = (o) => ({ side: 'RIGHT', path: 'docs/plan.md', author_association: 'MEMBER', user: { login: 'alice', avatar_url: AVATAR }, created_at: '2026-11-18T10:00:00Z', html_url: 'https://github.com/acme/docs/pull/7#discussion_r' + o.id, line: null, original_line: null, ...o });
export const COMMENTS = [
  C({ id: 101, line: 6, start_line: 3, original_line: 6, original_start_line: 3, body: 'Is this **too long**?' }),
  C({ id: 102, in_reply_to_id: 101, line: 6, user: { login: 'bob' }, created_at: '2026-11-19T09:00:00Z', body: 'Will trim it.' }),
  C({ id: 103, line: null, original_line: 9, user: { login: 'carol' }, body: 'Outdated note on the list.' }),
  C({ id: 104, path: 'other.md', line: 1, body: 'Different file.' }),
  C({ id: 105, side: 'LEFT', line: 2, body: 'On a removed line.' }),
  C({ id: 106, path: 'src/x.js', line: 1, body: 'Not markdown.' }),
  C({ id: 301, path: 'docs/removed.md', side: 'LEFT', line: 5, original_line: 5, body: 'Why drop this paragraph?' }),
  C({ id: 302, path: 'docs/removed.md', line: 5, original_line: 5, body: 'Should "keep one" be bold?' }),
];

/** Start the fake. Returns {port, posted: [], replies: [], close()}; `posted` collects POSTed review bodies. */
export async function startFake() {
  const posted = [];
  const replies = [];
  const server = http.createServer((req, res) => {
    const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer t') return json({ message: 'Bad credentials' }, 401);
    if (u.pathname === '/repos/acme/docs/pulls/7') {
      return json({ title: 'Plan v2', state: 'open', draft: false, merged: false, commits: 2, changed_files: 7, additions: 130, deletions: 9, comments: 3, review_comments: 6, created_at: '2026-11-18T09:00:00Z', html_url: 'https://github.com/acme/docs/pull/7', user: { login: 'bob', avatar_url: AVATAR }, head: { sha: SHA, ref: 'plan' }, base: { ref: 'main', sha: BASE_SHA } });
    }
    if (u.pathname === `/repos/acme/docs/compare/${BASE_SHA}...${SHA}`) return json({ merge_base_commit: { sha: MERGE_BASE } });
    if (u.pathname === '/repos/acme/docs/pulls/7/comments') return json(COMMENTS);
    const rm = /^\/repos\/acme\/docs\/pulls\/7\/comments\/(\d+)\/replies$/.exec(u.pathname);
    if (rm && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const body = JSON.parse(b);
        replies.push({ to: Number(rm[1]), ...body });
        json(C({ id: 900 + replies.length, in_reply_to_id: Number(rm[1]), line: 6, user: { login: 'me' }, created_at: '2026-11-20T12:00:00Z', body: body.body }));
      });
      return;
    }
    if (u.pathname === '/repos/acme/docs/pulls/7/files') {
      return json([
        { filename: 'docs/plan.md', status: 'modified', additions: 4, deletions: 1, patch: PATCH },
        { filename: 'docs/complex.md', status: 'added', additions: COMPLEX_LINES.length, deletions: 0, patch: COMPLEX_PATCH },
        { filename: 'docs/diagrams.md', status: 'added', additions: DIAGRAM_LINES.length, deletions: 0, patch: DIAGRAM_PATCH },
        { filename: 'docs/github.md', status: 'added', additions: GH_LINES.length, deletions: 0, patch: GH_PATCH },
        { filename: 'docs/removed.md', status: 'modified', additions: 4, deletions: 6, patch: REMOVED_PATCH },
        { filename: 'src/x.js', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'docs/old.md', status: 'removed', additions: 0, deletions: 9 },
      ]);
    }
    if (u.pathname === '/repos/acme/docs/contents/docs/img/x.png' && u.searchParams.get('ref') === SHA) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(PNG);
    }
    if (u.searchParams.get('ref') === MERGE_BASE && u.pathname === '/repos/acme/docs/contents/docs/removed.md') { // slow on purpose: a click can land while the first load is still running
      return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(REMOVED_OLD); }, 700);
    }
    if (u.searchParams.get('ref') === MERGE_BASE && u.pathname === '/repos/acme/docs/contents/docs/plan.md') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(PLAN_OLD); }
    if (u.pathname === '/repos/acme/docs/contents/docs/removed.md' && u.searchParams.get('ref') === SHA) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(REMOVED_NEW); }
    if (u.pathname === '/repos/acme/docs/contents/docs/github.md' && u.searchParams.get('ref') === SHA) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(GITHUBMD);
    }
    if (u.pathname === '/repos/acme/docs/contents/docs/diagrams.md' && u.searchParams.get('ref') === SHA) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(DIAGRAMS);
    }
    if (u.pathname === '/repos/acme/docs/contents/docs/complex.md' && u.searchParams.get('ref') === SHA) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(COMPLEX);
    }
    if (u.pathname === '/repos/acme/docs/contents/docs/plan.md' && u.searchParams.get('ref') === SHA) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(FILE);
    }
    if (u.pathname === '/repos/acme/docs/pulls/7/reviews' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const body = JSON.parse(b);
        if (body.comments?.some((c) => c.line > 14)) return json({ message: 'Unprocessable Entity', errors: ['line must be part of the diff'] }, 422);
        posted.push(body);
        json({ id: 1, html_url: 'https://github.com/acme/docs/pull/7#pullrequestreview-1', state: 'COMMENTED' });
      });
      return;
    }
    json({ message: 'Not Found ' + u.pathname }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, posted, replies, close: () => new Promise((r) => server.close(r)) };
}
