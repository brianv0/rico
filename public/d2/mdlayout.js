// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the native Markdown layout of D2 v0.9.0 (github.com/d2lang/d2, Copyright 2022 Terrastruct Inc.):
// lib/textmeasure/markdown.go (the box model: measureMarkdownNode in its legacy and CSS line box flavours,
// normalizeMarkdownWhitespaceTree), markdown_svg.go (LayoutMarkdown, the painter that turns the HTML tree of a Markdown label
// into positioned text/rect/line primitives, MarkdownLayout.SVG) and the Ruler methods they call (measureFontAdvance,
// cssFontBoxMetrics, cssNormalLineHeight) on top of textmeasure.js. The Markdown renders to HTML with markdown-it (registered in
// textmeasure.js) and the tree comes from htmlparse.js.
//
// Scope: text made of U+0020..U+007E, U+00A1..U+00FF (and tab/newline in code blocks), i.e. what the bundled fonts cover and what
// linebreak.js (uniseg's line breaking) supports. Anything else (CJK, emoji, combining marks, symbols) goes through D2's browser
// fallback emulation (scaleUnicodeCSS, fontfallback, ...) that is not ported: `layoutMarkdown` throws `Deferred` for it.

import * as d2fonts from './fonts.js';
import { parseBody } from './htmlparse.js';
import { renderMarkdown, MarkdownLineHeight, headerToFontSize } from './textmeasure.js';
import { Graphemes } from './uniseg.js';
import { firstLineSegmentInString } from './linebreak.js';
import { escapeText } from './svg.js';
import { goRound, goFixed } from './gomath.js';
import { utf8Len } from './ast.js';
import { Deferred } from './d2svg.js';

const TAB_SIZE = 4;

// these are css values from github-markdown.css so we can accurately compute the rendered dimensions
const PaddingLeft_ul_ol_em = 2.;
const MarginBottom_ul = 16.;

const MarginTop_li_p = 16.;
const MarginTop_li_em = 0.25;
const MarginBottom_p = 16.;

const LineHeight_h = 1.25;
const MarginTop_h = 24;
const MarginBottom_h = 16;
const PaddingBottom_h1_h2_em = 0.3;
const BorderBottom_h1_h2 = 1;

const Height_hr_em = 0.25;
const MarginTopBottom_hr = 24;

const Padding_pre = 16;
const MarginBottom_pre = 16;
const MarginBottom_table = 16;
const LineHeight_pre = 1.45;
const FontSize_pre_code_em = 0.85;

const PaddingTopBottom_code_em = 0.2;
const PaddingLeftRight_code_em = 0.4;
const PaddingLeftRight_heading_code_em = 0.2;

const PaddingLR_blockquote_em = 1.;
const MarginBottom_blockquote = 16;
const BorderLeft_blockquote_em = 0.25;

const h1_em = 2.;
const h2_em = 1.5;
const h3_em = 1.25;
const h4_em = 1.;
const h5_em = 0.875;
const h6_em = 0.85;

// MarkdownColorRole / MarkdownFontRole / kinds are their Go string values
const ColorForeground = 'foreground';
const ColorForegroundStroke = 'foreground-stroke';
const ColorMuted = 'muted';
const ColorMutedStroke = 'muted-stroke';
const ColorAccent = 'accent';
const ColorBorder = 'border';
const ColorBorderMuted = 'border-muted';
const ColorCanvas = 'canvas';
const ColorCanvasSubtle = 'canvas-subtle';
const ColorNeutralMuted = 'neutral-muted';

const goMax = (a, b) => (a > b ? a : b);
const trimSpace = (s) => s.replace(/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');

export function headerToFontScale(header) {
  switch (header) {
    case 'h1': return h1_em;
    case 'h2': return h2_em;
    case 'h3': return h3_em;
    case 'h4': return h4_em;
    case 'h5': return h5_em;
    case 'h6': return h6_em;
    default: return 1;
  }
}

const isMarkdownHeading = (e) => e === 'h1' || e === 'h2' || e === 'h3' || e === 'h4' || e === 'h5' || e === 'h6';

function hasMarkdownHeadingAncestor(n) {
  for (let ancestor = n.parent; ancestor != null; ancestor = ancestor.parent) {
    if (ancestor.type === 'element' && isMarkdownHeading(ancestor.data)) return true;
  }
  return false;
}

// ---- tree helpers (html.Node: Type/Data/Parent/FirstChild/LastChild/PrevSibling/NextSibling/Attr) ----

function nodeAttr(n, name) {
  const attrs = n.attrs ?? '';
  const re = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(attrs)) !== null) {
    if (m[1].toLowerCase() === name) return decodeAttr(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return '';
}
const decodeAttr = (v) => v.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
});

function hasPrev(n) {
  if (n.prevSibling == null) return false;
  if (trimSpace(n.prevSibling.data) === '') return hasPrev(n.prevSibling);
  return true;
}

function hasNext(n) {
  if (n.nextSibling == null) return false;
  // skip over empty text nodes
  if (trimSpace(n.nextSibling.data) === '') return hasNext(n.nextSibling);
  return true;
}

function getPrev(n) {
  if (n == null) return null;
  if (trimSpace(n.data) === '') {
    const next = getNext(n.prevSibling);
    if (next != null) return next;
  }
  return n;
}

function getNext(n) {
  if (n == null) return null;
  if (trimSpace(n.data) === '') {
    const next = getNext(n.nextSibling);
    if (next != null) return next;
  }
  return n;
}

function isBlockElement(elType) {
  switch (elType) {
    case 'blockquote': case 'div': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': case 'hr':
    case 'li': case 'ol': case 'p': case 'pre': case 'ul':
    case 'table': case 'thead': case 'tbody': case 'tr': case 'td': case 'th':
      return true;
    default:
      return false;
  }
}

function hasAncestorElement(n, elType) {
  if (n.parent == null) return false;
  if (n.parent.type === 'element' && n.parent.data === elType) return true;
  return hasAncestorElement(n.parent, elType);
}

const newBlock = () => ({ width: 0, height: 0, marginTop: 0, marginBottom: 0, extraData: null });
const blockIsNotEmpty = (b) => b != null && !(b.width === 0 && b.height === 0 && b.marginTop === 0 && b.marginBottom === 0 && b.extraData == null);

const isCollapsibleMarkdownWhitespace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * normalizeMarkdownWhitespaceTree applies CSS white-space: normal across inline element boundaries. Preformatted code is the
 * sole Markdown context that retains source whitespace.
 */
function normalizeMarkdownWhitespaceTree(root) {
  const outputs = new Map();
  const outputFor = (n) => { if (!outputs.has(n)) outputs.set(n, { s: '' }); return outputs.get(n); };
  const flushPending = (state) => {
    if (state.pending !== null && !state.atLineStart) state.pending.s += ' ';
    state.pending = null;
  };
  let normalizeBlock;
  const walkInline = (n, state) => {
    if (n.type === 'text') {
      const output = outputFor(n);
      for (const r of n.data) {
        if (isCollapsibleMarkdownWhitespace(r)) {
          if (state.pending === null) state.pending = output;
          continue;
        }
        flushPending(state);
        output.s += r;
        state.atLineStart = false;
      }
    } else if (n.type === 'element') {
      if (n.data === 'br') {
        state.pending = null;
        state.atLineStart = true;
      } else if (isBlockElement(n.data)) {
        state.pending = null;
        normalizeBlock(n);
        state.atLineStart = true;
      } else if (n.data === 'img') {
        // Markdown images are outside native SVG's supported subset. Ignore the node and let whitespace collapse across it.
      } else {
        for (let child = n.firstChild; child != null; child = child.nextSibling) walkInline(child, state);
      }
    }
  };
  normalizeBlock = (n) => {
    if (n.type === 'element' && n.data === 'pre') return;
    const state = { atLineStart: true, pending: null };
    for (let child = n.firstChild; child != null; child = child.nextSibling) walkInline(child, state);
    // A pending space at the end of a block or line is not painted.
    state.pending = null;
  };
  normalizeBlock(root);
  for (const [node, output] of outputs) node.data = output.s;
}

// ---- the Ruler methods markdown.go and markdown_svg.go use (textmeasure.go, with x/image's sfnt rounding) ----

const sizeless = (font) => d2fonts.font(font.Family, 0, font.Style);

function ttfOf(ruler, font) {
  const ttf = ruler.ttfs.get(d2fonts.fontKey(sizeless(font)));
  return ttf ?? null;
}

/** measureFontAdvance: the cursor advance of s (font.MeasureString of an x/image face), or null when a glyph is missing */
function measureFontAdvance(ruler, font, s) {
  const ttf = ttfOf(ruler, font);
  if (ttf === null) return null;
  for (const ch of s) {
    const r = ch.codePointAt(0);
    // GlyphIndex err != nil || (index == 0 && r != 0)
    const idx = ttf.index(r);
    if ((idx === undefined || idx === 0) && r !== 0) return null;
  }
  const ppem = Math.trunc(0.5 + font.Size * 64);
  let advance = 0;
  let prevC = -1;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (prevC >= 0) advance += ttf.kernAt(ppem, ttf.index(prevC), ttf.index(c));
    const idx = ttf.index(c);
    advance += ttf.scale(ttf.glyphs[idx].a * ppem);
    prevC = c;
  }
  return advance / 64;
}

/** [ascent, descent] of the integer CSS font box, or null */
function cssFontBoxMetrics(ruler, font, size) {
  const ttf = ttfOf(ruler, font);
  if (ttf === null) return null;
  const ppem = goRound(size * 64);
  const ascent = ttf.scale(ttf.ascent * ppem);
  const descent = -ttf.scale(ttf.descent * ppem);
  return [goRound(ascent / 64), goRound(descent / 64)];
}

function cssNormalLineHeight(ruler, font, size) {
  const ttf = ttfOf(ruler, font);
  if (ttf === null) return null;
  const ppem = goRound(size * 64);
  const height = ttf.scale((ttf.ascent - ttf.descent) * ppem); // hhea lineGap is 0 in all bundled fonts
  return goRound(height / 64);
}

/** the characters this port handles (see the file header) */
function checkSupportedText(ruler, s) {
  for (const ch of s) {
    const r = ch.codePointAt(0);
    if (r === 0x0a || r === 0x09 || (r >= 0x20 && r <= 0x7e) || (r >= 0xa1 && r <= 0xff)) continue;
    throw new Deferred('markdown-unicode');
  }
}

// ---- measureMarkdownNode ----

const isASCII = (s) => /^[\x00-\x7f]*$/.test(s);

const markdownPreLineCount = (text) => {
  if (text === '') return 0;
  let count = (text.match(/\n/g) ?? []).length + 1;
  if (text.endsWith('\n')) count--;
  return count;
};

function markdownNodeText(n) {
  let out = '';
  const walk = (node) => {
    if (node.type === 'text') { out += node.data; return; }
    if (node.type === 'element' && node.data === 'br') { out += '\n'; return; }
    for (let child = node.firstChild; child != null; child = child.nextSibling) walk(child);
  };
  walk(n);
  return out;
}

