// Entry point of public/d2/vendor/mathjax.js (see build.sh): MathJax 3.2.2 configured exactly like D2's custom component
// (d2renderers/d2latex/setup.js in D2 v0.7.2, which mathjax-go v0.1.0 reimplements): lite DOM adaptor, TeX input with the packages
// base mathtools ams amscd braket cancel cases color gensymb mhchem physics, SVG output with fontCache 'none', display mode,
// em 16 px, ex 8 px (D2's pxPerEx = 8), serialised with adaptor.innerHTML.
//
// D2 builds a fresh JavaScript engine (adaptor, TeX/SVG jax, MathDocument) for every Render call, because TeX state (\newcommand,
// \def, equation tags and labels, \mathtoolsset) would otherwise leak from one formula into the next. Here the module-level
// state is only the handler registration; the TeX input jax, the SVG output jax and the document are created per call.
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js';
import 'mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/amscd/AmsCdConfiguration.js';
import 'mathjax-full/js/input/tex/braket/BraketConfiguration.js';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js';
import 'mathjax-full/js/input/tex/cases/CasesConfiguration.js';
import 'mathjax-full/js/input/tex/color/ColorConfiguration.js';
import 'mathjax-full/js/input/tex/gensymb/GensymbConfiguration.js';
import 'mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js';
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration.js';

const packages = ['base', 'mathtools', 'ams', 'amscd', 'braket', 'cancel', 'cases', 'color', 'gensymb', 'mhchem', 'physics'];
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

export const version = '3.2.2';

/** html.convert(tex, {em: 16, ex: 8}) and the inner HTML of the container: the bare <svg> element. */
export function render(tex) {
  const html = mathjax.document('', { InputJax: new TeX({ packages }), OutputJax: new SVG({ fontCache: 'none' }) });
  return adaptor.innerHTML(html.convert(tex, { em: 16, ex: 8 }));
}
