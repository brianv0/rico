// node hlone.mjs <language> <text with \n escapes>: highlights with the JS port and prints the tokens and the time
import { index, loadLexer, highlight } from '../../public/d2/highlight.js';
const lang = process.argv[2];
const text = process.argv[3].replace(/\\n/g, '\n');
const name = index.names[lang] ?? index.names[lang.toLowerCase()];
await loadLexer(index.files[name]);
const t = performance.now();
let r;
for (;;) { try { r = highlight(lang, text); break; } catch (e) { if (e.kind !== 'lexer') throw e; await loadLexer(e.assetName); } }
console.log(JSON.stringify(r.light.lines.map((l) => l.map((x) => [x.type, x.value]))).slice(0, 1500), `${(performance.now() - t) | 0}ms`);
