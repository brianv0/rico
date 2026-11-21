// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2themes and d2themes/d2themescatalog packages (oss.terrastruct.com/d2 v0.7.2,
// Copyright 2022 Terrastruct Inc.). The theme data below is generated from the Go catalog
// (`go run . themes` in tools/d2ref, then tools/d2ref/genthemes.py), so every color is Go's. Themes keep Go's JSON
// shape (id, name, colors.neutrals.n1.., b1.., specialRules). Go copies Theme values; find() returns a copy.
//
// d2themes: darkest (N1) -> lightest (N7)

import * as color from './color.js';
import { formatFloat } from './svg.js';
import { ShapeSQLTable, ShapeClass } from './target.js';

export const newNeutral = () => ({ n1: '', n2: '', n3: '', n4: '', n5: '', n6: '', n7: '' });
export const newColorPalette = () => ({ neutrals: newNeutral(), b1: '', b2: '', b3: '', b4: '', b5: '', b6: '', aa2: '', aa4: '', aa5: '', ab4: '', ab5: '' });
export const newSpecialRules = () => ({ mono: false, noCornerRadius: false, outerContainerDoubleBorder: false, containerDots: false, capsLock: false, c4: false, allPaper: false });
export const newTheme = () => ({ id: 0, name: '', colors: newColorPalette(), specialRules: newSpecialRules() });

/** t.IsDark() */
export const isDark = (t) => t.id >= 200 && t.id < 300;

/** t.ApplyOverrides(overrides): mutates t; overrides is a d2target.ThemeOverrides (null fields are unset) */
export function applyOverrides(t, overrides) {
  if (overrides == null) return;

  if (overrides.b1 != null) t.colors.b1 = overrides.b1;
  if (overrides.b2 != null) t.colors.b2 = overrides.b2;
  if (overrides.b3 != null) t.colors.b3 = overrides.b3;
  if (overrides.b4 != null) t.colors.b4 = overrides.b4;
  if (overrides.b5 != null) t.colors.b5 = overrides.b5;
  if (overrides.b5 != null) t.colors.b5 = overrides.b5;
  if (overrides.b6 != null) t.colors.b6 = overrides.b6;
  if (overrides.aa2 != null) t.colors.aa2 = overrides.aa2;
  if (overrides.aa4 != null) t.colors.aa4 = overrides.aa4;
  if (overrides.aa5 != null) t.colors.aa5 = overrides.aa5;
  if (overrides.ab4 != null) t.colors.ab4 = overrides.ab4;
  if (overrides.ab5 != null) t.colors.ab5 = overrides.ab5;
  if (overrides.n1 != null) t.colors.neutrals.n1 = overrides.n1;
  if (overrides.n2 != null) t.colors.neutrals.n2 = overrides.n2;
  if (overrides.n3 != null) t.colors.neutrals.n3 = overrides.n3;
  if (overrides.n4 != null) t.colors.neutrals.n4 = overrides.n4;
  if (overrides.n5 != null) t.colors.neutrals.n5 = overrides.n5;
  if (overrides.n6 != null) t.colors.neutrals.n6 = overrides.n6;
  if (overrides.n7 != null) t.colors.neutrals.n7 = overrides.n7;
}

/*NEUTRALS*/
export function resolveThemeColor(theme, code) {
  if (!color.isThemeColor(code)) return code;
  switch (code) {
    case 'N1': return theme.colors.neutrals.n1;
    case 'N2': return theme.colors.neutrals.n2;
    case 'N3': return theme.colors.neutrals.n3;
    case 'N4': return theme.colors.neutrals.n4;
    case 'N5': return theme.colors.neutrals.n5;
    case 'N6': return theme.colors.neutrals.n6;
    case 'N7': return theme.colors.neutrals.n7;
    case 'B1': return theme.colors.b1;
    case 'B2': return theme.colors.b2;
    case 'B3': return theme.colors.b3;
    case 'B4': return theme.colors.b4;
    case 'B5': return theme.colors.b5;
    case 'B6': return theme.colors.b6;
    case 'AA2': return theme.colors.aa2;
    case 'AA4': return theme.colors.aa4;
    case 'AA5': return theme.colors.aa5;
    case 'AB4': return theme.colors.ab4;
    case 'AB5': return theme.colors.ab5;
    default: return '';
  }
}

// ---- common.go ----

/** returns [fill, stroke] */
export function shapeTheme(shape) {
  if (shape.type === ShapeSQLTable || shape.type === ShapeClass) {
    // Fill is used for header fill in these types
    // This fill property is just background of rows
    // Stroke (border) of these shapes should match the header fill
    return [shape.stroke, shape.fill];
  }
  return [shape.fill, shape.stroke];
}

