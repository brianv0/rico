// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2lib package (D2 v0.9.0, Copyright 2022 Terrastruct Inc.): d2.go.
// compile(text, opts) is the top-level entry: text -> parse -> IR -> graph -> dimensions -> layout -> d2target.Diagram,
// returning `{ diagram, graph, err }` like the WASM build's compile. `err` is null or an Error-like object with `.message`
// (Go's err.Error()).
//
// opts (Go's d2lib.CompileOptions, camelCase): { utf16, fs, measuredTexts, ruler, layout ('dagre'), layoutResolver,
// routerResolver, fontFamily, monoFontFamily, inputPath }. `fs` maps file paths to text for imports; the main file is
// `inputPath`. renderOpts (Go's d2svg.RenderOpts, the fields compile reads and writes): { themeID, darkThemeID, sketch, pad,
// center, themeOverrides, darkThemeOverrides }; pass an object to read back the values compile derived from d2-config.
//
// ELK is not ported: layout 'elk' fails with an error named ElkNotPorted. latex labels fail with LatexNotPorted.

import { compile as compileGraph } from './d2compiler.js';
import * as d2graph from './d2graph.js';
import * as d2target from './target.js';
import * as d2fonts from './fonts.js';
import * as d2themescatalog from './themes.js';
import * as d2layouts from './d2layouts.js';
import * as d2dagrelayout from './d2dagrelayout.js';
import { exportDiagram } from './d2exporter.js';
import { newRuler, loadMetrics, setMarkdownIt } from './textmeasure.js';

export const DEFAULT_PADDING = 100; // d2svg.DEFAULT_PADDING

export class ElkNotPorted extends Error {
  constructor() { super('the elk layout engine is not ported'); this.name = 'ElkNotPorted'; }
}

let ready = null;

/**
 * Loads what compile needs: the font metrics and dagre. `markdownit` is the markdown-it constructor (see
 * textmeasure.setMarkdownIt); pass it once if the page has not registered it yet.
 */
export function init({ markdownit } = {}) {
  if (markdownit) setMarkdownIt(markdownit);
  if (ready === null) ready = Promise.all([loadMetrics(), d2dagrelayout.loadDagre()]);
  return ready;
}

let defaultRuler = null;

/**
 * Compiles D2 source to a diagram (async: loads the metrics and dagre on first use).
 * @returns {Promise<{diagram: d2target.Diagram|null, graph: d2graph.Graph|null, err: {message: string}|null}>}
 */
export async function compile(input, compileOpts, renderOpts) {
  await init();
  return compileSync(input, compileOpts, renderOpts);
}

/** compile, once init() has resolved. */
export function compileSync(input, compileOpts, renderOpts) {
  compileOpts = compileOpts || {};
  renderOpts = renderOpts || {};
  if (compileOpts.ruler === undefined) compileOpts.ruler = defaultRuler ||= newRuler(); // ruler: null means none (only measuredTexts)

  const { g, config: config0, err } = compileGraph(compileOpts.inputPath || '', input, { utf16: !!compileOpts.utf16, fs: compileOpts.fs });
  if (err) return { diagram: null, graph: null, err };
  let config = config0;

  applyConfigs(config, compileOpts, renderOpts);
  applyDefaults(compileOpts, renderOpts);
  if (config !== null) applyGraphData(g, config.data);

  let d;
  try {
    d = compile_(g, compileOpts, renderOpts);
  } catch (e) {
    return { diagram: null, graph: g, err: e instanceof Error ? e : new Error(String(e)) };
  }
  if (config === null) config = new d2target.Config();
  // These are fields that affect a diagram's appearance, so feed them back
  // into diagram.Config to ensure the hash computed for CSS styling purposes
  // is unique to its appearance
  config.themeID = renderOpts.themeID;
  config.darkThemeID = renderOpts.darkThemeID;
  config.sketch = renderOpts.sketch;
  d.config = config;
  return { diagram: d, graph: g, err: null };
}

