#!/usr/bin/env python3
# Builds public/d2/vendor/elk.js from the unmodified npm package elkjs 0.12.0 (lib/elk-worker.min.js, EPL-2.0 OR GPL-3.0-or-later): the GWT-compiled ELK
# as one ES module whose layout runs synchronously on the calling thread (no Web Worker, no `eval`, no `new Function`, no setTimeout).
#   usage: build.py <path to package/lib/elk-worker.min.js of elkjs@0.12.0> <out> [path to package/lib/elk.bundled.js, to check against]
#
# elk-worker.min.js is the code elkjs's own elk.bundled.js embeds byte for byte (checked below when the bundle is passed as the 3rd
# argument). Its tail builds a Dispatcher (the message handler of the worker) and a FakeWorker for Node/browser main threads; the ES module
# exports the Dispatcher and the FakeWorker (`Worker` of elkjs). Edits to the original code:
#   1. the CommonJS `module`/`exports` it writes its exports to become module-local variables (header and footer);
#   2. the branch that turns the file into a real Web Worker (`typeof document === 'undefined' && typeof self !== 'undefined'`) is disabled, so
#      loading the module inside a worker does not hijack that worker's `onmessage`;
#   3. the Dispatcher is exported too, so a layout can be requested synchronously (FakeWorker.postMessage defers with setTimeout);
#   4. to 7. four elk-go compatibility edits (below).
import sys

src = open(sys.argv[1], encoding='utf-8').read()
if len(sys.argv) > 3:
    bundle = open(sys.argv[3], encoding='utf-8').read()
    assert src in bundle, 'elk-worker.min.js is not part of elk.bundled.js'


def rep(old, new, count=1):
    global src
    assert src.count(old) == count, (old, src.count(old))
    src = src.replace(old, new)


rep("if(typeof document===kwe&&typeof self!==kwe){var i=new h(self);self.onmessage=i.saveDispatch}else if(typeof module!==kwe&&module.exports){",
    "if(false){}else if(typeof module!==kwe&&module.exports){")
rep("module.exports={'default':j,Worker:j}", "module.exports={'default':j,Worker:j,Dispatcher:h}")

# elk-go compatibility (D2 v0.9.0 runs elk-go, not elkjs; they differ in one place, see vendor/README.txt):
#   4. ElkGraphImporter.findCoordinateSystemOrigin of ELK 0.12 returns null for an edge whose target is a descendant of its source (a container to its own
#      child); elk-go (a translation of ELK 0.8.1 there) does not, so the edge keeps a COORDINATE_SYSTEM_ORIGIN;
#   5. ElkGraphLayoutTransferrer.calculateHierarchicalOffset then walks up from the source's graph until it reaches that origin, which for such an edge
#      it never does (ELK.js throws a TypeError); elk-go stops the walk at the root graph (`if current.ParentNode == nil { break }`).
rep("if(Rzd(h)==Rzd(i)){return null}if(cFd(i,h)){return null}g=Gwd(b);", "if(Rzd(h)==Rzd(i)){return null}g=Gwd(b);")
rep("while(b!=e){c=b.e;b=DYb(c);Ufd(Vfd(Vfd(d,c.n),b.c),b.d.b,b.d.d)}return d}return s_b}", "while(b!=e){c=b.e;if(!c){break}b=DYb(c);Ufd(Vfd(Vfd(d,c.n),b.c),b.d.b,b.d.d)}return d}return s_b}")

