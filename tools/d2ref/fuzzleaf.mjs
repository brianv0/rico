// Fuzz input for the leaf stages:  node fuzzleaf.mjs measure|shape|label [count] [seed] > fuzz-<stage>.jsonl
// then `node diff.mjs <stage> fuzz-<stage>.jsonl` (shape: add --tol 1e-9, see docs).
const [stage, count = '3000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (n) => Math.floor(rnd() * n);
const out = [];

if (stage === 'measure') {
  const frag = ['# ', '## ', '### ', '- ', '* ', '1. ', '> ', '    ', '\t', '```\n', '```go\n', '`', '**', '*', '~~', '_', '[a](http://x?y=1&z=2)', '![i](u)', '<b>', '</b>', '<br>', '<br/>', '<div>', '</div>', '<p>', '<pre>', '</pre>',
    '<table><tr><td>', '</td></tr></table>', '| a | b |\n|---|---|\n| c | d |\n', '---\n', '***\n', 'hello', 'World', ' ', '  ', '\n', '\n\n', '\r\n', 'aé', '你好', '😀', '&amp;', '&nbsp;', '&#65;', '&lt;', '<!-- c -->', '\\', '\\*', 'x'.repeat(40),
    '1) ', '+ ', '<span>', '</span>', '<em>', '<h2>', '</h2>', '<ul><li>', '</li></ul>', '<a href="x&y">', '</a>', '‍', '́', 'กำ'];
  for (let i = 0; i < Number(count); i++) {
    let t = '';
    for (let n = 1 + int(12); n > 0; n--) t += pick(frag);
    const md = rnd() < 0.6;
    out.push({
      text: t, fontFamily: pick(['SourceSansPro', 'SourceCodePro', 'HandDrawn', '']), monoFamily: rnd() < 0.2 ? pick(['SourceCodePro', 'HandDrawn']) : '',
      fontSize: pick([1, 8, 13, 14, 16, 20, 24, 28, 32, 40, 77]), bold: rnd() < 0.2, italic: rnd() < 0.2, markdown: md, language: !md && rnd() < 0.2 ? pick(['go', 'js', 'text']) : '',
    });
  }
} else if (stage === 'shape') {
  const types = ['Square', 'RealSquare', 'Parallelogram', 'Document', 'Cylinder', 'Queue', 'Page', 'Package', 'Step', 'Callout', 'StoredData', 'Person', 'C4Person', 'Diamond', 'Oval', 'Circle', 'Hexagon', 'Cloud', 'Table', 'Class', 'Text', 'Code', 'Image', 'Zzz'];
  const dim = () => pick([0, 1, 5, 10, 25.5, 26, 30, 50, 77, 100, 123.456, 200, 333, 640, 1000, 4096, int(1000) + rnd(), int(300)]);
  for (let i = 0; i < Number(count); i++) out.push({ shape: pick(types), width: dim(), height: dim() });
} else if (stage === 'label') {
  for (let i = 0; i < Number(count); i++) {
    const n = 2 + int(5);
    const route = Array.from({ length: n }, () => [int(300) - 50 + (rnd() < 0.3 ? rnd() : 0), int(300) - 50 + (rnd() < 0.3 ? rnd() : 0)]);
    out.push({ width: int(400) + 1, height: int(200) + 1, route, stroke: pick([0, 1, 2, 3, 5, 8]), pct: pick([0, 0.25, 0.5, 0.75, 1, rnd(), -0.5, 1.5]) });
  }
}
process.stdout.write(out.map((o) => JSON.stringify(o)).join('\n') + '\n');