function mergeColumnWidths(existing, rows) {
  for (const rowWidths of rows) {
    rowWidths.forEach((width, i) => {
      if (i >= existing.length) existing.push(width);
      else existing[i] = goMax(existing[i], width);
    });
  }
  return existing;
}

/** Ruler.measureMarkdownNode: the box of n (legacy D2 dimensions, or CSS line boxes with cssLineBoxes) */
function measureMarkdownNode(ruler, depth, n, fontFamily, monoFontFamily, fontSize, fontScale, fontStyle, bold, italic, cssLineBoxes) {
  if (fontFamily == null) fontFamily = d2fonts.SourceSansPro;
  const font = d2fonts.font(fontFamily, fontSize, fontStyle);

  let parentElementType = '';
  if (n.parent != null && n.parent.type === 'element') parentElementType = n.parent.data;

  if (n.type === 'text') {
    if (!cssLineBoxes && n.data.replace(/^[\n\t\b]+|[\n\t\b]+$/g, '') === '') return newBlock();
    let str = n.data;
    const isCode = parentElementType === 'pre' || parentElementType === 'code';
    const isHeadingCode = parentElementType === 'code' && hasMarkdownHeadingAncestor(n);
    let spaceWidths = 0.;

    if (!isCode) {
      let spaceWidth = ruler.spaceWidth(font) * fontScale;
      if (cssLineBoxes) {
        const advance = measureFontAdvance(ruler, font, ' ');
        if (advance !== null) spaceWidth = advance * fontScale;
      }
      if (cssLineBoxes) {
        str = renderableMarkdownText(n);
        if (str === '') return newBlock();
        // MeasurePrecise omits edge whitespace, so account for it.
        if (str.startsWith(' ')) {
          str = str.slice(1);
          spaceWidths += spaceWidth;
        }
        if (str.endsWith(' ')) {
          str = str.slice(0, -1);
          spaceWidths += spaceWidth;
        }
      } else {
        str = str.replaceAll('\n', ' ');
        str = str.replaceAll('\t', ' ');
        if (str.startsWith(' ')) {
          str = str.slice(1);
          if (hasPrev(n)) spaceWidths += spaceWidth;
        }
        if (str.endsWith(' ')) {
          str = str.slice(0, -1);
          if (hasNext(n)) spaceWidths += spaceWidth;
        }
      }
    } else if (str === '') {
      return newBlock();
    }

    const originalLineHeight = ruler.LineHeightFactor;
    if (parentElementType === 'pre') ruler.LineHeightFactor = LineHeight_pre;
    try {
      let [w, h] = ruler.measurePrecise(font, str);
      if (cssLineBoxes) {
        // CSS lays out adjacent inline runs by cursor advance, not glyph ink bounds.
        const advance = measureFontAdvance(ruler, font, str);
        if (advance !== null) w = advance;
        else if (!isASCII(str)) throw new Deferred('markdown-unicode'); // else scaleUnicodeCSS leaves the measured width
      } else if (!isCode) {
        // scaleUnicodeLegacy: for the supported characters every grapheme has width 1 and the measurement is unchanged
      }
      w *= fontScale;
      h *= fontScale;
      if (isCode && (!isHeadingCode || !cssLineBoxes)) {
        w *= FontSize_pre_code_em;
        h *= FontSize_pre_code_em;
      }
      return { width: w + spaceWidths, height: h, marginTop: 0, marginBottom: 0, extraData: null };
    } finally {
      ruler.LineHeightFactor = originalLineHeight;
    }
  }

  if (n.type !== 'element') return newBlock();

  let isCode = false;
  const originalLineHeight = ruler.LineHeightFactor;
  try {
    switch (n.data) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (cssLineBoxes) fontScale *= headerToFontScale(n.data);
        else fontSize = headerToFontSize(fontSize, n.data);
        fontStyle = d2fonts.FONT_STYLE_SEMIBOLD;
        bold = false;
        ruler.LineHeightFactor = LineHeight_h;
        break;
      case 'em':
        fontStyle = d2fonts.FONT_STYLE_ITALIC;
        italic = true;
        break;
      case 'b': case 'strong':
        fontStyle = d2fonts.FONT_STYLE_BOLD;
        bold = true;
        break;
      case 'th':
        fontStyle = d2fonts.FONT_STYLE_SEMIBOLD;
        bold = true;
        break;
      case 'pre': case 'code':
        fontFamily = monoFontFamily != null ? monoFontFamily : d2fonts.SourceCodePro;
        // .md code selects the regular mono family, while CSS weight/style continue to inherit from surrounding strong/em elements.
        fontStyle = d2fonts.FONT_STYLE_REGULAR;
        isCode = true;
        break;
    }

    const block = newBlock();
    const cssFontSize = fontSize * fontScale;
    const lineHeightPx = cssFontSize * ruler.LineHeightFactor;

    if (n.firstChild != null) {
      const first = getNext(n.firstChild);
      const last = getPrev(n.lastChild);

      const blocks = [];
      let inlineBlock = null;
      // first create blocks from combined inline elements, then combine all blocks
      // inlineBlock will be non-null while inline elements are being combined into a block
      const endInlineBlock = () => {
        if (!isCode && inlineBlock.height > 0) {
          if (cssLineBoxes) inlineBlock.height = lineHeightPx;
          else if (inlineBlock.height < lineHeightPx) inlineBlock.height = lineHeightPx;
        }
        blocks.push(inlineBlock);
        inlineBlock = null;
      };
      for (let child = n.firstChild; child != null; child = child.nextSibling) {
        const childBlock = measureMarkdownNode(ruler, depth + 1, child, fontFamily, monoFontFamily, fontSize, fontScale, fontStyle, bold, italic, cssLineBoxes);

        if (child.type === 'element' && isBlockElement(child.data)) {
          if (inlineBlock != null) endInlineBlock();
          const nb = newBlock();
          nb.width = childBlock.width;
          nb.height = childBlock.height;
          if (child === first && n.data === 'blockquote') nb.marginTop = 0.;
          else nb.marginTop = childBlock.marginTop;
          if (child === last && n.data === 'blockquote') nb.marginBottom = 0.;
          else nb.marginBottom = childBlock.marginBottom;
          blocks.push(nb);
        } else if (child.type === 'element' && child.data === 'br') {
          if (inlineBlock != null) endInlineBlock();
          else block.height += lineHeightPx;
        } else if (blockIsNotEmpty(childBlock)) {
          if (inlineBlock == null) {
            // start inline block with child
            inlineBlock = childBlock;
          } else {
            // stack inline element dimensions horizontally
            inlineBlock.width += childBlock.width;
            inlineBlock.height = goMax(inlineBlock.height, childBlock.height);

            inlineBlock.marginTop = goMax(inlineBlock.marginTop, childBlock.marginTop);
            inlineBlock.marginBottom = goMax(inlineBlock.marginBottom, childBlock.marginBottom);
          }
        }
      }
      if (inlineBlock != null) endInlineBlock();

      let prevMarginBottom = 0;
      blocks.forEach((b, i) => {
        if (i === 0) {
          block.marginTop = goMax(block.marginTop, b.marginTop);
        } else {
          const marginDiff = b.marginTop - prevMarginBottom;
          if (marginDiff > 0) block.height += marginDiff;
        }
        if (i === blocks.length - 1) {
          block.marginBottom = goMax(block.marginBottom, b.marginBottom);
        } else {
          block.height += b.marginBottom;
          prevMarginBottom = b.marginBottom;
        }

        block.height += b.height;
        block.width = goMax(block.width, b.width);
      });
    }

    switch (n.data) {
      case 'img':
        // Preserve the browser-era measurement contract: image nodes have no intrinsic dimensions here.
        break;
      case 'blockquote': {
        let borderWidth = BorderLeft_blockquote_em * cssFontSize;
        if (cssLineBoxes) borderWidth = goMax(1, Math.floor(borderWidth));
        block.width += 2 * PaddingLR_blockquote_em * cssFontSize + borderWidth;
        block.marginBottom = goMax(block.marginBottom, MarginBottom_blockquote);
        break;
      }
      case 'p':
        if (parentElementType === 'li') block.marginTop = goMax(block.marginTop, MarginTop_li_p);
        block.marginBottom = goMax(block.marginBottom, MarginBottom_p);
        break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        block.marginTop = goMax(block.marginTop, MarginTop_h);
        block.marginBottom = goMax(block.marginBottom, MarginBottom_h);
        if (n.data === 'h1' || n.data === 'h2') block.height += PaddingBottom_h1_h2_em * cssFontSize + BorderBottom_h1_h2;
        break;
      case 'li':
        block.width += PaddingLeft_ul_ol_em * cssFontSize;
        // CSS paints an empty list marker in a line box, but D2's historical graph-layout measurement intentionally gives an
        // empty item no height.
        if (cssLineBoxes && block.height === 0) block.height = lineHeightPx;
        if (hasPrev(n)) block.marginTop = goMax(block.marginTop, MarginTop_li_em * cssFontSize);
        break;
      case 'ol': case 'ul':
        if (hasAncestorElement(n, 'ul') || hasAncestorElement(n, 'ol')) {
          block.marginTop = 0;
          block.marginBottom = 0;
        } else {
          block.marginBottom = goMax(block.marginBottom, MarginBottom_ul);
        }
        break;
      case 'pre': {
        // CSS white-space: pre creates one line box per logical line, except that a final newline does not create an extra empty
        // line box. The compatibility measurement keeps its historical glyph-bound height.
        const lineCount = markdownPreLineCount(markdownNodeText(n));
        if (cssLineBoxes && lineCount > 0) {
          const cssContentHeight = lineCount * LineHeight_pre * FontSize_pre_code_em * cssFontSize;
          block.height = goMax(block.height, cssContentHeight);
        }
        block.width += 2 * Padding_pre;
        block.height += 2 * Padding_pre;
        block.marginBottom = goMax(block.marginBottom, MarginBottom_pre);
        break;
      }
      case 'code':
        if (parentElementType !== 'pre') {
          if (cssLineBoxes && hasMarkdownHeadingAncestor(n)) {
            block.width += 2 * PaddingLeftRight_heading_code_em * cssFontSize;
            block.height = lineHeightPx;
          } else if (cssLineBoxes) {
            const codeFontSize = FontSize_pre_code_em * cssFontSize;
            block.width += 2 * PaddingLeftRight_code_em * codeFontSize;
            const m = cssFontBoxMetrics(ruler, d2fonts.font(fontFamily, fontSize, fontStyle), codeFontSize);
            if (m !== null) block.height = m[0] + m[1];
            block.height += 2 * PaddingTopBottom_code_em * codeFontSize;
          } else {
            block.width += 2 * PaddingLeftRight_code_em * cssFontSize;
            block.height += 2 * PaddingTopBottom_code_em * cssFontSize;
          }
        }
        break;
      case 'hr':
        block.height += Height_hr_em * cssFontSize;
        block.marginTop = goMax(block.marginTop, MarginTopBottom_hr);
        block.marginBottom = goMax(block.marginBottom, MarginTopBottom_hr);
        break;
      case 'table': {
        let columnWidths = [];
        let tableHeight = 0;

        // Border width for table (outer border)
        const tableBorder = 1.0;

        // Iterate over child nodes (tbody, thead, tr)
        for (let child = n.firstChild; child != null; child = child.nextSibling) {
          if (child.type === 'element' && (child.data === 'tbody' || child.data === 'thead' || child.data === 'tfoot')) {
            const childAttrs = measureMarkdownNode(ruler, depth + 1, child, fontFamily, monoFontFamily, fontSize, fontScale, fontStyle, bold, italic, cssLineBoxes);
            tableHeight += childAttrs.height;
            if (Array.isArray(childAttrs.extraData) && (childAttrs.extraData.length === 0 || Array.isArray(childAttrs.extraData[0]))) {
              columnWidths = mergeColumnWidths(columnWidths, childAttrs.extraData);
            }
          } else if (child.type === 'element' && child.data === 'tr') {
            const rowAttrs = measureMarkdownNode(ruler, depth + 1, child, fontFamily, monoFontFamily, fontSize, fontScale, fontStyle, bold, italic, cssLineBoxes);
            tableHeight += rowAttrs.height;
            if (Array.isArray(rowAttrs.extraData)) columnWidths = mergeColumnWidths(columnWidths, [rowAttrs.extraData]);
          }
        }

        // Calculate total table width including ALL borders
        let tableWidth = 0.0;
        if (columnWidths.length > 0) {
          for (const colWidth of columnWidths) tableWidth += colWidth;
          // Add border for every column division (including outer borders)
          tableWidth += (columnWidths.length + 1) * tableBorder;
        }

        // Add outer borders to height
        tableHeight += 2 * tableBorder;

        block.width = tableWidth;
        block.height = tableHeight;
        if (cssLineBoxes) block.marginBottom = goMax(block.marginBottom, MarginBottom_table);
        break;
      }
      case 'thead': case 'tbody': case 'tfoot': {
        let sectionWidth = 0, sectionHeight = 0;
        const sectionColumnWidths = [];

        // Iterate over tr elements
        for (let child = n.firstChild; child != null; child = child.nextSibling) {
          if (child.type === 'element' && child.data === 'tr') {
            const childAttrs = measureMarkdownNode(ruler, depth + 1, child, fontFamily, monoFontFamily, fontSize, fontScale, fontStyle, bold, italic, cssLineBoxes);
            sectionHeight += childAttrs.height;
            sectionWidth = goMax(sectionWidth, childAttrs.width);
            if (Array.isArray(childAttrs.extraData)) sectionColumnWidths.push(childAttrs.extraData);
          }
        }

        block.width = sectionWidth;
        block.height = sectionHeight;
        block.extraData = sectionColumnWidths; // Pass column widths back to table
        break;
      }
      case 'td': case 'th':
        if (!cssLineBoxes) {
          // Preserve D2's historical graph-layout measurement for mixed inline table-cell children: the widest child determines
          // width, while child heights accumulate.
          let cellContentWidth = 0, cellContentHeight = 0;
          for (let child = n.firstChild; child != null; child = child.nextSibling) {
            const childAttrs = measureMarkdownNode(ruler, depth + 1, child, fontFamily, monoFontFamily, fontSize, fontScale, fontStyle, bold, italic, false);
            cellContentWidth = goMax(cellContentWidth, childAttrs.width);
            cellContentHeight += childAttrs.height;
          }
          block.width = cellContentWidth;
          block.height = cellContentHeight;
        }
        break;
      case 'tr': {
        let rowWidth = 0, rowHeight = 0;
        const cellWidths = [];

        const cellBorder = 1.0;
        const rowBorder = 1.0;

        let maxCellHeight = 0.0;
        let cellCount = 0;

        // Check if this row is in a thead to determine default font style for cells
        const inHeader = hasAncestorElement(n, 'thead');
        let rowFontStyle = fontStyle;
        let rowBold = bold;
        if (inHeader) {
          rowFontStyle = d2fonts.FONT_STYLE_SEMIBOLD;
          rowBold = true;
        }

        for (let child = n.firstChild; child != null; child = child.nextSibling) {
          if (child.type === 'element' && (child.data === 'td' || child.data === 'th')) {
            cellCount++;

            // Use semibold for th elements regardless of location
            let childFontStyle = rowFontStyle;
            let childBold = rowBold;
            if (child.data === 'th') {
              childFontStyle = d2fonts.FONT_STYLE_SEMIBOLD;
              childBold = true;
            }

            const childAttrs = measureMarkdownNode(ruler, depth + 1, child, fontFamily, monoFontFamily, fontSize, fontScale, childFontStyle, childBold, italic, cssLineBoxes);
            const cellPaddingH = 13.0 * 2;
            const cellPaddingV = 6.0 * 2;

            const cellWidth = childAttrs.width + cellPaddingH;
            const cellHeight = childAttrs.height + cellPaddingV;

            cellWidths.push(cellWidth);
            maxCellHeight = goMax(maxCellHeight, cellHeight);
          }
        }

        if (cellCount > 0) {
          for (const w of cellWidths) rowWidth += w;
          rowWidth += (cellCount + 1) * cellBorder;
        }

        rowHeight = maxCellHeight + rowBorder;

        block.width = rowWidth;
        block.height = rowHeight;
        block.extraData = cellWidths;
        break;
      }
    }
    if (!cssLineBoxes && block.height > 0 && block.height < lineHeightPx) block.height = lineHeightPx;
    return block;
  } finally {
    ruler.LineHeightFactor = originalLineHeight;
  }
}

