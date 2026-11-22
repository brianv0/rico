import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrRef, resolveRepoPath, parsePatch, clampRange, wordCount, srcWords, lineForWord, trimBlock, locateLine, buildReview, rangeDetails, canSuggest, suggestionBody, lineDiff, parseSuggestion, mapPosition, positionSlope, buildLineComment, buildPrComment, parseQuote, normalizeWithMap, findQuote, formatQuote, plainQuote, coversWholeLines, clipMiddle, quoteText, parseD2Range, decodeD2Class, d2LineMaps, findMermaidLines, findDotLines, dotTokens, buildFileTree, statBlocks, diffAnchor, parsePatchRows, patchHunkRanges, patchDeletions, oldToNewMap, wordDiff, diffGroups
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

test('parsePrRef rejects dot segments (they would normalise away in the API path)', () => {
  for (const ref of ['../docs#7', './docs#7', 'docs/..#7', 'https://github.com/../docs/pull/7', 'https://github.com/docs/../pull/7', 'https://github.com/././pull/7']) assert.equal(parsePrRef(ref), null, ref);
  assert.deepEqual(parsePrRef('a..b/c#7'), { owner: 'a..b', repo: 'c', number: 7 }); // '..' inside a name is fine: not a path segment
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
  assert.equal(r.comments[1].body, '_Selected lines 3–30 of `a.md`. GitHub can only anchor lines 3–6 here, but this comment is about all of lines 3–30._\n\n> q2\n\nclamped');
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
  assert.equal(resolveRepoPath('docs', '%ZZ.png'), null); // a broken %-escape returns null instead of throwing (would abort the whole render)
  assert.equal(resolveRepoPath('docs', 'img/%E0%A4%A.png'), null);
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

test('parseD2Range reads 0-based start and end lines', () => {
  assert.deepEqual(parseD2Range('index,6:0:102-6:23:125'), { s: 6, e: 6 });
  assert.deepEqual(parseD2Range('index,2:4:10-5:1:60'), { s: 2, e: 5 });
  assert.equal(parseD2Range('garbage'), null);
  assert.equal(parseD2Range(undefined), null);
});

test('decodeD2Class decodes the base64 id and unescapes entities', () => {
  assert.equal(decodeD2Class(btoa('server.proxy')), 'server.proxy');
  assert.equal(decodeD2Class(btoa('(browser -&gt; server.proxy)[0]')), '(browser -> server.proxy)[0]');
  assert.equal(decodeD2Class(btoa('x') + ' extra'), 'x');
  assert.equal(decodeD2Class('%%%not base64%%%'), null);
});

test('d2LineMaps pairs shapes with graph objects and connections with AST edges', () => {
  const diagram = { shapes: [{ id: 'a' }, { id: 'c' }, { id: 'c.d' }], connections: [{ id: '(a -> c.d)[0]' }, { id: '(c.d -> a)[0]' }] };
  const graph = {
    objects: [
      { references: [{ key: { range: 'index,0:0:0-0:1:1' } }, { key: { range: 'index,4:0:50-4:1:51' } }] },
      { references: [{ key: { range: 'index,1:0:5-1:1:6' } }] },
      { references: [{ key: { range: 'index,2:2:9-2:3:10' } }, { key: { range: 'index,4:5:55-4:8:58' } }] },
    ],
    ast: { nodes: [
      { map_key: { edges: [] , value: { map: { nodes: [] } } } },
      { map_key: { edges: [{ range: 'index,4:0:50-4:20:70' }] } },
      { map_key: { edges: [{ range: 'index,5:0:71-5:20:91' }] } },
    ] },
  };
  const { shapes, conns } = d2LineMaps(diagram, graph);
  assert.deepEqual(shapes.get('a'), [{ s: 0, e: 0 }, { s: 4, e: 4 }]); // definition first
  assert.deepEqual(shapes.get('c.d'), [{ s: 2, e: 2 }, { s: 4, e: 4 }]);
  assert.deepEqual(conns.get('(a -> c.d)[0]'), [{ s: 4, e: 4 }]);
  assert.deepEqual(conns.get('(c.d -> a)[0]'), [{ s: 5, e: 5 }]);
});

test('d2LineMaps maps nothing when counts disagree rather than guessing', () => {
  const diagram = { shapes: [{ id: 'a' }, { id: 'b' }], connections: [{ id: 'x' }] };
  const graph = { objects: [{ references: [{ key: { range: 'index,0:0:0-0:1:1' } }] }], ast: { nodes: [] } };
  const { shapes, conns } = d2LineMaps(diagram, graph);
  assert.equal(shapes.size, 0); assert.equal(conns.size, 0);
});

test('d2LineMaps walks nested maps for edges, in document order', () => {
  const diagram = { shapes: [], connections: [{ id: 'e1' }, { id: 'e2' }] };
  const graph = { objects: [], ast: { nodes: [
    { map_key: { edges: [], value: { map: { nodes: [{ map_key: { edges: [{ range: 'index,2:2:9-2:10:17' }] } }] } } } },
    { map_key: { edges: [{ range: 'index,5:0:40-5:9:49' }] } },
  ] } };
  const { conns } = d2LineMaps(diagram, graph);
  assert.deepEqual([conns.get('e1')[0].s, conns.get('e2')[0].s], [2, 5]);
});

const MM = ['flowchart LR', '  A[Browser] -->|select| B(Server)', '  B --> C{GitHub}', '  C -->|ok| D[Done]', '  A --> B'].join('\n');
test('findMermaidLines: nodes prefer their declaration, edges need both ends in order', () => {
  assert.deepEqual(findMermaidLines(MM, { kind: 'node', id: 'A' }), { s: 1, e: 1 });
  assert.deepEqual(findMermaidLines(MM, { kind: 'node', id: 'C' }), { s: 2, e: 2 });
  assert.deepEqual(findMermaidLines(MM, { kind: 'edge', from: 'B', to: 'C', n: 0 }), { s: 2, e: 2 });
  assert.deepEqual(findMermaidLines(MM, { kind: 'edge', from: 'C', to: 'D', n: 0 }), { s: 3, e: 3 });
  assert.equal(findMermaidLines(MM, { kind: 'edge', from: 'D', to: 'A', n: 0 }), null); // wrong direction: no such line
  assert.equal(findMermaidLines(MM, { kind: 'node', id: 'Z' }), null);
});

test('findMermaidLines: repeated edges use their index; ids are matched as whole words', () => {
  const src = 'flowchart TD\n  AB --> C\n  A --> C\n  A --> C';
  assert.deepEqual(findMermaidLines(src, { kind: 'edge', from: 'A', to: 'C', n: 0 }), { s: 2, e: 2 }); // not "AB"
  assert.deepEqual(findMermaidLines(src, { kind: 'edge', from: 'A', to: 'C', n: 1 }), { s: 3, e: 3 });
  assert.deepEqual(findMermaidLines(src, { kind: 'edge', from: 'A', to: 'C', n: 9 }), { s: 3, e: 3 }); // clamps
});

test('findMermaidLines: sequence actors and messages', () => {
  const src = 'sequenceDiagram\n  participant U as User\n  participant R as Rico\n  U->>R: select text\n  R-->>U: comment box';
  assert.deepEqual(findMermaidLines(src, { kind: 'actor', id: 'R' }), { s: 2, e: 2 });
  assert.deepEqual(findMermaidLines(src, { kind: 'text', text: 'comment box' }), { s: 4, e: 4 });
  assert.deepEqual(findMermaidLines(src, { kind: 'text', text: 'select' }), { s: 3, e: 3 }); // falls back to substring
  assert.equal(findMermaidLines(src, null), null);
});

test('buildReview: a diagram element comment says what it is about, before everything else', () => {
  const r = buildReview({ commitId: 'x', event: 'COMMENT', comments: [
    { path: 'a.md', start: 44, end: 44, quote: 'q', body: 'say what travels here', about: 'edge “UI → Server”', quoteMd: '```mermaid\nUI --> Server\n```', includeQuote: true, anchor: { start: 44, end: 44, exact: true } },
    { path: 'a.md', start: 44, end: 44, quote: 'q', body: 'plain', anchor: { start: 44, end: 44, exact: true } },
  ] });
  assert.equal(r.comments[0].body, '_Re: edge “UI → Server”_\n\n```mermaid\nUI --> Server\n```\n\nsay what travels here');
  assert.equal(r.comments[1].body, 'plain');
});

test('buildFileTree: directories first, alphabetical, single-child chains collapsed', () => {
  const f = (filename) => ({ filename });
  const tree = buildFileTree([f('README.md'), f('docs/guide/faq.md'), f('docs/guide/start.md'), f('docs/a.md'), f('src/deep/er/x.js'), f('b.txt')]);
  assert.deepEqual(tree.map((n) => `${n.type}:${n.name}`), ['dir:docs', 'dir:src/deep/er', 'file:b.txt', 'file:README.md']);
  const docs = tree[0];
  assert.deepEqual(docs.children.map((n) => `${n.type}:${n.name}`), ['dir:guide', 'file:a.md']);
  assert.deepEqual(docs.children[0].children.map((n) => n.name), ['faq.md', 'start.md']);
  assert.equal(tree[1].path, 'src/deep/er'); assert.equal(tree[1].children[0].path, 'src/deep/er/x.js');
});

test('statBlocks: five squares, proportional, never hides a nonzero side', () => {
  assert.equal(statBlocks(0, 0), 'nnnnn');
  assert.equal(statBlocks(10, 0), 'ggggg');
  assert.equal(statBlocks(0, 7), 'rrrrr');
  assert.match(statBlocks(3, 3), /^g+r+$/); // an even split shows both colours
  assert.equal(statBlocks(100, 1), 'ggggr');
  assert.equal(statBlocks(1, 100), 'grrrr');
  for (const [a, d] of [[1, 1], [2, 9], [50, 50], [4, 0], [0, 1]]) assert.equal(statBlocks(a, d).length, 5);
});

test('diffAnchor is GitHub\'s sha256-of-path anchor', async () => {
  assert.equal(await diffAnchor('a'), 'diff-ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});

test('parsePatchRows numbers both sides and keeps hunk headers', () => {
  const rows = parsePatchRows(['@@ -3,4 +3,5 @@ ctx', ' keep', '-gone', '+new1', '+new2', ' tail', '\\ No newline at end of file'].join('\n'));
  assert.deepEqual(rows.map((r) => [r.type, r.old ?? null, r.new ?? null, r.text]), [
    ['hunk', null, null, '@@ -3,4 +3,5 @@ ctx'],
    ['ctx', 3, 3, 'keep'], ['del', 4, null, 'gone'], ['add', null, 4, 'new1'], ['add', null, 5, 'new2'], ['ctx', 5, 6, 'tail'],
    ['meta', null, null, '\\ No newline at end of file'],
  ]);
  assert.deepEqual(parsePatchRows(undefined), []);
  const two = parsePatchRows('@@ -1,1 +1,1 @@\n a\n@@ -10,1 +10,1 @@\n-b\n+c');
  assert.deepEqual(two.filter((r) => r.type === 'add').map((r) => r.new), [10]);
  assert.deepEqual(two.filter((r) => r.type === 'del').map((r) => r.old), [10]);
});

test('srcWords ignores task-list boxes and alert markers, which never render as text', () => {
  assert.equal(srcWords('- [x] Done item'), 2);
  assert.equal(srcWords('  - [ ] Open item with more words'), 5);
  assert.equal(srcWords('> [!NOTE]'), 0);
  assert.equal(srcWords('> [!warning]  '), 0);
  assert.equal(srcWords('> Useful information'), 2);
  assert.equal(srcWords('[x] box without a list marker'), 5); // a leading box is dropped wherever it appears (harmless: it never renders)
});

test('patchHunkRanges: contiguous per-side ranges for each hunk', () => {
  const rows = parsePatchRows(['@@ -1,4 +1,5 @@', ' a', '-b', '+c', '+d', ' e', '@@ -20,2 +30,1 @@', '-x', ' y'].join('\n'));
  assert.deepEqual(patchHunkRanges(rows), [
    { left: { start: 1, end: 3 }, right: { start: 1, end: 4 } },
    { left: { start: 20, end: 21 }, right: { start: 30, end: 30 } },
  ]);
  assert.deepEqual(patchHunkRanges([]), []);
});

test('buildReview: comments on removed lines are posted on the LEFT side', () => {
  const r = buildReview({ commitId: 'x', event: 'COMMENT', comments: [
    { path: 'a.md', side: 'LEFT', start: 2, end: 4, quote: 'q', body: 'why remove this?', anchor: { start: 2, end: 4, exact: true } },
    { path: 'a.md', start: 9, end: 9, quote: 'q', body: 'default side', anchor: { start: 9, end: 9, exact: true } },
  ] });
  assert.deepEqual(r.comments[0], { path: 'a.md', line: 4, side: 'LEFT', start_line: 2, start_side: 'LEFT', body: 'why remove this?' });
  assert.equal(r.comments[1].side, 'RIGHT');
  assert.equal('start_side' in r.comments[1], false);
});

test('patchDeletions: runs of removed lines and the new line they follow', () => {
  const rows = parsePatchRows([
    '@@ -1,6 +1,6 @@', ' keep', '-gone one', '-gone two', '+new', ' keep2', '-lonely', ' end',
    '@@ -30,2 +40,1 @@', '-first in hunk', ' tail',
  ].join('\n'));
  assert.deepEqual(patchDeletions(rows), [
    { oldStart: 2, oldEnd: 3, afterNew: 1 },  // replaced paragraph: red goes above the new one
    { oldStart: 5, oldEnd: 5, afterNew: 3 },  // after "keep2"
    { oldStart: 30, oldEnd: 30, afterNew: 39 }, // first line of a later hunk: just before its first new line
  ]);
  assert.deepEqual(patchDeletions(parsePatchRows('@@ -1,2 +1,2 @@\n-x\n+y\n z')), [{ oldStart: 1, oldEnd: 1, afterNew: 0 }]);
  assert.deepEqual(patchDeletions([]), []);
});

test('oldToNewMap maps only unchanged lines', () => {
  const rows = parsePatchRows('@@ -1,4 +1,4 @@\n a\n-b\n+c\n d\n e');
  assert.deepEqual([...oldToNewMap(rows)], [[1, 1], [3, 3], [4, 4]]);
});

test('prPath / parsePrPath round-trip a linkable PR location, with an optional commit', async () => {
  const { prPath, parsePrPath } = await import('../public/lib.js');
  const pr = { owner: 'acme', repo: 'docs', number: 7 };
  assert.equal(prPath(pr), '/github.com/acme/docs/7');
  assert.equal(prPath(pr, 'abcdef1234567890'), '/github.com/acme/docs/7@abcdef1');
  assert.deepEqual(parsePrPath('/github.com/acme/docs/7@abcdef1'), { instance: 'github.com', owner: 'acme', repo: 'docs', number: 7, sha: 'abcdef1' });
  assert.deepEqual(parsePrPath('/ghe.corp.com:8443/o/r/12/'), { instance: 'ghe.corp.com:8443', owner: 'o', repo: 'r', number: 12, sha: '' });
  assert.equal(parsePrPath('/'), null);
  assert.equal(parsePrPath('/vendor/x.js'), null);
  assert.equal(parsePrPath('/github.com/../docs/7'), null); // dot segments, as in parsePrRef
});

test('previewLines keeps short quotes whole and elides the middle of long ones', async () => {
  const { previewLines } = await import('../public/lib.js');
  assert.deepEqual(previewLines('a\nb\nc'), { head: ['a', 'b', 'c'], omitted: 0, tail: [] });
  const eleven = Array.from({ length: 11 }, (_, i) => `l${i + 1}`).join('\n');
  assert.equal(previewLines(eleven).omitted, 0);
  const many = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n');
  const p = previewLines(many);
  assert.deepEqual(p.head, ['l1', 'l2', 'l3', 'l4', 'l5']);
  assert.deepEqual(p.tail, ['l36', 'l37', 'l38', 'l39', 'l40']);
  assert.equal(p.omitted, 30);
});

test('buildLineComment: exact anchor is just the comment; clamped or quoted adds the note and quote; ranges carry start_line', () => {
  const base = { path: 'a.md', start: 3, end: 3, side: 'RIGHT', anchor: { start: 3, end: 3, exact: true }, body: 'Hi', quoteMd: '> words' };
  assert.deepEqual(buildLineComment(base), { path: 'a.md', line: 3, side: 'RIGHT', body: 'Hi' });
  assert.equal(buildLineComment({ ...base, includeQuote: true }).body, '> words\n\nHi');
  const clamped = buildLineComment({ ...base, start: 3, end: 9, anchor: { start: 5, end: 6, exact: false }, about: 'node “A”', side: 'LEFT' });
  assert.deepEqual(clamped, { path: 'a.md', line: 6, side: 'LEFT', start_line: 5, start_side: 'LEFT', body: '_Re: node “A”_\n\n_Selected lines 3–9 of `a.md` (old file). GitHub can only anchor lines 5–6 here, but this comment is about all of lines 3–9._\n\n> words\n\nHi' });
});

test('buildPrComment says where the text is, quotes it, and parseQuote reads it back', () => {
  const body = buildPrComment({ path: 'docs/a.md', start: 40, end: 42, quoteMd: '> far away words', body: 'Typo here?' });
  assert.equal(body, '**`docs/a.md` L40–42**\n\n> far away words\n\nTypo here?');
  assert.deepEqual(parseQuote(body), { path: 'docs/a.md', about: null, quote: 'far away words', rest: 'Typo here?' });
});

test('parseQuote: lead-in lines only, multi-line quotes, no quote, and a quote deeper in the text is not the selection', () => {
  assert.deepEqual(parseQuote('_Re: node “A”_\n\n_Selected lines 3–9 of `a.md`. GitHub can only anchor lines 5–6 here, but this comment is about all of lines 3–9._\n\n> one\n> two\n>\n> three\n\nBody'), { path: null, about: 'node “A”', quote: 'one\ntwo\n\nthree', rest: 'Body' });
  assert.equal(parseQuote('Just a comment').quote, null);
  assert.equal(parseQuote('I agree with:\n\n> this').quote, null);
  assert.equal(parseQuote('').quote, null);
  assert.equal(parseQuote(undefined).rest, '');
});

test('findQuote locates words in rendered text, across whitespace, and shortened quotes by head and tail', () => {
  const hay = 'The quick  brown fox\n jumps over the lazy dog.';
  assert.deepEqual(findQuote(hay, 'brown fox jumps'), { start: 11, end: 27 });
  assert.equal(hay.slice(11, 27).replace(/\s+/g, ' '), 'brown fox jumps');
  const short = findQuote(hay, 'quick … lazy');
  assert.equal(hay.slice(short.start, short.end).replace(/\s+/g, ' '), 'quick brown fox jumps over the lazy');
  assert.equal(findQuote(hay, 'purple'), null);
  assert.equal(findQuote(hay, ''), null);
  assert.deepEqual(normalizeWithMap('  a  b ').text, 'a b');
});

test('quoteParts splits a multi-block quote into the paragraphs to look for', async () => {
  const { quoteParts } = await import('../public/lib.js');
  assert.deepEqual(quoteParts('First here.\n\nSecond one\nwrapped'), ['First here.', 'Second one\nwrapped']);
  assert.deepEqual(quoteParts(''), []);
});

test('canSuggest: only whole new-file lines inside one hunk, with a reason otherwise', () => {
  const ok = { side: 'RIGHT', anchor: { start: 3, end: 4, exact: true } };
  assert.deepEqual(canSuggest(ok), { ok: true, reason: '' });
  assert.match(canSuggest({ ...ok, side: 'LEFT' }).reason, /removed text/);
  assert.match(canSuggest({ ...ok, touchesRemoved: true }).reason, /removed text/);
  assert.match(canSuggest({ side: 'RIGHT', anchor: null }).reason, /outside the diff/);
  assert.match(canSuggest({ ...ok, anchor: { start: 5, end: 6, exact: false } }).reason, /another hunk/);
  assert.equal(canSuggest(null).ok, false);
});

test('suggestionBody wraps the replacement in a suggestion block, keeps a note, deletes with an empty block, and survives backticks', () => {
  assert.equal(suggestionBody('new line'), '```suggestion\nnew line\n```');
  assert.equal(suggestionBody('a\nb\n', ' Please reword '), 'Please reword\n\n```suggestion\na\nb\n```');
  assert.equal(suggestionBody(''), '```suggestion\n```');
  assert.equal(suggestionBody('use ```js\nx\n```'), '````suggestion\nuse ```js\nx\n```\n````');
  assert.equal(parseSuggestion(suggestionBody('a\nb', 'note')), 'a\nb');
  assert.equal(parseSuggestion(suggestionBody('use ```js\nx\n```')), 'use ```js\nx\n```');
  assert.equal(parseSuggestion('```js\nnot one\n```'), null);
});

test('lineDiff: unchanged lines stay context, changes are del then add, empty edits delete', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c'], ['a', 'B', 'c']), [{ type: 'ctx', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'B' }, { type: 'ctx', text: 'c' }]);
  assert.deepEqual(lineDiff('a\nb', 'a'), [{ type: 'ctx', text: 'a' }, { type: 'del', text: 'b' }]);
  assert.deepEqual(lineDiff(['x'], []), [{ type: 'del', text: 'x' }]);
  assert.deepEqual(lineDiff(['x'], ['x']).map((r) => r.type), ['ctx']);
});

test('clamped comments carry the actual selected lines in a collapsed block; long lines and ranges are cut', () => {
  const base = { path: 'a.md', start: 3, end: 5, side: 'RIGHT', anchor: { start: 3, end: 3, exact: false }, body: 'Hi', quoteMd: '> q', lines: ['one', 'two `x`', 'x'.repeat(300)], sha: 'abc1234def' };
  const body = buildLineComment(base).body;
  assert.match(body, /^_Selected lines 3–5 of `a.md`\. GitHub can only anchor line 3 here, but this comment is about all of lines 3–5\._\n\n> q\n\nHi\n\n<details><summary>Full selection: lines 3–5 of <code>a.md<\/code> at abc1234<\/summary>\n\n```\none\ntwo `x`\n/);
  const block = body.split('\n```\n')[1];
  assert.ok(block.split('\n')[2].length <= 240 && block.includes(' … '), 'a 300-char line is cut');
  assert.ok(body.endsWith('</details>'));
  assert.ok(!buildLineComment({ ...base, anchor: { start: 3, end: 5, exact: true } }).body.includes('<details>'), 'exact anchors need none');
  assert.ok(!buildLineComment({ ...base, lines: undefined }).body.includes('<details>'));
  const many = rangeDetails({ ...base, end: 100, lines: Array.from({ length: 100 }, (_, i) => 'l' + i) });
  assert.match(many, /l19\n… 60 more lines …\nl80\n/);
  assert.match(rangeDetails({ ...base, side: 'LEFT' }), /at abc1234 \(old file\)/);
  assert.match(rangeDetails({ ...base, lines: ['```js'] }), /````\n```js\n````/, 'fences cannot be broken out of');
});

test('mapPosition: linear between threads, 1:1 outside, monotonic, never stalls the wheel', () => {
  const pts = [{ d: 100, m: 0 }, { d: 200, m: 300 }, { d: 200, m: 600 }, { d: 500, m: 700 }];
  assert.equal(mapPosition(pts, 100), 0);
  assert.equal(mapPosition(pts, 150), 150); // 100 text px are worth 300 margin px here: fast through a discussion
  assert.equal(mapPosition(pts, 50), -50); // before the first thread the margin moves with the text
  assert.equal(mapPosition(pts, 350), 650); // between 200 and 500 it barely moves
  assert.equal(mapPosition(pts, 600), 800); // after the last, 1:1
  let last = -Infinity;
  for (let d = -50; d < 800; d += 7) { const m = mapPosition(pts, d); assert.ok(m >= last); last = m; }
  assert.equal(positionSlope(pts, 150), 3);
  assert.ok(positionSlope([{ d: 0, m: 5 }, { d: 100, m: 5 }], 50) > 0, 'a flat stretch still lets the wheel move');
  assert.equal(mapPosition([], 42), 42);
});

test('findDotLines: nodes, edges (incl. groups, ports, repeats), clusters; attribute text and comments never match', () => {
  const src = [
    'digraph G {', // 0
    '  rankdir=LR; // a -> z',
    '  a [label="b -> x"];',
    '  "my node" -> b -> c;',
    '  a -> b [label=a];',
    '  subgraph cluster_x { label=Q; b; c }',
    '  {a b} -> d;',
    '  p:n -> q;',
    '  /* a -> q */ a -> b;',
    '}',
  ].join('\n');
  assert.deepEqual(findDotLines(src, { kind: 'node', id: 'a' }), { s: 2, e: 2 }); // the declaration, not an edge or a label
  assert.deepEqual(findDotLines(src, { kind: 'node', id: 'my node' }), { s: 3, e: 3 });
  assert.deepEqual(findDotLines(src, { kind: 'node', id: 'd' }), { s: 6, e: 6 });
  assert.equal(findDotLines(src, { kind: 'node', id: 'x' }), null); // only inside a label
  assert.deepEqual(findDotLines(src, { kind: 'edge', from: 'b', to: 'c', n: 0 }), { s: 3, e: 3 }); // a chain
  assert.deepEqual(findDotLines(src, { kind: 'edge', from: 'b', to: 'd', n: 0 }), { s: 6, e: 6 }); // a { a b } group
  assert.deepEqual(findDotLines(src, { kind: 'edge', from: 'p', to: 'q', n: 0 }), { s: 7, e: 7 }); // ports dropped
  assert.deepEqual(findDotLines(src, { kind: 'edge', from: 'a', to: 'b', n: 0 }), { s: 4, e: 4 }); // repeated edges: the nth statement
  assert.deepEqual(findDotLines(src, { kind: 'edge', from: 'a', to: 'b', n: 1 }), { s: 8, e: 8 }); // (a comment in front does not count)
  assert.deepEqual(findDotLines(src, { kind: 'edge', from: 'a', to: 'd', n: 0 }), { s: 6, e: 6 });
  assert.deepEqual(findDotLines(src, { kind: 'cluster', id: 'cluster_x' }), { s: 5, e: 5 });
  assert.equal(findDotLines(src, { kind: 'edge', from: 'q', to: 'a', n: 0 }), null);
  assert.deepEqual(findDotLines('graph { a -- b }', { kind: 'edge', from: 'b', to: 'a', undirected: true, n: 0 }), { s: 0, e: 0 });
});

test('dotTokens: quoted ids, escapes, HTML labels and comments', () => {
  const t = dotTokens('a -> "b\\"c" /* x\ny */ <<b>x</b>>\n# z\nd');
  assert.deepEqual(t.map((k) => [k.t, k.line]), [['a', 0], ['->', 0], ['b"c', 0], ['<b>x</b>', 1], ['d', 3]]);
});

test('parseD2Range accepts the WASM string and the JS port\'s Range object (its toJSON is that string)', () => {
  const str = 'index,6:0:102-6:23:125';
  assert.deepEqual(parseD2Range(str), { s: 6, e: 6 });
  assert.deepEqual(parseD2Range({ toJSON: () => str, toString: () => '7:1' }), { s: 6, e: 6 });
  assert.equal(parseD2Range(null), null);
});

test('wordDiff: marks only the changed words, as ranges in each text', () => {
  const sl = (s, rs) => rs.map(([a, z]) => s.slice(a, z));
  const a = 'together and why they are shaped';
  const b = 'together, why they are shaped, and which trade-offs we accepted';
  const d = wordDiff(a, b);
  assert.deepEqual(sl(a, d.del), ['and']);
  assert.deepEqual(sl(b, d.add), [',', ', and which trade-offs we accepted']);
  assert.equal(wordDiff('same text', 'same text').del.length + wordDiff('same text', 'same text').add.length, 0);
  assert.deepEqual(sl('a b c', wordDiff('a b c', 'a c').del), ['b']); // pure deletion
  assert.deepEqual(sl('a c d', wordDiff('a c', 'a c d').add), ['d']); // pure insertion
  assert.deepEqual(wordDiff('old words', 'new text').same, 0); // nothing in common: the caller keeps whole-block marks
  const r = wordDiff('call `foo()` now', 'call `bar()` now'); // inline code and punctuation are tokens too
  assert.deepEqual([sl('call `foo()` now', r.del), sl('call `bar()` now', r.add)], [['foo'], ['bar']]);
});

test('diffGroups: groups carry where removed words sit in the new text, and short unchanged runs fold into the change', () => {
  const a = 'fit together and why they are shaped the way they are.';
  const b = 'fit together, why they are shaped the way they are, and which trade-offs we accepted.';
  const sl = (s, r) => (r ? s.slice(r[0], r[1]) : null);
  const g = diffGroups(a, b, 3).groups.map((x) => [sl(a, x.del), sl(b, x.ins), x.at]);
  assert.deepEqual(g, [['and', ',', 12], [null, ', and which trade-offs we accepted', 50]]);
  // an unchanged run shorter than minGap between two changes is folded into one removal and one insertion
  const a2 = 'one two three four five six';
  const b2 = 'one 2 three 4 five six';
  assert.equal(diffGroups(a2, b2, 1).groups.length, 2);
  const f = diffGroups(a2, b2, 3).groups;
  assert.deepEqual(f.map((x) => [sl(a2, x.del), sl(b2, x.ins)]), [['two three four', '2 three 4']]);
  assert.equal(diffGroups('same', 'same').groups.length, 0);
  assert.equal(diffGroups('all new', 'xyz qrs').same, 0); // nothing in common
  const d = diffGroups('keep this', 'keep'); // pure removal: it sits at the end of the new text
  assert.deepEqual(d.groups.map((x) => [sl('keep this', x.del), x.ins, x.at]), [['this', null, 4]]);
});
