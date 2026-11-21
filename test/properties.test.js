// Executable form of docs/formal-spec.md: each test names the invariant it checks (e.g. "INV-A1").
// Inputs come from a small seeded generator, so a failure is reproducible: re-run with the printed seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrRef, prPath, parsePrPath, parsePatch, parsePatchRows, patchHunkRanges, patchDeletions, oldToNewMap,
  clampRange, buildReview, previewLines, statBlocks, buildFileTree, trimBlock, locateLine, formatQuote, plainQuote,
} from '../public/lib.js';

// ---- seeded PRNG (mulberry32) and generators ----
const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const each = (fn) => { for (const seed of SEEDS) { try { fn(rng(seed), seed); } catch (e) { e.message = `seed ${seed}: ${e.message}`; throw e; } } };

/** A well-formed unified diff: [{type:' '|'+'|'-', text}] grouped into hunks with correct @@ headers. */
function genPatch(r) {
  let o = int(r, 1, 5);
  let n = o;
  const out = [];
  const hunks = int(r, 1, 4);
  for (let h = 0; h < hunks; h++) {
    const body = [];
    const len = int(r, 1, 12);
    for (let i = 0; i < len; i++) body.push([' ', '+', '-'][int(r, 0, 2)]);
    const oc = body.filter((c) => c !== '+').length;
    const nc = body.filter((c) => c !== '-').length;
    out.push(`@@ -${o},${oc} +${n},${nc} @@`);
    body.forEach((c, i) => out.push(c + `line ${h}.${i}`));
    const gap = int(r, 1, 6); // unchanged lines between hunks: the same on both sides
    o += oc + gap;
    n += nc + gap;
  }
  return out.join('\n');
}

const hunkList = (rows) => patchHunkRanges(rows);

// ---------- Anchoring ----------

test('INV-A1 clampRange: the result lies inside one hunk and inside the request, and is maximal', () => {
  each((r) => {
    const hunks = [];
    let at = int(r, 1, 5);
    for (let i = 0; i < int(r, 1, 5); i++) { const len = int(r, 1, 10); hunks.push({ start: at, end: at + len - 1 }); at += len + int(r, 1, 8); }
    const s = int(r, 1, at + 5);
    const e = s + int(r, 0, 25);
    const got = clampRange(s, e, hunks);
    const overlaps = hunks.map((h) => ({ h, len: Math.min(e, h.end) - Math.max(s, h.start) + 1 })).filter((x) => x.len > 0);
    if (!overlaps.length) { assert.equal(got, null, 'no overlap -> null'); return; }
    assert.ok(got, 'overlap -> a result');
    assert.ok(got.start >= s && got.end <= e, 'inside the request');
    assert.ok(hunks.some((h) => got.start >= h.start && got.end <= h.end), 'inside one hunk');
    assert.equal(got.end - got.start + 1, Math.max(...overlaps.map((x) => x.len)), 'maximal overlap');
    assert.equal(got.exact, got.start === s && got.end === e, 'exact iff nothing was trimmed');
  });
});

test('INV-A2 clampRange is idempotent: clamping an exact result changes nothing', () => {
  each((r) => {
    const hunks = [{ start: int(r, 1, 5), end: 20 }, { start: 30, end: 40 }];
    const a = clampRange(int(r, 1, 45), int(r, 20, 50), hunks);
    if (!a) return;
    const b = clampRange(a.start, a.end, hunks);
    assert.deepEqual({ start: b.start, end: b.end, exact: b.exact }, { start: a.start, end: a.end, exact: true });
  });
});

// ---------- Diff parsing ----------

test('INV-D1 parsePatch hunks equal the RIGHT-side ranges of parsePatchRows; added = the "add" rows', () => {
  each((r) => {
    const patch = genPatch(r);
    const rows = parsePatchRows(patch);
    const { hunks, added } = parsePatch(patch);
    const right = hunkList(rows).map((h) => h.right).filter(Boolean);
    assert.deepEqual(hunks, right);
    assert.deepEqual([...added].sort((x, y) => x - y), rows.filter((x) => x.type === 'add').map((x) => x.new));
  });
});

test('INV-D2 line numbers are monotone: new numbers strictly increase over add/ctx rows, old over del/ctx rows', () => {
  each((r) => {
    const rows = parsePatchRows(genPatch(r)).filter((x) => x.type !== 'hunk' && x.type !== 'meta');
    const news = rows.filter((x) => x.new != null).map((x) => x.new);
    const olds = rows.filter((x) => x.old != null).map((x) => x.old);
    for (let i = 1; i < news.length; i++) assert.ok(news[i] > news[i - 1], 'new strictly increasing');
    for (let i = 1; i < olds.length; i++) assert.ok(olds[i] > olds[i - 1], 'old strictly increasing');
  });
});

test('INV-D3 every row has a side: add has only new, del only old, ctx both', () => {
  each((r) => {
    for (const x of parsePatchRows(genPatch(r))) {
      if (x.type === 'add') assert.ok(x.new != null && x.old == null);
      if (x.type === 'del') assert.ok(x.old != null && x.new == null);
      if (x.type === 'ctx') assert.ok(x.new != null && x.old != null);
    }
  });
});

