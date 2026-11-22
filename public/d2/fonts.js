// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2renderers/d2fonts package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.).
// Data only: font families, styles and sizes. The glyph tables the measuring code reads live in fonts/metrics.json
// (see textmeasure.js).
//
// Font embedding in SVGs (render stage, not ported here): d2svg.EmbedFonts writes one @font-face per
// (family, style) used by the diagram, with src: url(<data URI>). Go builds each data URI with
// Font.GetEncodedSubset(corpus): take the TTF for the font (d2renderers/d2fonts/ttf/*.ttf; HandDrawn italic is the
// regular face and HandDrawn semibold is the bold face), cut it to the unique characters of the diagram's text
// corpus (lib/font.UTF8CutFont), convert sfnt to WOFF (lib/font.Sfnt2Woff) and base64 it as
// "data:application/font-woff;base64,...". If subsetting fails it falls back to the full pre-encoded font
// (d2fonts/encoded/*.txt, already a data URI). The default JS bundle ships none of that: for Rico, reference
// cached same-origin font files instead (docs/d2-port.md, "Fonts in the SVG").

export const FONT_SIZE_XS = 13;
export const FONT_SIZE_S = 14;
export const FONT_SIZE_M = 16;
export const FONT_SIZE_L = 20;
export const FONT_SIZE_XL = 24;
export const FONT_SIZE_XXL = 28;
export const FONT_SIZE_XXXL = 32;

export const FONT_STYLE_REGULAR = 'regular';
export const FONT_STYLE_BOLD = 'bold';
export const FONT_STYLE_SEMIBOLD = 'semibold';
export const FONT_STYLE_ITALIC = 'italic';

export const SourceSansPro = 'SourceSansPro';
export const SourceCodePro = 'SourceCodePro';
export const HandDrawn = 'HandDrawn';

export const FontSizes = [FONT_SIZE_XS, FONT_SIZE_S, FONT_SIZE_M, FONT_SIZE_L, FONT_SIZE_XL, FONT_SIZE_XXL, FONT_SIZE_XXXL];

export const FontStyles = [FONT_STYLE_REGULAR, FONT_STYLE_BOLD, FONT_STYLE_SEMIBOLD, FONT_STYLE_ITALIC];

/** Go appends custom families with AddFontFamily; the default set is mutable the same way. */
export const FontFamilies = [SourceSansPro, SourceCodePro, HandDrawn];

export const D2_FONT_TO_FAMILY = { default: SourceSansPro, mono: SourceCodePro };

/** FontFamily.Font(size, style): a Font value {Family, Style, Size} (Go field names). */
export const font = (family, size, style) => ({ Family: family, Style: style, Size: size });

/** key for maps keyed by Go's Font struct value */
export const fontKey = (f) => `${f.Family}|${f.Style}|${f.Size}`;

/** the TTF behind each (family, style): HandDrawn has no italic or semibold, so it reuses regular and bold. */
export const FONT_FILES = {
  'SourceSansPro-regular': 'SourceSansPro-Regular.ttf',
  'SourceSansPro-bold': 'SourceSansPro-Bold.ttf',
  'SourceSansPro-semibold': 'SourceSansPro-Semibold.ttf',
  'SourceSansPro-italic': 'SourceSansPro-Italic.ttf',
  'SourceCodePro-regular': 'SourceCodePro-Regular.ttf',
  'SourceCodePro-bold': 'SourceCodePro-Bold.ttf',
  'SourceCodePro-semibold': 'SourceCodePro-Semibold.ttf',
  'SourceCodePro-italic': 'SourceCodePro-Italic.ttf',
  'HandDrawn-regular': 'FuzzyBubbles-Regular.ttf',
  'HandDrawn-italic': 'FuzzyBubbles-Regular.ttf',
  'HandDrawn-bold': 'FuzzyBubbles-Bold.ttf',
  'HandDrawn-semibold': 'FuzzyBubbles-Bold.ttf',
};
