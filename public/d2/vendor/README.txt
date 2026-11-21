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
(tools/d2ref/dagrocmp.mjs: 1030/1030 layouts of the D2 corpus, 20000+ generated ones). dagro has one more safety change, collision-checked
names for the edges dagre reverses (`rev1`...), which only matters for a caller edge named like that and cannot occur with D2's edge names.

To rebuild:  npm pack @dagrejs/dagre@3.1.1; tar xzf *.tgz; python3 tools/d2ref/dagrebuild/build.py package/dist/dagre.js public/d2/vendor/dagre.js
Do not edit dagre.js by hand; re-run the script when D2 moves to another dagre.