test('INV-D4 patchDeletions covers exactly the "del" rows, as disjoint ascending runs', () => {
  each((r) => {
    const rows = parsePatchRows(genPatch(r));
    const dels = rows.filter((x) => x.type === 'del').map((x) => x.old);
    const runs = patchDeletions(rows);
    const covered = runs.flatMap((u) => Array.from({ length: u.oldEnd - u.oldStart + 1 }, (_, i) => u.oldStart + i));
    assert.deepEqual(covered, dels);
    for (let i = 1; i < runs.length; i++) assert.ok(runs[i].oldStart > runs[i - 1].oldEnd);
  });
});

test('INV-D5 oldToNewMap maps exactly the context rows', () => {
  each((r) => {
    const rows = parsePatchRows(genPatch(r));
    const m = oldToNewMap(rows);
    const ctx = rows.filter((x) => x.type === 'ctx');
    assert.equal(m.size, ctx.length);
    for (const x of ctx) assert.equal(m.get(x.old), x.new);
  });
});

// ---------- Review construction ----------

function genComments(r) {
  const out = [];
  for (let i = 0, k = int(r, 0, 8); i < k; i++) {
    const start = int(r, 1, 60);
    const end = start + int(r, 0, 8);
    const kind = int(r, 0, 2); // 0 exact, 1 clamped, 2 unanchored
    const anchor = kind === 2 ? null : kind === 0 ? { start, end, exact: true } : { start, end: Math.max(start, end - 1), exact: false };
    out.push({ id: `c${i}`, path: `docs/f${int(r, 0, 2)}.md`, side: int(r, 0, 3) === 0 ? 'LEFT' : 'RIGHT', start, end, quote: `quote ${i}`, anchor, body: `body ${i}`, includeQuote: int(r, 0, 1) === 1, quoteMd: `> quote ${i}` });
  }
  return out;
}

test('INV-R1 buildReview conserves comments: every body appears exactly once, inline or in the review body', () => {
  each((r) => {
    const comments = genComments(r);
    const rev = buildReview({ comments, summary: 'sum', event: 'COMMENT', commitId: 'abc' });
    const haystack = rev.comments.map((c) => c.body).join('\n') + '\n' + (rev.body || '');
    for (const c of comments) assert.equal(haystack.split(c.body).length - 1, 1, `body of ${c.id} appears once`);
    assert.equal(rev.comments.length, comments.filter((c) => c.anchor).length, 'anchored -> inline');
  });
});

test('INV-R2 inline comments are well-formed for GitHub: line = anchor end, start_line < line only for ranges, matching sides', () => {
  each((r) => {
    const comments = genComments(r).filter((c) => c.anchor);
    const rev = buildReview({ comments, summary: '', event: 'COMMENT', commitId: 'abc' });
    rev.comments.forEach((x, i) => {
      const c = comments[i];
      assert.equal(x.path, c.path);
      assert.equal(x.line, c.anchor.end);
      assert.equal(x.side, c.side === 'LEFT' ? 'LEFT' : 'RIGHT');
      if (c.anchor.start < c.anchor.end) { assert.equal(x.start_line, c.anchor.start); assert.equal(x.start_side, x.side); assert.ok(x.start_line < x.line); } else assert.ok(!('start_line' in x));
    });
  });
});

test('INV-R3 unanchored comments always carry their quote; the review is pinned to the loaded commit and event', () => {
  each((r) => {
    const comments = genComments(r);
    const rev = buildReview({ comments, summary: '', event: 'REQUEST_CHANGES', commitId: 'deadbeef' });
    assert.equal(rev.commit_id, 'deadbeef');
    assert.equal(rev.event, 'REQUEST_CHANGES');
    for (const c of comments.filter((x) => !x.anchor)) assert.ok(rev.body.includes(c.quoteMd), 'quote in summary');
  });
});

test('INV-R4 a clamped (non-exact) comment says what was selected versus anchored', () => {
  each((r) => {
    const comments = genComments(r).filter((c) => c.anchor && !c.anchor.exact);
    const rev = buildReview({ comments, summary: '', event: 'COMMENT', commitId: 'x' });
    for (const x of rev.comments) assert.match(x.body, /_Selected lines? \d+(–\d+)?; anchored to lines? \d+(–\d+)?\._/);
  });
});

test('INV-R5 an empty queue and empty summary yield no body and no comments', () => {
  const rev = buildReview({ comments: [], summary: '   ', event: 'COMMENT', commitId: 'x' });
  assert.deepEqual(rev, { commit_id: 'x', event: 'COMMENT', comments: [] });
});

// ---------- Addressing ----------

test('INV-U1 prPath / parsePrPath round-trip (sha shortened to 7 chars)', () => {
  each((r) => {
    const ref = { owner: `o${int(r, 0, 99)}`, repo: `r.${int(r, 0, 99)}`, number: int(r, 1, 99999) };
    const sha = r() < 0.5 ? '' : 'abcdef0123456789abcdef0123456789abcdef01';
    const back = parsePrPath(prPath(ref, sha));
    assert.deepEqual({ owner: back.owner, repo: back.repo, number: back.number, sha: back.sha, instance: back.instance }, { ...ref, sha: sha.slice(0, 7), instance: 'github.com' });
  });
});

