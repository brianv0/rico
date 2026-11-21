// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's lib/font (github.com/d2lang/d2 v0.9.0): font.go (Sfnt2Woff, itself a port of
// github.com/fontello/ttf2woff) and subsetFont.go (UTF8CutFont, from github.com/jung-kurt/gofpdf, MIT, Copyright (c) 2019
// Arteom Korotkiy), plus d2fonts' Font.GetEncodedSubset. Together they cut a TrueType font down to the glyphs of a corpus and
// wrap it as a WOFF, byte for byte as Go does (the zlib streams come from flate.js).
//
// The subsetter reads only these tables of the input: head, hhea, maxp, cmap, loca, glyf, hmtx, name, cvt, fpgm, prep, gasp,
// post and OS/2, so the font files shipped under public/d2/fonts/ keep only those.

import { zlibCompress } from './flate.js';

// flags
const symbolWords = 1 << 0;
const symbolScale = 1 << 3;
const symbolContinue = 1 << 5;
const symbolAllScale = 1 << 6;
const symbol2x2 = 1 << 7;

const sortInts = (keys) => keys.sort((a, b) => a - b);
const asciiName = (b) => String.fromCharCode(b[0], b[1], b[2], b[3]);

class Utf8FontFile {
  constructor(buf) {
    this.array = buf;
    this.pos = 0;
    this.tableDescriptions = null;
    this.outTablesData = null;
    this.symbolOffsets = null;
    this.charSymbolDictionary = null;
  }

  read(n) {
    const b = this.array.subarray(this.pos, this.pos + n);
    if (b.length !== n) throw new RangeError('font: read past the end');
    this.pos += n;
    return b;
  }

  readUint16() { const s = this.read(2); return (s[0] << 8) + s[1]; }

  readUint32() { const s = this.read(4); return s[0] * 16777216 + (s[1] << 16) + (s[2] << 8) + s[3]; }

  /** the quirky readInt16 of gofpdf comes out as the signed 16 bit value */
  readInt16() { const s = this.read(2); return (((s[0] << 8) + s[1]) << 16) >> 16; }

  seek(shift) { this.pos = shift; }

  skip(delta) { this.pos += delta; }

  getUint16(pos) { this.seek(pos); const s = this.read(2); return (s[0] << 8) + s[1]; }

  seekTable(name) {
    this.seek(this.tableDescriptions.get(name).position);
    return this.pos;
  }

  getRange(pos, length) {
    this.seek(pos);
    if (length < 1) return new Uint8Array(0);
    return this.read(length);
  }

  getTableData(name) {
    const d = this.tableDescriptions.get(name);
    if (d === undefined) return null;
    if (d.size === 0) return null;
    this.seek(d.position);
    return this.read(d.size);
  }

  /** copy of stream with value written at offset */
  splice(stream, offset, value) {
    const out = Uint8Array.from(stream);
    out.set(value, offset);
    return out;
  }

  insertUint16(stream, offset, value) {
    return this.splice(stream, offset, Uint8Array.of((value >> 8) & 0xff, value & 0xff));
  }

  setOutTable(name, data) {
    if (data === null) return;
    if (name === 'head') data = this.splice(data, 8, Uint8Array.of(0, 0, 0, 0));
    this.outTablesData.set(name, data);
  }

  generateTableDescriptions() {
    const tablesCount = this.readUint16();
    this.readUint16();
    this.readUint16();
    this.readUint16();
    this.tableDescriptions = new Map();
    for (let i = 0; i < tablesCount; i++) {
      const name = asciiName(this.read(4));
      this.skip(4); // Skip the input table checksum; output checksums are recalculated.
      this.tableDescriptions.set(name, { position: this.readUint32(), size: this.readUint32() });
    }
  }

