// JS side of `xml` mode (tools/d2ref/urlcheck.go): the xml.Unmarshal-into-interface{} that d2compiler runs on rendered
// Markdown. Generator for its input (markdown from corpus.jsonl rendered by the port, hand-written XML, mutations):
//   node xmlcheck.mjs corpus.jsonl [seed] > xml.jsonl
import fs from 'node:fs';
import { unmarshalInterface } from '../../public/d2/xml.js';

export function xmlCheck(c) {
  const r = unmarshalInterface(c.text);
  if (r === null) return { err: null };
  return r.syntax ? { err: r.msg, syntax: true } : { err: r.msg };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: markdownit } = await import('markdown-it');
  const { setMarkdownIt, renderMarkdown } = await import('../../public/d2/textmeasure.js');
  const { parse } = await import('../../public/d2/parser.js');
  setMarkdownIt(markdownit);
  let x = Number(process.argv[3] || 7) >>> 0 || 1;
  const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const blocks = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.block_string) blocks.add(n.block_string.value);
    for (const k of ['unquoted_string', 'double_quoted_string', 'single_quoted_string']) if (n[k] && Array.isArray(n[k].value)) blocks.add(n[k].value.map((ch) => ch.string ?? '').join(''));
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  for (const line of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
    try { walk(parse('x.d2', JSON.parse(line).text, {}).ast); } catch { /* skip */ }
  }
  const md = [...blocks, 'a<br>b', '<b>x</i>', '<img src="x">', '<input disabled>', '&nbsp; x', '&copy;', '&#0;', '&#x110000;', '&foo bar;', '<p>x', '</div>', '</div></div>x', '<![CDATA[x]]>', '<!-- x -->', '<!-- x -- y -->', '<?xml version="2.0"?>', '<?xml encoding="latin1"?>', '<a:b></c:b>', '<日本>x</日本>', '<1a>', '<a b=c>', "<a b='c'>", '<a b="<">', '<a\tb="1"\n>x</a>', 'x]]>y', '\u0001', '<br/>', '<br />', '<a/ >', '<!DOCTYPE html>', '<!DOCTYPE a [<!-- c -->]>', '<a:b:c>', '<:a>', '<a:>', '<a: >'];
  const list = [];
  for (const m of md) { list.push({ text: '<div>' + renderMarkdown(m) + '</div>' }); list.push({ text: '<div>' + m + '</div>' }); }
  const alphabet = ['<', '>', '/', '&', ';', '#', 'x', '"', "'", '=', ' ', '\n', '\r', '-', '--', '!', '?', ':', '[', ']', 'CDATA[', '<div>', '</div>', '<p>', '</p>', 'é', '日', '\u0000', '�', '\xff', 'a', 'b1', '1', '&amp;', '&lt;', '&#65;', '<br>', '<img/>', '<!--', '-->'];
  const base = list.slice();
  for (let i = 0; i < 4000; i++) {
    let s = base[rnd(base.length)].text;
    for (let n = 1 + rnd(3); n > 0; n--) {
      const chars = Array.from(s);
      const k = rnd(chars.length + 1);
      const r = rnd(3);
      if (r === 0) chars.splice(k, 0, alphabet[rnd(alphabet.length)]);
      else if (r === 1 && chars.length) chars.splice(k % chars.length, 1);
      else chars.splice(k, 0, ...Array.from(base[rnd(base.length)].text.slice(0, 1 + rnd(10))));
      s = chars.join('');
    }
    list.push({ text: s });
  }
  process.stdout.write(list.map((c) => JSON.stringify(c)).join('\n') + '\n');
}
