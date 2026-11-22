// Client-side diagram rendering (D2 via WASM, Mermaid via plain JS, Graphviz/DOT via WASM) and the mapping from a
// clicked element back to the source line that defines it. The renderers are optional dependencies,
// loaded on demand; if one is missing the caller shows the source instead.
import { d2LineMaps, decodeD2Class, findMermaidLines, findDotLines } from './lib.js';

export const diagramLang = (info) => {
  const l = String(info || '').trim().split(/\s+/)[0].toLowerCase();
  if (l === 'dot' || l === 'graphviz' || l === 'gv') return 'dot'; // GitHub highlights ```dot; ```graphviz and ```gv are the common aliases
  return l === 'd2' || l === 'mermaid' ? l : null;
};

const fail = (messages, unavailable = false) => Object.assign(new Error(messages.join('; ')), { messages, unavailable });
const forcedTheme = () => (typeof document !== 'undefined' ? document.documentElement.dataset.theme : '') || '';
const prefersDark = () => (forcedTheme() ? forcedTheme() === 'dark' : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);

/**
 * The document shown inside the diagram's sandboxed iframe. The frame has no scripts (sandbox), and
 * this CSP forbids every network request, so untrusted diagram source cannot run code or phone home.
 */
// The diagram's own size: the width of the outer <svg>'s viewBox. Without a width/height attribute a bare SVG stretches to the
// whole frame, so a small diagram came out blown up (and cropped by the height cap): cap it at its natural width.
export const naturalWidth = (svg) => {
  const m = /<svg\b[^>]*?\bviewBox\s*=\s*["']\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+\s*["']/i.exec(String(svg));
  const w = m ? Number(m[1]) : 0;
  return w > 0 ? Math.ceil(w) : 0;
};

export const frameDoc = (svg, css = '', fontSrc = '') => '<!doctype html><meta charset="utf-8">'
  // An iframe whose colour scheme differs from its embedder gets an opaque white canvas (a white strip, light-grey lines on
  // white in dark mode). Declaring the scheme the page is using keeps it transparent.
  + `<meta name="color-scheme" content="${prefersDark() ? 'dark' : 'light'}">`
  + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:${fontSrc ? ' ' + fontSrc : ''}">`
  + '<style>html,body{margin:0;background:transparent}body{display:flex;justify-content:center}'
  + `svg{max-width:100%;height:auto;cursor:pointer}${naturalWidth(svg) ? `body>svg{max-width:min(100%,${naturalWidth(svg)}px)}` : ''}${css}</style>` // links are neutralised by the capture-phase click handler, not by CSS
  + `<body>${svg}</body>`;

// ---------------- D2 ----------------
function d2Errors(e) {
  try {
    const list = JSON.parse(e.message || String(e));
    if (Array.isArray(list)) return list.map((x) => String(x.errmsg || x).replace(/^index:/, 'line '));
  } catch { /* not JSON */ }
  return [String(e.message || e)];
}

// The JavaScript port of D2 (public/d2/, see docs/d2-port.md) is preferred: no WASM download, no worker, and the default layout is
// ready in tens of milliseconds. The WASM build (@terrastruct/d2, optional) stays as the fallback for when the port cannot load or
// throws something that is not a compile error of the diagram.
let d2jsPromise = null;
let d2wasmPromise = null;

function loadD2js() {
  return (d2jsPromise ||= (async () => {
    const [lib, svg] = await Promise.all([import('/d2/d2lib.js'), import('/d2/d2svg.js')]);
    await lib.init({ markdownit: window.markdownit });
    return { lib, svg };
  })().catch((e) => { d2jsPromise = null; throw e; }));
}

const d2Errs = (err) => (Array.isArray(err.errs) && err.errs.length ? err.errs : String(err.message || err).split('\n').filter(Boolean)).map((x) => `line ${String(x.errmsg || x.message || x).replace(/^(Error: |index:)/, '')}`); // the port's ParseError holds one Error per problem
const d2Theme = (ro) => (forcedTheme() ? { ...ro, themeID: forcedTheme() === 'dark' ? 200 : 0, darkThemeID: null } : { ...ro, themeID: ro.themeID ?? 0, darkThemeID: ro.darkThemeID ?? 200 });

async function d2WithPort(source) {
  const { lib, svg: svgm } = await loadD2js();
  const ro = {};
  const r = await lib.compile(source, {}, ro);
  if (r.err) throw fail(d2Errs(r.err)); // a real compile error of the diagram: do not retry with the WASM build
  // fonts: the SVG points at the cached same-origin TTFs instead of carrying base64 subsets; the frame's CSP allows exactly that origin
  const svg = await svgm.renderAsync(r.diagram, { ...d2Theme(ro), fonts: 'external', fontBaseURL: `${location.origin}/d2/fonts/` });
  return { svg, diagram: r.diagram, graph: r.graph, fontSrc: location.origin };
}

async function d2WithWasm(source) {
  let d2;
  try { d2 = await (d2wasmPromise ||= import('/vendor/d2.js').then((m) => new m.D2())); } catch {
    d2wasmPromise = null;
    throw fail(['Install the optional dependency: npm install @terrastruct/d2'], true);
  }
  let r;
  try { r = await d2.compile(source); } catch (e) { throw fail(d2Errors(e)); }
  const ro = r.renderOptions || {};
  const svg = await d2.render(r.diagram, d2Theme(ro));
  return { svg, diagram: r.diagram, graph: r.graph };
}

// A D2 `icon:` is a URL, but the diagram's frame may fetch nothing (CSP: img-src data:), so icons from D2's icon library are
// fetched here, through Rico's /api/icon (one allowed host, size-limited), and inlined as data: URIs before the SVG is framed.
// Any other icon URL stays as it is and is simply not shown.
const ICON_RE = /(<image\b[^>]*?\bhref=")(https:\/\/icons\.terrastruct\.com\/[^"]*)(")/g;
const iconCache = new Map(); // url -> Promise<data URI | null>
const toDataUri = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
function iconData(url) {
  if (!iconCache.has(url)) {
    iconCache.set(url, fetch('/api/icon?u=' + encodeURIComponent(url)).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? toDataUri(b) : null)).catch(() => null));
  }
  return iconCache.get(url);
}
export async function inlineIcons(svg) {
  const found = [...String(svg).matchAll(ICON_RE)];
  if (!found.length) return svg;
  const urls = [...new Set(found.map((m) => m[2].replace(/&amp;/g, '&')))];
  const got = new Map(await Promise.all(urls.map(async (u) => [u, await iconData(u)])));
  return String(svg).replace(ICON_RE, (all, a, u, z) => { const d = got.get(u.replace(/&amp;/g, '&')); return d ? a + d + z : all; });
}

