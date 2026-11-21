// JS side of `dims` mode (tools/d2ref/dimscheck.go): SetDimensions on every board, before any layout.
import { compile as compileGraph } from '../../public/d2/d2compiler.js';
import { newRuler } from '../../public/d2/textmeasure.js';

export function dimsCheck(c, ruler = newRuler()) {
  const r = compileGraph(c.path, c.text, { utf16: c.utf16 });
  if (r.err) return { err: r.err.message };
  try {
    return { boards: dimsBoards(r.g, ruler) };
  } catch (e) {
    if (e.name === 'LatexNotPorted') return { deferred: 'latex' };
    throw e;
  }
}

function dimsBoards(g, ruler) {
  const err = g.applyTheme(0);
  if (err) throw new Error(err);
  if ((g.objects || []).length > 0) {
    const e = g.setDimensions(null, ruler, null, null);
    if (e) throw new Error(e);
  }
  const objs = (g.objects || []).map((o) => ({
    id: o.absID(), w: o.box.Width, h: o.box.Height, label: o.attributes.label.value, labelDims: o.attributes.labelDimensions,
    labelPosition: o.labelPosition, iconPosition: o.iconPosition, car: o.contentAspectRatio,
  }));
  const edges = (g.edges || []).map((e) => ({
    id: e.absID(), label: e.attributes.label.value, labelDims: e.attributes.labelDimensions,
    src: e.srcArrowhead !== null && e.srcArrowhead.label.value !== '', srcDims: e.srcArrowhead && e.srcArrowhead.labelDimensions, dstDims: e.dstArrowhead && e.dstArrowhead.labelDimensions,
  }));
  const out = [{ name: g.name, objects: objs.length ? objs : null, edges: edges.length ? edges : null }];
  for (const l of [...(g.layers || []), ...(g.scenarios || []), ...(g.steps || [])]) out.push(...dimsBoards(l, ruler));
  return out;
}
