import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrRef, resolveRepoPath, parsePatch, clampRange, wordCount, srcWords, lineForWord, trimBlock, locateLine, buildReview, formatQuote, plainQuote, coversWholeLines, clipMiddle, quoteText,
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
  assert.equal(r.comments[1].body, '_Selected lines 3–30; anchored to lines 3–6._\n\n> q2\n\nclamped');
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

test('formatQuote: prose becomes a blockquote, paragraphs are separated by a quoted blank line', () => {
  assert.equal(formatQuote([{ kind: 'text', text: 'One.' }, { kind: 'text', text: 'Two.\nthree' }]), '> One.\n>\n> Two.\n> three');
  assert.equal(formatQuote([]), '');
  assert.equal(formatQuote([{ kind: 'text', text: '   ' }]), '');
});

test('formatQuote: code is fenced with its language; fences grow when the code contains fences', () => {
  assert.equal(formatQuote([{ kind: 'code', lang: 'js', text: 'a();\nb();\n' }]), '```js\na();\nb();\n```');
  assert.equal(formatQuote([{ kind: 'code', lang: '', text: 'x' }]), '```\nx\n```');
  assert.equal(formatQuote([{ kind: 'code', lang: 'md', text: '```js\nx\n```' }]), '````md\n```js\nx\n```\n````');
});

test('formatQuote: prose then code then prose keeps order and separation', () => {
  const md = formatQuote([{ kind: 'text', text: 'Before' }, { kind: 'code', lang: 'd2', text: 'a -> b' }, { kind: 'text', text: 'After' }]);
  assert.equal(md, '> Before\n\n```d2\na -> b\n```\n\n> After');
});

test('formatQuote: long selections keep head and tail with an ellipsis between', () => {
  const segs = Array.from({ length: 12 }, (_, i) => ({ kind: 'text', text: `Paragraph number ${i} with a fair amount of filler text to make it long enough.` }));
  const md = formatQuote(segs, { max: 400 });
  assert.ok(md.length <= 400, String(md.length));
  assert.match(md, /^> Paragraph number 0/);
  assert.match(md, /> …/);
  assert.match(md, /Paragraph number 11[^]*$/);
  assert.doesNotMatch(md, /Paragraph number 5/);
});

test('formatQuote: long code keeps its first and last lines', () => {
  const code = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const md = formatQuote([{ kind: 'code', lang: 'txt', text: code }], { maxCodeLines: 6 });
  assert.equal(md, '```txt\nline0\nline1\nline2\n…\nline37\nline38\nline39\n```');
});

test('clipMiddle and plainQuote', () => {
  assert.equal(clipMiddle('short', 20), 'short');
  const c = clipMiddle('a'.repeat(50) + 'b'.repeat(50), 30);
  assert.ok(c.startsWith('aaaa') && c.endsWith('bbbb') && c.includes(' … '));
  assert.equal(plainQuote([{ kind: 'text', text: 'x ' }, { kind: 'code', text: 'y' }]), 'x\n\ny');
  assert.equal(quoteText('a\n\nb'), '> a\n>\n> b');
});

test('coversWholeLines compares the selection to the anchored source lines', () => {
  const lines = ['- item with **bold** text', 'and a wrapped line'];
  assert.equal(coversWholeLines('item with bold text and a wrapped line', lines), true);
  assert.equal(coversWholeLines('item with bold', lines), false);
  assert.equal(coversWholeLines('anything', ['', '---']), false);
});

test('buildReview: quote can be switched off, edited text is used, loose comments always quote', () => {
  const base = { path: 'a.md', start: 4, end: 4, quote: 'raw', body: 'b', anchor: { start: 4, end: 4, exact: true } };
  const r = buildReview({ commitId: 'x', event: 'COMMENT', comments: [
    { ...base, quoteMd: '> kept', includeQuote: true },
    { ...base, quoteMd: '> hidden', includeQuote: false },
    { ...base, quoteMd: '> edited by the user', includeQuote: true },
    { ...base, anchor: null, quoteMd: '```d2\na -> b\n```', includeQuote: false },
  ] });
  assert.equal(r.comments[0].body, '> kept\n\nb');
  assert.equal(r.comments[1].body, 'b');
  assert.equal(r.comments[2].body, '> edited by the user\n\nb');
  assert.match(r.body, /`a\.md` L4\*\*\n```d2\na -> b\n```\n\nb/); // forced even though includeQuote is false
});
