// JS side of `label` mode (tools/d2ref/labelcheck.go), plus the generator for its input:
//   node labelcheck.mjs > label.jsonl
import * as geo from '../../public/d2/geo.js';
import * as label from '../../public/d2/label.js';

const F = (v) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : v);
const pt = (p) => (p ? [F(p.x), F(p.y)] : null);

export function labelCheck(c) {
  const box = geo.newBox(geo.newPoint(10, 20), c.width, c.height);
  const route = (c.route ?? []).map((p) => geo.newPoint(p[0], p[1]));
  const out = [];
  for (let p = label.Unset; p <= label.UnlockedBottom + 1; p++) {
    const s = label.positionString(p);
    const e = {
      s,
      from: label.fromString(s),
      shape: label.isShapePosition(p),
      edge: label.isEdgePosition(p),
      outside: label.isOutside(p),
      unlocked: label.isUnlocked(p),
      border: label.isBorder(p),
      onEdge: label.isOnEdge(p),
      mirror: label.mirrored(p),
      onBox: pt(label.getPointOnBox(p, box, label.PADDING, 33, 17)),
      onBox2: pt(label.getPointOnBox(p, box, 0, 50.5, 12.25)),
    };
    if (route.length >= 2) {
      const [pnt, idx] = label.getPointOnRoute(p, route, c.stroke ?? 0, c.pct ?? 0, 40, 18);
      e.onRoute = pt(pnt);
      e.routeIdx = idx;
    }
    out.push(e);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const routes = [
    [[10, 20], [110, 20]], [[0, 0], [100, 100]], [[0, 0], [50, 0], [50, 80], [120, 80]], [[5, 5], [5, 50]], [[100, 0], [0, 0], [0, 100]],
    [[0, 0], [30.5, 17.25], [61, 0], [90, 40]], [[0, 0], [0, 0], [10, 10]],
  ];
  const out = [];
  for (const [width, height] of [[100, 60], [10, 10], [333, 77]]) {
    out.push(JSON.stringify({ width, height }));
    for (const route of routes) for (const stroke of [0, 2, 5]) for (const pct of [0, 0.3, 0.5, 1, 1.2, -0.2]) out.push(JSON.stringify({ width, height, route, stroke, pct }));
  }
  process.stdout.write(out.join('\n') + '\n');
}
