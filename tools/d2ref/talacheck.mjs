// JS side of the TALA port's diff stages (see diff.mjs: talagraphjson, talaadapter, talarand, talaops, ...). Each function maps a case to the
// same JSON the Go mode of tala/xdump prints (build it with tala/setup.sh).
import fs from 'node:fs';
import * as bigjson from '../../public/d2/tala/bigjson.js';
import * as graphjson from '../../public/d2/tala/graphjson.js';
import * as lg from '../../public/d2/tala/layoutgraph.js';
import * as context from '../../public/d2/tala/context.js';

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
