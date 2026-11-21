// `svg` stage of diff.mjs: d2ref's `svgfromdiagram` mode prints {diagram, ro, svg, err} (Go: d2lib.Compile with dagre, then
// d2svg.Render); the JS renderer is fed Go's own diagram and render options and must reproduce `svg` byte for byte.
// Cases that need what is not ported (sketch, latex, unported code languages) come back as {deferred: reason}.
import markdownit from 'markdown-it';
import { diagramFromJSON } from '../../public/d2/target.js';
import { setMarkdownIt, loadMetrics } from '../../public/d2/textmeasure.js';
import { URL as GoURL } from '../../public/d2/url.js';
import { render, renderMultiboard, hooks, Deferred } from '../../public/d2/d2svg.js';

const FONT_URL = /url\("data:application\/font-woff;base64,[^"]*"\)/g;
const blank = (s) => s.replace(FONT_URL, 'url("FONT")');

// diagramFromJSON keeps icons as plain objects in the key order of Go's JSON; the diagram hash needs url.URL's own field order
function fixIcons(d) {
  const fix = (o) => { if (o.icon != null) o.icon = Object.assign(new GoURL(), o.icon); };
  (d.shapes ?? []).forEach(fix);
  (d.connections ?? []).forEach(fix);
  fix(d.root);
  for (const s of d.legend?.shapes ?? []) fix(s);
  for (const c of d.legend?.connections ?? []) fix(c);
  for (const k of ['layers', 'scenarios', 'steps']) (d[k] ?? []).forEach(fixIcons);
  return d;
}

export async function svgPrepare(nofonts) {
  setMarkdownIt(markdownit);
  await loadMetrics();
  if (nofonts) hooks.fonts = { getEncodedSubset: () => 'data:application/font-woff;base64,FONT' };
  else {
    const { loadFontsNode } = await import('../../public/d2/d2svgfonts.js');
    hooks.fonts = await loadFontsNode();
  }
  try { hooks.markdown = await import('../../public/d2/mdlayout.js'); } catch (e) { /* not ported yet */ }
  try { hooks.highlight = await import('../../public/d2/highlight.js'); } catch (e) { /* not ported yet */ }
  try { hooks.patterns = await import('../../public/d2/d2svgpatterns.js'); } catch (e) { /* not ported yet */ }
}

export function svgCheck(c, want, { nofonts }) {
  if (want.ro == null || want.diagram == null) return { deferred: 'compile-error' };
  const ro = want.ro;
  if (ro.sketch) return { deferred: 'sketch' };
  const diagram = fixIcons(diagramFromJSON(JSON.parse(JSON.stringify(want.diagram))));
  const opts = { ...ro, fonts: 'embed' };
  let svg = null, err = null;
  try {
    if (c.ropts && c.ropts.multiboard) svg = renderMultiboard(diagram, opts);
    else svg = render(diagram, opts);
  } catch (e) {
    if (e instanceof Deferred) return { deferred: e.reason.replace(/ \(.*$/, '').replace(/^code language .*/, 'code-language') };
    err = e.message;
  }
  if (nofonts) {
    svg = Array.isArray(svg) ? svg.map(blank) : svg == null ? svg : blank(svg);
    if (Array.isArray(want.svg)) want.svg = want.svg.map(blank);
    else if (typeof want.svg === 'string') want.svg = blank(want.svg);
  }
  return { diagram: want.diagram, ro: want.ro, svg: svg ?? '', err };
}