function renderableMarkdownText(n) { return n.data; }

// ---- the painter ----

function newPaintContext(fontFamily, monoFontFamily, fontSize) {
  return {
    fontFamily, monoFontFamily, fontSize, fontScale: 1, fontStyle: d2fonts.FONT_STYLE_REGULAR, bold: false, italic: false,
    lineHeightFactor: MarkdownLineHeight, mono: fontFamily === monoFontFamily, inlineCode: false, headingCode: false, heading: '',
    role: ColorForeground, link: '', linkTitle: '', decoration: '', decorationGroup: 0, decorationRole: '', tableCell: false, textAlign: '',
  };
}

const cssFontSizeOf = (ctx) => ctx.fontSize * ctx.fontScale;
const effectiveFontStyle = (ctx) => ctx.fontStyle;
const syntheticBold = (ctx) => ctx.bold && ctx.fontStyle !== d2fonts.FONT_STYLE_BOLD && ctx.fontStyle !== d2fonts.FONT_STYLE_SEMIBOLD;
const syntheticItalic = (ctx) => ctx.italic && ctx.fontStyle !== d2fonts.FONT_STYLE_ITALIC;

function fontRole(ctx) {
  const fontStyle = effectiveFontStyle(ctx);
  if (ctx.mono) {
    switch (fontStyle) {
      case d2fonts.FONT_STYLE_SEMIBOLD: return 'mono-semibold';
      case d2fonts.FONT_STYLE_BOLD: return 'mono-bold';
      case d2fonts.FONT_STYLE_ITALIC: return 'mono-italic';
      default: return 'mono';
    }
  }
  switch (fontStyle) {
    case d2fonts.FONT_STYLE_SEMIBOLD: return 'semibold';
    case d2fonts.FONT_STYLE_BOLD: return 'bold';
    case d2fonts.FONT_STYLE_ITALIC: return 'italic';
    default: return 'regular';
  }
}

const markdownSnap = (v) => Math.floor(v + 0.5);

const rect = (fields) => ({ Kind: 'rect', X: 0, Y: 0, X2: 0, Y2: 0, Width: 0, Height: 0, Radius: 0, StrokeWidth: 0, Text: '', Font: '', FontSize: 0, FillRole: '', StrokeRole: '', Link: '', LinkTitle: '', Decoration: '', SyntheticBold: false, SyntheticItalic: false, TextLength: false, ...fields });
const textPrim = (fields) => rect({ Kind: 'text', ...fields });

const newToken = (fields) => ({ breakLine: false, breakBefore: false, breakAfterSoftHyphen: false, softHyphenEnd: false, discretionaryHyphen: false, padding: false, leadingPadding: false, text: '', width: 0, height: 0, ctx: null, codeGroup: 0, codeHeight: 0, decorationGroup: 0, ...fields });

class MarkdownPainter {
  constructor(ruler, layout) {
    this.ruler = ruler;
    this.layout = layout;
  }

  fontOf(ctx) {
    const fontFamily = ctx.mono ? ctx.monoFontFamily : ctx.fontFamily;
    return d2fonts.font(fontFamily, ctx.fontSize, effectiveFontStyle(ctx));
  }

  measure(n, ctx) {
    const original = this.ruler.LineHeightFactor;
    this.ruler.LineHeightFactor = ctx.lineHeightFactor;
    try {
      return measureMarkdownNode(this.ruler, 0, n, ctx.fontFamily, ctx.monoFontFamily, ctx.fontSize, ctx.fontScale, ctx.fontStyle, ctx.bold, ctx.italic, true);
    } finally {
      this.ruler.LineHeightFactor = original;
    }
  }

