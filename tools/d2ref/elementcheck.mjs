// JS side of `element` mode (tools/d2ref/elementcheck.go); node elementcheck.mjs > element.jsonl generates its input.
import * as themes from '../../public/d2/themes.js';

export function elementCheck(c) {
  const spec = JSON.parse(c.text);
  const th = spec.theme != null ? themes.find(spec.theme) : null;
  const el = themes.newThemableElement(spec.tag, th);
  for (const [k, v] of Object.entries(spec.props ?? {})) el[k] = v;
  const out = {};
  const ov = spec.overlay ?? '';
  if (ov.startsWith('pattern:') || ov.startsWith('sketch:')) {
    try {
      out.overlay = ov.startsWith('pattern:') ? themes.newPatternOverlay(el, ov.slice(8)).render() : themes.newThemableSketchOverlay(el, ov.slice(7)).render();
      out.err = null;
    } catch (e) {
      out.overlay = '';
      out.err = e.message;
    }
  }
  out.render = el.render();
  out.after = { Fill: el.Fill, Stroke: el.Stroke, ClassName: el.ClassName };
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let seed = 3;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = (a) => a[rnd(a.length)];
  const cols = ['', 'N1', 'N7', 'B3', 'AA2', 'AB5', 'red', '#fff', 'linear-gradient(red, blue)', 'radial-gradient(circle, #fff 10%, #000)', 'N9', 'transparent'];
  const out = [];
  for (let i = 0; i < 1500; i++) {
    const props = {};
    for (const k of ['X', 'X1', 'X2', 'Y', 'Y1', 'Y2', 'Width', 'Height', 'R', 'Rx', 'Ry', 'Cx', 'Cy']) if (rnd(4) === 0) props[k] = pick([0, 1, -2.5, 3.14159265, 100, 1e-7, 123456.789, 0.1 + 0.2]);
    for (const k of ['Fill', 'Stroke', 'BackgroundColor', 'Color']) if (rnd(2)) props[k] = pick(cols);
    for (const k of ['D', 'Mask', 'Points', 'Transform', 'Href', 'ClassName', 'Style', 'Attributes', 'Content', 'ClipPath', 'FillPattern', 'StrokeDashArray']) {
      if (rnd(5) === 0) props[k] = pick(['', 'a', 'M 0 0 L 1 1', 'x y', 'dots', 'lines', 'none', 'grain', 'cls-1']);
    }
    const overlay = pick(['', '', '', 'pattern:dots', 'sketch:B3', 'sketch:red', 'sketch:#123456', 'sketch:nope']);
    out.push(JSON.stringify({ text: JSON.stringify({ tag: pick(['rect', 'path', 'div', 'circle', 'text']), theme: pick([null, null, 0, 1, 200, 300, 303, 12345]), props, overlay }) }));
  }
  process.stdout.write(out.join('\n') + '\n');
}
