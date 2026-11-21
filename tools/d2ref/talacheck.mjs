// JS side of the TALA port's diff stages (see diff.mjs: talagraphjson, talaadapter, talarand, talaops, ...). Each function maps a case to the
// same JSON the Go mode of tala/xdump prints (build it with tala/setup.sh).
import fs from 'node:fs';
import * as bigjson from '../../public/d2/tala/bigjson.js';
import * as graphjson from '../../public/d2/tala/graphjson.js';
import * as lg from '../../public/d2/tala/layoutgraph.js';
import * as context from '../../public/d2/tala/context.js';
import * as d2talalayout from '../../public/d2/tala/d2talalayout.js';
import * as geo from '../../public/d2/geo.js';
import { compileSync as d2compile } from '../../public/d2/d2lib.js';

export const ctx = () => context.background();

/** a graphjson fixture ({graph: <value>}) -> reconstructed layout graph */
export function graphFromFixture(c) {
  const g = new lg.Graph();
  graphjson.unmarshal(ctx(), c.graph, g);
  return g;
}

const errMsg = (e) => (e && e.name === 'GoError' ? e.message : null);

/** run fn, mapping a GoError to {err} like the Go modes; any other exception is a bug of the port and propagates. */
export function guarded(fn) {
  try {
    return fn();
  } catch (e) {
    const m = errMsg(e);
    if (m === null) throw e;
    return { err: m };
  }
}

// graphjson: Unmarshal + Serialize
export function graphjsonStage(c) {
  return guarded(() => {
    const g = graphFromFixture(c);
    return { graph: graphjson.serialize(ctx(), g) };
  });
}

export { bigjson, graphjson, lg };

// adapter: D2 text -> the TALA graph the adapter builds for every layout call (no layout is run: objects and edges get a placeholder
// placement so that compile goes on, exactly like xdump's adapter mode).
export function adapterStage(c) {
  const invocations = [];
  const layoutFn = (g) => {
    const rec = { adapter: null };
    try {
      const tg = lg.newGraph();
      d2talalayout.translateGraph(ctx(), g, tg, false);
      rec.adapter = graphjson.serialize(ctx(), tg);
    } catch (e) {
      const m = errMsg(e);
      if (m === null) throw e;
      rec.err = m;
    }
    invocations.push(rec);
    for (const o of g.objects ?? []) {
      if (o.box) o.box.TopLeft = new geo.Point(0, 0);
    }
    for (const e of g.edges ?? []) e.route = [new geo.Point(0, 0), new geo.Point(1, 0)];
  };
  const r = d2compile(c.text, { utf16: c.utf16, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: 'tala', layoutResolver: () => layoutFn, routerResolver: () => () => {}, measuredTexts: c.mtexts }, {});
  if (r.err && r.err.name !== 'Error' && r.err.name !== 'GoError') globalThis.__lastErr = r.err; // for talatry.mjs
  if (r.err && r.err instanceof TypeError) globalThis.__lastErr = r.err;
  if (r.err && r.err.name === 'LatexNotPorted') return { deferred: 'latex' };
  return { invocations: invocations.length ? invocations : null, err: r.err ? r.err.message : null };
}