// ---- element.go ----

const MaxFloat64 = Number.MAX_VALUE;

/**
 * ThemableElement is a helper class for creating new XML elements.
 * This should be preferred over formatting and must be used
 * whenever Fill, Stroke, BackgroundColor or Color contains a color from a theme.
 * i.e. N[1-7] | B[1-6] | AA[245] | AB[45]
 */
export class ThemableElement {
  constructor(tag, inlineTheme) {
    this.tag = tag;

    this.X = MaxFloat64;
    this.X1 = MaxFloat64;
    this.X2 = MaxFloat64;
    this.Y = MaxFloat64;
    this.Y1 = MaxFloat64;
    this.Y2 = MaxFloat64;
    this.Width = MaxFloat64;
    this.Height = MaxFloat64;
    this.R = MaxFloat64;
    this.Rx = MaxFloat64;
    this.Ry = MaxFloat64;
    this.Cx = MaxFloat64;
    this.Cy = MaxFloat64;

    this.D = '';
    this.Mask = '';
    this.Points = '';
    this.Transform = '';
    this.Href = '';
    this.Xmlns = tag === 'div' ? 'http://www.w3.org/1999/xhtml' : '';

    this.Fill = color.Empty;
    this.Stroke = color.Empty;
    this.StrokeDashArray = '';
    this.BackgroundColor = color.Empty;
    this.Color = color.Empty;

    this.ClassName = '';
    this.Style = '';
    this.Attributes = '';

    this.Content = '';
    this.ClipPath = '';

    this.FillPattern = '';

    this.inlineTheme = inlineTheme ?? null;
  }

  copy() {
    return Object.assign(Object.create(ThemableElement.prototype), this);
  }

  setTranslate(x, y) { this.Transform = `translate(${formatFloat(x)} ${formatFloat(y)})`; }

  setMaskUrl(url) { this.Mask = `url(#${url})`; }

  render() {
    const el = this;
    const f = formatFloat;
    let out = '<' + el.tag;

    // href has to be at the top for the img bundler to detect <image> tags correctly
    if (utf8Len(el.Href) > 0) out += ` href="${el.Href}"`;
    if (el.X !== MaxFloat64) out += ` x="${f(el.X)}"`;
    if (el.X1 !== MaxFloat64) out += ` x1="${f(el.X1)}"`;
    if (el.X2 !== MaxFloat64) out += ` x2="${f(el.X2)}"`;
    if (el.Y !== MaxFloat64) out += ` y="${f(el.Y)}"`;
    if (el.Y1 !== MaxFloat64) out += ` y1="${f(el.Y1)}"`;
    if (el.Y2 !== MaxFloat64) out += ` y2="${f(el.Y2)}"`;
    if (el.Width !== MaxFloat64) out += ` width="${f(el.Width)}"`;
    if (el.Height !== MaxFloat64) out += ` height="${f(el.Height)}"`;
    if (el.R !== MaxFloat64) out += ` r="${f(el.R)}"`;
    if (el.Rx !== MaxFloat64) out += ` rx="${f(calculateAxisRadius(el.Rx, el.Width, el.Height))}"`;
    if (el.Ry !== MaxFloat64) out += ` ry="${f(calculateAxisRadius(el.Ry, el.Width, el.Height))}"`;
    if (el.Cx !== MaxFloat64) out += ` cx="${f(el.Cx)}"`;
    if (el.Cy !== MaxFloat64) out += ` cy="${f(el.Cy)}"`;
    if (el.StrokeDashArray !== '') out += ` stroke-dasharray="${el.StrokeDashArray}"`;

    if (el.D.length > 0) out += ` d="${el.D}"`;
    if (el.Mask.length > 0) out += ` mask="${el.Mask}"`;
    if (el.Points.length > 0) out += ` points="${el.Points}"`;
    if (el.Transform.length > 0) out += ` transform="${el.Transform}"`;
    if (el.Xmlns.length > 0) out += ` xmlns="${el.Xmlns}"`;

    let cls = el.ClassName;
    const style = el.Style;

    // Add class {property}-{theme color} if the color is from a theme, set the property otherwise
    if (color.isThemeColor(el.Stroke)) {
      cls += ` stroke-${el.Stroke}`;
      if (el.inlineTheme != null) out += ` stroke="${resolveThemeColor(el.inlineTheme, el.Stroke)}"`;
    } else if (el.Stroke.length > 0) {
      if (color.isGradient(el.Stroke)) el.Stroke = `url('#${color.uniqueGradientID(el.Stroke)}')`;
      out += ` stroke="${el.Stroke}"`;
    }
    if (color.isThemeColor(el.Fill)) {
      cls += ` fill-${el.Fill}`;
      if (el.inlineTheme != null) out += ` fill="${resolveThemeColor(el.inlineTheme, el.Fill)}"`;
    } else if (el.Fill.length > 0) {
      if (color.isGradient(el.Fill)) el.Fill = `url('#${color.uniqueGradientID(el.Fill)}')`;
      out += ` fill="${el.Fill}"`;
    }
    if (color.isThemeColor(el.BackgroundColor)) {
      cls += ` background-color-${el.BackgroundColor}`;
      if (el.inlineTheme != null) out += ` background-color="${resolveThemeColor(el.inlineTheme, el.BackgroundColor)}"`;
    } else if (el.BackgroundColor.length > 0) {
      out += ` background-color="${el.BackgroundColor}"`;
    }
    if (color.isThemeColor(el.Color)) {
      cls += ` color-${el.Color}`;
      if (el.inlineTheme != null) out += ` color="${resolveThemeColor(el.inlineTheme, el.Color)}"`;
    } else if (el.Color.length > 0) {
      out += ` color="${el.Color}"`;
    }

    if (cls.length > 0) out += ` class="${cls}"`;
    if (style.length > 0) out += ` style="${style}"`;
    if (el.Attributes.length > 0) out += ` ${el.Attributes}`;

    if (el.ClipPath.length > 0) out += ` clip-path="url(#${el.ClipPath})"`;

    if (el.Content.length > 0) return `${out}>${el.Content}</${el.tag}>`;

    out += ' />';
    if (el.FillPattern !== '' && el.FillPattern !== 'none') {
      const patternEl = el.copy();
      patternEl.Fill = '';
      patternEl.Stroke = '';
      patternEl.BackgroundColor = '';
      patternEl.Color = '';
      patternEl.ClassName = `${el.FillPattern}-overlay`;
      patternEl.FillPattern = '';
      out += patternEl.render();
    }
    return out;
  }
}
export const newThemableElement = (tag, inlineTheme) => new ThemableElement(tag, inlineTheme);

