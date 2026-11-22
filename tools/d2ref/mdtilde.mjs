// node mdtilde.mjs [count] [seed] > mdtilde.jsonl: short random Markdown over an alphabet of delimiters (~ * _ ` [ ] ( ) ! space newline letters) for
// `node diff.mjs mdhtml mdtilde.jsonl`: finds where markdown-it and goldmark disagree about inline structure (strikethrough, emphasis, code spans, links).
const [count = '20000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
const alpha = ['~', '~', '~~', '*', '_', '`', 'a', 'b', ' ', ' ', 'x', '\n', '[', ']', '(', ')', '!', '.', '/', '1', '**', '~~~', '\\'];
const out = [];
for (let i = 0; i < Number(count); i++) {
  let s = '';
  for (let n = 1 + rnd(14); n > 0; n--) s += alpha[rnd(alpha.length)];
  out.push(JSON.stringify({ from: 'mdtilde:' + i, text: s }));
}
process.stdout.write(out.join('\n') + '\n');
