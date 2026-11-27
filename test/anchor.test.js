import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, sinceChanges, reanchor, inlineDiff, similarity, pairBlocks } from '../public/anchor.js';
import { lineDiff } from '../public/lib.js';

const apply = (a, b, ops) => {
  const out = [];
  for (const o of ops) {
    if (o.type === 'ctx') { assert.equal(a[o.a], b[o.b]); out.push(a[o.a]); } else if (o.type === 'add') out.push(b[o.b]);
    else assert.ok(o.a >= 0 && o.a < a.length);
  }
  return out;
};

test('diffLines rebuilds the new text from the old one, and matches the LCS on random input', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rnd(14) }, () => 'abcde'[rnd(5)]);
    const b = Array.from({ length: rnd(14) }, () => 'abcde'[rnd(5)]);
    const ops = diffLines(a, b);
    assert.deepEqual(apply(a, b, ops), b, `${a} -> ${b}`);
    const lcs = lineDiff(a, b).filter((o) => o.type === 'ctx').length;
    assert.equal(ops.filter((o) => o.type === 'ctx').length, lcs, `minimal for ${a} -> ${b}`);
    assert.equal(ops.filter((o) => o.type !== 'add').length, a.length); // every old line is either kept or removed once
    assert.equal(ops.filter((o) => o.type !== 'del').length, b.length);
  }
});

test('diffLines is fast on a long document with a few edits (lineDiff would give up on it)', () => {
  const a = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const b = [...a];
  b[100] = 'changed'; b.splice(2500, 0, 'inserted'); b.splice(4000, 3);
  const t0 = Date.now();
  const ops = diffLines(a, b);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(apply(a, b, ops), b);
  assert.equal(ops.filter((o) => o.type === 'del').length, 1 + 3 + 0);
  assert.equal(ops.filter((o) => o.type === 'add').length, 1 + 1);
});

test('diffLines past the edit budget reports the middle as replaced instead of failing', () => {
  const a = Array.from({ length: 40 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 40 }, (_, i) => `b${i}`);
  const ops = diffLines(a, b, 5);
  assert.deepEqual(apply(a, b, ops), b);
  assert.equal(ops.filter((o) => o.type === 'ctx').length, 0);
});

test('sinceChanges: added lines, removed runs and where they sit', () => {
  const a = ['# T', '', 'one', '', 'two', '', 'three'];
  const b = ['# T', '', 'one', '', 'TWO!', '', 'three', '', 'four'];
  const { added, runs } = sinceChanges(a, b);
  assert.deepEqual([...added].sort((x, y) => x - y), [5, 8, 9]);
  assert.equal(runs.length, 2);
  assert.deepEqual({ ...runs[0], oldLines: undefined }, { oldFrom: 5, oldTo: 5, newFrom: 5, newTo: 5, afterNew: 4, oldLines: undefined });
  assert.deepEqual(runs[0].oldLines, ['two']);
  assert.equal(runs[1].oldFrom, 0); // a pure insertion removed nothing
  assert.equal(runs[1].newFrom, 8);
  const gone = sinceChanges(['a', 'b', 'c'], ['a', 'c']);
  assert.equal(gone.added.size, 0);
  assert.deepEqual(gone.runs.map((r) => [r.oldFrom, r.oldTo, r.newFrom, r.afterNew]), [[2, 2, 0, 1]]);
});

const DOC = [
  '# Plan', '', 'The importer reads every row from the CSV file and validates each column', 'against the schema before it writes anything to the database.', '',
  'Retries use exponential backoff with a ceiling of thirty seconds per attempt.', '', 'Rollbacks restore the previous snapshot.',
];

test('reanchor: the same lines moved to another place', () => {
  const moved = [...DOC.slice(0, 2), 'A new intro paragraph.', '', ...DOC.slice(2)];
  assert.deepEqual(reanchor(DOC.slice(5, 6), moved, { hint: 6 }), { start: 8, end: 8, how: 'exact', score: 1 });
});