  generateChecksum(data) {
    if (data.length % 4 !== 0) {
      const padded = new Uint8Array(data.length + (4 - (data.length % 4)));
      padded.set(data);
      data = padded;
    }
    const answer = [0, 0];
    for (let i = 0; i < data.length; i += 4) {
      answer[0] += (data[i] << 8) + data[i + 1];
      answer[1] += (data[i + 2] << 8) + data[i + 3];
      answer[0] += answer[1] >> 16;
      answer[1] &= 0xFFFF;
      answer[0] &= 0xFFFF;
    }
    return answer;
  }

  calcInt32(x, y) {
    x = [x[0], x[1]];
    const answer = [0, 0];
    if (y[1] > x[1]) {
      x[1] += 1 << 16;
      x[0]++;
    }
    answer[1] = x[1] - y[1];
    if (y[0] > x[0]) x[0] += 1 << 16;
    answer[0] = x[0] - y[0];
    answer[0] &= 0xFFFF;
    return answer;
  }

  generateCMAP() {
    const cmapPosition = this.seekTable('cmap');
    this.skip(2);
    const cmapTableCount = this.readUint16();
    let runeCmapPosition = 0;
    for (let i = 0; i < cmapTableCount; i++) {
      const system = this.readUint16();
      const coder = this.readUint16();
      const position = this.readUint32();
      const oldPosition = this.pos;
      if ((system === 3 && coder === 1) || system === 0) {
        const format = this.getUint16(cmapPosition + position);
        if (format === 4) {
          runeCmapPosition = cmapPosition + position;
          break;
        }
      }
      this.seek(oldPosition);
    }

    if (runeCmapPosition === 0) return null; // "Font does not have cmap for Unicode"

    const charSymbolDictionary = new Map();
    this.generateCharSymbolDictionary(runeCmapPosition, charSymbolDictionary);
    return charSymbolDictionary;
  }

  generateCharSymbolDictionary(runeCmapPosition, charSymbolDictionary) {
    this.seek(runeCmapPosition + 2);
    const size = this.readUint16();
    const rim = runeCmapPosition + size;
    this.skip(2);

    const segmentSize = this.readUint16() / 2;
    this.skip(6);
    const completers = [];
    for (let i = 0; i < segmentSize; i++) completers.push(this.readUint16());
    this.skip(2);
    const beginners = [];
    for (let i = 0; i < segmentSize; i++) beginners.push(this.readUint16());
    const sizes = [];
    for (let i = 0; i < segmentSize; i++) sizes.push(this.readInt16());
    const readerPositionStart = this.pos;
    const positions = [];
    for (let i = 0; i < segmentSize; i++) positions.push(this.readUint16());
    let symbol;
    for (let n = 0; n < segmentSize; n++) {
      const completePosition = completers[n] + 1;
      for (let char = beginners[n]; char < completePosition; char++) {
        if (positions[n] === 0) {
          symbol = (char + sizes[n]) & 0xFFFF;
        } else {
          let position = (char - beginners[n]) * 2 + positions[n];
          position = readerPositionStart + 2 * n + position;
          if (position >= rim) {
            symbol = 0;
          } else {
            symbol = this.getUint16(position);
            if (symbol !== 0) symbol = (symbol + sizes[n]) & 0xFFFF;
          }
        }
        charSymbolDictionary.set(char, symbol);
      }
    }
  }

  /** the original table snapshot, decoded lazily */
  parseLOCATable(format, numSymbols) {
    const start = this.seekTable('loca');
    this.symbolOffsets = { data: null, width: 0 };
    let width = 0;
    switch (format) {
      case 0: width = 2; break;
      case 1: width = 4; break;
      default:
        return; // "Unknown loca table format"
    }
    // Read the full table now, retaining the original truncation check and reader position. Copy the bytes because later
    // metric extraction can mutate the input.
    const data = Uint8Array.from(this.getRange(start, (numSymbols + 1) * width));
    this.symbolOffsets = { data, width };
  }

