// JS side of `sprintf` mode (tools/d2ref/urlcheck.go). Generator: node sprintfcheck.mjs > sprintf.jsonl
import { sprintf } from '../../public/d2/gofmt.js';

export function sprintfCheck(c) {
  const out = { none: sprintf(c.text) };
  if (c.bold) { out.one = sprintf(c.text, 'arg'); out.two = sprintf(c.text, 'a b', 'c'); }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let x = Number(process.argv[2] || 7) >>> 0 || 1;
  const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const parts = ['%', '%%', '%d', '%s', '%v', '%q', '%#v', '%x', '%5d', '%-5s|', '%05d', '%.2s', '%+d', '% d', '%10.3q', '%z', '%é', '%', '%#', '%.', '%5', '%*d', '%.*s', 'a', ' ', 'é', '"', '\\', '100%', '50% off', '%T', '%p', '%c', '%U', '%e', '%f', '%t', '%b', '%o', '%X', '%[1]d', '%+v', '%#q', '%08.3f'];
  const list = [{ text: '' }];
  for (let i = 0; i < 5000; i++) {
    let s = '';
    for (let n = 1 + rnd(4); n > 0; n--) s += parts[rnd(parts.length)];
    list.push({ text: s });
  }
  const simple = ['%v', '%s', '%q', '%#v', '%%', 'a', ' ', 'é', '"', '%5s', '%-5s|', '%.2s', '%10q', '%5v'];
  for (let i = 0; i < 1500; i++) {
    let s = '';
    for (let n = 1 + rnd(4); n > 0; n--) s += simple[rnd(simple.length)];
    list.push({ text: s, bold: true });
  }
  process.stdout.write(list.map((c) => JSON.stringify(c)).join('\n') + '\n');
}
