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
