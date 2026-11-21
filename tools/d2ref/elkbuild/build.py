#!/usr/bin/env python3
# Builds public/d2/vendor/elk.js from the unmodified npm package elkjs 0.12.0 (lib/elk-worker.min.js, EPL-2.0 OR GPL-3.0-or-later): the GWT-compiled ELK
# as one ES module whose layout runs synchronously on the calling thread (no Web Worker, no `eval`, no `new Function`, no setTimeout), with the
# edits that make it agree with elk-go (the native Go ELK that D2 v0.9.0 calls) on the graphs D2 builds.
#   usage: build.py <path to package/lib/elk-worker.min.js of elkjs@0.12.0> <out> [path to package/lib/elk.bundled.js, to check against]
#   env ELK_COMPAT=all (default) | none | origin    which elk-go compatibility edits (4 and up, below) to apply; `none` is plain ELK.js 0.12.0
#
# elk-worker.min.js is the code elkjs's own elk.bundled.js embeds byte for byte (checked below when the bundle is passed as the 3rd
# argument). Its tail builds a Dispatcher (the message handler of the worker) and a FakeWorker for Node/browser main threads; the ES module
# exports the Dispatcher and the FakeWorker (`Worker` of elkjs). Edits to the original code:
#   1. the CommonJS `module`/`exports` it writes its exports to become module-local variables (header and footer);
#   2. the branch that turns the file into a real Web Worker (`typeof document === 'undefined' && typeof self !== 'undefined'`) is disabled, so
#      loading the module inside a worker does not hijack that worker's `onmessage`;
#   3. the Dispatcher is exported too, so a layout can be requested synchronously (FakeWorker.postMessage defers with setTimeout);
# and, elk-go compatibility (elk-go is a port of ELK's behaviour that follows ELK 0.8.1 in places where ELK 0.12 changed, and handles the
# cross-hierarchy edges of the compound preprocessor edge by edge instead of node by node; the layouts differ only for edges between a compound node
# and its own descendants, or several edges through the same compound node):
#   4. ElkGraphImporter.findCoordinateSystemOrigin of ELK 0.12 returns null for an edge whose target is a descendant of its source (a container to its own
#      child); elk-go does not, so the edge keeps a COORDINATE_SYSTEM_ORIGIN;
#   5. ElkGraphLayoutTransferrer.calculateHierarchicalOffset then walks up from the source's graph until it reaches that origin, which for such an edge
#      it never does (ELK.js throws a TypeError); elk-go stops the walk at the root graph (`if current.ParentNode == nil { break }`);
#   6. CompoundGraphPreprocessor: ELK sets a compound node's PORT_CONSTRAINTS to FIXED_SIDE once all of its external-port dummies exist
#      (setSidesOfPortsToSidesOfDummyNodes). elk-go sets it as soon as the node's first dummy exists, so every later edge's dummy for that node takes its side
#      from the boundary port (the layout direction, or the side of the port the edge ends at when it ends at the node itself) instead of from the net flow.
#      The patch tags every imported edge with its position in the import order, finds for each compound node the first edge that crosses its boundary
#      (elkgoPrepare) and reports PORT_CONSTRAINTS = FIXED_SIDE to createExternalPortDummy for every later one (elkgoConstraints);
#   8. the ports a compound node gets for its cross-hierarchy edges come in the order of the edges, and the dummies are ordered like elk-go's
#      reorderCompoundPortDummies (elkgoPorts, elkgoReorder);
#   9. the sides of a two-sided opposing self loop are taken in the order north, east, south, west (ELK.js: hash map order of identity-hashed enums);
#   7. and likewise for the side introduceHierarchicalEdgeSegment passes then (ELK: WEST for an input, EAST for an output; elk-go: the direction-based
#      side of the new boundary port).
import os
import sys

src = open(sys.argv[1], encoding='utf-8').read()
if len(sys.argv) > 3:
    bundle = open(sys.argv[3], encoding='utf-8').read()
    assert src in bundle, 'elk-worker.min.js is not part of elk.bundled.js'
compat = os.environ.get('ELK_COMPAT', 'all')
assert compat in ('all', 'none', 'origin')


def rep(old, new, count=1):
    global src
    assert src.count(old) == count, (old, src.count(old))
    src = src.replace(old, new)


# 2 and 3
rep("if(typeof document===kwe&&typeof self!==kwe){var i=new h(self);self.onmessage=i.saveDispatch}else if(typeof module!==kwe&&module.exports){",
    "if(false){}else if(typeof module!==kwe&&module.exports){")
