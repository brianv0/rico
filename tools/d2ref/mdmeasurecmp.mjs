// compares the two legacy measurers (textmeasure.measureMarkdown vs mdlayout.layoutMarkdown's Width/Height) on the |||md blocks of a jsonl
import fs from 'node:fs';
import markdownit from 'markdown-it';
import { setMarkdownIt, loadMetrics, newRuler, measureMarkdown } from '../../public/d2/textmeasure.js';
import * as md from '../../public/d2/mdlayout.js';
import * as fg from '../../public/d2/fontglyphs.js';
import * as lb from '../../public/d2/linebreak.js';
setMarkdownIt(markdownit); await loadMetrics(); await lb.loadFullTables();
const d2fonts = await import('../../public/d2/fonts.js');
for (const f of new Set(Object.values(d2fonts.FONT_FILES))) await fg.loadFont(f);
const ruler = newRuler();
let n = 0, bad = 0;
for (const line of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const c = JSON.parse(line);
  for (const m of c.text.matchAll(/\|\|\|md\n([\s\S]*?)\n\|\|\|/g)) {
    const text = m[1].split('\n').map((l) => l.slice(2)).join('\n');
    for (const size of [16, 20]) {
      n++;
      const [w, h] = measureMarkdown(text, ruler, null, null, size);
      let l;
      try { l = md.layoutMarkdown(text, ruler, null, null, size); } catch (e) { console.log('throw', e.message); continue; }
      if (w !== l.Width || h !== l.Height) { bad++; if (bad < 8) console.log(c.from, size, [w, h], [l.Width, l.Height], JSON.stringify(text).slice(0, 300)); }
    }
  }
}
console.log(n, 'measured,', bad, 'different');