// Go's len(string) is a byte length; only emptiness is tested above, which is the same for UTF-16 length.
const utf8Len = (s) => s.length;

function calculateAxisRadius(borderRadius, width, height) {
  const minimumSideSize = Math.min(width, height);
  const maximumBorderRadiusValue = minimumSideSize / 2.0;
  return Math.min(borderRadius, maximumBorderRadiusValue);
}

// ---- pattern_overlay.go ----

export class PatternOverlay {
  constructor(el, pattern) { this.el = el; this.pattern = pattern; }
  render() {
    const el = this.el.copy();
    el.Fill = '';
    el.ClassName = `${this.pattern}-overlay`;
    return el.render();
  }
}
export const newPatternOverlay = (el, pattern) => new PatternOverlay(el, pattern);

// ---- sketch_overlay.go ----

export class ThemableSketchOverlay {
  constructor(el, fill) { this.el = el; this.fill = fill; }
  /** WARNING: Do not reuse the element afterwards as this function changes the ClassName property */
  render() {
    if (color.isThemeColor(this.fill)) {
      this.el.ClassName += ` sketch-overlay-${this.fill}`; // e.g. sketch-overlay-B3
    } else {
      const lc = color.luminanceCategory(this.fill);
      this.el.ClassName += ` sketch-overlay-${lc}`; // e.g. sketch-overlay-dark
    }
    return this.el.render();
  }
}
export const newThemableSketchOverlay = (el, fill) => new ThemableSketchOverlay(el, fill);

// ---- d2themescatalog ----

/*THEMES*/
export const LightCatalog = [/*LIGHT*/];

export const DarkCatalog = [/*DARK*/];

/** Whether d2themescatalog.Find(id) finds a theme (d2ir uses this). */
export const themeExists = (id) => LightCatalog.some((t) => t.id === id) || DarkCatalog.some((t) => t.id === id);

const clone = (t) => JSON.parse(JSON.stringify(t));

/** Find returns a copy of the theme with the given id, or the zero Theme */
export function find(id) {
  for (const theme of LightCatalog) {
    if (theme.id === id) return clone(theme);
  }
  for (const theme of DarkCatalog) {
    if (theme.id === id) return clone(theme);
  }
  return newTheme();
}

export function CLIString() {
  let s = '';
  s += 'Light:\n';
  for (const t of LightCatalog) s += `- ${t.name}: ${t.id}\n`;
  s += 'Dark:\n';
  for (const t of DarkCatalog) s += `- ${t.name}: ${t.id}\n`;
  return s;
}