  locaAt(index) {
    const { data, width } = this.symbolOffsets;
    const count = width !== 0 ? Math.trunc(data.length / width) : 0;
    if (index >= count) throw new RangeError('font: glyph index out of range');
    const o = index * width;
    if (width === 2) return ((data[o] << 8) + data[o + 1]) * 2;
    return data[o] * 16777216 + (data[o + 1] << 16) + (data[o + 2] << 8) + data[o + 3];
  }

  parseSymbols(usedRunes) {
    const symbolCollection = new Map([[0, 0]]);
    const charSymbolPairCollection = new Map();
    for (const char of usedRunes) {
      if (this.charSymbolDictionary.has(char)) {
        symbolCollection.set(this.charSymbolDictionary.get(char), char);
        charSymbolPairCollection.set(char, this.charSymbolDictionary.get(char));
      }
    }

    const begin = this.tableDescriptions.get('glyf').position;

    const symbolArray = new Map();
    let symbolCollectionKeys = sortInts([...symbolCollection.keys()]);

    let symbolCounter = 0;
    for (const oldSymbolIndex of symbolCollectionKeys) {
      symbolArray.set(oldSymbolIndex, symbolCounter);
      symbolCounter++;
    }
    const charSymbolPairCollectionKeys = sortInts([...charSymbolPairCollection.keys()]);
    const runeSymbolPairCollection = new Map();
    for (const runa of charSymbolPairCollectionKeys) {
      runeSymbolPairCollection.set(runa, symbolArray.get(charSymbolPairCollection.get(runa)));
    }

    // range evaluates the slice once: composite glyphs found below are appended to the keys but not visited here
    for (const oldSymbolIndex of symbolCollectionKeys.slice()) {
      symbolCollectionKeys = this.getSymbols(oldSymbolIndex, begin, symbolArray, symbolCollection, symbolCollectionKeys);
    }

    return { runeSymbolPairCollection, symbolArray, symbolCollection, symbolCollectionKeys };
  }

  getSymbols(originalSymbolIdx, start, symbolSet, symbolsCollection, symbolsCollectionKeys) {
    const symbolPos = this.locaAt(originalSymbolIdx);
    const symbolSize = this.locaAt(originalSymbolIdx + 1) - symbolPos;
    if (symbolSize === 0) return symbolsCollectionKeys;
    this.seek(start + symbolPos);

    const lineCount = this.readInt16();

    if (lineCount < 0) {
      this.skip(8);
      let flags = symbolContinue;
      while ((flags & symbolContinue) !== 0) {
        flags = this.readUint16();
        const symbolIndex = this.readUint16();
        if (!symbolSet.has(symbolIndex)) {
          symbolSet.set(symbolIndex, symbolsCollection.size);
          symbolsCollection.set(symbolIndex, 1);
          symbolsCollectionKeys.push(symbolIndex);
        }
        const oldPosition = this.pos;
        symbolsCollectionKeys = this.getSymbols(symbolIndex, start, symbolSet, symbolsCollection, symbolsCollectionKeys);
        this.seek(oldPosition);
        if ((flags & symbolWords) !== 0) this.skip(4);
        else this.skip(2);
        if ((flags & symbolScale) !== 0) this.skip(2);
        else if ((flags & symbolAllScale) !== 0) this.skip(4);
        else if ((flags & symbol2x2) !== 0) this.skip(8);
      }
    }
    return symbolsCollectionKeys;
  }

  getMetrics(metricCount, gid) {
    const start = this.seekTable('hmtx');
    let metrics;
    if (gid < metricCount) {
      this.seek(start + gid * 4);
      metrics = Uint8Array.from(this.read(4));
    } else {
      const p = start + (metricCount - 1) * 4;
      this.seek(p);
      this.read(2);
      this.seek(start + metricCount * 2 + gid * 2);
      const b = Uint8Array.from(this.read(2));
      // Go appends the second half to a slice of the font itself, which overwrites the bytes after the advance width in place
      this.array.set(b, p + 2);
      metrics = this.array.slice(p, p + 4);
    }
    return metrics;
  }

