#!/usr/bin/env python3
# Builds public/d2/vendor/dagre.js from the unmodified npm package @dagrejs/dagre 3.1.1 (dist/dagre.js, MIT): an ES module with the
# three source corrections that D2's Go dagre port (dagro v0.2.1, testdata/differential/dagre-3.1.1-d2-compat.patch) applies to 3.1.1.
#   usage: build.py <path to package/dist/dagre.js of @dagrejs/dagre@3.1.1> <out>
import sys

src = open(sys.argv[1], encoding='utf-8').read()


def rep(old, new, count=1):
    global src
    assert src.count(old) == count, (old, src.count(old))
    src = src.replace(old, new)


# ES module instead of the IIFE assigned to a global
rep('"use strict";\nvar dagre = (() => {', 'const dagreModule = (() => {')
rep('  return __toCommonJS(index_exports);\n})();\n', '  return __toCommonJS(index_exports);\n})();\nconst dagre = dagreModule.default;\nexport const { graphlib, layout, version, debug, util } = dagre;\nexport const Graph = dagreModule.Graph;\nexport default dagre;\n')
rep('/*! For license information please see dagre.js.LEGAL.txt */\n//# sourceMappingURL=dagre.js.map\n', '')

# compat patch 1: the reversed-parallel-edge special case only applies when exactly one of the two dummies is reversed
rep('''nodeI.edgeObj) == null ? void 0 : _h.v) === ((_i = nodeJ.edgeObj) == null ? void 0 : _i.v) && ((_j = nodeI.edgeObj) == null ? void 0 : _j.w) === ((_k = nodeJ.edgeObj) == null ? void 0 : _k.w)) {
            if (nodeI.edgeLabel.reversed) {
              reversedPairs[nameJ] = entries[i];''', '''nodeI.edgeObj) == null ? void 0 : _h.v) === ((_i = nodeJ.edgeObj) == null ? void 0 : _i.v) && ((_j = nodeI.edgeObj) == null ? void 0 : _j.w) === ((_k = nodeJ.edgeObj) == null ? void 0 : _k.w) && nodeI.edgeLabel.reversed !== nodeJ.edgeLabel.reversed) {
            if (nodeI.edgeLabel.reversed) {
              (reversedPairs[nameJ] ??= []).push(entries[i]);''')
# 2: every reversed partner is kept
rep('''              reversedPairs[nameI] = entries[j2];''', '''              (reversedPairs[nameI] ??= []).push(entries[j2]);''')
rep('''    for (const [key, value] of Object.entries(resolvedReversedPairs)) {
      const keyIndex = sortable.findIndex((entry) => entry.vs[0] === key);
      sortable.splice(keyIndex + 1, 0, value);''', '''    for (const [key, values] of Object.entries(resolvedReversedPairs)) {
      const keyIndex = sortable.findIndex((entry) => entry.vs[0] === key);
      sortable.splice(keyIndex + 1, 0, ...values);''')
# 3: a rectangle intersection at the centre of a zero-size node returns the centre; axis-aligned intersections avoid a division by zero
rep('''    if (!dx && !dy) {
      throw new Error("Not possible to find intersection inside of the rectangle");
    }
    let sx, sy;
    if (Math.abs(dy) * w2 > Math.abs(dx) * h) {''', '''    if (!dx && !dy) {
      if (w2 === 0 || h === 0) {
        return { x: x2, y: y2 };
      }
      throw new Error("Not possible to find intersection inside of the rectangle");
    }
    let sx, sy;
    if (!dx) {
      if (dy < 0) {
        h = -h;
      }
      sx = 0;
      sy = h;
    } else if (!dy) {
      if (dx < 0) {
        w2 = -w2;
      }
      sx = w2;
      sy = 0;
    } else if (Math.abs(dy) * w2 > Math.abs(dx) * h) {''')
open(sys.argv[2], 'w', encoding='utf-8').write(src)