rep("module.exports={'default':j,Worker:j}", "module.exports={'default':j,Worker:j,Dispatcher:h}")

if compat in ('all', 'origin'):
    # 4
    rep("if(Rzd(h)==Rzd(i)){return null}if(cFd(i,h)){return null}g=Gwd(b);", "if(Rzd(h)==Rzd(i)){return null}g=Gwd(b);")
    # 5
    rep("while(b!=e){c=b.e;b=DYb(c);Ufd(Vfd(Vfd(d,c.n),b.c),b.d.b,b.d.d)}return d}return s_b}",
        "while(b!=e){c=b.e;if(!c){break}b=DYb(c);Ufd(Vfd(Vfd(d,c.n),b.c),b.d.b,b.d.d)}return d}return s_b}")

if compat == 'all':
    # 6: the import order of the edges, the first edge to cross each compound node, and the constraints the dummy creation sees
    rep("p=new GWb;mNb(p,b);rNb(p,(Wrc(),urc),b);", "p=new GWb;p.elkgoOrd=++elkgoOrd;mNb(p,b);rNb(p,(Wrc(),urc),b);")
    rep("c.Tg('Compound graph preprocessor',1);a.a=new Np;hWb(a,b,null);bWb(a,b);gWb(a);", "c.Tg('Compound graph preprocessor',1);a.a=new Np;elkgoPrepare(b);hWb(a,b,null);bWb(a,b);gWb(a);elkgoPorts(b);elkgoReorder(b);")
    rep("function YVb(a){var b;b=new GWb;mNb(b,a);rNb(b,(nyc(),Bwc),null);return b}", "function YVb(a){var b;b=new GWb;mNb(b,a);b.elkgoOrd=a.elkgoOrd;rNb(b,(nyc(),Bwc),null);return b}")
    rep("g=MXb(j,JD(oNb(c,(nyc(),qxc)),102),e,VVb(j),null,j.n,j.o,i,b);", "g=MXb(j,elkgoConstraints(c,f),e,VVb(j),null,j.n,j.o,i,b);")
    rep("JD(oNb(c,qxc),102),e,d==nAc?-1:1,null,new jgd,new lgd(0,0),i,b);", "elkgoConstraints(c,f),e,d==nAc?-1:1,null,new jgd,new lgd(0,0),i,b);")
    # 8: the ports a compound node gets for its cross-hierarchy edges are appended in the order of the edges (elk-go), not of the node-by-node walk
    rep("null,new jgd,new lgd(0,0),i,b);h=$Vb(g,c,d);", "null,new jgd,new lgd(0,0),i,b);h=$Vb(g,c,d);h.elkgoOrd=f.elkgoOrd;")
    # 9: the sides a two-sided opposing self loop touches come out of a hash map keyed by identity-hashed enum constants in ELK.js (their order depends on
    #    which constant was hashed first); elk-go always has them in the order north, east, south, west
    rep("i=JD(De(Ec(b.k),SC(M2,sye,64,2,0,1)),126);j=b.g;", "i=JD(De(Ec(b.k),SC(M2,sye,64,2,0,1)),126);i.sort(function(x,y){return x.g-y.g});j=b.g;")
    # 7
    rep("Old(JD(oNb(c,qxc),102))&&(k=f==nAc?Amd:gmd);", "Old(elkgoConstraints(c,d))&&(k=f==nAc?Dmd(Gmd(PXb(DYb(c)))):Gmd(PXb(DYb(c))));")
    src += '''
// ---- elk-go compatibility (edits 6 and 7 above; the functions below are not part of ELK.js) ----
var elkgoOrd=0;
function elkgoPrepare(top){var edges=[];(function walk(g){for(var i=0;i<g.a.c.length;i++){var n=g.a.c[i];for(var j=0;j<n.j.c.length;j++){var p=n.j.c[j];for(var k=0;k<p.g.c.length;k++){edges.push(p.g.c[k])}}if(n.e){n.elkgoMin=Infinity;walk(n.e)}}})(top);
edges.sort(function(x,y){return x.elkgoOrd-y.elkgoOrd});
var up=function(g){return g.e?DYb(g.e):null};
for(var i=0;i<edges.length;i++){var e=edges[i];if(!e.c||!e.d){continue}var sg=DYb(e.c.i),tg=DYb(e.d.i);if(sg==tg){continue}var anc=[];for(var g=sg;g;g=up(g)){anc.push(g)}var lca=null;for(var g=tg;g;g=up(g)){if(anc.indexOf(g)>=0){lca=g;break}}
for(var g=sg;g&&g!=lca;g=up(g)){if(g.e&&e.elkgoOrd<g.e.elkgoMin){g.e.elkgoMin=e.elkgoOrd}}
for(var g=tg;g&&g!=lca;g=up(g)){if(g.e&&e.elkgoOrd<g.e.elkgoMin){g.e.elkgoMin=e.elkgoOrd}}}}
function elkgoConstraints(parent,edge){return edge.elkgoOrd>parent.elkgoMin?(Mld(),Jld):JD(oNb(parent,(nyc(),qxc)),102)}
// elk-go's reorderCompoundPortDummies: the external-port dummies of every nested graph come after its other nodes, connected ones first, ordered by the
// path to the node they lead to (the index of each node on the way down, a descendant before its ancestor), the port index, the import order of the edge
// the ports created for the cross-hierarchy edges of a compound node come after its other ports, in the import order of the edges
function elkgoPorts(g){for(var i=0;i<g.a.c.length;i++){var n=g.a.c[i];if(n.e){var old=[],added=[],k;for(k=0;k<n.j.c.length;k++){var p=n.j.c[k];if(p.elkgoOrd===undefined){old.push(p)}else{added.push(p)}}
if(added.length>1){added.sort(function(x,y){return x.elkgoOrd-y.elkgoOrd});var all=old.concat(added);for(k=0;k<all.length;k++){n.j.c[k]=all[k]}}elkgoPorts(n.e)}}}
function elkgoInside(d){for(var i=0;i<d.j.c.length;i++){var p=d.j.c[i],k;for(k=0;k<p.g.c.length;k++){if(p.g.c[k].d){return{port:p.g.c[k].d,edge:p.g.c[k]}}}for(k=0;k<p.e.c.length;k++){if(p.e.c[k].c){return{port:p.e.c[k].c,edge:p.e.c[k]}}}}return null}
function elkgoIndex(list,x){for(var i=0;i<list.c.length;i++){if(list.c[i]==x){return i}}return Infinity}
function elkgoGraphIndex(g,n){var idx=0;for(var i=0;i<g.a.c.length;i++){var m=g.a.c[i];if(m.k==($Yb(),TYb)){continue}if(m==n){return idx}idx++}return Infinity}
function elkgoKey(g,port){var n=port.i;if(!n){return{path:null,port:Infinity}}var path=[elkgoGraphIndex(g,n)];if(n.e){var d=oNb(port,(Wrc(),Crc));if(d){var next=elkgoInside(d);if(next){var r=elkgoKey(n.e,next.port);return{path:path.concat(r.path||[]),port:r.port}}}}return{path:path,port:elkgoIndex(n.j,port)}}
function elkgoCompare(a,b){var n=Math.min(a.length,b.length);for(var i=0;i<n;i++){if(a[i]<b[i]){return -1}if(a[i]>b[i]){return 1}}return a.length>b.length?-1:a.length<b.length?1:0}
function elkgoReorder(g){var nodes=g.a.c.slice(),i;for(i=0;i<nodes.length;i++){if(nodes[i].e){elkgoReorder(nodes[i].e)}}nodes=g.a.c.slice();var normal=[],dummies=[];
for(i=0;i<nodes.length;i++){var n=nodes[i];if(n.k!=($Yb(),TYb)){normal.push(n);continue}var o={node:n,connected:false,path:[],port:Infinity,edge:Infinity,rank:i};var ins=elkgoInside(n);if(ins){o.connected=true;var key=elkgoKey(g,ins.port);o.path=key.path||[];o.port=key.port;o.edge=ins.edge.elkgoOrd}else{var origin=oNb(n,(Wrc(),urc));if(origin&&RD(origin,12)&&origin.i){o.port=elkgoIndex(origin.i.j,origin)}}dummies.push(o)}
if(dummies.length<2){return}
dummies.sort(function(x,y){if(x.connected!=y.connected){return x.connected?-1:1}var c=elkgoCompare(x.path,y.path);if(c!=0){return c}if(x.port!=y.port){return x.port<y.port?-1:1}if(x.edge!=y.edge){return x.edge<y.edge?-1:1}return x.rank-y.rank});
var out=normal.slice();for(i=0;i<dummies.length;i++){out.push(dummies[i].node)}for(i=0;i<out.length;i++){g.a.c[i]=out[i]}}
'''

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
 * Modified: wrapped as an ES module and adapted to elk-go (tools/d2ref/elkbuild/build.py, vendor/README.txt); the compiled code is otherwise unchanged.
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