  childContext(n, ctx) {
    if (n.type !== 'element') return ctx;
    ctx = { ...ctx };
    switch (n.data) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        ctx.heading = n.data;
        ctx.fontScale *= headerToFontScale(n.data);
        ctx.fontStyle = d2fonts.FONT_STYLE_SEMIBOLD;
        ctx.bold = false;
        ctx.lineHeightFactor = LineHeight_h;
        if (n.data === 'h6') ctx.role = ColorMuted;
        break;
      case 'em':
        ctx.fontStyle = d2fonts.FONT_STYLE_ITALIC;
        ctx.italic = true;
        break;
      case 'b': case 'strong':
        ctx.fontStyle = d2fonts.FONT_STYLE_BOLD;
        ctx.bold = true;
        break;
      case 'pre': case 'code':
        ctx.fontFamily = ctx.monoFontFamily;
        ctx.mono = true;
        ctx.fontStyle = d2fonts.FONT_STYLE_REGULAR;
        ctx.inlineCode = n.data === 'code' && (n.parent == null || n.parent.data !== 'pre');
        ctx.headingCode = ctx.inlineCode && hasMarkdownHeadingAncestor(n);
        break;
      case 'a':
        ctx.link = nodeAttr(n, 'href');
        ctx.linkTitle = nodeAttr(n, 'title');
        ctx.role = ColorAccent;
        break;
      case 'del': case 's': case 'strike':
        ctx.decoration = 'line-through';
        break;
      case 'blockquote':
        ctx.role = ColorMuted;
        break;
    }
    return ctx;
  }

  paintBlock(n, x, y, parentCtx, availableWidth) {
    const attrs = this.measure(n, parentCtx);
    const ctx = this.childContext(n, parentCtx);
    if (n.type !== 'element') return this.paintInlineNodes([n], x, y, parentCtx, availableWidth);

    switch (n.data) {
      case 'hr': {
        let width = availableWidth;
        if (width <= 0) width = attrs.width;
        const x1 = markdownSnap(x), x2 = markdownSnap(x + width);
        const y1 = markdownSnap(y), y2 = markdownSnap(y + Height_hr_em * cssFontSizeOf(ctx));
        this.layout.Primitives.push(rect({ X: x1, Y: y1, Width: x2 - x1, Height: y2 - y1, FillRole: ColorBorder }));
        return attrs.height;
      }
      case 'pre':
        return this.paintPre(n, x, y, attrs, ctx, availableWidth);
      case 'table':
        return this.paintTable(n, x, y, attrs, ctx, availableWidth);
    }

    const contentX = x;
    let contentY = y;
    let cx = contentX;
    let blockquoteBorderWidth = 0.0;
    switch (n.data) {
      case 'blockquote': {
        blockquoteBorderWidth = goMax(1, Math.floor(BorderLeft_blockquote_em * cssFontSizeOf(ctx)));
        const inset = blockquoteBorderWidth + PaddingLR_blockquote_em * cssFontSizeOf(ctx);
        cx += inset;
        availableWidth = goMax(0, availableWidth - inset - PaddingLR_blockquote_em * cssFontSizeOf(ctx));
        break;
      }
      case 'li': {
        const inset = this.listIndent(n, ctx);
        cx += inset;
        availableWidth = goMax(0, availableWidth - inset);
        this.paintListMarker(n, x, y, ctx, inset);
        break;
      }
    }

    const contentHeight = this.paintFlow(n, cx, contentY, ctx, availableWidth);
    let paintedHeight = goMax(attrs.height, contentHeight);
    if (n.data === 'h1' || n.data === 'h2') {
      const lineHeight = cssFontSizeOf(ctx) * ctx.lineHeightFactor;
      if (contentHeight > lineHeight) paintedHeight = attrs.height + contentHeight - lineHeight;
    }

    if (n.data === 'blockquote') {
      const barY1 = markdownSnap(y), barY2 = markdownSnap(y + paintedHeight);
      this.layout.Primitives.push(rect({ X: markdownSnap(x), Y: barY1, Width: blockquoteBorderWidth, Height: barY2 - barY1, FillRole: ColorBorder }));
    }

    if (n.data === 'h1' || n.data === 'h2') {
      let width = availableWidth;
      if (width <= 0) width = attrs.width;
      const x1 = markdownSnap(x), x2 = markdownSnap(x + width);
      const rawTop = y + paintedHeight - BorderBottom_h1_h2;
      const y1 = markdownSnap(rawTop), y2 = markdownSnap(rawTop + BorderBottom_h1_h2);
      this.layout.Primitives.push(rect({ X: x1, Y: y1, Width: x2 - x1, Height: y2 - y1, FillRole: ColorBorderMuted }));
    }
    return paintedHeight;
  }

  paintFlow(n, x, y, ctx, availableWidth) {
    const units = this.flowUnits(n, ctx);
    let currentY = y;
    let previousMarginBottom = 0.0;
    units.forEach((unit, i) => {
      if (i === 0 && n.data === 'body' && unit.block != null && (unit.block.data === 'ul' || unit.block.data === 'ol')) {
        // The root has no parent flow to consume a collapsed first-child margin. Chromium still paints that margin inside the
        // foreignObject viewport when a top-level loose list's first li starts with p, while D2's legacy outer height excludes it.
        currentY += unit.attrs.marginTop;
      } else if (i > 0) {
        currentY += goMax(previousMarginBottom, unit.attrs.marginTop);
      }
      let paintedHeight = unit.attrs.height;
      if (unit.block != null) paintedHeight = this.paintBlock(unit.block, x, currentY, ctx, availableWidth);
      else paintedHeight = goMax(paintedHeight, this.paintInlineNodes(unit.inline ?? [], x, currentY, ctx, availableWidth));
      currentY += paintedHeight;
      previousMarginBottom = unit.attrs.marginBottom;
    });
    return currentY - y;
  }

  flowUnits(n, ctx) {
    const units = [];
    let inlineNodes = [];
    let inlineAttrs = newBlock();
    const lineHeight = cssFontSizeOf(ctx) * ctx.lineHeightFactor;

    const flushInline = () => {
      if (inlineNodes.length === 0 || !blockIsNotEmpty(inlineAttrs)) {
        inlineNodes = [];
        inlineAttrs = newBlock();
        return;
      }
      inlineAttrs.height = lineHeight;
      units.push({ block: null, inline: inlineNodes, attrs: inlineAttrs });
      inlineNodes = [];
      inlineAttrs = newBlock();
    };

    const first = getNext(n.firstChild);
    const last = getPrev(n.lastChild);
    for (let child = n.firstChild; child != null; child = child.nextSibling) {
      if (child.type === 'element' && isBlockElement(child.data)) {
        flushInline();
        const attrs = this.measure(child, ctx);
        if (child === first && n.data === 'blockquote') attrs.marginTop = 0;
        if (child === last && n.data === 'blockquote') attrs.marginBottom = 0;
        units.push({ block: child, inline: null, attrs });
        continue;
      }
      if (child.type === 'element' && child.data === 'br') {
        if (blockIsNotEmpty(inlineAttrs)) flushInline();
        else units.push({ block: null, inline: null, attrs: { ...newBlock(), height: lineHeight } });
        continue;
      }

      const attrs = this.measure(child, ctx);
      inlineNodes.push(child);
      if (blockIsNotEmpty(attrs)) {
        inlineAttrs.width += attrs.width;
        inlineAttrs.height = goMax(inlineAttrs.height, attrs.height);
        inlineAttrs.marginTop = goMax(inlineAttrs.marginTop, attrs.marginTop);
        inlineAttrs.marginBottom = goMax(inlineAttrs.marginBottom, attrs.marginBottom);
      }
    }
    flushInline();
    return units;
  }

  paintInlineNodes(nodes, x, y, ctx, availableWidth) {
    const tokens = [];
    const counters = { nextCodeGroup: 0, nextDecorationGroup: 0 };
    for (const n of nodes) this.collectInlineTokens(n, ctx, tokens, counters, 0, 0);
    if (tokens.length === 0) return 0;

    const lines = this.wrapInlineTokens(tokens, availableWidth);
    let paintedHeight = 0.0;
    for (const line of lines) {
      const lineHeight = this.markdownInlineLineHeight(line, ctx);
      const lineY = y + paintedHeight;
      let lineX = x;
      if (ctx.textAlign !== '' && availableWidth > 0) {
        let lineWidth = 0.0;
        for (const token of line) lineWidth += token.width;
        const extra = goMax(0, availableWidth - lineWidth);
        if (ctx.textAlign === 'center') lineX += extra / 2;
        else if (ctx.textAlign === 'right') lineX += extra;
      }
      let cursorX = lineX;
      const codeSpans = new Map();
      const codeShifts = new Map();
      const codeLinks = new Map();
      const decorationSpans = new Map();
      for (const token of line) {
        if (token.codeGroup > 0) {
          let span = codeSpans.get(token.codeGroup);
          if (span === undefined) {
            span = [cursorX, cursorX, token.codeHeight];
            codeShifts.set(token.codeGroup, this.inlineCodeVerticalShift(ctx, token.ctx, lineHeight, token.codeHeight));
            codeLinks.set(token.codeGroup, [token.ctx.link, token.ctx.linkTitle]);
          }
          span[1] = cursorX + token.width;
          span[2] = goMax(span[2], token.codeHeight);
          codeSpans.set(token.codeGroup, span);
        }
        if (token.decorationGroup > 0) {
          let span = decorationSpans.get(token.decorationGroup);
          if (span === undefined) {
            span = rect({ X: cursorX, Y: markdownSnap(lineY + lineHeight / 2), Height: 1, FillRole: token.ctx.decorationRole });
          }
          span.Width = cursorX + token.width - span.X;
          decorationSpans.set(token.decorationGroup, span);
        }
        cursorX += token.width;
      }
      const groupIDs = [...codeSpans.keys()].sort((a, b) => a - b);
      for (const groupID of groupIDs) {
        const span = codeSpans.get(groupID);
        const height = span[2];
        this.layout.Primitives.push(rect({
          X: span[0], Y: lineY + (lineHeight - height) / 2 + codeShifts.get(groupID), Width: span[1] - span[0], Height: height, Radius: 6,
          FillRole: ColorNeutralMuted, Link: codeLinks.get(groupID)[0], LinkTitle: codeLinks.get(groupID)[1],
        }));
      }

      cursorX = lineX;
      for (const token of line) {
        if (token.padding) {
          cursorX += token.width;
          continue;
        }
        let fontSize = cssFontSizeOf(token.ctx);
        let fontScale = token.ctx.fontScale;
        if (token.ctx.inlineCode && !token.ctx.headingCode) {
          fontScale *= FontSize_pre_code_em;
          fontSize *= FontSize_pre_code_em;
        }
        let baselineY = this.textBaseline(token.ctx, lineY, lineHeight, fontScale);
        if (token.ctx.inlineCode && token.codeHeight > 0) {
          const codeTop = lineY + (lineHeight - token.codeHeight) / 2;
          let verticalPadding = 0.0;
          if (!token.ctx.headingCode) verticalPadding = PaddingTopBottom_code_em * fontSize;
          const contentTop = codeTop + verticalPadding;
          const contentHeight = goMax(0, token.codeHeight - 2 * verticalPadding);
          baselineY = this.textBaseline(token.ctx, contentTop, contentHeight, fontScale);
          baselineY += codeShifts.get(token.codeGroup);
        }
        baselineY -= markdownHeadingInkCorrection(token.ctx);
        this.layout.Primitives.push(textPrim({
          X: cursorX, Y: baselineY, Width: token.width, Height: token.height, Text: token.text, Font: fontRole(token.ctx), FontSize: fontSize,
          FillRole: token.ctx.role, Link: token.ctx.link, LinkTitle: token.ctx.linkTitle,
          SyntheticBold: syntheticBold(token.ctx), SyntheticItalic: syntheticItalic(token.ctx), TextLength: token.discretionaryHyphen,
        }));
        cursorX += token.width;
      }
      const decorationGroupIDs = [...decorationSpans.keys()].sort((a, b) => a - b);
      for (const groupID of decorationGroupIDs) this.layout.Primitives.push(decorationSpans.get(groupID));
      paintedHeight += lineHeight;
    }
    return paintedHeight;
  }

  markdownInlineLineHeight(line, ctx) {
    let lineHeight = cssFontSizeOf(ctx) * ctx.lineHeightFactor;
    if (!ctx.tableCell) return lineHeight;
    let lineCtx = ctx;
    let hasContent = false;
    let allCode = true;
    for (const token of line) {
      if (token.padding || token.text === '') continue;
      hasContent = true;
      if (!token.ctx.inlineCode) {
        const font = this.fontOf(token.ctx);
        const measurementText = token.text.replaceAll('­', '');
        if (measureFontAdvance(this.ruler, font, measurementText) === null && !isASCII(measurementText)) throw new Deferred('markdown-unicode');
        allCode = false;
        continue;
      }
      if (lineCtx.inlineCode === false) lineCtx = token.ctx;
    }
    allCode = hasContent && allCode;
    if (!allCode) lineCtx = ctx;
    const fontFamily = lineCtx.mono ? lineCtx.monoFontFamily : lineCtx.fontFamily;
    let fontSize = cssFontSizeOf(lineCtx);
    if (allCode) fontSize *= FontSize_pre_code_em;
    const font = d2fonts.font(fontFamily, lineCtx.fontSize, effectiveFontStyle(lineCtx));
    const normal = cssNormalLineHeight(this.ruler, font, fontSize);
    if (normal !== null) lineHeight = normal;
    if (allCode) {
      // Chromium's normal inline-formatting strut leaves two pixels of line gap around Source Code Pro at the 85% code size.
      lineHeight = goMax(lineHeight, goRound(fontSize * 1.4));
    }
    return lineHeight;
  }

  /** implements CSS white-space wrapping at Unicode line-break opportunities, with overflow-wrap fallbacks at inline element boundaries */
  wrapInlineTokens(tokens, availableWidth) {
    let lines = [[]];
    let lineWidth = 0.0;
    let needsWrap = false;
    for (const token of tokens) {
      if (token.breakLine) {
        lines.push([]);
        lineWidth = 0;
        continue;
      }
      lines[lines.length - 1].push(token);
      lineWidth += token.width;
      needsWrap = needsWrap || (availableWidth > 0 && lineWidth > availableWidth + 0.001);
    }
    if (!needsWrap) return lines;

    let atoms = this.atomizeInlineTokens(tokens);

    lines = [[]];
    lineWidth = 0;
    let pendingSpace = null;
    let pendingPadding = [];
    let pendingPaddingWidth = 0.0;
    let lineHasContent = false;
    for (let atomIndex = 0; atomIndex < atoms.length; atomIndex++) {
      let atom = atoms[atomIndex];
      if (atom.breakLine) {
        pendingSpace = null;
        pendingPadding = [];
        pendingPaddingWidth = 0;
        lines.push([]);
        lineWidth = 0;
        lineHasContent = false;
        continue;
      }
      if (atom.text === ' ' && !atom.padding) {
        pendingSpace = { ...atom };
        continue;
      }
      if (atom.padding && atom.leadingPadding) {
        pendingPadding.push(atom);
        pendingPaddingWidth += atom.width;
        continue;
      }

      for (;;) { // retryAtom
        const trailingPaddingWidth = inlineTrailingPaddingWidth(atoms, atomIndex);
        let needed = inlineUnbrokenWidth(atoms, atomIndex) + pendingPaddingWidth;
        if (pendingSpace !== null) needed += pendingSpace.width;
        const canWrap = atom.breakBefore || pendingSpace !== null;
        if (availableWidth > 0 && lineHasContent && !atom.padding && canWrap && lineWidth + needed > availableWidth + 0.001) {
          if (atom.breakAfterSoftHyphen) {
            const line = lines[lines.length - 1];
            for (let i = line.length - 1; i >= 0; i--) {
              if (!line[i].softHyphenEnd) continue;
              line[i].softHyphenEnd = false;
              const hyphen = { ...line[i] };
              hyphen.text = '-';
              hyphen.width = cssFontSizeOf(hyphen.ctx) / 3;
              hyphen.softHyphenEnd = false;
              hyphen.discretionaryHyphen = true;
              hyphen.breakBefore = false;
              hyphen.breakAfterSoftHyphen = false;
              line.splice(i + 1, 0, hyphen);
              lineWidth += hyphen.width;
              break;
            }
          }
          lines.push([]);
          lineWidth = 0;
          lineHasContent = false;
          pendingSpace = null;
        }

        let occupiedWidth = lineWidth + pendingPaddingWidth;
        if (pendingSpace !== null && lineHasContent) occupiedWidth += pendingSpace.width;
        if (availableWidth > 0 && !atom.padding && occupiedWidth + atom.width + trailingPaddingWidth > availableWidth + 0.001) {
          const maxTextWidth = goMax(0, availableWidth - occupiedWidth);
          const split = this.splitInlineTokenAtWidth(atom, maxTextWidth, trailingPaddingWidth > 0);
          if (split === null && lineHasContent) {
            // overflow-wrap: break-word falls back to the preceding grapheme boundary when no normal Unicode opportunity is available.
            lines.push([]);
            lineWidth = 0;
            lineHasContent = false;
            pendingSpace = null;
            continue; // goto retryAtom
          }
          if (split !== null) {
            atom = split.head;
            atoms.splice(atomIndex + 1, 0, split.tail);
          }
        }
        break;
      }

      if (pendingSpace !== null && lineHasContent) {
        lines[lines.length - 1].push(pendingSpace);
        lineWidth += pendingSpace.width;
        pendingSpace = null;
      } else if (pendingSpace !== null) {
        // CSS discards leading collapsible whitespace, but inline-box padding still belongs to the first painted fragment.
        pendingSpace = null;
      }
      lines[lines.length - 1].push(...pendingPadding);
      lineWidth += pendingPaddingWidth;
      pendingPadding = [];
      pendingPaddingWidth = 0;

      lines[lines.length - 1].push(atom);
      lineWidth += atom.width;
      if (!atom.padding) lineHasContent = true;
    }
    return lines;
  }

  splitInlineTokenAtWidth(token, maxWidth, forceSplit) {
    const boundaries = graphemeEnds(token.text);
    if (boundaries.length < 2) return null;

    let best = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const width = this.inlineTextAdvance(token.text.slice(0, boundaries[i]), token.ctx, token.width);
      if (width > maxWidth + 0.001) break;
      best = i;
    }
    if (best < 0) return null;
    if (best === boundaries.length - 1) {
      if (!forceSplit) return null;
      best--;
      if (best < 0) return null;
    }

    const boundary = boundaries[best];
    const head = { ...token };
    head.text = token.text.slice(0, boundary);
    head.width = this.inlineTextAdvance(head.text, head.ctx, token.width);
    head.softHyphenEnd = false;

    const tail = { ...token };
    tail.text = token.text.slice(boundary);
    tail.width = this.inlineTextAdvance(tail.text, tail.ctx, token.width);
    tail.breakBefore = false;
    tail.breakAfterSoftHyphen = false;
    return { head, tail };
  }

  /** splits text only at Unicode line-break opportunities (see linebreak.js) */
  atomizeInlineTokens(tokens) {
    const atoms = [];
    for (let start = 0; start < tokens.length;) {
      if (tokens[start].breakLine) {
        atoms.push(tokens[start]);
        start++;
        continue;
      }

      let end = start;
      let combinedText = '';
      while (end < tokens.length && !tokens[end].breakLine) {
        if (!tokens[end].padding) combinedText += tokens[end].text;
        end++;
      }

      const breakOffsets = new Set();
      // Unicode line-breaking and grapheme segmentation are distinct algorithms. Never accept a line-break offset that falls
      // inside an extended grapheme cluster, because SVG text would otherwise paint the pieces as separate glyphs.
      const graphemeBoundaries = new Set([0]);
      for (const e of graphemeEnds(combinedText)) graphemeBoundaries.add(e);
      let remaining = combinedText;
      let state = -1;
      let consumed = 0;
      while (remaining !== '') {
        const [segment, rest, , nextState] = firstLineSegmentInString(remaining, state);
        if (segment === '') break;
        consumed += segment.length;
        if (rest !== '' && graphemeBoundaries.has(consumed)) breakOffsets.add(consumed);
        remaining = rest;
        state = nextState;
      }

      let textOffset = 0;
      for (const token of tokens.slice(start, end)) {
        if (token.padding || token.text === '') {
          atoms.push(token);
          continue;
        }

        const tokenStart = textOffset;
        const tokenEnd = tokenStart + token.text.length;
        let pieceStart = tokenStart;
        for (let offset = tokenStart + 1; offset <= tokenEnd; offset++) {
          if (offset !== tokenEnd && !breakOffsets.has(offset)) continue;
          let piece = token.text.slice(pieceStart - tokenStart, offset - tokenStart);
          const atom = { ...token };
          atom.breakBefore = breakOffsets.has(pieceStart);
          atom.breakAfterSoftHyphen = atom.breakBefore && combinedText.slice(0, pieceStart).endsWith('­');
          if (piece.endsWith('­')) {
            piece = piece.slice(0, -1);
            atom.softHyphenEnd = true;
          }
          this.appendInlineTextAtoms(atoms, atom, piece);
          pieceStart = offset;
        }
        textOffset = tokenEnd;
      }
      start = end;
    }
    return atoms;
  }

  appendInlineTextAtoms(atoms, token, text) {
    if (text === '' && token.softHyphenEnd) {
      token.width = 0;
      atoms.push(token);
      return;
    }
    const content = text.replace(/ +$/, '');
    if (content !== '') {
      const atom = { ...token };
      atom.text = content;
      atom.width = this.inlineTextAdvance(content, token.ctx, token.width);
      atoms.push(atom);
      token.breakBefore = false;
    }
    for (let i = 0; i < text.length - content.length; i++) {
      const atom = { ...token };
      atom.text = ' ';
      atom.width = this.inlineTextAdvance(' ', token.ctx, token.width);
      atoms.push(atom);
      token.breakBefore = false;
    }
  }

  inlineCodeVerticalShift(parentCtx, codeCtx, lineHeight, codeHeight) {
    if (parentCtx.tableCell) return 0;
    let codeScale = codeCtx.fontScale;
    let codeFontSize = cssFontSizeOf(codeCtx);
    let verticalPadding = 0.0;
    if (!codeCtx.headingCode) {
      codeScale *= FontSize_pre_code_em;
      codeFontSize *= FontSize_pre_code_em;
      verticalPadding = PaddingTopBottom_code_em * codeFontSize;
    }
    const codeTop = (lineHeight - codeHeight) / 2 + verticalPadding;
    const codeContentHeight = goMax(0, codeHeight - 2 * verticalPadding);
    const codeBaseline = this.textBaseline(codeCtx, codeTop, codeContentHeight, codeScale);
    const parentBaseline = this.textBaseline(parentCtx, 0, lineHeight, parentCtx.fontScale);
    return parentBaseline - codeBaseline;
  }

  collectInlineTokens(n, ctx, tokens, counters, codeGroup, codeHeight) {
    if (n.type === 'text') {
      const text = renderableMarkdownText(n);
      const attrs = this.measure(n, ctx);
      if (text === '' && attrs.width === 0) return;
      const width = this.inlineTextAdvance(text, ctx, attrs.width);
      tokens.push(newToken({ text, width, height: attrs.height, ctx, codeGroup, codeHeight, decorationGroup: ctx.decorationGroup }));
      return;
    }
    if (n.type !== 'element') return;
    if (n.data === 'br') {
      if (!ctx.inlineCode) tokens.push(newToken({ breakLine: true }));
      return;
    }
    if (n.data === 'img') return;

    const childCtx = this.childContext(n, ctx);
    const isCodeSpan = n.data === 'code' && (n.parent == null || n.parent.data !== 'pre');
    let cctx = childCtx;
    if (cctx.decoration !== '' && ctx.decoration === '') {
      cctx = { ...cctx };
      counters.nextDecorationGroup++;
      cctx.decorationGroup = counters.nextDecorationGroup;
      cctx.decorationRole = cctx.role;
    }
    if (isCodeSpan) {
      counters.nextCodeGroup++;
      codeGroup = counters.nextCodeGroup;
      const attrs = this.measure(n, ctx);
      codeHeight = attrs.height;
      const padding = inlineCodeHorizontalPadding(cctx);
      tokens.push(newToken({ padding: true, leadingPadding: true, width: padding, ctx: cctx, codeGroup, codeHeight, decorationGroup: cctx.decorationGroup }));
    }
    for (let child = n.firstChild; child != null; child = child.nextSibling) this.collectInlineTokens(child, cctx, tokens, counters, codeGroup, codeHeight);
    if (isCodeSpan) {
      const padding = inlineCodeHorizontalPadding(cctx);
      tokens.push(newToken({ padding: true, width: padding, ctx: cctx, codeGroup, codeHeight, decorationGroup: cctx.decorationGroup }));
    }
  }

  inlineTextAdvance(text, ctx, fallback) {
    const font = this.fontOf(ctx);
    const measurementText = text.replaceAll('­', '');
    let advance = measureFontAdvance(this.ruler, font, measurementText);
    if (advance === null) {
      // control characters (code blocks): MeasurePrecise's width, which scaleUnicodeCSS leaves alone for ASCII
      if (!isASCII(measurementText)) throw new Deferred('markdown-unicode');
      [advance] = this.ruler.measurePrecise(font, measurementText);
      if (advance === 0 && measurementText !== '') return fallback;
    }
    let a = advance * ctx.fontScale;
    if (ctx.inlineCode && !ctx.headingCode) a *= FontSize_pre_code_em;
    return a;
  }

  paintPre(n, x, y, attrs, ctx, availableWidth) {
    const backgroundWidth = goMax(attrs.width, availableWidth);
    const bg = rect({ X: x, Y: y, Width: backgroundWidth, Height: attrs.height, Radius: 6, FillRole: ColorCanvasSubtle });
    this.layout.Primitives.push(bg);
    const text = markdownNodeText(n);
    let lines = [];
    if (text !== '') lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines = lines.slice(0, -1);
    const fontSize = FontSize_pre_code_em * cssFontSizeOf(ctx);
    const lineHeight = LineHeight_pre * fontSize;
    let backgroundHeight = lines.length * lineHeight + 2 * Padding_pre;
    if (lines.length === 0) backgroundHeight = 2 * Padding_pre;
    bg.Height = backgroundHeight;
    lines.forEach((line, i) => {
      if (line === '') return;
      line = expandMarkdownTabs(line);
      this.layout.Primitives.push(textPrim({
        X: x + Padding_pre, Y: this.textBaseline(ctx, y + Padding_pre + i * lineHeight, lineHeight, FontSize_pre_code_em * ctx.fontScale),
        Text: line, Font: fontRole(ctx), FontSize: fontSize, FillRole: ctx.role, SyntheticBold: syntheticBold(ctx), SyntheticItalic: syntheticItalic(ctx),
      }));
    });
    return backgroundHeight;
  }

  paintTable(n, x, y, attrs, ctx, availableWidth) {
    const rows = collectMarkdownTableRows(n);
    let columnWidths = [];
    let columnMinWidths = [];
    for (const row of rows) {
      const rowMinWidths = [];
      for (const cell of row.cells) {
        const cellCtx = markdownTableCellContext(ctx, row, cell);
        const cellAttrs = this.measure(cell, cellCtx);
        row.widths.push(cellAttrs.width + 26);
        rowMinWidths.push(this.markdownMinContentWidth(cell, cellCtx) + 26);
      }
      columnWidths = mergeColumnWidths(columnWidths, [row.widths]);
      columnMinWidths = mergeColumnWidths(columnMinWidths, [rowMinWidths]);
    }
    let tableWidth = attrs.width;
    if (availableWidth > 0) tableWidth = Math.min(tableWidth, availableWidth);
    tableWidth = goMax(1, tableWidth);
    columnWidths = fitMarkdownTableColumns(columnWidths, columnMinWidths, tableWidth);
    let paintedTableWidth = columnWidths.length + 1;
    for (const width of columnWidths) paintedTableWidth += width;
    paintedTableWidth = goMax(tableWidth, paintedTableWidth);

    for (const row of rows) {
      let maxCellHeight = 0.0;
      row.cells.forEach((cell, cellIndex) => {
        const cellCtx = markdownTableCellContext(ctx, row, cell);
        const contentWidth = goMax(0, columnWidths[cellIndex] - 26);
        const probe = new MarkdownPainter(this.ruler, { Primitives: [] });
        const contentHeight = probe.paintFlow(cell, 0, 0, cellCtx, contentWidth);
        row.heights.push(contentHeight);
        maxCellHeight = goMax(maxCellHeight, contentHeight + 12);
      });
      // Empty cells have only their 6px vertical padding and the collapsed one-pixel row border. Chromium therefore paints an
      // empty row at 13px.
      row.height = maxCellHeight + 1;
    }
    let finalBoundaryY = y;
    for (const row of rows) finalBoundaryY += row.height;
    const leftBorderX = markdownSnap(x);
    const topBorderY = markdownSnap(y);
    const rightBorderX = markdownSnap(x + paintedTableWidth - 1);
    const bottomBorderY = markdownSnap(finalBoundaryY);
    const gridWidth = rightBorderX - leftBorderX + 1;
    const gridHeight = bottomBorderY - topBorderY + 1;

    this.layout.Primitives.push(rect({ X: leftBorderX, Y: topBorderY, Width: gridWidth, Height: gridHeight, FillRole: ColorCanvas }));
    let stripeY = y;
    for (const row of rows) {
      if (row.stripe) {
        const stripeTop = markdownSnap(stripeY);
        const stripeBottom = markdownSnap(stripeY + row.height);
        this.layout.Primitives.push(rect({ X: leftBorderX + 1, Y: stripeTop, Width: goMax(0, rightBorderX - leftBorderX - 1), Height: stripeBottom - stripeTop, FillRole: ColorCanvasSubtle }));
      }
      stripeY += row.height;
    }
    const grid = [
      rect({ X: leftBorderX, Y: topBorderY, Width: gridWidth, Height: 1, FillRole: ColorBorder }),
      rect({ X: leftBorderX, Y: topBorderY, Width: 1, Height: gridHeight, FillRole: ColorBorder }),
      rect({ X: rightBorderX, Y: topBorderY, Width: 1, Height: gridHeight, FillRole: ColorBorder }),
    ];
    let rowY = y;
    for (const row of rows) {
      let cursorX = x + 1;
      row.cells.forEach((cell, cellIndex) => {
        const cellCtx = markdownTableCellContext(ctx, row, cell);
        const contentX = cursorX + 13;
        const available = columnWidths[cellIndex] - 26;
        let contentHeight = 0.0;
        if (cellIndex < row.heights.length) contentHeight = row.heights[cellIndex];
        const contentY = rowY + 7 + goMax(0, row.height - 13 - contentHeight) / 2;
        // The collapsed top border occupies the first CSS pixel of each row; cell padding starts after it. Table cells vertically
        // center content when another cell makes the shared row taller.
        this.paintFlow(cell, contentX, contentY, cellCtx, available);
        cursorX += columnWidths[cellIndex];
        if (cellIndex < row.cells.length - 1) {
          const segmentTop = markdownSnap(rowY);
          const segmentBottom = markdownSnap(rowY + row.height);
          grid.push(rect({ X: markdownSnap(cursorX), Y: segmentTop, Width: 1, Height: segmentBottom - segmentTop, FillRole: ColorBorder }));
        }
        cursorX++;
      });
      rowY += row.height;
      grid.push(rect({ X: leftBorderX, Y: markdownSnap(rowY), Width: gridWidth, Height: 1, FillRole: ColorBorder }));
    }
    this.layout.Primitives.push(...grid);
    return gridHeight;
  }

  /** the narrowest width allowed by ordinary CSS line-break opportunities */
  markdownMinContentWidth(n, ctx) {
    let minWidth = 0.0;
    for (const unit of this.flowUnits(n, ctx)) {
      if (unit.block != null) {
        minWidth = goMax(minWidth, this.measure(unit.block, ctx).width);
        continue;
      }
      if (unit.inline == null) continue;
      const tokens = [];
      const counters = { nextCodeGroup: 0, nextDecorationGroup: 0 };
      for (const inline of unit.inline) this.collectInlineTokens(inline, ctx, tokens, counters, 0, 0);
      const atoms = this.atomizeInlineTokens(tokens);
      let segmentWidth = 0.0;
      let pendingLeadingPadding = 0.0;
      let previousContentCtx = null;
      const commit = (extra) => {
        minWidth = goMax(minWidth, segmentWidth + extra);
        segmentWidth = 0;
        previousContentCtx = null;
      };
      for (const atom of atoms) {
        if (atom.breakLine) {
          segmentWidth += pendingLeadingPadding;
          pendingLeadingPadding = 0;
          commit(0);
          continue;
        }
        if (atom.text === ' ' && !atom.padding) {
          segmentWidth += pendingLeadingPadding;
          pendingLeadingPadding = 0;
          commit(0);
          continue;
        }
        if (atom.padding && atom.leadingPadding) {
          pendingLeadingPadding += atom.width;
          continue;
        }
        if (!atom.padding && atom.breakBefore) {
          let extra = 0.0;
          if (atom.breakAfterSoftHyphen && previousContentCtx !== null) extra = cssFontSizeOf(previousContentCtx) / 3;
          commit(extra);
        }
        segmentWidth += pendingLeadingPadding;
        pendingLeadingPadding = 0;
        segmentWidth += atom.width;
        if (!atom.padding) previousContentCtx = atom.ctx;
      }
      segmentWidth += pendingLeadingPadding;
      commit(0);
    }
    return minWidth;
  }

  listIndent(n, ctx) { return PaddingLeft_ul_ol_em * cssFontSizeOf(ctx); }

  paintListMarker(n, x, y, ctx, inset) {
    const baselineY = this.listMarkerBaseline(n, y, ctx);
    if (n.parent != null && n.parent.type === 'element' && n.parent.data === 'ul') {
      const fontSize = cssFontSizeOf(ctx);
      // Blink paints list markers as pixel-snapped geometry. Its disc/square box is about .3em, with a three-pixel minimum at
      // small font sizes.
      const side = goMax(3, markdownSnap(0.3 * fontSize));
      // CSS places outside markers in a marker box whose center sits about one em before the list content.
      const centerX = x + inset - fontSize / 2 - 6.5;
      const primitive = rect({ X: markdownSnap(centerX - side / 2), Y: baselineY - Math.floor(1.5 * side), Width: side, Height: side });
      const depth = markdownListDepth(n);
      switch (depth) {
        case 0:
          primitive.Radius = side / 2;
          primitive.FillRole = ctx.role;
          break;
        case 1:
          primitive.Radius = side / 2;
          primitive.StrokeWidth = 1;
          primitive.StrokeRole = ctx.role === ColorMuted ? ColorMutedStroke : ColorForegroundStroke;
          break;
        default:
          primitive.FillRole = ctx.role;
      }
      this.layout.Primitives.push(primitive);
      return;
    }
    const marker = markdownListMarker(n);
    if (marker === '') return;
    const font = this.fontOf(ctx);
    let [markerWidth, markerHeight] = this.ruler.measurePrecise(font, marker);
    markerWidth *= ctx.fontScale;
    markerHeight *= ctx.fontScale;
    this.layout.Primitives.push(textPrim({
      X: x + inset - markerWidth - this.ruler.spaceWidth(font) * ctx.fontScale, Y: baselineY, Width: markerWidth, Height: markerHeight,
      Text: marker, Font: fontRole(ctx), FontSize: cssFontSizeOf(ctx), FillRole: ctx.role, SyntheticBold: syntheticBold(ctx), SyntheticItalic: syntheticItalic(ctx),
    }));
  }

  /**
   * A list marker participates in the list item's first line box. When that line is introduced by a heading, its larger baseline
   * pulls the marker down, but the marker itself still inherits the list item's (body) font size.
   */
  listMarkerBaseline(n, y, ctx) {
    const baseline = this.textBaseline(ctx, y, cssFontSizeOf(ctx) * ctx.lineHeightFactor, ctx.fontScale);
    const first = getNext(n.firstChild);
    if (first == null || first.type !== 'element' || !isMarkdownHeading(first.data)) return baseline;
    const headingCtx = this.childContext(first, ctx);
    const headingBaseline = this.textBaseline(headingCtx, y, cssFontSizeOf(headingCtx) * headingCtx.lineHeightFactor, headingCtx.fontScale);
    return goMax(baseline, headingBaseline);
  }

  /** CSS line-box placement: half of the extra line-height sits above the rounded OpenType font box, followed by its ascent */
  textBaseline(ctx, top, lineHeight, scale) {
    const fontFamily = ctx.mono ? ctx.monoFontFamily : ctx.fontFamily;
    const font = d2fonts.font(fontFamily, ctx.fontSize, effectiveFontStyle(ctx));
    const m = cssFontBoxMetrics(this.ruler, font, ctx.fontSize * scale);
    if (m === null) throw new Deferred('markdown-font');
    const leading = goMax(0, lineHeight - m[0] - m[1]);
    return top + leading / 2 + m[0];
  }
}

