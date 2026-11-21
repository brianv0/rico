// node mdchars.mjs [astral] > mdchars.jsonl: for every BMP code point (with `astral`: planes 1 and 2 as well) a few Markdown snippets with that character
// next to emphasis delimiters and in table cells, for `node diff.mjs mdhtml mdchars.jsonl` (markdown-it against goldmark: flanking rules, cell trimming).
const astral = process.argv[2] === 'astral';
const out = [];
const add = (cp, t) => out.push(JSON.stringify({ from: `U+${cp.toString(16)}`, text: t }));
const ranges = astral ? [[0x20, 0xd7ff], [0xe000, 0x2ffff], [0xe0000, 0xe01ff]] : [[0x20, 0xd7ff], [0xe000, 0xffff]];
for (const [lo, hi] of ranges) {
  for (let cp = lo; cp <= hi; cp++) {
    const c = String.fromCodePoint(cp);
    if (cp > 0xffff && cp % 7 !== 0 && !(cp >= 0x1f000 && cp <= 0x1ffff) && !(cp >= 0xe0000)) continue;
    add(cp, `a**${c}b**c`);
    add(cp, `a**b${c}**c`);
    add(cp, `x _${c}b_ y`);
    add(cp, `x _b${c}_ y`);
    add(cp, `${c}*b*${c}`);
    if (cp < 0x3000 || cp > 0xffff) { add(cp, `| ${c}x${c} |\n|---|\n| ${c}y |`); add(cp, `${c}x\n\n    ${c}y`); }
  }
}
process.stdout.write(out.join('\n') + '\n');