async function renderD2(source) {
  let out;
  try { out = await d2WithPort(source); } catch (e) {
    if (e.messages) throw e; // the diagram does not compile
    console.warn('D2 (JavaScript port) failed, falling back to the WASM build:', e);
    out = await d2WithWasm(source);
  }
  const maps = d2LineMaps(out.diagram, out.graph);
  return {
    svg: await inlineIcons(out.svg),
    fontSrc: out.fontSrc,
    // walk up from the clicked element to the group D2 tagged with the shape / connection id
    resolve(target) {
      for (let el = target; el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'svg'; el = el.parentElement) {
        const cls = el.getAttribute('class');
        const id = cls ? decodeD2Class(cls) : null;
        const lines = id != null && (maps.shapes.get(id) || maps.conns.get(id));
        if (lines) return { el, kind: maps.conns.has(id) ? 'edge' : 'node', label: id, lines };
      }
      return null;
    },
  };
}

// ---------------- Mermaid ----------------
let mermaidPromise = null;
let mermaidCount = 0;

function loadMermaid() {
  return (mermaidPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.js';
    s.onload = () => {
      const m = window.mermaid || window.__esbuild_esm_mermaid_nm?.mermaid?.default;
      if (!m) return reject(new Error('mermaid global missing'));
      // strict: labels are sanitized and click handlers / javascript: links are not emitted
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: prefersDark() ? 'dark' : 'default' });
      resolve(m);
    };
    s.onerror = () => reject(new Error('failed to load'));
    document.head.append(s);
  })).catch((e) => { mermaidPromise = null; throw e; });
}

const nodeIdOf = (el) => /(?:flowchart|state|classId)-(.+)-\d+$/.exec(el.id || '')?.[1] ?? null;