  generateCMAPTable(cidSymbolPairCollection, numSymbols) {
    const cidSymbolPairCollectionKeys = sortInts([...cidSymbolPairCollection.keys()]);
    let cidID = 0;
    const cidArray = new Map();
    let prevCid = -2;
    let prevSymbol = -1;
    for (const cid of cidSymbolPairCollectionKeys) {
      if (cid === prevCid + 1 && cidSymbolPairCollection.get(cid) === prevSymbol + 1) {
        if (!cidArray.has(cidID)) cidArray.set(cidID, []);
        cidArray.get(cidID).push(cidSymbolPairCollection.get(cid));
      } else {
        cidID = cid;
        cidArray.set(cidID, []);
        cidArray.get(cidID).push(cidSymbolPairCollection.get(cid));
      }
      prevCid = cid;
      prevSymbol = cidSymbolPairCollection.get(cid);
    }
    const cidArrayKeys = sortInts([...cidArray.keys()]);
    const segCount = cidArray.size + 1;

    let searchRange = 1;
    let entrySelector = 0;
    while (searchRange * 2 <= segCount) {
      searchRange *= 2;
      entrySelector++;
    }
    searchRange *= 2;
    const rangeShift = segCount * 2 - searchRange;

    const data = [0, 1, 3, 1, 0, 12, 4];

    const cmap = [segCount * 2, searchRange, entrySelector, rangeShift];
    for (const start of cidArrayKeys) {
      const endCode = start + (cidArray.get(start).length - 1);
      cmap.push(endCode);
    }
    cmap.push(0xFFFF);
    cmap.push(0);

    cmap.push(...cidArrayKeys);
    cmap.push(0xFFFF);
    for (const cidKey of cidArrayKeys) {
      const idDelta = -(cidKey - cidArray.get(cidKey)[0]);
      cmap.push(idDelta);
    }
    cmap.push(1);
    for (let i = 0; i < cidArray.size; i++) cmap.push(0);
    cmap.push(0);
    for (const start of cidArrayKeys) cmap.push(...cidArray.get(start));
    cmap.push(0);

    // Calculating cmap length based off of fpdf: the 3 extra values are for encodingID, offset, format
    const length = (3 + cmap.length) * 2;
    data.push(length, 0);
    data.push(...cmap);

    const cmapstr = new Uint8Array(data.length * 2);
    data.forEach((cm, i) => { cmapstr[2 * i] = (cm >> 8) & 0xff; cmapstr[2 * i + 1] = cm & 0xff; });
    return cmapstr;
  }

