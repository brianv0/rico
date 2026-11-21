// node genpatterns.mjs <D2 source dir>: writes public/d2/patterns/{paper,grain}.svg.txt from d2renderers/internal/patternassets (v0.9.0):
// the built-in `fill-pattern: paper` (decompressed from paper.txt.br) and `grain` (grain.png inside D2's SVG wrapper) pattern definitions,
// with Go's fmt verbs (%[1]s = the diagram hash) left in place. They are loaded on demand by d2svg's renderAsync.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.join(process.argv[2], 'd2renderers/internal/patternassets');
const out = new URL('../../public/d2/patterns/', import.meta.url);
fs.mkdirSync(out, { recursive: true });

const grainPrefix = `<pattern id="grain-%[1]s" x="0" y="0" width="300" height="300" patternUnits="userSpaceOnUse">
<g opacity="0.8" clip-path="url(#clip0_3943_51420-%[1]s)">
<path d="M300 0H0V300H300V0Z" fill="url(#pattern0-%[1]s)" fill-opacity="0.9"/>
</g>
<defs>
<pattern id="pattern0-%[1]s" patternContentUnits="objectBoundingBox" width="1" height="1">
<use xlink:href="#image0_3943_51420-%[1]s" transform="scale(0.00214592 0.00286533)"/>
</pattern>
<clipPath id="clip0_3943_51420-%[1]s">
<rect width="300" height="300" fill="white"/>
</clipPath>
<image id="image0_3943_51420-%[1]s" width="466" height="349" xlink:href="data:image/png;base64,`;
const grainSuffix = `"/>
</defs>
</pattern>
`;
fs.writeFileSync(new URL('paper.svg.txt', out), zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'paper.txt.br'))));
fs.writeFileSync(new URL('grain.svg.txt', out), grainPrefix + fs.readFileSync(path.join(dir, 'grain.png')).toString('base64') + grainSuffix);
