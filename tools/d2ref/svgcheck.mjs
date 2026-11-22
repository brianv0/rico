// `svg` stage of diff.mjs: d2ref's `svgfromdiagram` mode prints {diagram, ro, svg, err} (Go: d2lib.Compile with dagre, then
// d2svg.Render); the JS renderer is fed Go's own diagram and render options and must reproduce `svg` byte for byte.
// Cases that need what is not ported (sketch, latex, unported code languages) come back as {deferred: reason}.
import markdownit from 'markdown-it';
import { diagramFromJSON } from '../../public/d2/target.js';
import { setMarkdownIt, loadMetrics } from '../../public/d2/textmeasure.js';
import { URL as GoURL, Userinfo } from '../../public/d2/url.js';
import { render, renderMultiboard, hooks, Deferred, NeedAsset } from '../../public/d2/d2svg.js';
import { compileSync } from '../../public/d2/d2lib.js';

const FONT_URL = /url\("data:application\/font-woff;base64,[^"]*"\)/g;
const blank = (s) => s.replace(FONT_URL, 'url("FONT")');

// diagramFromJSON keeps icons as plain objects in the key order of Go's JSON; the diagram hash needs url.URL's own field order
// Go's svgfromdiagram mode prints the credentials separately (`userinfo`, one entry per icon in the order below), since a url.Userinfo marshals as {}
let userinfo = [];
const bin = (s) => Buffer.from(s, 'utf8').toString('latin1'); // url.js keeps Go strings as one character per UTF-8 byte
function fixIcons(d) {
  // a url.Userinfo marshals as {} (its fields are unexported), so a diagram read back from JSON cannot carry one
  const fix = (o) => {
    if (o.icon == null) return;
    const u = userinfo.shift();
    o.icon = Object.assign(new GoURL(), o.icon);
    o.icon.User = u ? new Userinfo(bin(u.user), bin(u.password), u.passwordSet) : null;
  };
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
    const m = await import('../../public/d2/d2svgfonts.js');
    await m.loadAllFonts();
    hooks.fonts = m;
  }
  try { hooks.markdown = await import('../../public/d2/mdlayout.js'); } catch (e) { /* not ported yet */ }
  await (await import('../../public/d2/linebreak.js')).loadFullTables();
  hooks.highlight = await import('../../public/d2/highlight.js');
  hooks.sketch = await import('../../public/d2/d2sketch.js');
  hooks.patterns = await import('../../public/d2/d2svgpatterns.js');
  await hooks.patterns.loadPattern('paper');
  await hooks.patterns.loadPattern('grain');
}

// code labels load their lexer on demand, as renderAsync does: a NeedAsset('lexer') loads the file and the render is retried
async function withLexers(fn) {
  for (;;) {
    try { return fn(); } catch (e) {
      if (!(e instanceof NeedAsset) || e.kind !== 'lexer') throw e;
      await hooks.highlight.loadLexer(e.assetName);
    }
  }
}

export async function svgCheck(c, want, { nofonts }) {
  if (want.ro == null || want.diagram == null) return { deferred: 'compile-error' };
  const ro = want.ro;
  userinfo = [...(want.userinfo ?? [])];
  const diagram = fixIcons(diagramFromJSON(JSON.parse(JSON.stringify(want.diagram))));
  const opts = { ...ro, fonts: 'embed' };
  let svg = null, err = null;
  try {
    if (c.ropts && c.ropts.multiboard) svg = await withLexers(() => renderMultiboard(diagram, opts));
    else svg = await withLexers(() => render(diagram, opts));
  } catch (e) {
    if (e instanceof NeedAsset) return { deferred: `unported-${e.kind}` };
    if (e instanceof Deferred) return { deferred: e.reason.replace(/ \(.*$/, '').replace(/^code language .*/, 'code-language') };
    err = e.message;
  }
  if (nofonts) {
    svg = Array.isArray(svg) ? svg.map(blank) : svg == null ? svg : blank(svg);
    if (Array.isArray(want.svg)) want.svg = want.svg.map(blank);
    else if (typeof want.svg === 'string') want.svg = blank(want.svg);
  }
  return { diagram: want.diagram, ro: want.ro, svg: svg ?? (c.ropts && c.ropts.multiboard ? [] : ''), err, userinfo: want.userinfo };
}

// `svgfull` stage: the whole JS pipeline against Go's. Go's `svgfromdiagram` mode compiles the text (dagre) with the case's render options and renders
// it; the JS port compiles the same text with the same options (so `--sketch` / `vars.d2-config.sketch` change fonts, sizes and layout) and renders.
// Compared: the diagram, the SVG (byte for byte) and the error.
export async function svgFullCheck(c, want, { nofonts }) {
  const ro = { ...(c.ropts ?? {}) };
  delete ro.multiboard;
  const r = compileSync(c.text, { utf16: false, fs: c.fs && { [c.path]: c.text, ...c.fs }, inputPath: c.path, layout: c.layout || 'dagre' }, ro);
  if (r.err) {
    if (r.err.name === 'LatexNotPorted') return { deferred: 'latex' };
    return { diagram: null, err: r.err.message };
  }
  let svg = null, err = null;
  try { svg = await withLexers(() => render(r.diagram, { ...ro, fonts: 'embed' })); } catch (e) {
    if (e instanceof NeedAsset) return { deferred: `unported-${e.kind}` };
    if (e instanceof Deferred) return { deferred: e.reason.replace(/ \(.*$/, '').replace(/^code language .*/, 'code-language') };
    err = e.message;
  }
  if (nofonts) { svg = svg == null ? svg : blank(svg); if (typeof want.svg === 'string') want.svg = blank(want.svg); }
  const roKeys = ['pad', 'sketch', 'center', 'themeID', 'darkThemeID', 'themeOverrides', 'darkThemeOverrides', 'scale', 'masterID', 'noXMLTag', 'salt', 'omitVersion'];
  return { diagram: r.diagram, ro: Object.fromEntries(roKeys.map((k) => [k, ro[k] ?? (k === 'masterID' ? '' : null)])), svg: svg ?? '', err, userinfo: want.userinfo };
}