/** [end offset (UTF-16 index) of each grapheme cluster] */
function graphemeEnds(text) {
  const out = [];
  const g = new Graphemes(text);
  let end = 0;
  while (g.next()) {
    for (const r of g.runes()) end += r > 0xffff ? 2 : 1;
    out.push(end);
  }
  return out;
}

function inlineCodeHorizontalPadding(ctx) {
  if (ctx.headingCode) return PaddingLeftRight_heading_code_em * cssFontSizeOf(ctx);
  return PaddingLeftRight_code_em * FontSize_pre_code_em * cssFontSizeOf(ctx);
}

/** HTML line boxes at h2's 24px and h5's 14px font sizes expose ink one pixel above the baseline produced by rounded OpenType font-box metrics */
function markdownHeadingInkCorrection(ctx) {
  if (ctx.heading === 'h5' || (ctx.heading === 'h2' && ctx.fontFamily === d2fonts.SourceSansPro)) return 1;
  return 0;
}

function inlineTrailingPaddingWidth(atoms, atomIndex) {
  let width = 0.0;
  for (let i = atomIndex + 1; i < atoms.length && atoms[i].padding && !atoms[i].leadingPadding; i++) width += atoms[i].width;
  return width;
}

/** looks through style/link token boundaries until the next real Unicode break */
function inlineUnbrokenWidth(atoms, atomIndex) {
  let width = 0.0;
  for (let i = atomIndex; i < atoms.length; i++) {
    const atom = atoms[i];
    if (atom.breakLine || (i > atomIndex && !atom.padding && (atom.breakBefore || atom.text === ' '))) break;
    if (i === atomIndex && atom.text === ' ' && !atom.padding) break;
    width += atom.width;
  }
  return width;
}

function expandMarkdownTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  let column = 0;
  const g = new Graphemes(line);
  while (g.next()) {
    const grapheme = String.fromCodePoint(...g.runes());
    if (grapheme === '\t') {
      const spaces = TAB_SIZE - (column % TAB_SIZE);
      out += ' '.repeat(spaces);
      column += spaces;
      continue;
    }
    out += grapheme;
    let width = g.width();
    if (width < 1) width = 1;
    column += width;
  }
  return out;
}

function markdownTableCellContext(ctx, row, cell) {
  ctx = { ...ctx };
  ctx.tableCell = true;
  // The browser UA stylesheet resets tables to line-height: normal. Source Sans Pro's normal 16px line box is 20px rather than
  // Markdown's 24px.
  ctx.lineHeightFactor = 1.25;
  if (row.header || cell.data === 'th') {
    ctx.fontStyle = d2fonts.FONT_STYLE_SEMIBOLD;
    ctx.bold = true;
  }
  ctx.textAlign = nodeAttr(cell, 'align');
  if (ctx.textAlign === '' && (row.header || cell.data === 'th')) ctx.textAlign = 'center';
  return ctx;
}

function fitMarkdownTableColumns(widths, minWidths, tableWidth) {
  if (widths.length === 0) return widths;
  const fitted = widths.slice();
  const columnBudget = goMax(0, tableWidth - (widths.length + 1));
  let naturalWidth = 0.0;
  for (const width of widths) naturalWidth += width;
  if (naturalWidth <= columnBudget + 0.001) return fitted;
  let minWidth = 0.0;
  let shrinkCapacity = 0.0;
  widths.forEach((width, i) => {
    let minimum = 0.0;
    if (i < minWidths.length) minimum = Math.min(width, minWidths[i]);
    minWidth += minimum;
    shrinkCapacity += width - minimum;
  });
  if (minWidth <= columnBudget + 0.001 && shrinkCapacity > 0) {
    const shrink = naturalWidth - columnBudget;
    widths.forEach((width, i) => {
      let minimum = 0.0;
      if (i < minWidths.length) minimum = Math.min(width, minWidths[i]);
      const capacity = width - minimum;
      fitted[i] = width - (shrink * capacity) / shrinkCapacity;
    });
    return fitted;
  }
  if (minWidth > columnBudget + 0.001) {
    // CSS automatic table layout does not compress columns below their min-content widths. The row can overflow a
    // max-width-constrained table.
    widths.forEach((width, i) => {
      if (i < minWidths.length) fitted[i] = Math.min(width, minWidths[i]);
    });
    return fitted;
  }
  const paddingWidth = 26.0 * widths.length;
  if (columnBudget <= paddingWidth) {
    for (let i = 0; i < fitted.length; i++) fitted[i] = columnBudget / fitted.length;
    return fitted;
  }
  const contentBudget = columnBudget - paddingWidth;
  let naturalContentWidth = 0.0;
  for (const width of widths) naturalContentWidth += goMax(0, width - 26);
  if (naturalContentWidth === 0) {
    for (let i = 0; i < fitted.length; i++) fitted[i] = 26 + contentBudget / fitted.length;
    return fitted;
  }
  widths.forEach((width, i) => {
    const share = goMax(0, width - 26) / naturalContentWidth;
    fitted[i] = 26 + contentBudget * share;
  });
  return fitted;
}