#   6. CompoundGraphPreprocessor: ELK sets a compound node's PORT_CONSTRAINTS to FIXED_SIDE once all of its external-port dummies exist
#      (setSidesOfPortsToSidesOfDummyNodes). elk-go handles the cross-hierarchy edges one at a time in the order they were imported and sets it as soon as the
#      node's first dummy exists, so every later edge's dummy for that node takes its side from the boundary port (the layout direction, or the side of the
#      port the edge ends at when it ends at the node itself) instead of from the net flow. The patch tags every imported edge with its position in the import
#      order, finds for each compound node the first edge that crosses its boundary (elkgoPrepare) and reports PORT_CONSTRAINTS = FIXED_SIDE to createExternalPortDummy
#      for every later one (elkgoConstraints);
#   7. and likewise for the side introduceHierarchicalEdgeSegment passes then (ELK: WEST for an input, EAST for an output; elk-go: the direction-based
#      side of the new boundary port).
rep("p=new GWb;mNb(p,b);rNb(p,(Wrc(),urc),b);", "p=new GWb;p.elkgoOrd=++elkgoOrd;mNb(p,b);rNb(p,(Wrc(),urc),b);")
rep("c.Tg('Compound graph preprocessor',1);a.a=new Np;hWb(a,b,null);", "c.Tg('Compound graph preprocessor',1);a.a=new Np;elkgoPrepare(b);hWb(a,b,null);")
rep("g=MXb(j,JD(oNb(c,(nyc(),qxc)),102),e,VVb(j),null,j.n,j.o,i,b);", "g=MXb(j,elkgoConstraints(c,f),e,VVb(j),null,j.n,j.o,i,b);")
rep("JD(oNb(c,qxc),102),e,d==nAc?-1:1,null,new jgd,new lgd(0,0),i,b);", "elkgoConstraints(c,f),e,d==nAc?-1:1,null,new jgd,new lgd(0,0),i,b);")
rep("Old(JD(oNb(c,qxc),102))&&(k=f==nAc?Amd:gmd);", "Old(elkgoConstraints(c,d))&&(k=f==nAc?Dmd(Gmd(PXb(DYb(c)))):Gmd(PXb(DYb(c))));")

elkgo_js = '''
// ---- elk-go compatibility (see the edits above; the functions below are not part of ELK.js) ----
var elkgoOrd=0;
function elkgoPrepare(top){var edges=[];(function walk(g){for(var i=0;i<g.a.c.length;i++){var n=g.a.c[i];for(var j=0;j<n.j.c.length;j++){var p=n.j.c[j];for(var k=0;k<p.g.c.length;k++){edges.push(p.g.c[k])}}if(n.e){n.elkgoMin=Infinity;walk(n.e)}}})(top);
edges.sort(function(x,y){return x.elkgoOrd-y.elkgoOrd});
var up=function(g){return g.e?DYb(g.e):null};
for(var i=0;i<edges.length;i++){var e=edges[i];if(!e.c||!e.d){continue}var sg=DYb(e.c.i),tg=DYb(e.d.i);if(sg==tg){continue}var anc=[];for(var g=sg;g;g=up(g)){anc.push(g)}var lca=null;for(var g=tg;g;g=up(g)){if(anc.indexOf(g)>=0){lca=g;break}}
for(var g=sg;g&&g!=lca;g=up(g)){if(g.e&&e.elkgoOrd<g.e.elkgoMin){g.e.elkgoMin=e.elkgoOrd}}
for(var g=tg;g&&g!=lca;g=up(g)){if(g.e&&e.elkgoOrd<g.e.elkgoMin){g.e.elkgoMin=e.elkgoOrd}}}}
function elkgoConstraints(parent,edge){return edge.elkgoOrd>parent.elkgoMin?(Mld(),Jld):JD(oNb(parent,(nyc(),qxc)),102)}
'''
src = src + elkgo_js

header = '''/*******************************************************************************
 * Eclipse Layout Kernel (ELK) 0.12.0 compiled to JavaScript by elkjs 0.12.0 (kieler/elkjs on GitHub), lib/elk-worker.min.js.
 * Copyright (c) Kiel University and others.
 *
 * This program and the accompanying materials are made available under the terms of the Eclipse Public License 2.0 which is available at
 * https://www.eclipse.org/legal/epl-2.0. This Source Code may also be made available under the following Secondary Licenses when the
 * conditions for such availability set forth in the Eclipse Public License v. 2.0 are satisfied: GPL-3.0 which is available at
 * https://www.gnu.org/licenses/gpl-3.0-standalone.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later
 *
 * Modified: wrapped as an ES module (tools/d2ref/elkbuild/build.py, vendor/README.txt); the compiled code is unchanged apart from the two small edits listed there.
 *******************************************************************************/
const module = { exports: {} };
const exports = module.exports;
'''
footer = '''
export const Dispatcher = module.exports.Dispatcher;
export const Worker = module.exports.Worker;
export default module.exports;
'''
open(sys.argv[2], 'w', encoding='utf-8').write(header + src + footer)
