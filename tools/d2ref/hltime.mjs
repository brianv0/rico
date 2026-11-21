// times chroma (Go) and the JS port per language on a few random snippets: node hltime.mjs [per language]
import { execFileSync } from 'node:child_process';
import { index, loadLexer, highlight } from '../../public/d2/highlight.js';
const per = Number(process.argv[2] || 2);
const names = [...new Set(Object.values(index.names))].filter((n) => index.files[n]);
const frags = ['foo', 'bar', '(', ')', '{', '}', '"s"', '42', '#', '//', '\n', ' ', 'if', 'end', ';', '=', '<a>', '$x', "'c'", '/*', '*/'];
let seed = 7;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const slow = [];
for (const n of names) {
  const lang = Object.entries(index.names).find(([k, v]) => v === n)[0];
  await loadLexer(index.files[n]);
  for (let i = 0; i < per; i++) {
    let text = '';
    for (let k = 0; k < 12; k++) text += frags[(rnd() * frags.length) | 0] + (rnd() < 0.5 ? ' ' : '');
    const t0 = performance.now();
    let js = 'ok';
    try { highlight(lang, text); } catch (e) { js = String(e.message).slice(0, 80); }
    const tjs = performance.now() - t0;
    const t1 = performance.now();
    execFileSync('/tmp/d2refbin_mine', ['highlight'], { input: JSON.stringify({ language: lang, text }) + '\n', timeout: 20000 });
    const tgo = performance.now() - t1;
    if (tjs > 300 || tgo > 600 || js !== 'ok') slow.push(`${n} js ${tjs | 0}ms go ${tgo | 0}ms ${js}`);
  }
}
console.log(slow.join('\n') || 'none slow');
