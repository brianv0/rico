// JS side of `shape` mode (tools/d2ref/shapecheck.go): same JSON shape from public/d2/shape.js.
import * as geo from '../../public/d2/geo.js';
import { newShape, traceToShapeBorder, CLOUD_TYPE, getPathCommands } from '../../public/d2/shape.js';

const F = (v) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : v);
const pt = (p) => (p ? [F(p.x), F(p.y)] : null);
const boxOut = (b) => (b ? { tl: pt(b.TopLeft), w: F(b.Width), h: F(b.Height) } : null);
const pts = (ps) => (ps ?? []).map(pt);

export function shapeCheck(c) {
  const box = geo.newBox(geo.newPoint(10, 20), c.width, c.height);
  const s = newShape(c.shape, box);
  const out = {};
  out.type = s.getType();
  out.ar1 = s.aspectRatio1();
  out.rect = s.isRectangular();
  if (s.is(CLOUD_TYPE)) {
    s.setInnerBoxAspectRatio(1.7);
    out.cloudInner = boxOut(s.getInnerBox());
    s.setInnerBoxAspectRatio(0);
  }
  out.inner = boxOut(s.getInnerBox());
  out.innerForContent = boxOut(s.getInnerBoxForContent(50, 20));
  out.innerForContent2 = boxOut(s.getInnerBoxForContent(20, 50));
  [[c.width / 3, c.height / 4, 6, 8], [30, 20, 0, 0], [100, 100, 40, 40]].forEach((a, i) => {
    out['inside' + i] = pt(s.getInsidePlacement(a[0], a[1], a[2], a[3]));
  });
  const [px, py] = s.getDefaultPadding();
  out.padding = [F(px), F(py)];
  const fits = [];
  for (const cc of [[30, 20], [100, 40], [10, 10], [400, 300], [1, 1], [0, 0], [123.5, 17.25]]) {
    for (const p of [[px, py], [0, 0], [20, 30], [8, 6]]) {
      const [w, h] = s.getDimensionsToFit(cc[0], cc[1], p[0], p[1]);
      fits.push([F(w), F(h)]);
    }
  }
  out.fit = fits;
  out.path = s.getSVGPathData();
  const pcs = getPathCommands(s);
  if (pcs !== null) out.pathCommands = pcs.map((pc) => pc.map((c) => [c.Kind, pt(c.Control1), pt(c.Control2), pt(c.End)]));

  const per = [];
  const hits = [];
  const tl = box.TopLeft;
  const mk = (a, b, c2, d) => new geo.Segment(geo.newPoint(a, b), geo.newPoint(c2, d));
  const tests = [
    mk(tl.x - 50, tl.y + box.Height / 2, tl.x + box.Width + 50, tl.y + box.Height / 2),
    mk(tl.x + box.Width / 2, tl.y - 50, tl.x + box.Width / 2, tl.y + box.Height + 50),
    mk(tl.x - 20, tl.y - 20, tl.x + box.Width + 20, tl.y + box.Height + 20),
    mk(tl.x + box.Width + 20, tl.y - 20, tl.x - 20, tl.y + box.Height + 20),
    mk(tl.x + box.Width / 3, tl.y - 30, tl.x + box.Width / 5, tl.y + box.Height + 40),
    mk(tl.x - 10, tl.y + box.Height / 3, tl.x + box.Width + 10, tl.y + box.Height / 4),
  ];
  for (const p of s.perimeter() ?? []) {
    if (p instanceof geo.Segment) per.push({ seg: [...pt(p.Start), ...pt(p.End)] });
    else if (p instanceof geo.BezierCurve) per.push({ bez: [0, 0.25, 0.5, 0.75, 1].map((t) => pt(p.at(t))) });
    else if (p instanceof geo.Ellipse) per.push({ ell: [F(p.Center.x), F(p.Center.y), F(p.Rx), F(p.Ry)] });
    else per.push('?');
    hits.push(tests.map((t) => pts(p.intersections(t))));
  }
  out.perimeter = per;
  out.hits = hits;

  const trace = [];
  const l = tl.x, t = tl.y, r = tl.x + box.Width, b = tl.y + box.Height;
  for (const cc of [
    [r, t + box.Height / 2, r + 40, t + box.Height / 2],
    [l, t + box.Height / 3, l - 40, t + box.Height / 3],
    [l + box.Width / 2, t, l + box.Width / 2, t - 40],
    [l + box.Width / 3, b, l + box.Width / 3, b + 40],
    [r, t + box.Height / 4, r + 30, t + box.Height / 4 - 17],
  ]) {
    trace.push(pt(traceToShapeBorder(s, geo.newPoint(cc[0], cc[1]), geo.newPoint(cc[2], cc[3]))));
  }
  out.trace = trace;
  return out;
}
