// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The font side of d2svg's `fonts: 'embed'` mode: the bundled TrueType faces (public/d2/fonts/*.ttf, loaded on demand) and
// d2fonts' Font.GetEncodedSubset on top of fontsubset.js. Nothing here is imported by d2svg.js directly; `renderAsync` loads
// this module (and then only the faces a diagram uses) when it embeds fonts.

import * as d2fonts from './fonts.js';
import { getEncodedSubset as cutAndEncode } from './fontsubset.js';
import { NeedAsset } from './d2svg.js';

const faces = new Map(); // file name -> Uint8Array

/** where the font files are served from (default: fonts/ next to this module) */
let baseURL = new URL('./fonts/', import.meta.url);
export function setFontBaseURL(u) { baseURL = new URL(u, import.meta.url); }

/** Registers a face by file name (for callers that load the bytes themselves). */
export function setFont(file, bytes) { faces.set(file, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }

/** Loads one font file (fetch in browsers, fs in Node). */
export async function loadFont(file) {
  if (faces.has(file)) return;
  const u = new URL(file, baseURL);
  if (typeof process !== 'undefined' && process.versions?.node && u.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    faces.set(file, new Uint8Array(await fs.readFile(u)));
  } else {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`d2svg: cannot load font ${u}: ${res.status}`);
    faces.set(file, new Uint8Array(await res.arrayBuffer()));
  }
}

/** Loads every bundled face (tests; a page only needs the ones its diagrams use). */
export async function loadAllFonts() {
  for (const file of new Set(Object.values(d2fonts.FONT_FILES))) await loadFont(file);
}

/** Font.GetEncodedSubset: the data: URL (WOFF) of the family's style cut down to the characters of corpus. */
export function getEncodedSubset(family, style, corpus) {
  const file = d2fonts.FONT_FILES[`${family}-${style}`];
  if (file === undefined) throw new Error(`d2svg: no bundled font ${family} ${style}`);
  const face = faces.get(file);
  if (face === undefined) throw new NeedAsset('font', file);
  return cutAndEncode(face, corpus);
}
