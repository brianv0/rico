// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The part of D2's lib/textmeasure that d2ir calls (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.):
// ReplaceSubstitutionsMarkdown. Go finds the text nodes with goldmark; there is no markdown parser in this port
// yet, so the code spans, fenced code blocks and indented code blocks that goldmark skips are found with a small
// line scanner. Everything else is treated as text.

// Go's strings.ReplaceAll(s, "${k}", v) for each variable, in map order (insertion order here).
function replaceVariables(s, vars) {
  for (const [k, v] of vars) s = s.split('${' + k + '}').join(v);
  return s;
}

/** Spans [start, end) of mdText that goldmark treats as code and so skips. */
function codeSpans(md) {
  const spans = [];
  const lines = md.split('\n');
  let off = 0, fence = null, prevBlank = true, inPara = false;
  for (const line of lines) {
    const end = off + line.length;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      spans.push([off, end + 1]);
      const c = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
      if (c.test(line)) fence = null;
    } else if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
      fence = m[1];
      spans.push([off, end + 1]);
    } else if (/^( {4}|\t)/.test(line) && line.trim() !== '' && !inPara) {
      spans.push([off, end + 1]);
    }
    const blank = line.trim() === '';
    inPara = !blank && !fence && !/^( {4}|\t)/.test(line) ? true : blank ? false : inPara;
    prevBlank = blank;
    off = end + 1;
  }
  // inline code spans: a backtick run closed by a run of the same length
  let i = 0;
  while (i < md.length) {
    if (spans.some(([a, b]) => i >= a && i < b)) { i++; continue; }
    if (md[i] === '\\') { i += 2; continue; }
    if (md[i] !== '`') { i++; continue; }
    let j = i;
    while (md[j] === '`') j++;
    const run = j - i;
    let k = j, found = -1;
    while (k < md.length) {
      if (md[k] !== '`') { k++; continue; }
      let e = k;
      while (md[e] === '`') e++;
      if (e - k === run) { found = e; break; }
      k = e;
    }
    if (found < 0) { i = j; continue; }
    spans.push([i, found]);
    i = found;
  }
  void prevBlank;
  return spans;
}

/** Go's textmeasure.ReplaceSubstitutionsMarkdown(mdText, variables); variables is a Map of name to value. */
export function replaceSubstitutionsMarkdown(mdText, variables) {
  if (variables.size === 0 || !mdText.includes('${')) return mdText;
  const spans = codeSpans(mdText);
  let out = '', pos = 0;
  const flush = (a, b) => { out += replaceVariables(mdText.slice(a, b), variables); };
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    if (a < pos) continue;
    flush(pos, a);
    out += mdText.slice(a, Math.min(b, mdText.length));
    pos = Math.min(b, mdText.length);
  }
  flush(pos, mdText.length);
  return out;
}