test('INV-U2 dot segments are never accepted as owner or repo (path-escape guard)', () => {
  for (const bad of ['./r#1', '../r#1', 'o/..#1', 'o/.#1', 'https://github.com/../r/pull/1', 'https://github.com/o/../pull/1']) assert.equal(parsePrRef(bad), null, bad);
  for (const bad of ['/github.com/../r/1', '/github.com/o/../1']) assert.equal(parsePrPath(bad), null, bad);
});

// ---------- Presentation ----------

test('INV-V1 previewLines loses nothing except a reported gap', () => {
  each((r) => {
    const text = Array.from({ length: int(r, 1, 40) }, (_, i) => `l${i}`).join('\n');
    const total = text.split('\n').length;
    const p = previewLines(text);
    assert.equal(p.head.length + p.omitted + p.tail.length, total);
    if (p.omitted) assert.ok(p.omitted >= 2, 'a gap marker never hides a single line');
  });
});

test('INV-V2 statBlocks is five squares; g/r appear iff there are additions/deletions', () => {
  each((r) => {
    const a = int(r, 0, 500);
    const d = int(r, 0, 500);
    const s = statBlocks(a, d);
    assert.equal(s.length, 5);
    assert.equal(s.includes('g'), a > 0);
    assert.equal(s.includes('r'), d > 0);
    assert.match(s, /^g*r*n*$/);
  });
});

test('INV-V3 buildFileTree contains every file exactly once, directories before files at each level', () => {
  each((r) => {
    const names = new Set();
    for (let i = 0, k = int(r, 1, 15); i < k; i++) names.add(Array.from({ length: int(r, 1, 3) }, () => ['a', 'b', 'docs', 'guide'][int(r, 0, 3)]).join('/') + `/f${i}.md`);
    const files = [...names].map((filename) => ({ filename }));
    const tree = buildFileTree(files);
    const seen = [];
    const walk = (nodes) => {
      const kinds = nodes.map((n) => n.type);
      assert.deepEqual(kinds, [...kinds].sort((x, y) => (x === y ? 0 : x === 'dir' ? -1 : 1)), 'dirs first');
      for (const n of nodes) { if (n.type === 'file') seen.push(n.path); else walk(n.children); }
    };
    walk(tree);
    assert.deepEqual(seen.sort(), [...names].sort());
  });
});

// ---------- Source mapping ----------

test('INV-S1 trimBlock yields a non-empty range inside the block', () => {
  each((r) => {
    const lines = Array.from({ length: int(r, 1, 20) }, () => (r() < 0.3 ? '' : 'text'));
    const a0 = int(r, 0, lines.length - 1);
    const b0 = int(r, a0 + 1, lines.length);
    const { s, e } = trimBlock(lines, a0, b0);
    assert.ok(s === a0 + 1 && e >= s && e <= b0);
  });
});

test('INV-S2 locateLine always returns a line inside the block (never a wrong-block line)', () => {
  each((r) => {
    const lines = Array.from({ length: int(r, 1, 12) }, (_, i) => `word${i} more words here`);
    const s = int(r, 1, lines.length);
    const e = int(r, s, lines.length);
    const got = locateLine(lines, { s, e }, { which: r() < 0.5 ? 'start' : 'end', fence: r() < 0.3, renderedTotal: int(r, 0, 60), wordsBefore: int(r, 0, 60), midWord: r() < 0.5, newlinesBefore: int(r, 0, 20) });
    assert.ok(got >= s && got <= e);
  });
});

test('INV-S3 locateLine falls back to the block edge when rendered and source word counts disagree', () => {
  const lines = ['alpha beta', 'gamma delta', 'epsilon'];
  const block = { s: 1, e: 3 };
  assert.equal(locateLine(lines, block, { which: 'start', fence: false, renderedTotal: 99, wordsBefore: 3, midWord: false, newlinesBefore: 0 }), 1);
  assert.equal(locateLine(lines, block, { which: 'end', fence: false, renderedTotal: 99, wordsBefore: 3, midWord: false, newlinesBefore: 0 }), 3);
});

test('INV-Q1 formatQuote: empty in, empty out; fences are balanced; plainQuote keeps every segment', () => {
  assert.equal(formatQuote([]), '');
  each((r) => {
    const segs = Array.from({ length: int(r, 1, 5) }, (_, i) => (r() < 0.4
      ? { kind: 'code', lang: 'js', text: Array.from({ length: int(r, 1, 30) }, (__, j) => `x${j}`).join('\n') }
      : { kind: 'text', text: `prose ${i} `.repeat(int(r, 1, 40)).trim() }));
    const md = formatQuote(segs);
    const fences = md.split('\n').filter((l) => /^`{3,}/.test(l));
    assert.equal(fences.length % 2, 0, 'every opened fence is closed');
    assert.equal(plainQuote(segs).split('\n\n').length, segs.length);
  });
});
