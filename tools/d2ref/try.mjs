// Compiles D2 text given as arguments (or from a file with --file) with the JS port and prints the error or "ok":
//   node try.mjs 'a -> b' 'x: {near: top-left}'
import fs from 'node:fs';
import markdownit from 'markdown-it';
import { init as initD2, compileSync as d2compile } from '../../public/d2/d2lib.js';
import { setMarkdownIt } from '../../public/d2/textmeasure.js';

setMarkdownIt(markdownit);
await initD2();
const args = process.argv.slice(2);
const texts = args[0] === '--file' ? [fs.readFileSync(args[1], 'utf8')] : args;
for (const t of texts) {
  const r = d2compile(t, { inputPath: 'f.d2', layout: 'dagre' }, {});
  console.log(JSON.stringify(t.slice(0, 80)), '->', r.err ? r.err.message : 'ok');
}
