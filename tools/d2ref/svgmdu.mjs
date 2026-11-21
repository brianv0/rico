// node svgmdu.mjs [count] [seed] > svgmdu.jsonl: Markdown-heavy D2 programs full of non-Latin-1 text for the `svg` stage (the markdown-unicode class):
// Latin Extended, Greek, Cyrillic, CJK, Hangul, Thai, Arabic/Hebrew, emoji (ZWJ sequences, flags, keycaps, variation selectors, skin tones), combining marks,
// format controls (ZWJ, ZWNJ, soft hyphen, NBSP, zero-width space, bidi marks), symbols, mixed with headings, lists, tables, code spans/blocks, links and emphasis.
// Use with `node diff.mjs svg svgmdu.jsonl` (Go compiles with dagre and renders; the JS renderer must print the same SVG).
const [count = '1000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
const pick = (a) => a[rnd(a.length)];
const words = {
  latin: ['hello', 'world', 'Árvíztűrő', 'tükörfúrógép', 'naïve', 'café', 'Ångström', 'Łódź', 'Dvořák', 'ŒuvreÆ', 'straße', 'Việt', 'Nam', 'ǅ', 'ﬁne', 'İstanbul', 'ſ'],
  greek: ['Ελληνικά', 'αβγδ', 'Ωμέγα', 'ΣΊΣΥΦΟΣ', 'λόγος', 'ά', 'ϑ'],
  cyr: ['Привет', 'мир', 'Ёжик', 'Україна', 'Български', 'ђ', 'Ӂ'],
  cjk: ['床前明月光', '今日はTokyoで', 'すしを食べました', '你好，世界！', '漢字', '舉頭望明月', 'ｱｲｳｴｵ', '全角ＡＢＣ', '、。「」', '（括弧）'],
  hangul: ['안녕하세요', '한국어', 'ㄱㄴㄷ', '각', '힣'],
  thai: ['สวัสดี', 'ภาษาไทย', 'กำ'],
  rtl: ['שלום', 'עולם', 'مرحبا', 'العربية', 'ﷲ', '‏x‎'],
  emoji: ['😊', '👩‍👩‍👧‍👶', '🇯🇵', '🇺🇸🇫🇷', '1️⃣', '#️⃣', '❤️', '❤', '⚠', '⚠️', '☺', '✔', '✔️', '👍🏽', '🏳️‍🌈', '🧑‍💻', '🎉', '❤︎', '🫠', '🦄'],
  marks: ['é', 'ñ', 'ä', 'é̂', 'क्ष', 'क्', 'ก้', 'ǰ', '⃣', 'ଅା'],
  fmt: ['‍', '‌', '­', ' ', '​', '⁠', '﻿', ' ', '　', 'in­ter­national­i­za­tion', '\u2028x', '️'],
  sym: ['→', '←', '↔', '≤', '≥', '∑', '√', '∞', '€', '£', '¥', '©', '®', '™', '½', '°', '•', '…', '—', '–', '“', '”', '‘', '’', '■', '□', '▲', '◆', '★', '☆', '♠', '♥', '✓', '✗', '℃', '№', 'ℵ'],
  ascii: ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'x', '1', '2.5', 'foo_bar', 'a.b.c', 'end.'],
};
const classes = Object.keys(words);
const word = () => {
  const c = rnd(5) === 0 ? pick(classes) : pick(['ascii', 'ascii', 'latin', 'cjk', 'emoji', 'cyr', 'greek', 'sym', 'hangul', 'marks']);
  return pick(words[c]);
};
const phrase = (n = 1 + rnd(8)) => Array.from({ length: n }, () => (rnd(6) === 0 ? word() + word() : word())).join(rnd(8) === 0 ? '' : ' ');
const inline = () => {
  const p = phrase();
  switch (rnd(12)) {
    case 0: return `**${p}**`;
    case 1: return `_${p}_`;
    case 2: return `\`${p}\``;
    case 3: return `[${p}](http://example.com/${encodeURIComponent(word())})`;
    case 4: return `~~${p}~~`;
    case 5: return `***${p}***`;
    case 6: return `**${p}** and _${phrase(2)}_`;
    default: return p;
  }
};
const para = () => Array.from({ length: 1 + rnd(5) }, inline).join(rnd(4) === 0 ? ' \n' : ' ');
const block = () => {
  switch (rnd(12)) {
    case 0: return `${'#'.repeat(1 + rnd(6))} ${phrase()}`;
    case 1: return Array.from({ length: 1 + rnd(4) }, () => `- ${inline()}`).join('\n');
    case 2: return Array.from({ length: 1 + rnd(4) }, (_, i) => `${i + 1}. ${inline()}`).join('\n');
    case 3: return '```\n' + Array.from({ length: 1 + rnd(3) }, () => phrase(1 + rnd(4)).replace(/ /g, rnd(3) ? ' ' : '\t')).join('\n') + '\n```';
    case 4: { const cols = 1 + rnd(3); const row = () => `| ${Array.from({ length: cols }, () => inline()).join(' | ')} |`; return [row(), `|${' --- |'.repeat(cols)}`, row(), row()].join('\n'); }
    case 5: return `> ${para()}`;
    case 6: return '---';
    case 7: return `    ${phrase()}`;
    default: return para();
  }
};
const markdown = () => Array.from({ length: 1 + rnd(4) }, block).join('\n\n');
const out = [];
for (let i = 0; i < Number(count); i++) {
  const lines = [];
  const n = 1 + rnd(3);
  for (let k = 0; k < n; k++) {
    const body = markdown().split('\n').map((l) => '  ' + l).join('\n');
    const w = rnd(4) === 0 ? ` {\n  style.font-size: ${pick([10, 14, 20, 28, 40])}\n  style.bold: ${pick(['true', 'false'])}\n}` : '';
    lines.push(`m${k}: |||md\n${body}\n|||${w}`);
  }
  if (n > 1) lines.push(`m0 -> m${n - 1}: ${rnd(2) ? JSON.stringify(phrase()) : '|||md\n  ' + inline() + '\n|||'}`);
  if (rnd(5) === 0) lines.push(`s: ${JSON.stringify(phrase())}`);
  out.push({ from: 'svgmdu:' + i, path: 'x.d2', text: lines.join('\n') + '\n' });
}
process.stdout.write(out.map((c) => JSON.stringify(c)).join('\n') + '\n');
