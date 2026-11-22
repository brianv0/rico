// JS side of `htmlunescape` mode (tools/d2ref/urlcheck.go). Generator for its input:
//   node htmlcheck.mjs [seed] > html.jsonl
import { unescapeString } from '../../public/d2/gohtml.js';
import { jsonStr } from '../../public/d2/url.js';

export const htmlUnescapeCheck = (c) => ({ s: jsonStr(unescapeString(c.text)) });

if (import.meta.url === `file://${process.argv[1]}`) {
  let x = Number(process.argv[2] || 7) >>> 0 || 1;
  const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const names = ['amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'copy', 'reg', 'colon', 'sol', 'lpar', 'notit', 'not', 'NotEqualTilde', 'nLt', 'eacute', 'Eacute', 'ampx', 'AMP', 'amp;', 'foo', 'Tab', 'NewLine', 'lbrace', 'verbar', 'bsol', 'lowbar', 'times', 'timesb', 'frac12', 'frac14x', 'para', 'sect', 'thinsp'];
  const parts = ['&', ';', '#', 'x', 'X', '0', '1', '9', 'a', 'f', 'g', '80', '9f', '110000', 'd800', '0', '41', 'ffffffff', '100000000', '7fffffff', '80000000', ' ', 'é', '/', ':', '='];
  const list = ['', '&', '&&', '&#', '&#;', '&#x', '&#x;', '&#1', '&#1;', '&#x1;', '&amp', '&amp;', 'a&b', 'http&colon;//x', '&#58;//', '&#x3a;//', 'javascript&colon;'];
  for (let i = 0; i < 6000; i++) {
    let s = '';
    for (let n = 1 + rnd(5); n > 0; n--) {
      const r = rnd(4);
      if (r === 0) s += '&' + names[rnd(names.length)] + (rnd(2) ? ';' : '');
      else if (r === 1) s += '&#' + (rnd(2) ? 'x' : '') + parts[rnd(parts.length)] + parts[rnd(parts.length)] + (rnd(2) ? ';' : '');
      else if (r === 2) s += parts[rnd(parts.length)];
      else s += 'ab/:'[rnd(4)];
    }
    list.push(s);
  }
  process.stdout.write(list.map((text) => JSON.stringify({ text })).join('\n') + '\n');
}