function collectMarkdownTableRows(table) {
  const rows = [];
  const appendRow = (n, inHeader, stripe) => {
    const row = { cells: [], header: inHeader, height: 0, widths: [], heights: [], stripe };
    for (let child = n.firstChild; child != null; child = child.nextSibling) {
      if (child.type === 'element' && (child.data === 'td' || child.data === 'th')) {
        row.cells.push(child);
        if (child.data === 'th') row.header = true;
      }
    }
    rows.push(row);
  };
  const walk = (n, inHeader) => {
    if (n.type !== 'element') return;
    if (n.data === 'thead' || n.data === 'tbody' || n.data === 'tfoot' || n.data === 'table') {
      if (n.data === 'thead') inHeader = true;
      let rowIndex = 0;
      for (let child = n.firstChild; child != null; child = child.nextSibling) {
        if (child.type === 'element' && child.data === 'tr') {
          appendRow(child, inHeader, rowIndex % 2 === 1);
          rowIndex++;
        } else {
          walk(child, inHeader);
        }
      }
      return;
    }
    for (let child = n.firstChild; child != null; child = child.nextSibling) walk(child, inHeader);
  };
  walk(table, false);
  return rows;
}

function markdownListMarker(n) {
  if (n.parent == null || n.parent.type !== 'element') return '';
  if (n.parent.data === 'ul') {
    // Browser list markers are geometric shapes, not font glyphs. They are painted by paintListMarker and deliberately
    // excluded from font corpus.
    return '';
  }
  let marker = '';
  if (n.parent.data === 'ol') {
    let index = 1;
    const startAttr = nodeAttr(n.parent, 'start');
    if (/^[+-]?[0-9]+$/.test(startAttr)) index = parseInt(startAttr, 10);
    for (let sibling = n.prevSibling; sibling != null; sibling = sibling.prevSibling) {
      if (sibling.type === 'element' && sibling.data === 'li') index++;
    }
    let style = nodeAttr(n.parent, 'type');
    if (style === '') {
      let depth = 0;
      for (let ancestor = n.parent.parent; ancestor != null; ancestor = ancestor.parent) {
        if (ancestor.type === 'element' && (ancestor.data === 'ol' || ancestor.data === 'ul')) depth++;
      }
      switch (depth) {
        case 0: style = '1'; break;
        case 1: style = 'i'; break;
        default: style = 'a';
      }
    }
    marker = orderedListMarker(index, style);
  }
  return marker;
}

function markdownListDepth(n) {
  let depth = 0;
  if (n == null || n.parent == null) return depth;
  for (let ancestor = n.parent.parent; ancestor != null; ancestor = ancestor.parent) {
    if (ancestor.type === 'element' && (ancestor.data === 'ol' || ancestor.data === 'ul')) depth++;
  }
  return depth;
}

function orderedListMarker(index, style) {
  switch (style.toLowerCase()) {
    case 'a': return lowerAlpha(index) + '.';
    case 'i': return lowerRoman(index) + '.';
    default: return String(index) + '.';
  }
}

function lowerAlpha(index) {
  if (index <= 0) return String(index);
  const out = [];
  while (index > 0) {
    index--;
    out.push(String.fromCharCode(97 + (index % 26)));
    index = Math.trunc(index / 26);
  }
  return out.reverse().join('');
}

