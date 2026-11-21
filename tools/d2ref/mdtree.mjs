// Debug aid: node mdtree.mjs '<markdown text>'  prints Go's goquery tree and htmlparse.js's tree for the rendered markdown.
import { execFileSync } from 'node:child_process';
import markdownit from 'markdown-it';
import { setMarkdownIt, renderMarkdown } from '../../public/d2/textmeasure.js';
import { parseBody } from '../../public/d2/htmlparse.js';

setMarkdownIt(markdownit);
const text = process.argv[2];
const go = JSON.parse(execFileSync('go', ['run', '.', 'mdtree'], { input: JSON.stringify({ text }) + '\n' }).toString());
const html = renderMarkdown(text);
let js = '';
const walk = (n, d) => {
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.type === 'text') js += `${' '.repeat(d)}#text ${JSON.stringify(c.data)}\n`;
    else if (c.type === 'element') { js += `${' '.repeat(d)}<${c.data}>\n`; walk(c, d + 1); } else js += `${' '.repeat(d)}#other ${JSON.stringify(c.data)}\n`;
  }
};
walk(parseBody(html), 0);
console.log('html (go) ', JSON.stringify(go.html), '\nhtml (js) ', JSON.stringify(html), '\n--- go\n' + go.tree + '--- js\n' + js);
