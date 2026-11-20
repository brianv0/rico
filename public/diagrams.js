// Client-side diagram rendering (D2 via WASM, Mermaid via plain JS) and the mapping from a clicked
// element back to the source line that defines it. Both renderers are optional dependencies,
// loaded on demand; if one is missing the caller shows the source instead.
import { d2LineMaps, decodeD2Class, findMermaidLines } from './lib.js';

export const diagramLang = (info) => {
  const l = String(info || '').trim().split(/\s+/)[0].toLowerCase();
  return l === 'd2' || l === 'mermaid' ? l : null;
};

const fail = (messages, unavailable = false) => Object.assign(new Error(messages.join('; ')), { messages, unavailable });
const prefersDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/**
 * The document shown inside the diagram's sandboxed iframe. The frame has no scripts (sandbox), and
 * this CSP forbids every network request, so untrusted diagram source cannot run code or phone home.
 */
export const frameDoc = (svg) => '<!doctype html><meta charset="utf-8">'
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">'
  + '<style>html,body{margin:0;background:transparent}body{display:flex;justify-content:center}'
  + 'svg{max-width:100%;height:auto;cursor:pointer}</style>' // links are neutralised by the capture-phase click handler, not by CSS
  + `<body>${svg}</body>`;

// ---------------- D2 ----------------
let d2Promise = null;
function d2Errors(e) {
  try {
    const list = JSON.parse(e.message || String(e));
    if (Array.isArray(list)) return list.map((x) => String(x.errmsg || x).replace(/^index:/, 'line '));
  } catch { /* not JSON */ }
  return [String(e.message || e)];
}

async function renderD2(source) {
  let d2;
  try { d2 = await (d2Promise ||= import('/vendor/d2.js').then((m) => new m.D2())); } catch {
    d2Promise = null;
    throw fail(['Install the optional dependency: npm install @terrastruct/d2'], true);
  }
  let r;
  try { r = await d2.compile(source); } catch (e) { throw fail(d2Errors(e)); }
  const ro = r.renderOptions || {};
  const svg = await d2.render(r.diagram, { ...ro, themeID: ro.themeID ?? 0, darkThemeID: ro.darkThemeID ?? 200 });
  const maps = d2LineMaps(r.diagram, r.graph);
  return {
    svg,
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

/** Render a diagram. Throws an Error with `.messages` (and `.unavailable` if the renderer is not installed). */
export function renderDiagram(lang, source) {
  return lang === 'd2' ? renderD2(source) : renderMermaid(source);
}
