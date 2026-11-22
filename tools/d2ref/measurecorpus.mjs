// Builds the input for `node diff.mjs measure`: every label / markdown / code string in corpus.jsonl (found by
// parsing each case with public/d2/parser.js), crossed with the font sizes and styles D2 uses, plus hand-written
// unicode / emoji / CJK / RTL / multi-line strings.
//
//   node measurecorpus.mjs corpus.jsonl > measure.jsonl
import fs from 'node:fs';
import { parse } from '../../public/d2/parser.js';

const file = process.argv[2] || 'corpus.jsonl';
const strings = new Set();
const blocks = new Map(); // text -> Set(tag)

function walk(n) {
  if (Array.isArray(n)) return n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  for (const k of ['unquoted_string', 'double_quoted_string', 'single_quoted_string']) {
    if (n[k] && Array.isArray(n[k].value)) strings.add(n[k].value.map((c) => c.string ?? '').join(''));
  }
  if (n.block_string) {
    const b = n.block_string;
    if (!blocks.has(b.value)) blocks.set(b.value, new Set());
    blocks.get(b.value).add(b.tag);
  }
  for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
}
for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
  const c = JSON.parse(line);
  let r;
  try { r = parse(c.path, c.text, {}); } catch { continue; }
  walk(r.ast ?? r);
}

const extra = [
  '', ' ', 'a', 'Hello', 'WAVE To AV', 'fi fl ffi', 'éèêë ÀÁÂÃÄÅ ñÑ ß',
  '你好，世界', '日本語のテキスト カタカナ', '한국어 텍스트',
  '😀 smile', '👨‍👩‍👧 family', '🇺🇸 flag', '❤️ heart', '❤︎ text heart',
  'שלום עולם', 'مرحبا بالعالم', 'mixed שלום and english',
  'é combining', 'สวัสดี', 'नमस्ते',
  'tab\there', 'a\tb\tc', '\tleading tab', 'cr\rlf', 'crlf\r\nline', 'line1\nline2\nline3', '\n', 'a\n\nb', 'trailing\n', '\nleading',
  '■□▲● ◆', 'a b', 'zero​width', 'a\u2028b',
  'The quick brown fox jumps over the lazy dog. '.repeat(8).trim(),
  Array.from({ length: 40 }, (_, i) => `line ${i} — ${'x'.repeat(i)}`).join('\n'),
  '中文\n日本語\nEnglish\n😀',
  'func main() {\n\tfmt.Println("hi")\n}',
  '   indented\n  more',
];
for (const s of extra) strings.add(s);