function applyGraphData(g, data) {
  if (g === null || g === undefined) return;
  g.data = d2layouts.cloneGraphData(data);
  for (const boards of [g.layers, g.scenarios, g.steps]) {
    for (const board of boards || []) applyGraphData(board, data);
  }
}

function compile_(g, compileOpts, renderOpts) {
  const terr = g.applyTheme(renderOpts.themeID);
  if (terr !== null) throw new Error(terr);

  if ((g.objects || []).length > 0) {
    const serr = g.setDimensions(compileOpts.measuredTexts || null, compileOpts.ruler || null, compileOpts.fontFamily ?? null, compileOpts.monoFontFamily ?? null);
    if (serr !== null) throw new Error(serr);

    const coreLayout = getLayout(compileOpts);
    const edgeRouter = getEdgeRouter(compileOpts);

    const graphInfo = d2layouts.nestedGraphInfo(g.root);
    d2layouts.layoutNested(g, graphInfo, coreLayout, edgeRouter);
  }

  const d = exportDiagram(g, compileOpts.fontFamily ?? null, compileOpts.monoFontFamily ?? null);

  for (const l of g.layers || []) d.layers = [...(d.layers || []), compile_(l, compileOpts, renderOpts)];
  for (const l of g.scenarios || []) d.scenarios = [...(d.scenarios || []), compile_(l, compileOpts, renderOpts)];
  for (const l of g.steps || []) d.steps = [...(d.steps || []), compile_(l, compileOpts, renderOpts)];
  return d;
}

function getLayout(opts) {
  if (opts.layout !== null && opts.layout !== undefined) {
    if (opts.layoutResolver) return opts.layoutResolver(opts.layout);
    if (opts.layout.toLowerCase() === 'elk') throw new ElkNotPorted();
    return d2dagrelayout.defaultLayout;
  }
  throw new Error('no available layout');
}

function getEdgeRouter(opts) {
  if (opts.layout !== null && opts.layout !== undefined && opts.routerResolver) {
    const router = opts.routerResolver(opts.layout);
    if (router !== null && router !== undefined) return router;
  }
  return d2layouts.defaultRouter;
}

/**
 * applyConfigs applies the configs read from D2 and applies it to passed in opts
 * It will only write to opt fields that are nil, as passed-in opts have precedence
 */
function applyConfigs(config, compileOpts, renderOpts) {
  if (config === null) return;

  if (compileOpts.layout === null || compileOpts.layout === undefined) compileOpts.layout = config.layoutEngine;

  if (renderOpts.themeID == null) renderOpts.themeID = config.themeID;
  if (renderOpts.darkThemeID == null) renderOpts.darkThemeID = config.darkThemeID;
  if (renderOpts.sketch == null) renderOpts.sketch = config.sketch;
  if (renderOpts.pad == null) renderOpts.pad = config.pad;
  if (renderOpts.center == null) renderOpts.center = config.center;
  if (renderOpts.themeOverrides == null) renderOpts.themeOverrides = config.themeOverrides;
  if (renderOpts.darkThemeOverrides == null) renderOpts.darkThemeOverrides = config.darkThemeOverrides;
}

function applyDefaults(compileOpts, renderOpts) {
  if (compileOpts.layout == null) compileOpts.layout = 'dagre';

  if (renderOpts.themeID == null) renderOpts.themeID = d2themescatalog.NeutralDefault.id;
  if (renderOpts.sketch == null) renderOpts.sketch = false;
  if (renderOpts.sketch && (compileOpts.fontFamily == null)) compileOpts.fontFamily = d2fonts.HandDrawn;
  if (renderOpts.pad == null) renderOpts.pad = DEFAULT_PADDING;
  if (renderOpts.center == null) renderOpts.center = false;
  if (renderOpts.darkThemeID === undefined) renderOpts.darkThemeID = null;
}
