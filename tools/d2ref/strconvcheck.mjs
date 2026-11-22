// JS side of `strconv` mode (tools/d2ref/urlcheck.go): Atoi, ParseFloat, ParseBool. Generator: node strconvcheck.mjs > strconv.jsonl
import { atoi, parseFloat64, parseBool } from '../../public/d2/strconv.js';

export function strconvCheck(c) {
  const [i, ie] = atoi(c.text);
  const [f, fe] = parseFloat64(c.text);
  const [b, be] = parseBool(c.text);
  const fv = Number.isNaN(f) ? 'NaN' : f === Infinity ? '+Inf' : f === -Infinity ? '-Inf' : f;
  return { atoi: { v: i, err: ie }, float: { v: fv, err: fe }, bool: { v: b, err: be } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let x = Number(process.argv[2] || 7) >>> 0 || 1;
  const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const list = ['', '0', '1', '-1', '+1', '+', '-', '01', '007', '0.5', '.5', '5.', '1e3', '1E3', '1e+3', '1e-3', '1e', 'e1', '.', '.e1', '1_000', '1__0', '_1', '1_', '0x10', '0x1p4', '0x1.8p1', '0x.8p0', '0x1', '0xp1', '0X1P-2', '0b101', '0o7', 'inf', 'Inf', '+inf', '-Inf', 'infinity', 'INFINITY', 'infinit', 'infx', 'nan', 'NaN', 'NAN', '+nan', 'nano', ' 1', '1 ', '1\n', '１', 'true', 'TRUE', 'True', 'tRUE', 't', 'T', 'f', 'F', 'false', 'FALSE', 'False', 'yes', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '-9223372036854775809', '99999999999999999999', '1e999', '-1e999', '1e-999', '0.1', '0.30000000000000004', '123456789012345678901234567890', '1.7976931348623157e308', '1.7976931348623159e308', '4.9e-324', '2.4e-324', '0x1p1024', '0x1p-1074', '0x1.fffffffffffffp1023', '0x1.fffffffffffff8p1023', '0x123456789abcdef01p0', '1e10000', '1e-10000', '0.0000000000000000000000001', '00.5', '0e0', '-0', '-0.0', '1.5.5', '1e5e5', '१२', 'é'];
  const alphabet = ['0', '1', '5', '9', '.', 'e', 'E', '-', '+', '_', 'x', 'p', 'a', 'f', ' ', 'i', 'n', 'f', 'y', '0x', 'e+', 'p-'];
  const base = list.slice();
  for (let i = 0; i < 6000; i++) {
    let s = base[rnd(base.length)];
    for (let n = 1 + rnd(3); n > 0; n--) {
      const chars = Array.from(s);
      const k = rnd(chars.length + 1);
      const r = rnd(3);
      if (r === 0) chars.splice(k, 0, alphabet[rnd(alphabet.length)]);
      else if (r === 1 && chars.length) chars.splice(k % chars.length, 1);
      else { const t = base[rnd(base.length)]; chars.splice(k, 0, ...Array.from(t.slice(0, 1 + rnd(6)))); }
      s = chars.join('');
    }
    list.push(s);
  }
  process.stdout.write(list.map((text) => JSON.stringify({ text })).join('\n') + '\n');
}
