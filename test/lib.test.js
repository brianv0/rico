import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrRef, resolveRepoPath, parsePatch, clampRange, wordCount, srcWords, lineForWord, trimBlock, locateLine, buildReview,
} from '../public/lib.js';

test('parsePrRef accepts urls and short forms', () => {
  const want = { owner: 'o', repo: 'r.x', number: 12 };
  assert.deepEqual(parsePrRef('https://github.com/o/r.x/pull/12/files'), want);
  assert.deepEqual(parsePrRef('github.com/o/r.x/pull/12'), want);
  assert.deepEqual(parsePrRef('o/r.x#12'), want);
  assert.deepEqual(parsePrRef('o/r.x/pull/12'), want);
  assert.equal(parsePrRef('https://example.com/o/r/pull/1'), null);
  assert.equal(parsePrRef('nonsense'), null);
});

const PATCH = [
  '@@ -1,3 +1,4 @@',
  ' # Title',
  '+new line',
  ' ',
  ' kept',
  '@@ -20,4 +21,3 @@ ctx',
  ' a',
  '-removed',
  '+b',
  ' c',
].join('\n');

test('parsePatch yields RIGHT-side hunks and added lines', () => {
  const { hunks, added } = parsePatch(PATCH);
  assert.deepEqual(hunks, [{ start: 1, end: 4 }, { start: 21, end: 23 }]);
  assert.deepEqual([...added].sort((a, b) => a - b), [2, 22]);
});

test('parsePatch tolerates stripped blank context lines and missing patch', () => {
  const p = '@@ -1,3 +1,3 @@\n a\n\n c';
  assert.deepEqual(parsePatch(p).hunks, [{ start: 1, end: 3 }]);
  assert.deepEqual(parsePatch(undefined).hunks, []);
});

test('clampRange picks the hunk with most overlap', () => {
  const hunks = [{ start: 1, end: 4 }, { start: 21, end: 23 }];
  assert.deepEqual(clampRange(2, 3, hunks), { start: 2, end: 3, exact: true });
  assert.deepEqual(clampRange(3, 30, hunks), { start: 21, end: 23, exact: false });
  assert.deepEqual(clampRange(2, 25, hunks), { start: 2, end: 4, exact: false });
  assert.equal(clampRange(10, 15, hunks), null);
});

test('word counting ignores markers and punctuation-only tokens', () => {
  assert.equal(wordCount('hello - world !!'), 2);
  assert.equal(srcWords('- 1. item one'), 2);
  assert.equal(srcWords('## Heading here'), 2);
  assert.equal(srcWords('> quoted words'), 2);
  assert.equal(srcWords('1. first'), 1);
  assert.equal(lineForWord([3, 0, 2], 3), 2);
  assert.equal(lineForWord([3, 2], 0), 0);
  assert.equal(lineForWord([3, 2], 99), 1);
});

test('trimBlock drops trailing blank lines', () => {
  assert.deepEqual(trimBlock(['a', 'b', '', ''], 0, 4), { s: 1, e: 2 });
  assert.deepEqual(trimBlock(['a'], 0, 5), { s: 1, e: 1 });
});

test('locateLine refines inside hard-wrapped paragraphs, falls back on mismatch', () => {
  const lines = ['one two three', 'four five six', 'seven eight'];
  const block = { s: 1, e: 3 };
  const base = { fence: false, renderedTotal: 8 };
  // start at word "four" (index 3) -> line 2
  assert.equal(locateLine(lines, block, { ...base, which: 'start', wordsBefore: 3, midWord: false }), 2);
  // start mid-word of "five": text before has 5 tokens (partial counted) -> idx 4 -> line 2
  assert.equal(locateLine(lines, block, { ...base, which: 'start', wordsBefore: 5, midWord: true }), 2);
  // end after "six" (6 words through) -> idx 5 -> line 2
  assert.equal(locateLine(lines, block, { ...base, which: 'end', wordsBefore: 6 }), 2);
  // end after the last word -> line 3
  assert.equal(locateLine(lines, block, { ...base, which: 'end', wordsBefore: 8 }), 3);
  // mismatch -> block bounds
  assert.equal(locateLine(lines, block, { ...base, renderedTotal: 7, which: 'start', wordsBefore: 4 }), 1);
  assert.equal(locateLine(lines, block, { ...base, renderedTotal: 7, which: 'end', wordsBefore: 4 }), 3);
});

test('locateLine in fenced code counts newlines after the fence line', () => {
  const lines = ['```js', 'a', 'b', 'c', '```'];
  const block = { s: 1, e: 5 };
  assert.equal(locateLine(lines, block, { fence: true, which: 'start', newlinesBefore: 0 }), 2);
  assert.equal(locateLine(lines, block, { fence: true, which: 'end', newlinesBefore: 2 }), 4);
});

test('buildReview anchors inline comments and folds the rest into the body', () => {
  const r = buildReview({
    commitId: 'abc',
    event: 'COMMENT',
    summary: 'Overall: good.',
    comments: [
      { path: 'a.md', start: 3, end: 8, quote: 'q1', body: 'exact one', anchor: { start: 3, end: 8, exact: true } },
      { path: 'a.md', start: 3, end: 30, quote: 'q2', body: 'clamped', anchor: { start: 3, end: 6, exact: false } },
      { path: 'a.md', start: 50, end: 50, quote: 'q3', body: 'outside', anchor: null },
    ],
  });
  assert.equal(r.commit_id, 'abc');
  assert.equal(r.comments.length, 2);
  assert.deepEqual(r.comments[0], { path: 'a.md', line: 8, side: 'RIGHT', start_line: 3, start_side: 'RIGHT', body: 'exact one' });
  assert.match(r.comments[1].body, /^> q2\n\nclamped$/);
  assert.match(r.body, /Overall: good\./);
  assert.match(r.body, /`a\.md` L50\*\*\n> q3\n\noutside/);
});

test('buildReview single-line comment has no start_line', () => {
  const r = buildReview({
    commitId: 'x', event: 'COMMENT', comments: [{ path: 'p.md', start: 4, end: 4, quote: 'q', body: 'b', anchor: { start: 4, end: 4, exact: true } }],
  });
  assert.equal('start_line' in r.comments[0], false);
  assert.equal('body' in r, false);
});

test('resolveRepoPath resolves relative targets and rejects the rest', () => {
  assert.equal(resolveRepoPath('docs/guide', 'img/a.png'), 'docs/guide/img/a.png');
  assert.equal(resolveRepoPath('docs/guide', './a.png'), 'docs/guide/a.png');
  assert.equal(resolveRepoPath('docs/guide', '../a.png?raw=1#x'), 'docs/a.png');
  assert.equal(resolveRepoPath('docs/guide', '/assets/a%20b.png'), 'assets/a b.png');
  assert.equal(resolveRepoPath('', 'a.png'), 'a.png');
  assert.equal(resolveRepoPath('docs', '../../../etc/passwd'), null); // cannot climb above the repo root
  for (const u of ['https://x.com/a.png', '//x.com/a.png', 'data:image/png;base64,AAAA', '#frag', '']) assert.equal(resolveRepoPath('docs', u), null);
});