async function renderMermaid(source) {
  let m;
  try { m = await loadMermaid(); } catch { throw fail(['Install the optional dependency: npm install mermaid'], true); }
  const id = `rico-m-${++mermaidCount}`;
  let out;
  try { out = await m.render(id, source); } catch (e) {
    document.getElementById('d' + id)?.remove(); // mermaid leaves its scratch element behind on errors
    document.getElementById(id)?.remove();
    throw fail([String(e.message || e).split('\n').slice(0, 3).join(' ').trim() || 'Mermaid could not render this diagram']);
  }
  const hint = (el, h) => { const lines = findMermaidLines(source, h); return lines ? { el, kind: h.kind === 'text' ? 'label' : h.kind, label: h.id || h.text || `${h.from} → ${h.to}`, lines: [lines] } : null; };
  // "L_A_B_0" -> {from: A, to: B, n: 0}; ids may contain underscores, so try every split against the real nodes
  const edgeHit = (pathEl) => {
    const em = /-L_(.+)_(\d+)$/.exec(pathEl.id || '');
    if (!em) return null;
    const ids = new Set([...pathEl.ownerDocument.querySelectorAll('g.node')].map(nodeIdOf).filter(Boolean));
    let from = null;
    let to = null;
    for (let i = 0; i < em[1].length; i++) {
      if (em[1][i] !== '_') continue;
      const a = em[1].slice(0, i); const b = em[1].slice(i + 1);
      if (ids.has(a) && ids.has(b)) { from = a; to = b; break; }
    }
    if (!from) { const i = em[1].indexOf('_'); from = em[1].slice(0, i); to = em[1].slice(i + 1); }
    return hint(pathEl, { kind: 'edge', from, to, n: Number(em[2]) });
  };
  return {
    svg: out.svg,
    resolve(target) {
      const closest = (sel) => (target.closest ? target.closest(sel) : null);
      const doc = target.ownerDocument;
      let el = closest('g.node');
      if (el) { const nid = nodeIdOf(el); if (nid) return hint(el, { kind: 'node', id: nid }); }
      el = closest('path.flowchart-link, path[id*="-L_"]');
      if (el) return edgeHit(el);
      el = closest('g.edgeLabel'); // edge labels are emitted in the same order as the edge paths
      if (el) {
        const i = [...doc.querySelectorAll('g.edgeLabel')].indexOf(el);
        const path = doc.querySelectorAll('path.flowchart-link, path[id*="-L_"]')[i];
        const h = path && edgeHit(path);
        if (h) return { ...h, el };
      }
      el = closest('rect.actor') || closest('text.actor')?.parentElement?.querySelector('rect.actor[name]');
      if (el && el.getAttribute('name')) return hint(el, { kind: 'actor', id: el.getAttribute('name') });
      el = closest('text.messageText, text.noteText, text.labelText');
      if (el && el.textContent.trim()) return hint(el, { kind: 'text', text: el.textContent });
      el = closest('line[class^="messageLine"], path[class^="messageLine"]'); // a message arrow: pair it with its message text
      if (el) {
        const lines = [...doc.querySelectorAll('line[class^="messageLine"], path[class^="messageLine"]')];
        const t = doc.querySelectorAll('text.messageText')[lines.indexOf(el)];
        if (t) return hint(el, { kind: 'text', text: t.textContent });
      }
      return null;
    },
  };
}

// ---------------- Graphviz (DOT) ----------------
let vizPromise = null;

// Graphviz draws black lines and text on an opaque white polygon. In the dark theme the colours are inverted (hue kept) and the
// background dropped so the diagram sits on the page like the others.
const dotCss = () => 'g.graph>polygon{fill:transparent!important;stroke:transparent!important}' + (prefersDark() ? 'svg{filter:invert(.92) hue-rotate(180deg)}' : '');

async function renderDot(source) {
  let viz;
  try { viz = await (vizPromise ||= import('/vendor/viz.js').then((m) => m.instance())); } catch {
    vizPromise = null;
    throw fail(['Install the optional dependency: npm install @viz-js/viz'], true);
  }
  let r;
  try { r = viz.render(source, { format: 'svg', engine: 'dot' }); } catch (e) { throw fail([String(e.message || e)]); }
  if (r.status !== 'success' || !r.output) {
    const errs = (r.errors || []).filter((x) => x.level !== 'warning').map((x) => String(x.message || x).trim().replace(/\s*\n\s*/g, ' '));
    throw fail(errs.length ? errs : ['Graphviz could not render this diagram']);
  }
  const hit = (el, h) => { const lines = findDotLines(source, h); return lines ? { el, kind: h.kind, label: h.label, lines: [lines] } : null; };
  const titleOf = (g) => g.querySelector(':scope > title')?.textContent ?? '';
  // "a:p1:n->b:p2" / "a--b": drop ports, split on the arrow
  const ends = (t) => { const m = /^(.*?)(->|--)(.*)$/s.exec(t); return m ? { from: m[1].split(':')[0], to: m[3].split(':')[0], undirected: m[2] === '--' } : null; };
  return {
    svg: r.output,
    css: dotCss(),
    resolve(target) {
      const g = target.closest ? target.closest('g.node, g.edge, g.cluster') : null;
      if (!g) return null;
      const t = titleOf(g);
      if (g.classList.contains('node')) return hit(g, { kind: 'node', id: t, label: t });
      if (g.classList.contains('cluster')) return hit(g, { kind: 'cluster', id: t, label: t.replace(/^cluster_?/, '') || t });
      const e = ends(t);
      if (!e) return null;
      let n = 0; // the nth edge between the same pair
      for (const o of g.ownerDocument.querySelectorAll('g.edge')) {
        if (o === g) break;
        const x = ends(titleOf(o));
        if (x && x.from === e.from && x.to === e.to) n++;
      }
      return hit(g, { kind: 'edge', from: e.from, to: e.to, undirected: e.undirected, n, label: `${e.from} ${e.undirected ? '–' : '→'} ${e.to}` });
    },
  };
}

/** Render a diagram. Throws an Error with `.messages` (and `.unavailable` if the renderer is not installed). */
export function renderDiagram(lang, source) {
  return lang === 'd2' ? renderD2(source) : lang === 'dot' ? renderDot(source) : renderMermaid(source);
}
