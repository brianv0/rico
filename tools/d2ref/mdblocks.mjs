// node dbg4.mjs svgmdu.jsonl > measure-mdu.jsonl: the |||md blocks of a svgmdu file as `measure` stage cases
import fs from 'node:fs';
for (const line of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const c = JSON.parse(line);
  for (const m of c.text.matchAll(/\|\|\|md\n([\s\S]*?)\n\|\|\|/g)) {
    const text = m[1].split('\n').map((l) => l.slice(2)).join('\n');
    console.log(JSON.stringify({ from: c.from, text, fontSize: 16, markdown: true }));
  }
}
