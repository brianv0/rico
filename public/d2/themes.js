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
import { goFixed } from './gomath.js';
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

export const CoolNeutral = {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"};
export const DarkMauveNeutral = {"n1": "#CDD6F4", "n2": "#BAC2DE", "n3": "#A6ADC8", "n4": "#585B70", "n5": "#45475A", "n6": "#313244", "n7": "#1E1E2E"};
export const DarkNeutral = {"n1": "#F4F6FA", "n2": "#BBBEC9", "n3": "#868A96", "n4": "#676D7D", "n5": "#3A3D49", "n6": "#191C28", "n7": "#000410"};
export const WarmNeutral = {"n1": "#170206", "n2": "#535152", "n3": "#787777", "n4": "#CCCACA", "n5": "#DFDCDC", "n6": "#ECEBEB", "n7": "#FFFFFF"};

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

export const NeutralDefault = {"id": 0, "name": "Neutral Default", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#0D32B2", "b2": "#0D32B2", "b3": "#E3E9FD", "b4": "#E3E9FD", "b5": "#EDF0FD", "b6": "#F7F8FE", "aa2": "#4A6FF3", "aa4": "#EDF0FD", "aa5": "#F7F8FE", "ab4": "#EDF0FD", "ab5": "#F7F8FE"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const NeutralGrey = {"id": 1, "name": "Neutral Grey", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#0A0F25", "b2": "#676C7E", "b3": "#9499AB", "b4": "#CFD2DD", "b5": "#DEE1EB", "b6": "#EEF1F8", "aa2": "#676C7E", "aa4": "#CFD2DD", "aa5": "#DEE1EB", "ab4": "#CFD2DD", "ab5": "#DEE1EB"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const FlagshipTerrastruct = {"id": 3, "name": "Flagship Terrastruct", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#000E3D", "b2": "#234CDA", "b3": "#6B8AFB", "b4": "#A6B8F8", "b5": "#D2DBFD", "b6": "#E7EAFF", "aa2": "#5829DC", "aa4": "#B4AEF8", "aa5": "#E4DBFF", "ab4": "#7FDBF8", "ab5": "#C3F0FF"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const CoolClassics = {"id": 4, "name": "Cool Classics", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#000536", "b2": "#0F66B7", "b3": "#4393DD", "b4": "#87BFF3", "b5": "#BCDDFB", "b6": "#E5F3FF", "aa2": "#076F6F", "aa4": "#77DEDE", "aa5": "#C3F8F8", "ab4": "#C1A2F3", "ab5": "#DACEFB"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const MixedBerryBlue = {"id": 5, "name": "Mixed Berry Blue", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#000536", "b2": "#0F66B7", "b3": "#4393DD", "b4": "#87BFF3", "b5": "#BCDDFB", "b6": "#E5F3FF", "aa2": "#7639C5", "aa4": "#C1A2F3", "aa5": "#DACEFB", "ab4": "#EA99C6", "ab5": "#FFDEF1"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const GrapeSoda = {"id": 6, "name": "Grape Soda", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#170034", "b2": "#7639C5", "b3": "#8F70D1", "b4": "#C1A2F3", "b5": "#DACEFB", "b6": "#F2EDFF", "aa2": "#0F66B7", "aa4": "#87BFF3", "aa5": "#BCDDFB", "ab4": "#EA99C6", "ab5": "#FFDAEF"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const Aubergine = {"id": 7, "name": "Aubergine", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#170034", "b2": "#7639C5", "b3": "#8F70D1", "b4": "#D0B9F5", "b5": "#E7DEFF", "b6": "#F4F0FF", "aa2": "#0F66B7", "aa4": "#87BFF3", "aa5": "#BCDDFB", "ab4": "#92E3E3", "ab5": "#D7F5F5"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const ColorblindClear = {"id": 8, "name": "Colorblind Clear", "colors": {"neutrals": {"n1": "#0A0F25", "n2": "#676C7E", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#DEE1EB", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#010E31", "b2": "#173688", "b3": "#5679D4", "b4": "#84A1EC", "b5": "#C8D6F9", "b6": "#E5EDFF", "aa2": "#048E63", "aa4": "#A6E2D0", "aa5": "#CAF2E6", "ab4": "#FFDA90", "ab5": "#FFF0D1"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const VanillaNitroCola = {"id": 100, "name": "Vanilla Nitro Cola", "colors": {"neutrals": {"n1": "#170206", "n2": "#535152", "n3": "#787777", "n4": "#CCCACA", "n5": "#DFDCDC", "n6": "#ECEBEB", "n7": "#FFFFFF"}, "b1": "#1E1303", "b2": "#55452F", "b3": "#9A876C", "b4": "#C9B9A1", "b5": "#E9DBCA", "b6": "#FAF1E6", "aa2": "#D35F0A", "aa4": "#FABA8A", "aa5": "#FFE0C7", "ab4": "#84A1EC", "ab5": "#D5E0FD"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const OrangeCreamsicle = {"id": 101, "name": "Orange Creamsicle", "colors": {"neutrals": {"n1": "#170206", "n2": "#535152", "n3": "#787777", "n4": "#CCCACA", "n5": "#DFDCDC", "n6": "#ECEBEB", "n7": "#FFFFFF"}, "b1": "#311602", "b2": "#D35F0A", "b3": "#F18F47", "b4": "#FABA8A", "b5": "#FFE0C7", "b6": "#FFF6EF", "aa2": "#13A477", "aa4": "#A6E2D0", "aa5": "#CAF2E6", "ab4": "#FEEC8C", "ab5": "#FFF8CF"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const ShirleyTemple = {"id": 102, "name": "Shirley Temple", "colors": {"neutrals": {"n1": "#170206", "n2": "#535152", "n3": "#787777", "n4": "#CCCACA", "n5": "#DFDCDC", "n6": "#ECEBEB", "n7": "#FFFFFF"}, "b1": "#31021D", "b2": "#9B1A48", "b3": "#D2517F", "b4": "#EA99B6", "b5": "#FFDAE7", "b6": "#FCEDF2", "aa2": "#D35F0A", "aa4": "#FABA8A", "aa5": "#FFE0C7", "ab4": "#FFE767", "ab5": "#FFF2AA"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const EarthTones = {"id": 103, "name": "Earth Tones", "colors": {"neutrals": {"n1": "#170206", "n2": "#535152", "n3": "#787777", "n4": "#CCCACA", "n5": "#DFDCDC", "n6": "#ECEBEB", "n7": "#FFFFFF"}, "b1": "#1E1303", "b2": "#55452F", "b3": "#9A876C", "b4": "#C9B9A1", "b5": "#E9DBCA", "b6": "#FAF1E6", "aa2": "#D35F0A", "aa4": "#FABA8A", "aa5": "#FFE0C7", "ab4": "#FFE767", "ab5": "#FFF2AA"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const EvergladeGreen = {"id": 104, "name": "Everglade Green", "colors": {"neutrals": {"n1": "#170206", "n2": "#535152", "n3": "#787777", "n4": "#CCCACA", "n5": "#DFDCDC", "n6": "#ECEBEB", "n7": "#FFFFFF"}, "b1": "#023324", "b2": "#048E63", "b3": "#49BC99", "b4": "#A6E2D0", "b5": "#CAF2E6", "b6": "#EBFDF7", "aa2": "#D35F0A", "aa4": "#FABA8A", "aa5": "#FFE0C7", "ab4": "#C9B9A1", "ab5": "#E9DBCA"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const ButteredToast = {"id": 105, "name": "Buttered Toast", "colors": {"neutrals": {"n1": "#170206", "n2": "#535152", "n3": "#787777", "n4": "#CCCACA", "n5": "#DFDCDC", "n6": "#ECEBEB", "n7": "#FFFFFF"}, "b1": "#312102", "b2": "#DF9C18", "b3": "#FDC659", "b4": "#FFDA90", "b5": "#FFF0D1", "b6": "#FFF7E7", "aa2": "#55452F", "aa4": "#C9B9A1", "aa5": "#E9DBCA", "ab4": "#FABA8A", "ab5": "#FFE0C7"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const Terminal = {"id": 300, "name": "Terminal", "colors": {"neutrals": {"n1": "#000410", "n2": "#0000B8", "n3": "#9499AB", "n4": "#CFD2DD", "n5": "#C3DEF3", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#000410", "b2": "#0000E4", "b3": "#5AA4DC", "b4": "#E7E9EE", "b5": "#F5F6F9", "b6": "#FFFFFF", "aa2": "#008566", "aa4": "#45BBA5", "aa5": "#7ACCBD", "ab4": "#F1C759", "ab5": "#F9E088"}, "specialRules": {"mono": true, "noCornerRadius": true, "outerContainerDoubleBorder": true, "containerDots": true, "capsLock": true, "c4": false, "allPaper": false}};

export const TerminalGrayscale = {"id": 301, "name": "Terminal Grayscale", "colors": {"neutrals": {"n1": "#000410", "n2": "#000410", "n3": "#9499AB", "n4": "#FFFFFF", "n5": "#FFFFFF", "n6": "#EEF1F8", "n7": "#FFFFFF"}, "b1": "#000410", "b2": "#000410", "b3": "#FFFFFF", "b4": "#E7E9EE", "b5": "#F5F6F9", "b6": "#FFFFFF", "aa2": "#6D7284", "aa4": "#F5F6F9", "aa5": "#FFFFFF", "ab4": "#F5F6F9", "ab5": "#FFFFFF"}, "specialRules": {"mono": true, "noCornerRadius": true, "outerContainerDoubleBorder": true, "containerDots": true, "capsLock": true, "c4": false, "allPaper": false}};

export const Origami = {"id": 302, "name": "Origami", "colors": {"neutrals": {"n1": "#170206", "n2": "#6F0019", "n3": "#FFFFFF", "n4": "#E07088", "n5": "#D2B098", "n6": "#FFFFFF", "n7": "#FFFFFF"}, "b1": "#170206", "b2": "#A62543", "b3": "#E07088", "b4": "#F3E0D2", "b5": "#FAF1E6", "b6": "#FFFBF8", "aa2": "#0A4EA6", "aa4": "#3182CD", "aa5": "#68A8E4", "ab4": "#E07088", "ab5": "#F19CAE"}, "specialRules": {"mono": false, "noCornerRadius": true, "outerContainerDoubleBorder": true, "containerDots": false, "capsLock": false, "c4": false, "allPaper": true}};

export const C4 = {"id": 303, "name": "C4", "colors": {"neutrals": {"n1": "#0f5eaa", "n2": "#707070", "n3": "#FFFFFF", "n4": "#073b6f", "n5": "#999999", "n6": "#FFFFFF", "n7": "#FFFFFF"}, "b1": "#073b6f", "b2": "#08427b", "b3": "#3c7fc0", "b4": "#438dd5", "b5": "#8a8a8a", "b6": "#999999", "aa2": "#0f5eaa", "aa4": "#707070", "aa5": "#f5f5f5", "ab4": "#e1e1e1", "ab5": "#f0f0f0"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": true, "allPaper": false}};

export const DarkMauve = {"id": 200, "name": "Dark Mauve", "colors": {"neutrals": {"n1": "#CDD6F4", "n2": "#BAC2DE", "n3": "#A6ADC8", "n4": "#585B70", "n5": "#45475A", "n6": "#313244", "n7": "#1E1E2E"}, "b1": "#CBA6f7", "b2": "#CBA6f7", "b3": "#6C7086", "b4": "#585B70", "b5": "#45475A", "b6": "#313244", "aa2": "#f38BA8", "aa4": "#45475A", "aa5": "#313244", "ab4": "#45475A", "ab5": "#313244"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};

export const DarkFlagshipTerrastruct = {"id": 201, "name": "Dark Flagship Terrastruct", "colors": {"neutrals": {"n1": "#F4F6FA", "n2": "#BBBEC9", "n3": "#868A96", "n4": "#676D7D", "n5": "#3A3D49", "n6": "#191C28", "n7": "#000410"}, "b1": "#F4F6FA", "b2": "#6B8AFB", "b3": "#3733E9", "b4": "#070B67", "b5": "#0B1197", "b6": "#3733E9", "aa2": "#8B5DEE", "aa4": "#4918B1", "aa5": "#7240DD", "ab4": "#00607C", "ab5": "#01799D"}, "specialRules": {"mono": false, "noCornerRadius": false, "outerContainerDoubleBorder": false, "containerDots": false, "capsLock": false, "c4": false, "allPaper": false}};


export const LightCatalog = [NeutralDefault, NeutralGrey, FlagshipTerrastruct, CoolClassics, MixedBerryBlue, GrapeSoda, Aubergine, ColorblindClear, VanillaNitroCola, OrangeCreamsicle, ShirleyTemple, EarthTones, EvergladeGreen, ButteredToast, Terminal, TerminalGrayscale, Origami, C4];

export const DarkCatalog = [DarkMauve, DarkFlagshipTerrastruct];

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
