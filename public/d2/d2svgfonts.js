// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The font side of d2svg's `fonts: 'embed'` mode: the bundled TrueType faces (public/d2/fonts/*.ttf, loaded on demand) and
// d2fonts' Font.GetEncodedSubset on top of fontsubset.js. Nothing here is imported by d2svg.js directly; `renderAsync` loads
// this module (and then only the faces a diagram uses) when it embeds fonts.

import * as d2fonts from './fonts.js';
import { getEncodedSubset as cutAndEncode } from './fontsubset.js';
import { NeedAsset } from './d2svg.js';
import { setFontBaseURL, setFont, loadFont, fontBytes } from './fontglyphs.js';

// the face store (bytes, loading, base URL) is shared with the Markdown measurer: fontglyphs.js
export { setFontBaseURL, setFont, loadFont };

/** Loads every bundled face (tests; a page only needs the ones its diagrams use). */
export async function loadAllFonts() {
  for (const file of new Set(Object.values(d2fonts.FONT_FILES))) await loadFont(file);
}

/** Font.GetEncodedSubset: the data: URL (WOFF) of the family's style cut down to the characters of corpus. */
export function getEncodedSubset(family, style, corpus) {
  const file = d2fonts.FONT_FILES[`${family}-${style}`];
  if (file === undefined) throw new Error(`d2svg: no bundled font ${family} ${style}`);
  const face = fontBytes(file);
  if (face === undefined) throw new NeedAsset('font', file);
  return cutAndEncode(face, corpus);
}
