// JS side of `latex` mode (tools/d2ref/latexcheck.go): d2latex.Render and d2latex.Measure of one TeX source ({text}).
// The engine (vendor/mathjax.js) must be loaded first (diff.mjs does).
import { render, measure } from '../../public/d2/d2latex.js';

export function latexCheck(c) {
  const [svg, err] = render(c.text);
  const [width, height, merr] = measure(c.text);
  return { svg, err, width, height, merr };
}