  /** GenerateCutFont: the font with only the glyphs of usedRunes (an array of code points) */
  generateCutFont(usedRunes) {
    this.pos = 0;
    this.outTablesData = new Map();
    this.skip(4);
    this.generateTableDescriptions();

    this.seekTable('head');
    this.skip(50);
    let locaFormat = this.readUint16();

    this.seekTable('hhea');
    this.skip(34);
    let metricsCount = this.readUint16();
    const oldMetrics = metricsCount;

    this.seekTable('maxp');
    this.skip(4);
    let numSymbols = this.readUint16();

    this.charSymbolDictionary = this.generateCMAP();
    if (this.charSymbolDictionary === null) return null;

    this.parseLOCATable(locaFormat, numSymbols);

    const { runeSymbolPairCollection: cidSymbolPairCollection, symbolArray, symbolCollection, symbolCollectionKeys } = this.parseSymbols(usedRunes);

    metricsCount = symbolCollection.size;
    numSymbols = metricsCount;

    this.setOutTable('name', this.getTableData('name'));
    this.setOutTable('cvt ', this.getTableData('cvt '));
    this.setOutTable('fpgm', this.getTableData('fpgm'));
    this.setOutTable('prep', this.getTableData('prep'));
    this.setOutTable('gasp', this.getTableData('gasp'));

    const post = this.getTableData('post');
    const postTable = new Uint8Array(4 + 12 + 16);
    postTable.set([0x00, 0x03, 0x00, 0x00], 0);
    postTable.set(post.subarray(4, 16), 4);
    this.setOutTable('post', postTable);

    cidSymbolPairCollection.delete(0);

    this.setOutTable('cmap', this.generateCMAPTable(cidSymbolPairCollection, numSymbols));

    const symbolData = this.getTableData('glyf');

    const offsets = [];
    const glyfParts = [];
    let pos = 0;
    const hmtxParts = [];

    for (const originalSymbolIdx of symbolCollectionKeys) {
      hmtxParts.push(this.getMetrics(oldMetrics, originalSymbolIdx));

      offsets.push(pos);
      const symbolPos = this.locaAt(originalSymbolIdx);
      const symbolLen = this.locaAt(originalSymbolIdx + 1) - symbolPos;
      let data = symbolData.subarray(symbolPos, symbolPos + symbolLen);
      let up = 0;
      if (symbolLen > 0) up = (data[0] << 8) + data[1];

      if (symbolLen > 2 && (up & (1 << 15)) !== 0) {
        let posInSymbol = 10;
        let flags = symbolContinue;
        while ((flags & symbolContinue) !== 0) {
          up = (data[posInSymbol] << 8) + data[posInSymbol + 1];
          flags = up;
          up = (data[posInSymbol + 2] << 8) + data[posInSymbol + 3];
          const symbolIdx = up;
          data = this.insertUint16(data, posInSymbol + 2, symbolArray.get(symbolIdx) ?? 0);
          posInSymbol += 4;
          if ((flags & symbolWords) !== 0) posInSymbol += 4;
          else posInSymbol += 2;
          if ((flags & symbolScale) !== 0) posInSymbol += 2;
          else if ((flags & symbolAllScale) !== 0) posInSymbol += 4;
          else if ((flags & symbol2x2) !== 0) posInSymbol += 8;
        }
      }

      glyfParts.push(data);
      pos += symbolLen;
      if (pos % 4 !== 0) {
        const padding = 4 - (pos % 4);
        glyfParts.push(new Uint8Array(padding));
        pos += padding;
      }
    }

    offsets.push(pos);
    this.setOutTable('glyf', concat(glyfParts));

    this.setOutTable('hmtx', concat(hmtxParts));

    let locaData;
    if (((pos + 1) >> 1) > 0xFFFF) {
      locaFormat = 1;
      locaData = new Uint8Array(offsets.length * 4);
      offsets.forEach((o, i) => { locaData[4 * i] = (o >>> 24) & 0xff; locaData[4 * i + 1] = (o >>> 16) & 0xff; locaData[4 * i + 2] = (o >>> 8) & 0xff; locaData[4 * i + 3] = o & 0xff; });
    } else {
      locaFormat = 0;
      locaData = new Uint8Array(offsets.length * 2);
      offsets.forEach((o, i) => { const v = Math.trunc(o / 2); locaData[2 * i] = (v >> 8) & 0xff; locaData[2 * i + 1] = v & 0xff; });
    }
    this.setOutTable('loca', locaData);

    let headData = this.getTableData('head');
    headData = this.insertUint16(headData, 50, locaFormat);
    this.setOutTable('head', headData);

    let hheaData = this.getTableData('hhea');
    hheaData = this.insertUint16(hheaData, 34, metricsCount);
    this.setOutTable('hhea', hheaData);

    let maxp = this.getTableData('maxp');
    maxp = this.insertUint16(maxp, 4, numSymbols);
    this.setOutTable('maxp', maxp);

    const os2Data = this.getTableData('OS/2');
    this.setOutTable('OS/2', os2Data);

    return this.assembleTables();
  }

  assembleTables() {
    const tablesCount = this.outTablesData.size;
    let findSize = 1;
    let writer = 0;
    while (findSize * 2 <= tablesCount) {
      findSize *= 2;
      writer++;
    }
    findSize *= 16;
    const rOffset = tablesCount * 16 - findSize;

    const parts = [];
    const header = new Uint8Array(12);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x00010000);
    hv.setUint16(4, tablesCount);
    hv.setUint16(6, findSize);
    hv.setUint16(8, writer);
    hv.setUint16(10, rOffset);
    parts.push(header);

