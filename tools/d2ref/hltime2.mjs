// JS-only timing per lexer: node hltime2.mjs [per language] [min ms to report]
import { index, loadLexer, highlight } from '../../public/d2/highlight.js';
const per = Number(process.argv[2] || 2), min = Number(process.argv[3] || 100);
const names = [...new Set(Object.values(index.names))].filter((n) => index.files[n]);
const frags = ['foo', 'bar', '(', ')', '{', '}', '"s"', '42', '#', '//', '\n', ' ', 'if', 'end', ';', '=', '<a>', '$x', "'c'", '/*', '*/'];
let seed = 7;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
for (const n of names) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(n)) continue;
  const lang = Object.entries(index.names).find(([, v]) => v === n)[0];
  process.stderr.write(n + " ");
  let t0 = performance.now();
  await loadLexer(index.files[n]);
  const tl = performance.now() - t0;
  for (let i = 0; i < per; i++) {
    let text = '';
    for (let k = 0; k < 12; k++) text += frags[(rnd() * frags.length) | 0] + (rnd() < 0.5 ? ' ' : '');
    t0 = performance.now();
    process.stderr.write("[" + JSON.stringify(text) + "]");
    let js = "ok";
    try { highlight(lang, text); } catch (e) { js = String(e.message).slice(0, 80); }
    const t = performance.now() - t0;
    if (t > min || tl > min || js !== 'ok') console.log(`${n}: load ${tl | 0}ms, highlight ${t | 0}ms ${js} ${JSON.stringify(text).slice(0, 80)}`);
  }
}
console.log('done');
