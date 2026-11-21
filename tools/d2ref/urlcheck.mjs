// JS side of `url` mode (tools/d2ref/urlcheck.go): net/url Parse and ParseRequestURI. Generator for its input:
//   node urlcheck.mjs [seed] > url.jsonl
import { parse, parseRequestURI, jsonStr } from '../../public/d2/url.js';

function one(f, s) {
  const { url, err } = f(s);
  if (err) return { err: err.message };
  return { url, string: jsonStr(url.toString()), path: jsonStr(url.escapedPath()), hostname: jsonStr(url.hostname()), port: jsonStr(url.port()) };
}

export function urlCheck(c) {
  return { parse: one(parse, c.text), parseRequestURI: one(parseRequestURI, c.text) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let x = Number(process.argv[2] || 7) >>> 0 || 1;
  const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const list = [
    '', '*', '/', '//', '///', 'a', 'a:b', ':', ':a', 'http://', 'http://a', 'http://a/', 'http://a:80/b?c#d', 'HTTP://A.COM', 'https://user:pw@host:8080/p/a/t/h?query=1&b=2#frag',
    'https://user@host', 'https://u:@h', 'https://:p@h', 'https://@h', 'https://a@b@c', 'http://[::1]:80/', 'http://[fe80::1%25en0]/', 'http://[fe80::1%25en%30]:5/', 'http://[::1', 'http://[::1]x',
    'http://a:b/', 'http://a:/', 'http://a:1x/', 'http://a b/', 'http://a%20b/', 'http://a%41b/', 'http://%ff/', 'http://é.com/', 'http://a<b>/', 'http://a"b/',
    'mailto:a@b.c', 'mailto:a@b.c?subject=x', 'tel:+1', 'javascript:alert(1)', 'data:text/plain;base64,AAAA', 'file:///etc/passwd', 'file:/a/b', 'file://host/a', 'urn:x:y',
    '/a/b', '/a b', '/a%2fb', '/a%2Fb', '/a%zz', '/a%', '/a%2', '/%e4%b8%ad', '/%ff', '/中文', '/é', '?', 'a?', 'a??', '?q', '#f', '#', '#%zz', '#a b', '#é', 'a#b#c', 'a b', 'a:b/c', 'a/b:c', './a:b', '1a:b', '+a:b', 'a+b.c-d:e', 'a_b:c',
    '::????:::%%orange', 'x://y', 'x:///y', 'x:////y', '//host', '//host/', '///a', 'a//b', 'http:///a', 'http:a', 'http:/a', 'HTTP:a', 'a\\b', 'a\tb', 'a\nb', '\x7f', 'a\x00b', ' ', ' http://a', 'http://a\u00a0b',
    '/a?b=c d', '/a;b,c', '/a@b:c', '/a$b&c+d=e', "/a'b(c)d*e!f", '/~a-b_c.d', 'a:%2f', 'a:b%zz', 'a://b%zz', 'a://b/%zz', 'a://b?%zz', 'a://b#%zz', '/\ud83d\ude00', 'http://\ud83d\ude00/', 'http://u\u00e9@h/', 'http://u%zz@h/', 'http://u:p%zz@h/',
    'root.layers.x', 'layers.x', 'root.x', 'foo.d2', 'http://localhost:8080', 'https://example.com/a b', 'ftp://ftp.example.com/f.txt', 'www.example.com', 'example.com/path', 'x.png', 'icons/x.svg', 'https://icons.terrastruct.com/essentials%2F092-graph.svg',
  ];
  const alphabet = ['a', 'b', 'Z', '0', '9', ':', '/', '//', '?', '#', '@', '[', ']', '%', '%2f', '%41', '%zz', '%ff', ' ', '.', '-', '+', '_', '~', '&', '=', ';', ',', '*', '!', "'", '(', ')', '<', '>', '"', '\\', '\x01', '\x7f', 'é', '中', '\ud83d\ude00', 'http', 'https:', 'http://', 'a:', '25', '[::1]', ':80', '%25'];
  const base = list.slice();
  for (let i = 0; i < 4000; i++) {
    let s = base[rnd(base.length)];
    for (let n = 1 + rnd(3); n > 0; n--) {
      const chars = Array.from(s);
      const k = rnd(chars.length + 1);
      const r = rnd(3);
      if (r === 0) chars.splice(k, 0, alphabet[rnd(alphabet.length)]);
      else if (r === 1 && chars.length) chars.splice(k % chars.length, 1);
      else { const t = base[rnd(base.length)]; chars.splice(k, 0, ...Array.from(t.slice(0, 1 + rnd(8)))); }
      s = chars.join('');
    }
    list.push(s);
  }
  process.stdout.write(list.map((text) => JSON.stringify({ text })).join('\n') + '\n');
}