    const tables = this.outTablesData;
    const tablesNames = [...tables.keys()].sort();

    let offset = 12 + tablesCount * 16;
    let begin = 0;

    for (const name of tablesNames) {
      if (name === 'head') begin = offset;
      const entry = new Uint8Array(16);
      for (let i = 0; i < 4; i++) entry[i] = name.charCodeAt(i);
      const checksum = this.generateChecksum(tables.get(name));
      const ev = new DataView(entry.buffer);
      ev.setUint16(4, checksum[0]);
      ev.setUint16(6, checksum[1]);
      ev.setUint32(8, offset);
      ev.setUint32(12, tables.get(name).length);
      parts.push(entry);
      const paddedLength = (tables.get(name).length + 3) & ~3;
      offset += paddedLength;
    }

    for (const key of tablesNames) {
      const t = tables.get(key);
      const padded = new Uint8Array((t.length + 3) & ~3);
      padded.set(t);
      parts.push(padded);
    }

    let answer = concat(parts);
    let checksum = this.generateChecksum(answer);
    checksum = this.calcInt32([0xB1B0, 0xAFBA], checksum);
    answer = this.splice(answer, begin + 8, Uint8Array.of((checksum[0] >> 8) & 0xff, checksum[0] & 0xff, (checksum[1] >> 8) & 0xff, checksum[1] & 0xff));
    return answer;
  }
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * UTF8CutFont: a TrueType font composed only of the runes included in cutset (a string; one glyph per distinct code point).
 * inBuf is not modified. Returns null when the font has no Unicode cmap.
 */
export function utf8CutFont(inBuf, cutset) {
  const f = new Utf8FontFile(inBuf);
  const runes = [];
  for (const ch of cutset) runes.push(ch.codePointAt(0));
  return f.generateCutFont(runes);
}

// ---- font.go: Sfnt2Woff ----

const SIZE_OF_WOFF_HEADER = 44;
const SIZE_OF_WOFF_ENTRY = 20;
const SIZE_OF_SFNT_HEADER = 12;
const SIZE_OF_SFNT_TABLE_ENTRY = 16;
const MAGIC_WOFF = 0x774f4646;
const MAGIC_CHECKSUM_ADJUSTMENT = 0xb1b0afba;

const longAlign = (n) => ((n + 3) & ~3) >>> 0;

function calcChecksum(buf) {
  let sum = 0;
  const nlongs = buf.length >> 2;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < nlongs; i++) sum = (sum + dv.getUint32(i * 4)) >>> 0;
  return sum;
}

