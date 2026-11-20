// Pure logic shared by the browser UI, the server, and the tests. No DOM, no Node APIs.

/** Parse "https://github.com/o/r/pull/12/files", "o/r#12", "o/r/pull/12" -> {owner, repo, number} | null */
export function parsePrRef(input) {
  const s = String(input || '').trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(s);
  if (!m) m = /^([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/**
 * Parse a unified-diff patch (as returned by GET /pulls/:n/files) into the RIGHT-side
 * line numbers GitHub will accept review comments on.
 *   hunks: [{start, end}]  contiguous RIGHT-side ranges (context + added lines)
 *   added: Set of added RIGHT-side line numbers
 */
export function parsePatch(patch) {
  const hunks = [];
  const added = new Set();
  if (!patch) return { hunks, added };
  let ln = 0;
  let remaining = 0;
  let cur = null;
  for (const raw of String(patch).split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (m) {
      ln = Number(m[1]);
      remaining = m[2] === undefined ? 1 : Number(m[2]);
      cur = { start: ln, end: ln - 1 };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = raw[0];
    if (c === '-' || c === '\\') continue; // removed line / "no newline" marker: not on the RIGHT side
    if (remaining <= 0) continue;
    if (c === '+') added.add(ln);
    else if (c !== ' ' && raw !== '') continue;
    cur.end = ln;
    ln++;
    remaining--;
  }
  return { hunks: hunks.filter((h) => h.end >= h.start), added };
}

/**
 * Clamp a wanted source-line range to what GitHub can anchor a comment to.
 * A multi-line comment must sit inside one hunk, so pick the hunk with the largest overlap.
 * Returns {start, end, exact} or null when the range touches no hunk.
 */
export function clampRange(start, end, hunks) {
  let best = null;
  for (const h of hunks) {
    const s = Math.max(start, h.start);
    const e = Math.min(end, h.end);
    if (s > e) continue;
    const len = e - s + 1;
    if (!best || len > best.len) best = { start: s, end: e, len };
  }
  return best ? { start: best.start, end: best.end, exact: best.start === start && best.end === end } : null;
}

/** Number of "words" (whitespace-separated tokens containing a letter or digit). */
export function wordCount(text) {
  let n = 0;
  for (const t of String(text).split(/\s+/)) if (/[\p{L}\p{N}]/u.test(t)) n++;
  return n;
}

/** Words in one markdown source line, ignoring list/quote/heading markers that never render. */
export function srcWords(line) {
  let s = String(line);
  for (;;) {
    const next = s.replace(/^\s*(?:>|[-*+]|\d+[.)])\s+/, '').replace(/^\s*#{1,6}\s+/, '');
    if (next === s) break;
    s = next;
  }
  return wordCount(s);
}

/** Which line (index into counts) holds word number `idx` (0-based)? Skips zero-word lines. */
export function lineForWord(counts, idx) {
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    acc += counts[i];
    if (idx < acc) return i;
  }
  return counts.length - 1;
}

/** Trim blank lines off a markdown-it block map [start0, end0) -> 1-based inclusive {s, e}. */
export function trimBlock(lines, start0, end0) {
  let s = start0 + 1;
  let e = Math.min(end0, lines.length);
  while (e > s && !String(lines[e - 1] ?? '').trim()) e--;
  return { s, e };
}

/**
 * Locate the source line for one end of a selection inside a block.
 *  block: {s, e} 1-based inclusive; lines: all source lines
 *  info: {fence, renderedTotal, wordsBefore (words fully/partly before the point),
 *         newlinesBefore (code blocks), midWord, which: 'start'|'end'}
 * Falls back to the block's own bounds whenever the rendered text and the source disagree.
 */
export function locateLine(lines, block, info) {
  const { s, e } = block;
  const fallback = info.which === 'start' ? s : e;
  if (s === e) return s;
  if (info.fence) {
    const body = Math.max(0, info.newlinesBefore);
    return Math.min(e, Math.max(s, s + 1 + body));
  }
  const counts = lines.slice(s - 1, e).map(srcWords);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total || total !== info.renderedTotal) return fallback;
  const idx =
    info.which === 'start'
      ? Math.min(total - 1, Math.max(0, info.wordsBefore - (info.midWord ? 1 : 0)))
      : Math.min(total - 1, Math.max(0, info.wordsBefore - 1));
  return s + lineForWord(counts, idx);
}

/** Markdown blockquote of (truncated) text. */
export function quoteText(text, max = 600) {
  let t = String(text).replace(/\r/g, '').trim();
  if (t.length > max) t = t.slice(0, max).trimEnd() + '…';
  return t.split('\n').map((l) => '> ' + l).join('\n');
}

/**
 * Turn queued comments into a GitHub "create review" payload.
 * Comments that cannot be anchored to a diff line go into the review body with a quote.
 */
export function buildReview({ comments, summary, event, commitId }) {
  const inline = [];
  const loose = [];
  for (const c of comments) {
    if (c.anchor) {
      const body = (c.anchor.exact ? '' : quoteText(c.quote) + '\n\n') + c.body;
      const item = { path: c.path, line: c.anchor.end, side: 'RIGHT', body };
      if (c.anchor.start < c.anchor.end) {
        item.start_line = c.anchor.start;
        item.start_side = 'RIGHT';
      }
      inline.push(item);
    } else {
      const where = c.start === c.end ? `L${c.start}` : `L${c.start}–${c.end}`;
      loose.push(`**\`${c.path}\` ${where}**\n${quoteText(c.quote)}\n\n${c.body}`);
    }
  }
  const body = [summary?.trim(), ...loose].filter(Boolean).join('\n\n---\n\n');
  const out = { commit_id: commitId, event, comments: inline };
  if (body) out.body = body;
  return out;
}

/**
 * Resolve a markdown image/link target to a repo-root-relative path, or null when it is not
 * a relative repo path (absolute URL, protocol-relative, data:, #anchor).
 *   fileDir: directory of the markdown file, e.g. "docs/guide" ("" for the repo root)
 */
export function resolveRepoPath(fileDir, src) {
  const raw = String(src || '').split(/[?#]/)[0];
  if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null;
  const parts = raw.startsWith('/') ? [] : String(fileDir || '').split('/').filter(Boolean);
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(decodeURIComponent(seg));
  }
  return parts.length ? parts.join('/') : null;
}
