// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2renderers/d2latex package (D2 v0.9.0, Copyright 2022 Terrastruct Inc.): latex_common.go, the glue around
// github.com/d2lang/mathjax-go (mathjax.Render / mathjax.Measure).
//
// The engine is not ported. D2 v0.9.0 runs mathjax-go, a native Go reimplementation of MathJax 3.2.2 (the custom component that
// D2 <= v0.7.2 ran in a JavaScript VM); here the engine is MathJax 3.2.2 itself, built into vendor/mathjax.js (tools/d2ref/mathjaxbuild)
// and loaded with a dynamic import the first time a diagram has a LaTeX label, so nothing is downloaded otherwise. The two engines give
// identical SVG on D2's own formulas but not on all input; see "LaTeX" in docs/d2-port.md for exactly where they differ.
//
// API (Go's `(string, error)` is `[string, string|null]`, the error as its text, like the rest of the port):
//   render(s)   -> [svg, err]            Go's Render: the bare <svg> element MathJax makes for the TeX source s
//   measure(s)  -> [width, height, err]  Go's Measure: the SVG's ex-based size in pixels (8 px per ex), rounded up
//   loadLatex() -> Promise               loads the engine (the sync functions throw NeedLatex until then)
// `render` and `measure` throw NeedLatex when the engine has not been loaded: the async entry points (d2lib.compile, d2svg.renderAsync)
// load it and retry.

import { parseFloat64 } from './strconv.js';

export class NeedLatex extends Error {
  constructor() { super('d2latex: the MathJax engine is not loaded (use d2lib.compile / d2svg.renderAsync, or await loadLatex() first)'); this.name = 'NeedLatex'; }
}

let engine = null;
let loading = null;

/** where the engine module is served from (default: vendor/mathjax.js next to this module) */
let engineURL = new URL('./vendor/mathjax.js', import.meta.url);
export function setEngineURL(u) { engineURL = new URL(u, import.meta.url); }

/** Registers an engine module by hand: any `{render(tex) -> svg string}` (for callers that import vendor/mathjax.js themselves). */
export function setEngine(e) { engine = e; }

export function isLoaded() { return engine !== null; }

/** Loads vendor/mathjax.js (once). */
export function loadLatex() {
  if (engine !== null) return Promise.resolve();
  return (loading ??= import(/* webpackIgnore: true */ engineURL.href).then((m) => { engine = m; }, (e) => { loading = null; throw e; }));
}

const pxPerEx = 8;

// `width="..ex" height="..ex"` of the root element (mathjax-go's svgDimensions)
const svgDimensions = /<svg[^>]+width="([0-9.]+)ex" height="([0-9.]+)ex"[^>]+>/;

/**
 * mathjax.Render for D2's options (display mode, em 16, ex 8, no font cache), wrapped by xdefer.Errorf(&err, "latex failed to parse").
 * @returns {[string, string|null]} the SVG and the error message
 */
export function render(s) {
  if (engine === null) throw new NeedLatex();
  let svg;
  try {
    svg = engine.render(s);
  } catch (e) {
    return ['', `latex failed to parse: ${e && e.message !== undefined ? e.message : e}`];
  }
  return [svg, null];
}

/**
 * mathjax.Measure: the rounded-up pixel size of the rendered SVG.
 * @returns {[number, number, string|null]} width, height, error message
 */
export function measure(s) {
  const [svg, err] = render(s);
  if (err !== null) return [0, 0, err];
  const wrap = (m) => `latex failed to parse: ${m}`;
  const matches = svgDimensions.exec(svg);
  if (matches === null) return [0, 0, wrap('mathjax-go: SVG dimensions not found')];
  const [widthEx, werr] = parseFloat64(matches[1]);
  if (werr !== null) return [0, 0, wrap(`mathjax-go: parse SVG width: ${werr}`)];
  const [heightEx, herr] = parseFloat64(matches[2]);
  if (herr !== null) return [0, 0, wrap(`mathjax-go: parse SVG height: ${herr}`)];
  return [Math.ceil(widthEx * pxPerEx), Math.ceil(heightEx * pxPerEx), null];
}
