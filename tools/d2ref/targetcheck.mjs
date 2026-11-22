// JS side of `target` / `targetstatics` modes (tools/d2ref/targetcheck.go). Input for `target` is built from the
// `layout` output of the corpus:  node targetcorpus.mjs > target.jsonl   (needs Go; see that file)
import * as geo from '../../public/d2/geo.js';
import * as t from '../../public/d2/target.js';

const F = (v) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : v);
const pt = (p) => (p ? [F(p.x), F(p.y)] : null);

export function targetCheck(c) {
  const d = t.diagramFromJSON(c.diagram);
  const out = {};
  out.bytes = d.bytes();
  out.hash = d.hashID(null);
  out.hashSalt = d.hashID('salty');
  let [tl, br] = d.boundingBox();
  out.bbox = [tl.x, tl.y, br.x, br.y];
  [tl, br] = d.nestedBoundingBox();
  out.nbbox = [tl.x, tl.y, br.x, br.y];
  out.corpus = d.getCorpus();
  out.ncorpus = d.getNestedCorpus();
  out.hasHexagon = d.hasShape((s) => s.type === t.ShapeHexagon);
  out.shapes = (d.shapes ?? []).map((s) => ({ css: s.cssStyle(), font: s.getFontColor(), z: s.getZIndex(), id: s.getID() }));
  out.conns = (d.connections ?? []).map((cn) => {
    const e = { css: cn.cssStyle(), font: cn.getFontColor(), z: cn.getZIndex(), id: cn.getID() };
    if (cn.route != null && cn.route.length >= 2) {
      if (cn.label !== '') e.labelTL = pt(cn.getLabelTopLeft());
      if (cn.icon != null) e.icon = pt(cn.getIconPosition());
      if (cn.srcLabel != null) e.srcTL = pt(cn.getArrowheadLabelPosition(false));
      if (cn.dstLabel != null) e.dstTL = pt(cn.getArrowheadLabelPosition(true));
    }
    return e;
  });
  return out;
}

export function targetStatics() {
  const out = {};
  const heads = [t.NoArrowhead, t.ArrowArrowhead, t.UnfilledTriangleArrowhead, t.TriangleArrowhead, t.DiamondArrowhead, t.FilledDiamondArrowhead,
    t.CircleArrowhead, t.FilledCircleArrowhead, t.CrossArrowhead, t.BoxArrowhead, t.FilledBoxArrowhead, t.LineArrowhead, t.CfOne, t.CfMany,
    t.CfOneRequired, t.CfManyRequired, 'bogus'];
  out.dims = [];
  for (const h of heads) for (const sw of [0, 1, 2, 3, 5.5, 10]) out.dims.push(t.arrowheadDimensions(h, sw).map(F));
  out.toArrowhead = [];
  for (const name of ['diamond', 'circle', 'none', 'arrow', 'triangle', 'cross', 'box', 'cf-one', 'cf-many', 'cf-one-required', 'cf-many-required', 'bogus', '']) {
    for (const filled of [null, true, false]) out.toArrowhead.push(t.toArrowhead(name, filled));
  }
  out.iconSizes = [];
  for (const pos of ['', 'INSIDE_MIDDLE_CENTER', 'INSIDE_TOP_LEFT', 'OUTSIDE_TOP_LEFT', 'BORDER_LEFT_TOP', 'bogus']) {
    for (const [w, h] of [[10, 10], [40, 40], [100, 30], [500, 500], [64, 200], [7.9, 100]]) out.iconSizes.push(t.getIconSize(geo.newBox(geo.newPoint(0, 0), w, h), pos));
  }
  out.tooltipPos = ['top-left', 'top-center', 'top-right', 'center-left', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right', '', 'x']
    .map((pos) => t.calculateTooltipPosition(10, 20, 100.5, 40, 80, 33, pos).map(F));
  out.isShape = ['', 'Rectangle', 'SQUARE', 'sql_table', 'nope', 'C4-Person', 'Hierarchy'].map(t.isShape);
  out.setType = ['Circle', 'SQUARE', 'Rectangle', 'Hexagon', '', 'CLASS'].map((n) => { const s = new t.Shape(); s.setType(n); return s.type; });
  out.shapeTypeToDSL = { ...t.SHAPE_TYPE_TO_DSL_SHAPE };
  out.zeroShape = t.goMarshal(new t.Shape());
  out.zeroConnection = t.goMarshal(new t.Connection());
  out.zeroDiagram = t.goMarshal(new t.Diagram());
  out.baseShape = t.goMarshal(t.baseShape());
  out.baseConnection = t.goMarshal(t.baseConnection());
  out.newDiagram = t.goMarshal(t.newDiagram());
  return out;
}