function lowerRoman(index) {
  if (index <= 0 || index > 3999) return String(index);
  const values = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [value, text] of values) {
    while (index >= value) {
      out += text;
      index -= value;
    }
  }
  return out;
}

function validateMarkdownSVGNodes(n) {
  if (n.type === 'element') {
    switch (n.data) {
      case 'html': case 'head': case 'body':
      case 'p': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      case 'blockquote': case 'ul': case 'ol': case 'li': case 'pre': case 'code':
      case 'em': case 'b': case 'strong': case 'del': case 's': case 'strike': case 'a': case 'br': case 'hr': case 'img':
      case 'table': case 'thead': case 'tbody': case 'tfoot': case 'tr': case 'td': case 'th':
        break;
      default:
        throw new Error(`native Markdown SVG does not support HTML element <${n.data}>`);
    }
  }
  for (let child = n.firstChild; child != null; child = child.nextSibling) validateMarkdownSVGNodes(child);
}

/**
 * x/net/html parses a document: <script>, <style>, <title>, <meta>, <link> and <base> before any other content land in <head>, which
 * the painter never sees (`doc.Find("body")`). parseBody only builds the body, so drop that leading run first.
 */
function stripLeadingHead(src) {
  let s = src;
  let dropped = false;
  for (;;) {
    let m = /^(?:[ \t\n\r\f]+|<!--[\s\S]*?-->)/.exec(s);
    if (m) { s = s.slice(m[0].length); continue; }
    m = /^<(script|style|title|noscript)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/i.exec(s) ?? /^<(meta|link|base|basefont|bgsound)(?=[\s>/])[^>]*>/i.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
    dropped = true;
  }
  return dropped ? s : src;
}

// ---- MarkdownLayout ----

/**
 * LayoutMarkdown parses Markdown once, measures it with D2's existing box model, and paints that same box model into native SVG
 * primitives. Returns {Width, Height, Primitives, Corpus, svg(opts)}.
 */
export function layoutMarkdown(mdText, ruler, fontFamily, monoFontFamily, fontSize) {
  const render = stripLeadingHead(renderMarkdown(mdText));
  const body = parseBody(render);
  const legacyBody = parseBody(render);
  validateMarkdownSVGNodes(body);
  // the supported characters, checked before measuring
  const check = (n) => {
    if (n.type === 'text') checkSupportedText(ruler, n.data);
    for (let c = n.firstChild; c != null; c = c.nextSibling) check(c);
  };
  check(body);
  normalizeMarkdownWhitespaceTree(body);

  const originalLineHeight = ruler.LineHeightFactor;
  const originalBoundsWithDot = ruler.boundsWithDot;
  ruler.LineHeightFactor = MarkdownLineHeight;
  ruler.boundsWithDot = true;
  try {
    if (fontFamily == null) fontFamily = d2fonts.SourceSansPro;
    if (monoFontFamily == null) monoFontFamily = d2fonts.SourceCodePro;

    const ctx = newPaintContext(fontFamily, monoFontFamily, fontSize);
    const layout = { Width: 0, Height: 0, Primitives: [], Corpus: '', svg: (opts) => svgOf(layout, opts) };
    const p = new MarkdownPainter(ruler, layout);
    // D2's historical Markdown measurements are graph-layout API: changing them moves shapes and routes. Paint with browser-style
    // CSS line boxes below, but retain those established outer dimensions.
    const rootAttrs = measureMarkdownNode(ruler, 0, legacyBody, fontFamily, monoFontFamily, fontSize, 1, d2fonts.FONT_STYLE_REGULAR, false, false, false);
    const contentWidth = Math.ceil(rootAttrs.width);
    const contentHeight = Math.ceil(rootAttrs.height);
    layout.Width = contentWidth;
    layout.Height = contentHeight;
    p.paintBlock(body, 0, 0, ctx, contentWidth);
    let corpus = '';
    for (const primitive of layout.Primitives) if (primitive.Kind === 'text') corpus += primitive.Text;
    layout.Corpus = corpus;
    return layout;
  } finally {
    ruler.LineHeightFactor = originalLineHeight;
    ruler.boundsWithDot = originalBoundsWithDot;
  }
}

// ---- SVG serialization (MarkdownLayout.SVG) ----

const defaultRolePaint = () => ({
  [ColorForeground]: { Class: 'md-color-fg', Color: 'currentColor' },
  [ColorForegroundStroke]: { Class: 'md-stroke-fg', Color: 'currentColor' },
  [ColorMuted]: { Class: 'md-color-muted', Color: 'var(--color-fg-muted, currentColor)' },
  [ColorMutedStroke]: { Class: 'md-stroke-muted', Color: 'var(--color-fg-muted, currentColor)' },
  [ColorAccent]: { Class: 'md-color-accent', Color: 'var(--color-accent-fg, currentColor)' },
  [ColorBorder]: { Class: 'md-color-border', Color: 'var(--color-border-default, currentColor)' },
  [ColorBorderMuted]: { Class: 'md-color-border-muted', Color: 'var(--color-border-muted, currentColor)' },
  [ColorCanvas]: { Class: 'md-color-canvas', Color: 'var(--color-canvas-default, none)' },
  [ColorCanvasSubtle]: { Class: 'md-color-canvas-subtle', Color: 'var(--color-canvas-subtle, none)' },
  [ColorNeutralMuted]: { Class: 'md-color-neutral-muted', Color: 'var(--color-neutral-muted, none)' },
});

const defaultFontClasses = () => ({
  regular: 'text', semibold: 'text-semibold', bold: 'text-bold', italic: 'text-italic',
  mono: 'text-mono', 'mono-semibold': 'text-mono-semibold', 'mono-bold': 'text-mono-bold', 'mono-italic': 'text-mono-italic',
});

// the d2svg callers pass role names in Go's field naming; map them to the role strings
const ROLE_KEYS = {
  Foreground: ColorForeground, ForegroundStroke: ColorForegroundStroke, Muted: ColorMuted, MutedStroke: ColorMutedStroke, Accent: ColorAccent,
  Border: ColorBorder, BorderMuted: ColorBorderMuted, Canvas: ColorCanvas, CanvasSubtle: ColorCanvasSubtle, NeutralMuted: ColorNeutralMuted,
};

function mdFloat(v) {
  if (Math.abs(v) < 0.0005) v = 0;
  return goFixed(v, 3);
}

const dangerousPrefix = (url, prefix) => url.length >= prefix.length && url.slice(0, prefix.length).toLowerCase() === prefix;
function isDangerousURL(url) {
  if (dangerousPrefix(url, 'data:image/') && url.length >= 11) {
    const v = url.slice(11);
    if (dangerousPrefix(v, 'png') || dangerousPrefix(v, 'gif') || dangerousPrefix(v, 'jpeg') || dangerousPrefix(v, 'webp')) return false;
    return true;
  }
  return dangerousPrefix(url, 'javascript:') || dangerousPrefix(url, 'vbscript:') || dangerousPrefix(url, 'file:') || dangerousPrefix(url, 'data:');
}

/** SafeMarkdownLink returns link when it is safe to expose as interactive metadata and an empty string for unsafe schemes */
export function safeMarkdownLink(link) {
  link = trimSpace(link);
  if (link === '') return '';
  // Browsers ignore ASCII controls and whitespace in URI schemes. Normalize them before applying goldmark's dangerous-URL policy.
  const normalized = Array.from(link).filter((ch) => !/[\p{Cc}\s]/u.test(ch) && !/[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(ch)).join('');
  if (isDangerousURL(normalized)) return '';
  return link;
}

function svgOf(layout, opts) {
  const cls = opts.Class === '' || opts.Class == null ? 'md md-native' : opts.Class;
  const rolePaint = defaultRolePaint();
  for (const [k, paint] of Object.entries(opts.RolePaint ?? {})) rolePaint[ROLE_KEYS[k] ?? k] = paint;
  const fontClasses = { ...defaultFontClasses(), ...(opts.FontClasses ?? {}) };

  let out = `<g class="${escapeText(cls)}">`;
  for (const primitive of layout.Primitives) {
    const classes = [];
    if (primitive.Kind === 'text') {
      classes.push('md-text');
      const fc = fontClasses[primitive.Font];
      if (fc) classes.push(fc);
    }
    const fillPaint = rolePaint[primitive.FillRole] ?? { Class: '', Color: '' };
    const strokePaint = rolePaint[primitive.StrokeRole] ?? { Class: '', Color: '' };
    if (fillPaint.Class !== '') classes.push(fillPaint.Class);
    if (strokePaint.Class !== '') classes.push(strokePaint.Class);
    const classAttr = classes.length > 0 ? ` class="${escapeText(classes.join(' '))}"` : '';
    let fill = fillPaint.Color;
    let stroke = strokePaint.Color;
    const link = safeMarkdownLink(primitive.Link);
    if (link !== '' && !opts.DisableLinks) {
      const l = escapeText(link);
      out += `<a href="${l}" xlink:href="${l}">`;
      if (primitive.LinkTitle !== '') out += `<title>${escapeText(primitive.LinkTitle)}</title>`;
    }

    switch (primitive.Kind) {
      case 'rect':
        out += `<rect x="${mdFloat(primitive.X)}" y="${mdFloat(primitive.Y)}" width="${mdFloat(primitive.Width)}" height="${mdFloat(primitive.Height)}" rx="${mdFloat(primitive.Radius)}"${classAttr}`;
        if (fill === '') fill = 'none';
        out += ` fill="${escapeText(fill)}"`;
        if (stroke !== '' && primitive.StrokeWidth > 0) out += ` stroke="${escapeText(stroke)}" stroke-width="${mdFloat(primitive.StrokeWidth)}"`;
        out += '/>';
        break;
      case 'line':
        if (stroke === '') stroke = 'currentColor';
        out += `<line x1="${mdFloat(primitive.X)}" y1="${mdFloat(primitive.Y)}" x2="${mdFloat(primitive.X2)}" y2="${mdFloat(primitive.Y2)}"${classAttr} stroke="${escapeText(stroke)}" stroke-width="${mdFloat(primitive.StrokeWidth)}"/>`;
        break;
      case 'text': {
        if (fill === '') fill = 'currentColor';
        out += `<text x="${mdFloat(primitive.X)}" y="${mdFloat(primitive.Y)}"${classAttr} fill="${escapeText(fill)}" font-size="${mdFloat(primitive.FontSize)}" xml:space="preserve"`;
        let decoration = primitive.Decoration;
        if (opts.Underline) decoration = decoration === '' ? 'underline' : 'underline ' + decoration;
        if (decoration !== '') out += ` text-decoration="${escapeText(decoration)}"`;
        if (primitive.SyntheticBold) out += ' font-weight="bold"';
        if (primitive.SyntheticItalic) out += ' font-style="italic"';
        if (primitive.TextLength) out += ` textLength="${mdFloat(primitive.Width)}" lengthAdjust="spacingAndGlyphs"`;
        out += `>${escapeText(primitive.Text)}</text>`;
        break;
      }
    }
    if (link !== '' && !opts.DisableLinks) out += '</a>';
  }
  out += '</g>';
  return out;
}
