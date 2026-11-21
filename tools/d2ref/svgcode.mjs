// node svgcode.mjs [count] [seed] > svgcode.jsonl: D2 programs with code labels (`|lang ... |` block strings and `shape: code`) in many chroma languages, with ASCII and non-ASCII text,
// for `node diff.mjs svg svgcode.jsonl` (Go compiles and renders; the JS renderer, with chroma's lexers run by regexp2.js, must print the same SVG).
import fs from 'node:fs';
const [count = '300', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
const pick = (a) => a[rnd(a.length)];
const idx = JSON.parse(fs.readFileSync(new URL('../../public/d2/lexers/index.json', import.meta.url), 'utf8'));
const names = Object.keys(idx.names).filter((k) => idx.files[idx.names[k]] && /^[a-z0-9+#-]{1,20}$/.test(k));
const frags = ['foo', 'bar_baz', 'x1', 'if', 'else', 'for', 'return', 'class', 'def', 'func', 'let', 'const', 'import', 'SELECT', 'FROM', '42', '3.14', '0xFF', '"str"', "'c'", '`raw`', '# comment', '// comment',
  '/* c */', '(', ')', '[', ']', '{', '}', ',', ';', ':', '.', '=', '==', '->', '=>', '+', '-', '*', '/', '<', '>', '&&', '||', '!', '@', '$x', '%d', '\\n', '<div>', '</div>', '#include <x.h>', 'nil', 'true'];
const uni = ['é', 'ñandú', 'Ωμέγα', 'привет', '漢字', 'こんにちは', '🙂', 'ß', 'İ', '“q”', '→', '€', 'Ünï', '_é', 'x²', 'á', ' '];
const out = [];
for (let i = 0; i < Number(count); i++) {
  const lang = pick(names);
  const lines = [];
  for (let l = 1 + rnd(5); l > 0; l--) {
    let line = '';
    for (let n = rnd(9); n > 0; n--) line += (rnd(4) === 0 && rnd(2) === 0 ? pick(uni) : pick(frags)) + (rnd(3) ? ' ' : '');
    lines.push(rnd(4) === 0 ? '  ' + line : line);
  }
  const body = lines.join('\n').replace(/\|/g, '/');
  const text = rnd(3) === 0 ? `c: {\n  shape: code\n  label: |${lang}\n${body.split('\n').map((l) => '  ' + l).join('\n')}\n  |\n}\n` : `c: |${lang}\n${body.split('\n').map((l) => '  ' + l).join('\n')}\n|\n`;
  out.push({ from: `svgcode:${lang}:${i}`, path: 'x.d2', text: text.replace(/\|\|+/g, '|') });
}
process.stdout.write(out.map((c) => JSON.stringify(c)).join('\n') + '\n');
