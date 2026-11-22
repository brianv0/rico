// node e2esvg.mjs <D2 source dir> > e2esvg.jsonl: render inputs from D2's own e2e goldens. Every testdata/<group>/<case>/<engine>/board.exp.json
// (dagre, elk and tala layouts alike: rendering only needs the diagram) becomes {path, from, diagram}; boards with layers, scenarios or steps
// also get a {ropts: {multiboard: true}} case that renders every board. Use with `node diff.mjs svg e2esvg.jsonl`.
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.argv[2], 'e2etests/testdata');
const out = [];
for (const group of fs.readdirSync(root).sort()) {
  const gdir = path.join(root, group);
  if (!fs.statSync(gdir).isDirectory()) continue;
  for (const name of fs.readdirSync(gdir).sort()) {
    const cdir = path.join(gdir, name);
    if (!fs.statSync(cdir).isDirectory()) continue;
    for (const engine of fs.readdirSync(cdir).sort()) {
      const f = path.join(cdir, engine, 'board.exp.json');
      if (!fs.existsSync(f)) continue;
      const diagram = JSON.parse(fs.readFileSync(f, 'utf8'));
      const from = `${group}/${name}/${engine}`;
      out.push({ path: from, from, diagram });
      if ((diagram.layers || diagram.scenarios || diagram.steps)) out.push({ path: from + ':multiboard', from: from + ':multiboard', diagram, ropts: { multiboard: true } });
    }
  }
}
for (const c of out) process.stdout.write(JSON.stringify(c) + '\n');