const sizes = [13, 14, 16, 20, 24, 28, 32];
const out = [];
const emit = (o) => out.push(JSON.stringify(o));
// plain labels: a rotating selection of sizes/styles/families per string, plus the default family+16 always
let i = 0;
for (const s of strings) {
  if (s.length > 4000) continue;
  const fam = ['SourceSansPro', 'SourceSansPro', 'HandDrawn', 'SourceCodePro'][i % 4];
  emit({ text: s, fontFamily: 'SourceSansPro', fontSize: 16 });
  emit({ text: s, fontFamily: fam, fontSize: sizes[i % sizes.length], bold: i % 3 === 0, italic: i % 3 === 1 });
  i++;
}
// code blocks
for (const [text, tags] of blocks) {
  if (text.length > 4000) continue;
  for (const tag of tags) {
    if (tag === 'md' || tag === 'markdown') {
      for (const size of [16, 20]) emit({ text, fontFamily: 'SourceSansPro', fontSize: size, markdown: true });
      emit({ text, fontFamily: 'HandDrawn', monoFamily: 'SourceCodePro', fontSize: 16, markdown: true });
    } else if (tag && tag !== 'latex' && tag !== 'tex') {
      for (const size of [13, 16]) emit({ text, fontSize: size, language: tag });
    } else {
      emit({ text, fontFamily: 'SourceSansPro', fontSize: 16 });
    }
  }
}
// every font/style/size on a fixed pangram
for (const fam of ['SourceSansPro', 'SourceCodePro', 'HandDrawn']) {
  for (const size of [1, 7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32, 36, 48, 64, 100]) {
    for (const [bold, italic] of [[false, false], [true, false], [false, true]]) {
      emit({ text: 'Sphinx of black quartz, judge my vow! 0123456789 éüñ ■', fontFamily: fam, fontSize: size, bold, italic });
    }
  }
}
// markdown shapes (headings, emphasis, lists, nested lists, tables, quotes, code, html, links, hr, br)
const mds = [
  '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6', 'Setext\n======\n\nSub\n---', 'plain *em* **strong** ***both*** ~~strike~~ `code` [link](http://x.y?a=1&b=2)',
  '- a\n- b\n  - c\n  - d\n    - e\n- f', '1. one\n2. two\n3. three', '- a\n\n- b\n\n  para in li', '> quote\n> more\n>\n> > nested', '```go\nfunc main() {\n\tfmt.Println(1)\n}\n```',
  '    indented code\n    more', '| a | b |\n|---|:-:|\n| 1 | 2 |\n| long cell text | **x** |', 'a  \nhard break\nsoft break', '---\n\ntext\n\n***',
  '<div>raw <b>html</b></div>\n\npara', '<table><tr><td>x</td><td>yy</td></tr></table>', 'entity &amp; &copy; &lt;b&gt; &#65; &nbsp;x', '\u4f60\u597d **\u4e16\u754c** \ud83d\ude00',
  '![img](http://x/y.png) text', '<http://autolink.com> and www.example.com', 'line one\n\n\n\nline two', '  \n', '* [ ] task\n* [x] done', 'a<br>b<br/>c', '# Title with `code` and *em*\n\ntext',
  '1. a\n   ```\n   code\n   ```\n2. b', 'term\n: not definition', '<!-- comment -->\ntext', '<span>inline</span> <em>x</em>text', '\\*escaped\\*',
  'x'.repeat(100) + '\n\n' + 'y'.repeat(30),
];
for (const text of mds) {
  for (const size of [13, 16, 24]) emit({ text, fontFamily: 'SourceSansPro', fontSize: size, markdown: true });
  emit({ text, fontFamily: 'HandDrawn', monoFamily: 'SourceCodePro', fontSize: 20, markdown: true });
  emit({ text, markdown: true, fontSize: 16 });
}
if (process.argv.includes('--big')) {
  const all = Runes().map((r) => String.fromCodePoint(r)).join('');
  for (const fam of ['SourceSansPro', 'SourceCodePro', 'HandDrawn']) {
    for (let size = 1; size <= 100; size++) {
      for (const [bold, italic] of [[false, false], [true, false], [false, true]]) emit({ text: all, fontFamily: fam, fontSize: size, bold, italic });
    }
  }
  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
  for (const [fam, bold, italic] of [['SourceSansPro', false, false], ['SourceSansPro', false, true], ['SourceSansPro', true, false], ['SourceCodePro', false, false], ['SourceCodePro', true, false], ['HandDrawn', false, false], ['HandDrawn', true, false]]) {
    for (const a of ascii) for (const b of ascii) emit({ text: a + b, fontFamily: fam, fontSize: 24, bold, italic });
  }
  // unicode: widths/graphemes over many code points
  for (let cp = 0x80; cp < 0x30000; cp += 7) {
    if (cp >= 0xd800 && cp < 0xe000) continue;
    emit({ text: 'a' + String.fromCodePoint(cp) + 'b' + String.fromCodePoint(cp + 1 >= 0xd800 && cp + 1 < 0xe000 ? 0x41 : cp + 1), fontFamily: 'SourceSansPro', fontSize: 16 });
  }
}
if (process.argv.includes('--big')) {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pool = [0x61, 0x42, 0x20, 0x0a, 0x0d, 0x09, 0x200d, 0xfe0e, 0xfe0f, 0x301, 0x300, 0x1f1e6, 0x1f1fa, 0x1f1f8, 0x1f600, 0x1f468, 0x1f469, 0x2764, 0x2600, 0xa9, 0x1100, 0x1161, 0x11a8, 0xac00, 0xac01, 0xd55c, 0x4e2d, 0x3042, 0x30ab, 0xff21, 0xff0c,
    0xe01, 0xe31, 0xe33, 0x915, 0x94d, 0x93e, 0x93f, 0x600, 0x5d0, 0x627, 0x64b, 0x1f3fb, 0x20e3, 0x23, 0x2e3a, 0x2e3b, 0x7f, 0x85, 0xad, 0x200b, 0x2028, 0x1f9d1, 0x2640, 0xe0067, 0xe007f, 0x1b000, 0x3000, 0xa0];
  for (let i = 0; i < 30000; i++) {
    const n = 1 + rnd(12);
    let t = '';
    for (let k = 0; k < n; k++) t += String.fromCodePoint(pool[rnd(pool.length)]);
    emit({ text: t, fontFamily: ['SourceSansPro', 'HandDrawn', 'SourceCodePro'][i % 3], fontSize: [13, 16, 24][i % 3], bold: i % 5 === 0 });
  }
}
function Runes() { const r = []; for (let i = 0; i <= 0xff; i++) r.push(i); for (let i = 0x25a0; i <= 0x25ff; i++) r.push(i); return r; }
process.stdout.write(out.join('\n') + '\n');
