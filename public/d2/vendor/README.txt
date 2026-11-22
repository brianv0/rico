dagre.js is dagre 3.1.1 (https://github.com/dagrejs/dagre, npm @dagrejs/dagre@3.1.1, MIT, Copyright (c) 2012-2014 Chris Pettitt) with its
graph library (@dagrejs/graphlib, MIT) bundled in, as one ES module (`import dagre from './vendor/dagre.js'`, default export
`{ graphlib, layout, version, ... }`). The licence text is dagre.LICENSE.txt.

It is the package's own dist/dagre.js (the unminified esbuild bundle) with exactly four edits, made by tools/d2ref/dagrebuild/build.py:

  1. the wrapper: `"use strict"; var dagre = (() => {` ... `})();` becomes an ES module with `export default`;
  2. to 4. the three source corrections that D2's Go dagre port (dagro v0.2.1, which D2 v0.9.0 calls instead of an embedded JS engine)
     applies to dagre 3.1.1 (dagro's testdata/differential/dagre-3.1.1-d2-compat.patch):
       - lib/order/sort-subgraph.ts: the "reversed parallel edge" special case only applies when exactly one of the two dummy nodes is
         reversed (official 3.1.1 can drop a same-direction dummy and propagate NaN);
       - lib/order/sort-subgraph.ts, sort.ts: every reversed partner is kept (an array per key, spliced in encounter order);
       - lib/util.ts intersectRect: an intersection at the centre of a zero-size node returns the centre; axis-aligned intersections
         avoid a division by zero.

With these edits dagre.js gives the same node coordinates and edge points as dagro, bit for bit, on every graph D2's glue builds
(tools/d2ref/dagrocmp.mjs: 1030/1030 layouts of the D2 corpus, 6500+ generated ones). dagro has one more safety change, collision-checked
names for the edges dagre reverses (`rev1`...), which only matters for a caller edge named like that and cannot occur with D2's edge names.

To rebuild:  npm pack @dagrejs/dagre@3.1.1; tar xzf *.tgz; python3 tools/d2ref/dagrebuild/build.py package/dist/dagre.js public/d2/vendor/dagre.js
Do not edit dagre.js by hand; re-run the script when D2 moves to another dagre.


mathjax.js is MathJax 3.2.2 (https://github.com/mathjax/MathJax-src, npm mathjax-full@3.2.2, Apache License 2.0, licence text in
mathjax.LICENSE.txt) with mhchemparser 4.1.1 (Apache License 2.0), as one minified ES module (1.7 MB, 599 KB gzipped). It is built by
tools/d2ref/mathjaxbuild/build.sh from tools/d2ref/mathjaxbuild/entry.js, which configures it like D2's LaTeX component (lite DOM adaptor,
TeX packages base mathtools ams amscd braket cancel cases color gensymb mhchem physics, SVG output with fontCache none, em 16, ex 8) and
creates the TeX/SVG jax and the document for every formula (D2 starts a fresh JavaScript engine per formula). It exports
`render(tex) -> svg string` and `version`. Nothing loads it except d2latex.js, with a dynamic import() the first time a diagram has a
LaTeX label. It uses no eval and no `new Function` (checked by grep on the bundle and by running it under a CSP without 'unsafe-eval').
To rebuild:  sh tools/d2ref/mathjaxbuild/build.sh   (esbuild is fetched into a temporary directory by npm and is not a dependency of the repo)
Do not edit mathjax.js by hand.

rough.js is roughjs 4.6.6 (https://github.com/rough-stuff/rough, npm roughjs@4.6.6, MIT, Copyright (c) 2019 Preet Shihn) exactly as the package ships it:
bundled/rough.esm.js (one minified ES module with its four dependencies hachure-fill 0.5.2, path-data-parser 0.1.0, points-on-curve 0.2.0 and
points-on-path 0.2.1 inside; default export `{ generator, canvas, svg, newSeed }`), unmodified. The licence texts are in rough.LICENSE.txt.
npm tarball sha256 373873b2c3f1b7ddba878525c774816057c5818029780c7fba081f06018ba78c (the one rough-go, D2 v0.9.0's native Go port of Rough.js 4.6.6,
names as its oracle); rough.js sha256 e921535f216ebc93d422489d614da955b5286812220b3149fc70978f4cb5bd45.

It is only imported by d2sketch.js, which d2svg.js loads on demand in sketch mode, so a page that never draws a sketch diagram never downloads it
(8.9 KB gzipped). It is used as is because tools/d2ref/roughcmp.mjs shows it prints the same paths as rough-go on every call d2sketch makes:
identical text, except that ellipses, circles and zigzag fills differ in the last bit of some numbers (V8's sin/cos against Go's), which d2sketch's
six-decimal truncation removes (no difference left over 100000+ generated calls and every call of the corpus and D2's e2e boards).
To refresh, take bundled/rough.esm.js from `npm pack roughjs@4.6.6` and copy it over rough.js.

elk.js is ELK (Eclipse Layout Kernel) 0.12.0 as compiled to JavaScript by elkjs 0.12.0 (https://github.com/kieler/elkjs, npm elkjs@0.12.0; EPL-2.0 OR GPL-3.0-or-later,
Copyright (c) Kiel University and others; the licence text is elk.LICENSE.txt, the file header says what was modified). It is lib/elk-worker.min.js of the package (the code elkjs's own
elk.bundled.js, sha256 1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3, embeds byte for byte; elk-go, D2 v0.9.0's native Go port, names that bundle as its oracle) as an ES module
that exports ELK's worker `Dispatcher`, so d2elklayout.js can lay a graph out synchronously on the main thread: no Web Worker, no `eval`, no `new Function`, no `importScripts`, no timers
(it runs under a CSP with `script-src 'self'` only; tools/d2ref/elkcsp.mjs checks that in Chromium). 1.6 MB, 464 KB gzipped, sha256 cb3864c608bce5fad4cded642c09b8c3d410f2097941865b0c1113870436df23.
It is only imported by d2elklayout.js, which d2lib.js loads with `import()` the first time a diagram uses the ELK layout (`layout: 'elk'`), so the default (dagre) path never downloads it.

Edits to the package's code, made by tools/d2ref/elkbuild/build.py (read its header for the reasons; `ELK_COMPAT=none` builds the engine with edits 1 to 3 only):
  1. to 3. the module wrapper, the worker branch disabled, the Dispatcher exported;
  4. and 5. an edge from a compound node to one of its own descendants keeps its coordinate-system origin and the offset walk stops at the root graph (what elk-go does; ELK 0.12 returns null / ELK.js throws);
  6. to 8. the ports and external-port dummies of compound nodes are created and ordered edge by edge, and a compound node is FIXED_SIDE from its first dummy on (elk-go's order of events);
  9. the sides of a two-sided opposing self loop are taken in the order north, east, south, west (ELK.js: order of a hash map of identity-hashed enum constants).
With them the engine gives the same layout as elk-go for every graph D2's glue built in the corpus, D2's e2e tests and about 22000 generated programs (tools/d2ref/elkcmp.mjs; exact numbers in docs/d2-port.md).
To rebuild:  npm pack elkjs@0.12.0; tar xzf elkjs-0.12.0.tgz; python3 tools/d2ref/elkbuild/build.py package/lib/elk-worker.min.js public/d2/vendor/elk.js package/lib/elk.bundled.js
Do not edit elk.js by hand; re-run the script when D2 moves to another ELK (and diff against its native engine again: elk-go is not ELK.js).