/** Sfnt2Woff: fontBuf is modified (the head table's checksum adjustment, as in Go) */
export function sfnt2Woff(fontBuf) {
  const fv = new DataView(fontBuf.buffer, fontBuf.byteOffset, fontBuf.byteLength);
  const numTables = fv.getUint16(4);

  const woffHeader = new Uint8Array(SIZE_OF_WOFF_HEADER);
  const hv = new DataView(woffHeader.buffer);
  hv.setUint32(0, MAGIC_WOFF);
  hv.setUint16(12, numTables);

  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const o = SIZE_OF_SFNT_HEADER + i * SIZE_OF_SFNT_TABLE_ENTRY;
    entries.push({
      tag: fontBuf.subarray(o, o + 4),
      tagStr: asciiName(fontBuf.subarray(o, o + 4)),
      checkSum: fv.getUint32(o + 4),
      offset: fv.getUint32(o + 8),
      length: fv.getUint32(o + 12),
    });
  }
  entries.sort((a, b) => (a.tagStr < b.tagStr ? -1 : a.tagStr > b.tagStr ? 1 : 0));

  let sfntSize = SIZE_OF_SFNT_HEADER + numTables * SIZE_OF_SFNT_TABLE_ENTRY;
  const tableInfo = new Uint8Array(numTables * SIZE_OF_WOFF_ENTRY);
  const tv = new DataView(tableInfo.buffer);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.tagStr !== 'head') {
      const alignTable = fontBuf.subarray(e.offset, e.offset + longAlign(e.length));
      if (calcChecksum(alignTable) !== e.checkSum) throw new Error(`checksum error in table: ${e.tagStr}`);
    }

    tv.setUint32(i * SIZE_OF_WOFF_ENTRY, new DataView(e.tag.buffer, e.tag.byteOffset, 4).getUint32(0));
    tv.setUint32(i * SIZE_OF_WOFF_ENTRY + 12, e.length);
    tv.setUint32(i * SIZE_OF_WOFF_ENTRY + 16, e.checkSum);

    sfntSize = (sfntSize + longAlign(e.length)) >>> 0;
  }

  let sfntOffset = SIZE_OF_SFNT_HEADER + entries.length * SIZE_OF_SFNT_TABLE_ENTRY;
  let csum = calcChecksum(fontBuf.subarray(0, SIZE_OF_SFNT_HEADER));
  for (const e of entries) {
    const b = new Uint8Array(SIZE_OF_SFNT_TABLE_ENTRY);
    const bv = new DataView(b.buffer);
    bv.setUint32(0, new DataView(e.tag.buffer, e.tag.byteOffset, 4).getUint32(0));
    bv.setUint32(4, e.checkSum);
    bv.setUint32(8, sfntOffset);
    bv.setUint32(12, e.length);

    sfntOffset += longAlign(e.length);
    csum = (csum + calcChecksum(b)) >>> 0;
    csum = (csum + e.checkSum) >>> 0;
  }

  const checksumAdjustment = (MAGIC_CHECKSUM_ADJUSTMENT - csum) >>> 0;

  let majorVersion = 0;
  let minVersion = 1;
  let flavor = 0;
  let offset = SIZE_OF_WOFF_HEADER + numTables * SIZE_OF_WOFF_ENTRY;
  const tableBytes = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const sfntData = fontBuf.subarray(e.offset, e.offset + e.length);
    if (e.tagStr === 'head') {
      const sv = new DataView(sfntData.buffer, sfntData.byteOffset, sfntData.byteLength);
      majorVersion = sv.getUint16(4);
      minVersion = sv.getUint16(6);
      flavor = sv.getUint32(0);
      sv.setUint32(8, checksumAdjustment);
    }

    const compressed = zlibCompress(sfntData);

    const compLength = Math.min(compressed.length, sfntData.length);
    const length = longAlign(compLength);

    const table = new Uint8Array(length);
    // only deflate data if the deflated data is actually smaller
    if (compressed.length >= sfntData.length) table.set(sfntData);
    else table.set(compressed);

    tv.setUint32(i * SIZE_OF_WOFF_ENTRY + 4, offset);

    offset += table.length;

    tv.setUint32(i * SIZE_OF_WOFF_ENTRY + 8, compLength);

    tableBytes.push(table);
  }

  const tb = concat(tableBytes);
  const woffSize = woffHeader.length + tableInfo.length + tb.length;
  hv.setUint32(8, woffSize);
  hv.setUint32(16, sfntSize);
  hv.setUint16(20, majorVersion);
  hv.setUint16(22, minVersion);
  hv.setUint32(4, flavor);

  return concat([woffHeader, tableInfo, tb]);
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Font.GetEncodedSubset(corpus): a data: URL with the WOFF of the font cut down to the characters of corpus */
export function getEncodedSubset(ttf, corpus) {
  const unique = [];
  const seen = new Set();
  for (const ch of corpus) {
    if (!seen.has(ch)) { seen.add(ch); unique.push(ch); }
  }
  const cut = utf8CutFont(Uint8Array.from(ttf), unique.join(''));
  const woff = sfnt2Woff(cut);
  return `data:application/font-woff;base64,${toBase64(woff)}`;
}