test('reanchor: the same words, wrapped differently', () => {
  const rewrapped = ['# Plan', '', 'The importer reads every row from the CSV file and validates each column against the schema', 'before it writes anything to the database.', '', DOC[5], '', DOC[7]];
  const r = reanchor(DOC.slice(2, 4), rewrapped, { hint: 3 });
  assert.deepEqual([r.start, r.end, r.how], [3, 4, 'rewrapped']);
});

test('reanchor: a partial-line comment is found by its quote when the rest changed', () => {
  const edited = ['# Plan', '', 'Completely rewritten opening sentence, but exponential backoff stays.', '', 'Something else entirely.'];
  const r = reanchor(['Retries use exponential backoff with a ceiling of thirty seconds per attempt.'], edited, { quote: 'exponential backoff' });
  assert.deepEqual([r.start, r.end, r.how], [3, 3, 'quote']);
});

test('reanchor: a reworded paragraph is found by its shared words, and only when one place is clearly best', () => {
  const edited = [...DOC];
  edited[5] = 'Retries now use exponential backoff, capped at sixty seconds for each attempt.';
  const r = reanchor([DOC[5]], edited, { hint: 6 });
  assert.equal(r.how, 'fuzzy');
  assert.deepEqual([r.start, r.end], [6, 6]);
  assert.ok(r.score >= 0.55);
  // two equally good places: do not guess
  const twin = ['intro', '', 'Retries use backoff with a ceiling of ten seconds per attempt.', '', 'Retries use backoff with a ceiling of twenty seconds per attempt.'];
  assert.equal(reanchor([DOC[5]], twin), null);
});

test('reanchor: text that is gone gives null, and repeats resolve to the one nearest the original line', () => {
  assert.equal(reanchor(['Nothing like this survives anywhere in the file.'], DOC), null);
  assert.equal(reanchor([], DOC), null);
  const twice = ['same line here', '', 'x', '', 'same line here'];
  assert.equal(reanchor(['same line here'], twice, { hint: 5 }).start, 5);
  assert.equal(reanchor(['same line here'], twice, { hint: 1 }).start, 1);
});

test('inlineDiff: the old and new text as one run, changes marked', () => {
  const { parts, same } = inlineDiff('Retries use exponential backoff, capped at thirty seconds.', 'Retries use exponential backoff, capped at sixty seconds.');
  assert.deepEqual(parts.map((p) => p.t), ['same', 'del', 'ins', 'same']);
  assert.equal(parts[1].text, 'thirty');
  assert.equal(parts[2].text, 'sixty');
  assert.equal(parts.filter((p) => p.t !== 'del').map((p) => p.text).join(''), 'Retries use exponential backoff, capped at sixty seconds.'); // without the removals it reads as the new text
  assert.ok(same >= 6);
  assert.equal(inlineDiff('totally', 'different').same, 0);
  assert.deepEqual(inlineDiff('same words', 'same words').parts, [{ t: 'same', text: 'same words' }]);
});

test('similarity and pairBlocks: old and new paragraphs are matched by what they say, not by position', () => {
  assert.equal(similarity('The same words here.', 'the   same words\nhere.'), 1);
  assert.ok(similarity('Retries use exponential backoff.', 'Retries now use exponential backoff capped at sixty seconds.') > 0.5);
  assert.ok(similarity('Totally unrelated sentence.', 'Nothing in common whatsoever, honestly.') < 0.2);
  // the diff said "these two paragraphs became that one": the one that is left matches the second, not the first
  const olds = ['First paragraph here, with the older wording about timeouts.', 'Second paragraph is hard\nwrapped across two lines for testing.'];
  const news = ['Second paragraph is hard wrapped\nacross two lines for testing.'];
  assert.deepEqual(pairBlocks(olds, news).map(([i, j]) => [i, j]), [[1, 0]]);
  // one old paragraph, two new ones: the closer one gets it
  assert.deepEqual(pairBlocks(['Alpha beta gamma delta.'], ['Unrelated text entirely here.', 'Alpha beta gamma epsilon.']).map(([i, j]) => [i, j]), [[0, 1]]);
  assert.deepEqual(pairBlocks(['abc def ghi'], ['xyz uvw rst']), []); // nothing alike: no pair
});
