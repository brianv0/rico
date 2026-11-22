// Generator of graph-stage cases that exercise the Markdown validation of d2compiler (md block strings and tooltips):
//   node graphmd.mjs corpus.jsonl [count] [seed] > graphmd.jsonl
// Markdown snippets (taken from corpus.jsonl's block strings, plus hand-written HTML-ish ones) are mutated and
// wrapped as `a: |md ... |md` or `a: { tooltip: "..." }`.
import fs from 'node:fs';
import { parse } from '../../public/d2/parser.js';

const [file, count = '3000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
const blocks = new Set();
const walk = (n) => {
  if (Array.isArray(n)) return n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  if (n.block_string) blocks.add(n.block_string.value);
  for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
};
for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
  try { walk(parse('x.d2', JSON.parse(line).text, {}).ast); } catch { /* skip */ }
}
const hand = ['# Title\n\ntext **b** _i_ `c`', '- a\n- b\n  - c', '1. x\n2. y', '> quote\n> more', '```\ncode < & >\n```', '    indented\n', '| a | b |\n|---|---|\n| 1 | 2 |', '[l](http://x.com?a=1&b=2)', '![img](http://x/y.png)', '<b>x</b>', '<br>', 'a<br/>b', '<div>x</div>', '<p>p', '</p>', '<span class="a">x</span>', '<input disabled>', '<a href=x>y</a>', '&amp; &lt; &gt; &nbsp; &copy; &#65; &#x41;', '<!-- c -->', '<![CDATA[x]]>', '***', '---', '~~del~~', 'a  \nb', '\\*', '<http://auto.link>', 'x\u0000y', 'tab\tx', '日本語 😀', '<script>x</script>', '<style>a{}</style>', '<pre>x</pre>', '<table><tr><td>x</td></tr></table>', '<img src="a" alt=b>', '<hr>', '<ul><li>a</ul>'];
const md = [...blocks, ...hand];
const alphabet = ['<', '>', '/', '&', ';', '#', '*', '_', '`', '"', "'", '=', ' ', '\n', '\n\n', '-', '!', '[', ']', '(', ')', '|', 'b', 'p', 'br', 'a', '1', 'é', '日', '<br>', '</p>', '&amp;', '&nbsp;', '    ', '```', '> '];
const out = [];
for (let i = 0; i < Number(count); i++) {
  let s = md[rnd(md.length)];
  for (let n = rnd(4); n > 0; n--) {
    const chars = Array.from(s);
    const k = rnd(chars.length + 1);
    const r = rnd(3);
    if (r === 0) chars.splice(k, 0, alphabet[rnd(alphabet.length)]);
    else if (r === 1 && chars.length) chars.splice(k % chars.length, 1);
    else chars.splice(k, 0, ...Array.from(md[rnd(md.length)]).slice(0, 1 + rnd(12)));
    s = chars.join('');
  }
  let text;
  if (rnd(3) === 0) text = `a: { tooltip: ${JSON.stringify(s)} }`;
  else if (rnd(2) === 0) text = `a -> b: |md\n${s.split('\n').map((l) => '  ' + l).join('\n')}\n|`;
  else text = `a: |md\n${s.split('\n').map((l) => '  ' + l).join('\n')}\n|`;
  out.push({ from: 'graphmd:' + i, path: 'x.d2', text });
}
process.stdout.write(out.map((c) => JSON.stringify(c)).join('\n') + '\n');
