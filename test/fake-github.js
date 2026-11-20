// A tiny fake of the GitHub REST endpoints Rico uses. Shared by the server tests and the e2e run.
import http from 'node:http';

export const SHA = 'abc1234def5678';
export const FILE = [
  '# Plan', '', 'First paragraph here.', '', 'Second paragraph is hard wrapped', 'across two lines for testing.', '',
  '- item one', '- item two', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', 'Far away paragraph outside the diff.', '',
].join('\n');
export const PATCH = [
  '@@ -1,7 +1,10 @@', ' # Plan', ' ', '+First paragraph here.', ' ', '+Second paragraph is hard wrapped',
  '+across two lines for testing.', ' ', ' - item one', ' - item two', ' ',
  '@@ -10,2 +12,3 @@', ' const a = 1;', '+const b = 2;', ' ```',
].join('\n');

/** Start the fake. Returns {port, posted: [], close()}; `posted` collects POSTed review bodies. */
export async function startFake() {
  const posted = [];
  const server = http.createServer((req, res) => {
    const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer t') return json({ message: 'Bad credentials' }, 401);
    if (u.pathname === '/repos/acme/docs/pulls/7') {
      return json({ title: 'Plan v2', state: 'open', html_url: 'https://github.com/acme/docs/pull/7', user: { login: 'bob' }, head: { sha: SHA, ref: 'plan' }, base: { ref: 'main' } });
    }
    if (u.pathname === '/repos/acme/docs/pulls/7/files') {
      return json([
        { filename: 'docs/plan.md', status: 'modified', additions: 4, deletions: 0, patch: PATCH },
        { filename: 'src/x.js', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'docs/old.md', status: 'removed', additions: 0, deletions: 9 },
      ]);
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
  return { port: server.address().port, posted, close: () => new Promise((r) => server.close(r)) };
}
