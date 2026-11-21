// JavaScript port of the part of Go's compress/flate and compress/zlib (Go 1.27, BSD-3-Clause, Copyright 2009 The Go
// Authors) that D2's lib/font/woff_compression.go runs: one zlib stream per font table at the default compression level
// (level 6), written as Write(data); Flush(); Close() on a fresh writer. Go 1.27's flate encodes levels 1-6 with the fast
// encoders (level6.go here) and Huffman blocks from huffman_bit_writer.go; every decision is reproduced so the bytes are
// identical to Go's. Not covered (unused by D2): levels other than 6, dictionaries, streaming output, Reset reuse.
//
// Only the bit stream matters, not how Go chunks its writes, so the bit writer below keeps a small accumulator and appends
// whole bytes to the output instead of Go's 64-bit register and 246-byte buffer.

export const maxStoreBlockSize = 65535;
const maxMatchLength = 258;
const baseMatchOffset = 1;
const baseMatchLength = 3;
const maxMatchOffset = 1 << 15;
const tableBits = 15;
const tableSize = 1 << tableBits;
const allocHistory = maxStoreBlockSize * 5;
const lengthShift = 22;
const offsetMask = (1 << lengthShift) - 1;
const matchType = 1 << 30;
const matchOffsetOnlyMask = 0xffff;
const offsetCodeCount = 30;
const endBlockMarker = 256;
const lengthCodesStart = 257;
const codegenCodeCount = 19;
const badCode = 255;
const maxPredefinedTokens = 250;
const literalCount = 286;
const maxBitsLimit = 16;
const lengthExtraBitsMinCode = 8;
const offsetExtraBitsMinCode = 4;
const MaxInt32 = 0x7fffffff;

// ---- token.go tables, derived from RFC 1951 ----

const lengthBase = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 255];
const lengthExtraBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0];
const offsetExtraBits = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];
const offsetCombined = [0x0, 0x0, 0x0, 0x0, 0x401, 0x601, 0x802, 0xc02, 0x1003, 0x1803, 0x2004, 0x3004, 0x4005, 0x6005, 0x8006, 0xc006,
  0x10007, 0x18007, 0x20008, 0x30008, 0x40009, 0x60009, 0x8000a, 0xc000a, 0x10000b, 0x18000b, 0x20000c, 0x30000c, 0x40000d, 0x60000d, 0x0, 0x0];
const codegenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// lengthCodes[i] is the length code for length i+3 (0..28); length 258 (i=255) is code 28
const lengthCodes = new Uint8Array(256);
{
  const base = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  for (let i = 0; i < 256; i++) {
    const len = i + 3;
    let code = 0;
    for (let c = 0; c < 29; c++) if (base[c] <= len) code = c;
    lengthCodes[i] = code;
  }
  lengthCodes[255] = 28;
}
const lengthCodes1 = Uint8Array.from(lengthCodes, (v) => v + 1);
// offsetCodes[i] is the offset code for distance i+1 (i < 256); offsetCodes14 are the same plus 14, indexed by off>>7
const offsetCodes = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  const d = i + 1;
  if (d <= 4) offsetCodes[i] = d - 1;
  else {
    const n = 31 - Math.clz32(d - 1);
    offsetCodes[i] = 2 * n + (((d - 1) >> (n - 1)) & 1);
  }
}
const offsetCodes14 = Uint32Array.from(offsetCodes, (v) => v + 14);
const offsetCode = (off) => (off < 256 ? offsetCodes[off & 255] : offsetCodes14[(off >>> 7) & 255]);

// ---- tokens ----

class Tokens {
  constructor() {
    this.extraHist = new Uint16Array(32);
    this.offHist = new Uint16Array(32);
    this.litHist = new Uint16Array(256);
    this.nFilled = 0;
    this.n = 0;
    this.tokens = new Uint32Array(65536);
  }

  reset() {
    if (this.n === 0) return;
    this.n = 0;
    this.nFilled = 0;
    this.litHist.fill(0);
    this.extraHist.fill(0);
    this.offHist.fill(0);
  }

  addLiteral(lit) {
    this.tokens[this.n] = lit;
    this.litHist[lit]++;
    this.n = (this.n + 1) & 0xffff;
  }

  /** estimated minimum size for the optimal compression, in bits (float32 arithmetic like Go) */
  estimatedBits() {
    const f = Math.fround;
    let shannon = 0;
    let bits = 0;
    let nMatches = 0;
    const total = this.n + this.nFilled;
    if (total > 0) {
      const invTotal = f(1.0 / f(total));
      for (const v of this.litHist) {
        if (v > 0) {
          const n = f(v);
          shannon = f(shannon + f(Math.min(15, Math.max(1, -mFastLog2(f(n * invTotal)))) * n));
        }
      }
      // Just add 15 for EOB
      shannon = f(shannon + 15);
      for (let i = 0; i < literalCount - 256 - 1; i++) {
        const v = this.extraHist[1 + i];
        if (v > 0) {
          const n = f(v);
          shannon = f(shannon + f(Math.min(15, Math.max(1, -mFastLog2(f(n * invTotal)))) * n));
          bits += lengthExtraBits[i & 31] * v;
          nMatches += v;
        }
      }
    }
    if (nMatches > 0) {
      const invTotal = f(1.0 / f(nMatches));
      for (let i = 0; i < offsetCodeCount; i++) {
        const v = this.offHist[i];
        if (v > 0) {
          const n = f(v);
          shannon = f(shannon + f(Math.min(15, Math.max(1, -mFastLog2(f(n * invTotal)))) * n));
          bits += offsetExtraBits[i & 31] * v;
        }
      }
    }
    return Math.trunc(shannon) + bits;
  }

  /** xlength is length-3, xoffset is offset-1 */
  addMatchLong(xlength, xoffset) {
    const oc = offsetCode(xoffset);
    xoffset = (xoffset | (oc << 16)) >>> 0;
    while (xlength > 0) {
      let xl = xlength;
      if (xl > 258) {
        // We need to have at least baseMatchLength left over for next loop.
        if (xl > 258 + baseMatchLength) xl = 258;
        else xl = 258 - baseMatchLength;
      }
      xlength -= xl;
      xl -= baseMatchLength;
      this.extraHist[lengthCodes1[xl & 255]]++;
      this.offHist[oc & 31]++;
      this.tokens[this.n] = (matchType | (xl << lengthShift) | xoffset) >>> 0;
      this.n = (this.n + 1) & 0xffff;
    }
  }

  addEOB() {
    this.tokens[this.n] = endBlockMarker;
    this.extraHist[0]++;
    this.n = (this.n + 1) & 0xffff;
  }
}

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
// mFastLog2 returns a fast approximation of log2(val) (float32 bit tricks)
function mFastLog2(val) {
  f32[0] = val;
  let ux = i32[0];
  let log2 = Math.fround(((ux >> 23) & 255) - 128);
  ux &= -0x7f800001;
  ux += 127 << 23;
  i32[0] = ux;
  const uval = f32[0];
  const f = Math.fround;
  log2 = f(log2 + f(f(f(f(f(-0.34484843) * uval) + f(2.02466578)) * uval) - f(0.67487759)));
  return log2;
}

// ---- huffman_code.go ----

const newhcode = (code, length) => (length | (code << 8)) >>> 0;
const hlen = (h) => h & 0xff;
const hcode64 = (h) => h >>> 8;

function reverseBits(x, b) {
  x = (x << ((16 - b) & 15)) & 0xffff;
  let r = 0;
  for (let i = 0; i < 16; i++) { r = (r << 1) | (x & 1); x >>= 1; }
  return r & 0xffff;
}

class HuffmanEncoder {
  constructor(size) {
    this.codes = new Uint32Array(size);
    this.bitCount = new Int32Array(17);
  }

  bitLength(freq) {
    let total = 0;
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i];
      if (f !== 0) total += f * hlen(this.codes[i]);
    }
    return total;
  }

  /** the number of bits to encode freq, or MaxInt32 if freq cannot be encoded */
  canEncodeLen(freq) {
    let total = 0;
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i];
      if (f !== 0) {
        const code = this.codes[i];
        if (code === 0) return MaxInt32;
        total += f * hlen(code);
      }
    }
    return total;
  }

  // list: array of {literal, freq} in order of increasing frequency, with room for the max node at index n
  bitCounts(list, maxBits) {
    const n = list.length;
    list.push({ literal: 0xffff, freq: 0xffff });
    if (maxBits > n - 1) maxBits = n - 1;

    const levels = [];
    for (let i = 0; i < maxBitsLimit + 1; i++) levels.push({ level: 0, lastFreq: 0, nextCharFreq: 0, nextPairFreq: 0, needed: 0 });
    const leafCounts = [];
    for (let i = 0; i < maxBitsLimit; i++) leafCounts.push(new Int32Array(maxBitsLimit));

    for (let level = 1; level <= maxBits; level++) {
      levels[level] = {
        level,
        lastFreq: list[1].freq,
        nextCharFreq: list[2].freq,
        nextPairFreq: list[0].freq + list[1].freq,
        needed: 0,
      };
      leafCounts[level][level] = 2;
      if (level === 1) levels[level].nextPairFreq = MaxInt32;
    }

    // We need a total of 2*n - 2 items at top level and have already generated 2.
    levels[maxBits].needed = 2 * n - 4;

    let level = maxBits;
    while (level < 16) {
      const l = levels[level];
      if (l.nextPairFreq === MaxInt32 && l.nextCharFreq === MaxInt32) {
        // We've run out of both leafs and pairs. End all calculations for this level.
        l.needed = 0;
        levels[level + 1].nextPairFreq = MaxInt32;
        level++;
        continue;
      }

      const prevFreq = l.lastFreq;
      if (l.nextCharFreq < l.nextPairFreq) {
        // The next item on this row is a leaf node.
        const nn = leafCounts[level][level] + 1;
        l.lastFreq = l.nextCharFreq;
        // Lower leafCounts are the same of the previous node.
        leafCounts[level][level] = nn;
        const e = list[nn];
        if (e.literal < 0xffff) l.nextCharFreq = e.freq;
        else l.nextCharFreq = MaxInt32;
      } else {
        // The next item on this row is a pair from the previous row.
        l.lastFreq = l.nextPairFreq;
        // Take leaf counts from the lower level, except counts[level] remains the same.
        const save = leafCounts[level][level];
        leafCounts[level] = Int32Array.from(leafCounts[level - 1]);
        leafCounts[level][level] = save;
        levels[l.level - 1].needed = 2;
      }

      if (--l.needed === 0) {
        // We've done everything we need to do for this level.
        if (l.level === maxBits) break; // All done!
        levels[l.level + 1].nextPairFreq = prevFreq + l.lastFreq;
        level++;
      } else {
        // If we stole from below, move down temporarily to replenish it.
        while (levels[level - 1].needed > 0) level--;
      }
    }

    if (leafCounts[maxBits][maxBits] !== n) throw new Error('leafCounts[maxBits][maxBits] != n');

    const bitCount = this.bitCount;
    let bits = 1;
    const counts = leafCounts[maxBits];
    for (let lv = maxBits; lv > 0; lv--) {
      // chain.leafCount gives the number of literals requiring at least "bits" bits to encode.
      bitCount[bits] = counts[lv] - counts[lv - 1];
      bits++;
    }
    return maxBits + 1;
  }

  assignEncodingAndSize(bitCountLen, list) {
    let code = 0;
    let end = list.length;
    for (let n = 0; n < bitCountLen; n++) {
      const bits = this.bitCount[n];
      code = (code << 1) & 0xffff;
      if (n === 0 || bits === 0) continue;
      // The literals list[end-bits] .. list[end] are encoded using "bits" bits, and get the values code, code+1, ...
      // The code values are assigned in literal order (not frequency order).
      const chunk = list.slice(end - bits, end);
      chunk.sort((a, b) => a.literal - b.literal);
      for (const node of chunk) {
        this.codes[node.literal] = newhcode(reverseBits(code, n), n);
        code = (code + 1) & 0xffff;
      }
      end -= bits;
    }
  }

  /** rewrites this to be the Huffman code for the frequency count (freq: array-like of uint16) */
  generate(freq, maxBits) {
    const list = [];
    for (let i = 0; i < freq.length; i++) {
      if (freq[i] !== 0) list.push({ literal: i, freq: freq[i] });
      else this.codes[i] = 0;
    }
    const count = list.length;
    if (count <= 2) {
      // With two or fewer literals, everything has bit length 1.
      list.forEach((node, i) => { this.codes[node.literal] = newhcode(i, 1); });
      return;
    }
    list.sort((a, b) => ((a.freq << 10) + a.literal) - ((b.freq << 10) + b.literal));

    // Get the number of literals for each bit count
    const bitCountLen = this.bitCounts(list, maxBits);
    // And do the assignment (bitCounts appended the max node; drop it first)
    list.pop();
    this.assignEncodingAndSize(bitCountLen, list);
  }
}

const fixedLiteralEncoding = (() => {
  const h = new HuffmanEncoder(literalCount);
  for (let ch = 0; ch < literalCount; ch++) {
    let bits, size;
    if (ch < 144) { bits = ch + 48; size = 8; }
    else if (ch < 256) { bits = ch + 400 - 144; size = 9; }
    else if (ch < 280) { bits = ch - 256; size = 7; }
    else { bits = ch + 192 - 280; size = 8; }
    h.codes[ch] = newhcode(reverseBits(bits, size), size);
  }
  return h;
})();
const fixedOffsetEncoding = (() => {
  const h = new HuffmanEncoder(30);
  for (let ch = 0; ch < 30; ch++) h.codes[ch] = newhcode(reverseBits(ch, 5), 5);
  return h;
})();

function histogram(b, h) {
  for (let i = 0; i < b.length; i++) h[b[i]]++;
}

// ---- huffman_bit_writer.go ----

class HuffmanBitWriter {
  constructor() {
    this.out = [];
    this.acc = 0; // pending bits (fewer than 8 after each write)
    this.nacc = 0;
    this.wroteHuffman = false;
    this.literalEncoding = new HuffmanEncoder(literalCount);
    this.tmpLitEncoding = new HuffmanEncoder(literalCount);
    this.offsetEncoding = new HuffmanEncoder(offsetCodeCount);
    this.codegenEncoding = new HuffmanEncoder(codegenCodeCount);
    this.prevHeader = 0;
    this.logNewTablePenalty = 7;
    this.literalFreq = new Uint16Array(lengthCodesStart + 32);
    this.offsetFreq = new Uint16Array(32);
    this.codegenFreq = new Uint16Array(codegenCodeCount);
    this.codegen = new Uint8Array(literalCount + offsetCodeCount + 1);
  }

  writeBits(b, nb) {
    // b < 2^16 and nacc < 8 keep acc below 2^24
    this.acc |= b << this.nacc;
    this.nacc += nb;
    while (this.nacc >= 8) {
      this.out.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nacc -= 8;
    }
  }

  writeCode(c) { this.writeBits(hcode64(c), hlen(c)); }

  /** flushes the currently encoded data; an EOB is written if the current block hasn't been ended */
  flush() {
    if (this.prevHeader > 0) {
      // We owe an EOB
      this.writeCode(this.literalEncoding.codes[endBlockMarker]);
      this.prevHeader = 0;
    }
    if (this.nacc > 0) {
      this.out.push(this.acc & 0xff);
      this.acc = 0;
      this.nacc = 0;
    }
  }

  writeBytes(bytes) {
    // flush() ran before: the pending bits are a whole number of bytes (none)
    for (let i = 0; i < bytes.length; i++) this.out.push(bytes[i]);
  }

  generateCodegen(numLiterals, numOffsets, litEnc, offEnc) {
    this.codegenFreq.fill(0);
    const codegen = this.codegen;
    for (let i = 0; i < numLiterals; i++) codegen[i] = hlen(litEnc.codes[i]);
    for (let i = 0; i < numOffsets; i++) codegen[numLiterals + i] = hlen(offEnc.codes[i]);
    codegen[numLiterals + numOffsets] = badCode;

    let size = codegen[0];
    let count = 1;
    let outIndex = 0;
    for (let inIndex = 1; size !== badCode; inIndex++) {
      // INVARIANT: We have seen "count" copies of size that have not yet had output generated for them.
      const nextSize = codegen[inIndex];
      if (nextSize === size) {
        count++;
        continue;
      }
      // We need to generate codegen indicating "count" of size.
      if (size !== 0) {
        codegen[outIndex++] = size;
        this.codegenFreq[size]++;
        count--;
        while (count >= 3) {
          const n = Math.min(6, count);
          codegen[outIndex++] = 16;
          codegen[outIndex++] = n - 3;
          this.codegenFreq[16]++;
          count -= n;
        }
      } else {
        while (count >= 11) {
          const n = Math.min(138, count);
          codegen[outIndex++] = 18;
          codegen[outIndex++] = n - 11;
          this.codegenFreq[18]++;
          count -= n;
        }
        if (count >= 3) {
          // count >= 3 && count <= 10
          codegen[outIndex++] = 17;
          codegen[outIndex++] = count - 3;
          this.codegenFreq[17]++;
          count = 0;
        }
      }
      count--;
      for (; count >= 0; count--) {
        codegen[outIndex++] = size;
        this.codegenFreq[size]++;
      }
      // Set up invariant for next time through the loop.
      size = nextSize;
      count = 1;
    }
    // Marker indicating the end of the codegen.
    codegen[outIndex] = badCode;
  }

  codegens() {
    let numCodegens = this.codegenFreq.length;
    while (numCodegens > 4 && this.codegenFreq[codegenOrder[numCodegens - 1]] === 0) numCodegens--;
    return numCodegens;
  }

  /** [size, numCodegens] */
  headerSize() {
    const numCodegens = this.codegens();
    return [3 + 5 + 5 + 4 + 3 * numCodegens + this.codegenEncoding.bitLength(this.codegenFreq) +
      this.codegenFreq[16] * 2 + this.codegenFreq[17] * 3 + this.codegenFreq[18] * 7, numCodegens];
  }

  dynamicReuseSize(litEnc, offEnc) {
    return litEnc.bitLength(this.literalFreq) + offEnc.bitLength(this.offsetFreq);
  }

  /** [size, numCodegens] */
  dynamicSize(litEnc, offEnc, extraBits) {
    const [header, numCodegens] = this.headerSize();
    return [header + litEnc.bitLength(this.literalFreq) + offEnc.bitLength(this.offsetFreq) + extraBits, numCodegens];
  }

  extraBitSize() {
    let total = 0;
    for (let i = 0; i < literalCount - 257; i++) total += this.literalFreq[257 + i] * lengthExtraBits[i & 31];
    for (let i = 0; i < offsetCodeCount; i++) total += this.offsetFreq[i] * offsetExtraBits[i & 31];
    return total;
  }

  fixedSize(extraBits) {
    return 3 + fixedLiteralEncoding.bitLength(this.literalFreq) + fixedOffsetEncoding.bitLength(this.offsetFreq) + extraBits;
  }

  /** [sizeInBits, storable] */
  storedSize(input) {
    if (input == null) return [0, false];
    if (input.length <= maxStoreBlockSize) return [(input.length + 5) * 8, true];
    return [0, false];
  }

  writeDynamicHeader(numLiterals, numOffsets, numCodegens, isEof) {
    const firstBits = isEof ? 5 : 4;
    this.writeBits(firstBits, 3);
    this.writeBits(numLiterals - 257, 5);
    this.writeBits(numOffsets - 1, 5);
    this.writeBits(numCodegens - 4, 4);

    for (let i = 0; i < numCodegens; i++) this.writeBits(hlen(this.codegenEncoding.codes[codegenOrder[i]]), 3);

    let i = 0;
    for (;;) {
      const codeWord = this.codegen[i++];
      if (codeWord === badCode) break;
      this.writeCode(this.codegenEncoding.codes[codeWord]);

      switch (codeWord) {
        case 16: this.writeBits(this.codegen[i++], 2); break;
        case 17: this.writeBits(this.codegen[i++], 3); break;
        case 18: this.writeBits(this.codegen[i++], 7); break;
      }
    }
  }

  /** a stored header; a stored block used only for EOF is replaced with a fixed huffman block */
  writeStoredHeader(length, isEof) {
    if (this.prevHeader > 0) {
      // We owe an EOB
      this.writeCode(this.literalEncoding.codes[endBlockMarker]);
      this.prevHeader = 0;
    }

    // To write EOF, use a fixed encoding block. 10 bits instead of 5 bytes.
    if (length === 0 && isEof) {
      this.writeFixedHeader(isEof);
      // EOB: 7 bits, value: 0
      this.writeBits(0, 7);
      this.flush();
      return;
    }

    this.writeBits(isEof ? 1 : 0, 3);
    this.flush();
    this.writeBits(length, 16);
    this.writeBits(~length & 0xffff, 16);
  }

  writeFixedHeader(isEof) {
    if (this.prevHeader > 0) {
      // We owe an EOB
      this.writeCode(this.literalEncoding.codes[endBlockMarker]);
      this.prevHeader = 0;
    }
    // Indicate that we are a fixed Huffman block
    this.writeBits(isEof ? 3 : 2, 3);
  }

  writeBlockDynamic(tokens, eof, input, sync) {
    sync = sync || eof;
    if (sync) tokens.addEOB();
    else tokens.extraHist[0] = 1; // Ensure we can always write EOB.

    // We cannot reuse pure Huffman table, and must mark as EOF.
    if ((this.wroteHuffman || eof) && this.prevHeader > 0) {
      // We will not try to reuse.
      this.writeCode(this.literalEncoding.codes[endBlockMarker]);
      this.prevHeader = 0;
      this.wroteHuffman = false;
    }

    if (this.prevHeader > 0 && !this.canReuse(tokens)) {
      this.writeCode(this.literalEncoding.codes[endBlockMarker]);
      this.prevHeader = 0;
    }

    let [numLiterals, numOffsets] = this.indexTokens(tokens);
    let extraBits = 0;
    const [ssize, storable] = this.storedSize(input);

    if (storable || this.prevHeader > 0) extraBits = this.extraBitSize();

    let size;

    // Check whether we should reuse the previous Huffman table.
    if (this.prevHeader > 0) {
      // Estimate size for using a new table. Use the previous header size as the best estimate.
      let newSize = this.prevHeader + tokens.estimatedBits();

      // The estimated size is calculated as an optimal table. We add a penalty to make it more realistic and re-use a bit more.
      newSize += hlen(this.literalEncoding.codes[endBlockMarker]) + (newSize >> this.logNewTablePenalty);

      // Calculate the size for reusing the current table.
      const reuseSize = this.dynamicReuseSize(this.literalEncoding, this.offsetEncoding) + extraBits;

      // Check if a new table is better.
      if (newSize < reuseSize) {
        // Write the EOB we owe.
        this.writeCode(this.literalEncoding.codes[endBlockMarker]);
        size = newSize;
        this.prevHeader = 0;
      } else {
        size = reuseSize;
      }

      // Small blocks can be more efficient with fixed encoding.
      if (tokens.n < maxPredefinedTokens) {
        const preSize = this.fixedSize(extraBits) + 7;
        if (preSize < size) {
          // Check if we get a reasonable size decrease.
          if (storable && ssize <= size) {
            this.writeStoredHeader(input.length, eof);
            this.writeBytes(input);
            return;
          }
          this.writeFixedHeader(eof);
          if (!sync) tokens.addEOB();
          this.writeTokens(tokens, fixedLiteralEncoding.codes, fixedOffsetEncoding.codes);
          return;
        }
      }

      // Check if we get a reasonable size decrease.
      if (storable && ssize <= size) {
        this.writeStoredHeader(input.length, eof);
        this.writeBytes(input);
        return;
      }
    }

    // We want a new block/table
    if (this.prevHeader === 0) {
      this.literalFreq[endBlockMarker] = 1;

      this.generate();
      // Generate codegen and codegenFrequencies, which indicates how to encode the literalEncoding and the offsetEncoding.
      this.generateCodegen(numLiterals, numOffsets, this.literalEncoding, this.offsetEncoding);
      this.codegenEncoding.generate(this.codegenFreq, 7);

      let numCodegens;
      [size, numCodegens] = this.dynamicSize(this.literalEncoding, this.offsetEncoding, extraBits);

      // Store predefined or raw, if we don't get a reasonable improvement.
      if (tokens.n < maxPredefinedTokens) {
        const preSize = this.fixedSize(extraBits);
        if (preSize <= size) {
          // Store bytes, if we don't get an improvement.
          if (storable && ssize <= preSize) {
            this.writeStoredHeader(input.length, eof);
            this.writeBytes(input);
            return;
          }
          this.writeFixedHeader(eof);
          if (!sync) tokens.addEOB();
          this.writeTokens(tokens, fixedLiteralEncoding.codes, fixedOffsetEncoding.codes);
          return;
        }
      }

      if (storable && ssize <= size) {
        // Store bytes, if we don't get an improvement.
        this.writeStoredHeader(input.length, eof);
        this.writeBytes(input);
        return;
      }

      // Write Huffman table.
      this.writeDynamicHeader(numLiterals, numOffsets, numCodegens, eof);
      if (!sync) [this.prevHeader] = this.headerSize();
      this.wroteHuffman = false;
    }

    if (sync) this.prevHeader = 0;
    // Write the tokens.
    this.writeTokens(tokens, this.literalEncoding.codes, this.offsetEncoding.codes);
  }

  canReuse(t) {
    for (let i = 0; i < offsetCodeCount; i++) if (t.offHist[i] !== 0 && this.offsetEncoding.codes[i] === 0) return false;
    for (let i = 0; i < literalCount - 256; i++) if (t.extraHist[i] !== 0 && this.literalEncoding.codes[256 + i] === 0) return false;
    for (let i = 0; i < 256; i++) if (t.litHist[i] !== 0 && this.literalEncoding.codes[i] === 0) return false;
    return true;
  }

  /** updates literalFreq and offsetFreq; returns [numLiterals, numOffsets] */
  indexTokens(t) {
    this.literalFreq.set(t.litHist, 0);
    this.literalFreq.set(t.extraHist, 256);
    this.offsetFreq.set(t.offHist);

    if (t.n === 0) return [0, 0];
    // get the number of literals
    let numLiterals = this.literalFreq.length;
    while (this.literalFreq[numLiterals - 1] === 0) numLiterals--;
    // get the number of offsets
    let numOffsets = this.offsetFreq.length;
    while (numOffsets > 0 && this.offsetFreq[numOffsets - 1] === 0) numOffsets--;
    if (numOffsets === 0) {
      // We haven't found a single match. If we want to go with the dynamic encoding, we should count at least one offset to be
      // sure that the offset huffman tree could be encoded.
      this.offsetFreq[0] = 1;
      numOffsets = 1;
    }
    return [numLiterals, numOffsets];
  }

  generate() {
    this.literalEncoding.generate(this.literalFreq.subarray(0, literalCount), 15);
    this.offsetEncoding.generate(this.offsetFreq.subarray(0, offsetCodeCount), 15);
  }

  writeTokens(tokens, lenCodes, offCodes) {
    const n = tokens.n;
    if (n === 0) return;
    const toks = tokens.tokens;
    // Only last token should be endBlockMarker.
    let end = n;
    let deferEOB = false;
    if (toks[n - 1] === endBlockMarker) {
      end = n - 1;
      deferEOB = true;
    }
    for (let i = 0; i < end; i++) {
      const t = toks[i];
      if (t < 256) {
        this.writeCode(lenCodes[t]);
        continue;
      }
      // Write the length
      const length = (t >>> lengthShift) & 0xff;
      const lenCode = lengthCodes[length] & 31;
      this.writeCode(lenCodes[lengthCodesStart + lenCode]);

      if (lenCode >= lengthExtraBitsMinCode) {
        const extraLength = length - lengthBase[lenCode];
        this.writeBits(extraLength, lengthExtraBits[lenCode]);
      }
      // Write the offset
      const offset = t & offsetMask;
      const offCode = (offset >>> 16) & 31;
      this.writeCode(offCodes[offCode]);

      if (offCode >= offsetExtraBitsMinCode) {
        const offsetComb = offsetCombined[offCode];
        this.writeBits((offset - (offsetComb >>> 8)) & matchOffsetOnlyMask, offsetComb & 0xff);
      }
    }
    if (deferEOB) this.writeCode(lenCodes[endBlockMarker]);
  }

  writeBlockHuff(eof, input, sync) {
    // Clear histogram
    this.literalFreq.fill(0);
    if (!this.wroteHuffman) this.offsetFreq.fill(0);

    const numLiterals = endBlockMarker + 1;
    const numOffsets = 1;

    // Estimate size of literal encoding.
    const guessHeaderSizeBits = 70 * 8; // 70 bytes; see https://stackoverflow.com/a/25454430
    histogram(input, this.literalFreq);
    const [ssize, storable] = this.storedSize(input);
    if (storable && input.length > 1024) {
      // Quick check for incompressible content: all frequencies lie close to the average frequency.
      let abs = 0;
      const avg = input.length / 256;
      const max = input.length * 2;
      for (let i = 0; i < 256; i++) {
        const diff = this.literalFreq[i] - avg;
        abs += diff * diff;
        if (abs >= max) break;
      }
      if (abs < max) {
        // No chance we can compress this...
        this.writeStoredHeader(input.length, eof);
        this.writeBytes(input);
        return;
      }
    }
    this.literalFreq[endBlockMarker] = 1;
    this.tmpLitEncoding.generate(this.literalFreq.subarray(0, numLiterals), 15);
    let estBits = this.tmpLitEncoding.canEncodeLen(this.literalFreq.subarray(0, numLiterals));
    if (estBits < MaxInt32) {
      estBits += this.prevHeader;
      if (this.prevHeader === 0) estBits += guessHeaderSizeBits;
      estBits += estBits >> this.logNewTablePenalty;
    }

    // Store bytes, if we don't get a reasonable improvement.
    if (storable && ssize <= estBits) {
      this.writeStoredHeader(input.length, eof);
      this.writeBytes(input);
      return;
    }

    if (this.prevHeader > 0) {
      const reuseSize = this.literalEncoding.canEncodeLen(this.literalFreq.subarray(0, 256));
      if (estBits < reuseSize) {
        // We owe an EOB
        this.writeCode(this.literalEncoding.codes[endBlockMarker]);
        this.prevHeader = 0;
      }
    }

    if (this.prevHeader === 0) {
      // Use the temp encoding, so swap.
      [this.literalEncoding, this.tmpLitEncoding] = [this.tmpLitEncoding, this.literalEncoding];
      // Generate codegen and codegenFrequencies, which indicates how to encode the literalEncoding and the offsetEncoding.
      this.generateCodegen(numLiterals, numOffsets, this.literalEncoding, huffOffset());
      this.codegenEncoding.generate(this.codegenFreq, 7);
      const numCodegens = this.codegens();

      // Huffman.
      this.writeDynamicHeader(numLiterals, numOffsets, numCodegens, eof);
      this.wroteHuffman = true;
      [this.prevHeader] = this.headerSize();
    }

    const encoding = this.literalEncoding.codes;
    for (let i = 0; i < input.length; i++) this.writeCode(encoding[input[i]]);

    if (eof || sync) {
      this.writeCode(this.literalEncoding.codes[endBlockMarker]);
      this.prevHeader = 0;
      this.wroteHuffman = false;
    }
  }
}

let huffOffsetEnc = null;
function huffOffset() {
  if (huffOffsetEnc === null) {
    const freq = new Uint16Array(32);
    freq[0] = 1;
    huffOffsetEnc = new HuffmanEncoder(offsetCodeCount);
    huffOffsetEnc.generate(freq.subarray(0, offsetCodeCount), 15);
  }
  return huffOffsetEnc;
}

// ---- deflatefast.go / level6.go ----

const P4 = 0x9E3779B1; // prime4bytes (2654435761)
// prime7bytes = 58295818150454627 as two 32-bit halves
const P7 = 58295818150454627n;
const P7_LO = Number(P7 & 0xffffffffn);
const P7_HI = Number(P7 >> 32n);

function mulhi(a, b) {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const w0 = a0 * b0;
  const t = a1 * b0 + (w0 >>> 16);
  let w1 = (t & 0xffff) + a0 * b1;
  const w2 = t >>> 16;
  return (a1 * b1 + w2 + (w1 >>> 16)) >>> 0;
}

/** hashLen(u, 15, 4) for u with low 32 bits lo */
const hashShort = (lo) => Math.imul(lo, P4) >>> (32 - tableBits);

/** hashLen(u, 15, 7): top 15 bits of the low 64 bits of (u << 8) * prime7bytes, u = hi:lo */
function hashLong(lo, hi) {
  const xlo = (lo << 8) >>> 0;
  const xhi = ((hi << 8) | (lo >>> 24)) >>> 0;
  const rhi = (mulhi(xlo, P7_LO) + Math.imul(xlo, P7_HI) + Math.imul(xhi, P7_LO)) >>> 0;
  return rhi >>> (32 - tableBits);
}

function loadLE32(b, i) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function matchLen(a, ai, alen, b, bi) {
  let n = 0;
  while (n < alen && a[ai + n] === b[bi + n]) n++;
  return n;
}

class FastEncL6 {
  constructor() {
    this.hist = new Uint8Array(allocHistory);
    this.histLen = 0;
    this.cur = maxStoreBlockSize;
    this.table = new Int32Array(tableSize);
    this.bCur = new Int32Array(tableSize);
    this.bPrev = new Int32Array(tableSize);
  }

  addBlock(src) {
    // check if we have space already
    if (this.histLen + src.length > allocHistory) {
      // Move down
      const offset = this.histLen - maxMatchOffset;
      this.hist.copyWithin(0, offset, offset + maxMatchOffset);
      this.cur += offset;
      this.histLen = maxMatchOffset;
    }
    const s = this.histLen;
    this.hist.set(src, s);
    this.histLen += src.length;
    return s;
  }

  matchLenLimited(s, t, src) {
    const alen = Math.min(s + maxMatchLength - 4, this.histLen) - s;
    return matchLen(src, s, alen, src, t);
  }

  matchLenLong(s, t, src) {
    return matchLen(src, s, this.histLen - s, src, t);
  }

  setLong(h, offset) {
    this.bPrev[h] = this.bCur[h];
    this.bCur[h] = offset;
  }

  encode(dst, srcBlock) {
    const inputMargin = 12 - 1;
    const minNonLiteralBlockSize = 1 + 1 + inputMargin;
    const skipLog = 7;
    const doEvery = 1;
    const table = this.table, bCur = this.bCur, bPrev = this.bPrev;

    let s = this.addBlock(srcBlock);
    if (srcBlock.length < minNonLiteralBlockSize) {
      // We do not fill the token table. This will be picked up by caller.
      dst.n = srcBlock.length;
      return;
    }

    // Override src
    const src = this.hist;
    const srcLen = this.histLen;

    // nextEmit is where in src the next emitLiterals should start from.
    let nextEmit = s;

    // sLimit is when to stop looking for offset/length copies.
    const sLimit = srcLen - inputMargin;

    let cvLo = loadLE32(src, s), cvHi = loadLE32(src, s + 4);
    // Repeat MUST be > 1 and within range
    let repeat = 1;
    emit: for (;;) {
      let nextS = s;
      let l = 0;
      let t = 0;
      search: for (;;) {
        let nextHashS = hashShort(cvLo);
        let nextHashL = hashLong(cvLo, cvHi);
        s = nextS;
        nextS = s + doEvery + ((s - nextEmit) >> skipLog);
        if (nextS > sLimit) break emit;
        // Fetch a short+long candidate
        const sCandidate = table[nextHashS];
        let lCur = bCur[nextHashL], lPrev = bPrev[nextHashL];
        const nextLo = loadLE32(src, nextS), nextHi = loadLE32(src, nextS + 4);
        const entry = s + this.cur;
        table[nextHashS] = entry;
        this.setLong(nextHashL, entry);

        // Calculate hashes of 'next'
        nextHashS = hashShort(nextLo);
        nextHashL = hashLong(nextLo, nextHi);

        t = lCur - this.cur;
        if (s - t < maxMatchOffset) {
          if (cvLo === loadLE32(src, t)) {
            // Long candidate matches at least 4 bytes.

            // Store the next match
            table[nextHashS] = nextS + this.cur;
            this.setLong(nextHashL, nextS + this.cur);

            // Check the previous long candidate as well.
            const t2 = lPrev - this.cur;
            if (s - t2 < maxMatchOffset && cvLo === loadLE32(src, t2)) {
              l = this.matchLenLimited(s + 4, t + 4, src) + 4;
              const ml1 = this.matchLenLimited(s + 4, t2 + 4, src) + 4;
              if (ml1 > l) {
                t = t2;
                l = ml1;
                break search;
              }
            }
            break search;
          }
          // Current value did not match, but check if previous long value does.
          t = lPrev - this.cur;
          if (s - t < maxMatchOffset && cvLo === loadLE32(src, t)) {
            // Store the next match
            table[nextHashS] = nextS + this.cur;
            this.setLong(nextHashL, nextS + this.cur);
            break search;
          }
        }

        t = sCandidate - this.cur;
        if (s - t < maxMatchOffset && cvLo === loadLE32(src, t)) {
          // Found a 4 match...
          l = this.matchLenLimited(s + 4, t + 4, src) + 4;

          // Look up next long candidate (at nextS)
          lCur = bCur[nextHashL];
          lPrev = bPrev[nextHashL];

          // Store the next match
          table[nextHashS] = nextS + this.cur;
          this.setLong(nextHashL, nextS + this.cur);

          // Check repeat at s + repOff
          const repOff = 1;
          let t2 = s - repeat + repOff;
          const cv8 = ((cvLo >>> 8) | (cvHi << 24)) >>> 0; // uint32(cv >> 8)
          if (loadLE32(src, t2) === cv8) {
            const ml = this.matchLenLimited(s + 4 + repOff, t2 + 4, src) + 4;
            if (ml > l) {
              t = t2;
              l = ml;
              s += repOff;
              // Not worth checking more.
              break search;
            }
          }

          // If the next long is a candidate, use that...
          t2 = lCur - this.cur;
          if (nextS - t2 < maxMatchOffset) {
            if (loadLE32(src, t2) === nextLo) {
              const ml = this.matchLenLimited(nextS + 4, t2 + 4, src) + 4;
              if (ml > l) {
                t = t2;
                s = nextS;
                l = ml;
                // This is ok, but check previous as well.
              }
            }
            // If the previous long is a candidate, use that...
            t2 = lPrev - this.cur;
            if (nextS - t2 < maxMatchOffset && loadLE32(src, t2) === nextLo) {
              const ml = this.matchLenLimited(nextS + 4, t2 + 4, src) + 4;
              if (ml > l) {
                t = t2;
                s = nextS;
                l = ml;
                break search;
              }
            }
          }
          break search;
        }
        cvLo = nextLo;
        cvHi = nextHi;
      }

      // Extend the 4-byte match as long as possible.
      if (l === 0) l = this.matchLenLong(s + 4, t + 4, src) + 4;
      else if (l === maxMatchLength) l += this.matchLenLong(s + l, t + l, src);

      // Try to locate a better match by checking the end-of-match...
      const sAt = s + l;
      if (sAt < sLimit) {
        // Allow some bytes at the beginning to mismatch.
        const skipBeginning = 2;
        const h = hashLong(loadLE32(src, sAt), loadLE32(src, sAt + 4));
        // Test current
        let t2 = bCur[h] - this.cur - l + skipBeginning;
        const s2 = s + skipBeginning;
        const off = s2 - t2;
        if (off < maxMatchOffset) {
          if (off > 0 && t2 >= 0) {
            const l2 = this.matchLenLong(s2, t2, src);
            if (l2 > l) {
              t = t2;
              l = l2;
              s = s2;
            }
          }
          // Test previous entry:
          t2 = bPrev[h] - this.cur - l + skipBeginning;
          const off2 = s2 - t2;
          if (off2 > 0 && off2 < maxMatchOffset && t2 >= 0) {
            const l2 = this.matchLenLong(s2, t2, src);
            if (l2 > l) {
              t = t2;
              l = l2;
              s = s2;
            }
          }
        }
      }

      // Extend backwards
      while (t > 0 && s > nextEmit && src[t - 1] === src[s - 1]) {
        s--;
        t--;
        l++;
      }
      if (nextEmit < s) {
        for (let i = nextEmit; i < s; i++) {
          const v = src[i];
          dst.tokens[dst.n] = v;
          dst.litHist[v]++;
          dst.n = (dst.n + 1) & 0xffff;
        }
      }

      dst.addMatchLong(l, s - t - baseMatchOffset);
      repeat = s - t;
      s += l;
      nextEmit = s;
      if (nextS >= s) s = nextS + 1;

      if (s >= sLimit) {
        // Index after match end.
        for (let i = nextS + 1; i < srcLen - 8; i += 2) {
          const lo = loadLE32(src, i), hi = loadLE32(src, i + 4);
          table[hashShort(lo)] = i + this.cur;
          this.setLong(hashLong(lo, hi), i + this.cur);
        }
        break emit;
      }

      // Store every long hash in-between and every second short.
      for (let i = nextS + 1; i < s - 1; i += 2) {
        const lo = loadLE32(src, i), hi = loadLE32(src, i + 4);
        const tv = i + this.cur;
        const t2v = tv + 1;
        const h1 = hashLong(lo, hi);
        const h2 = hashLong(((lo >>> 8) | (hi << 24)) >>> 0, hi >>> 8);
        table[hashShort(lo)] = tv;
        this.setLong(h1, tv);
        this.setLong(h2, t2v);
      }
      cvLo = loadLE32(src, s);
      cvHi = loadLE32(src, s + 4);
    }

    // emitRemainder
    if (nextEmit < srcLen) {
      // If nothing was added, don't encode literals.
      if (dst.n === 0) return;
      for (let i = nextEmit; i < srcLen; i++) {
        const v = src[i];
        dst.tokens[dst.n] = v;
        dst.litHist[v]++;
        dst.n = (dst.n + 1) & 0xffff;
      }
    }
  }
}

// ---- deflate.go (levels 1-6) ----

class Compressor {
  constructor() {
    this.w = new HuffmanBitWriter();
    this.w.logNewTablePenalty = 7;
    this.fast = new FastEncL6();
    this.window = new Uint8Array(maxStoreBlockSize);
    this.windowEnd = 0;
    this.tokens = new Tokens();
    this.sync = false;
  }

  writeStoredBlock(buf) {
    this.w.writeStoredHeader(buf.length, false);
    this.w.writeBytes(buf);
  }

  deflateFast() {
    // We only compress if we have maxStoreBlockSize.
    if (this.windowEnd < this.window.length) {
      if (!this.sync) return;
      // Handle extremely small sizes.
      if (this.windowEnd < 128) {
        if (this.windowEnd === 0) return;
        if (this.windowEnd <= 32) this.writeStoredBlock(this.window.subarray(0, this.windowEnd));
        else this.w.writeBlockHuff(false, this.window.subarray(0, this.windowEnd), true);
        this.tokens.reset();
        this.windowEnd = 0;
        // fast.reset(): the encoder is not used for another block of this stream
        this.fast.histLen = 0;
        return;
      }
    }

    const win = this.window.subarray(0, this.windowEnd);
    this.fast.encode(this.tokens, win);
    // If we made zero matches, store the block as is.
    if (this.tokens.n === 0) {
      this.writeStoredBlock(win);
      // If we removed less than 1/16th, huffman compress the block.
    } else if (this.tokens.n > this.windowEnd - (this.windowEnd >> 4)) {
      this.w.writeBlockHuff(false, win, this.sync);
    } else {
      this.w.writeBlockDynamic(this.tokens, false, win, this.sync);
    }
    this.tokens.reset();
    this.windowEnd = 0;
  }

  write(b) {
    let off = 0;
    while (off < b.length) {
      if (this.windowEnd === this.window.length || this.sync) this.deflateFast();
      const n = Math.min(b.length - off, this.window.length - this.windowEnd);
      this.window.set(b.subarray(off, off + n), this.windowEnd);
      this.windowEnd += n;
      off += n;
    }
  }

  syncFlush() {
    this.sync = true;
    this.deflateFast();
    this.w.writeStoredHeader(0, false);
    this.w.flush();
    this.sync = false;
  }

  close() {
    this.sync = true;
    this.deflateFast();
    this.w.writeStoredHeader(0, true);
    this.w.flush();
  }
}

// ---- zlib ----

function adler32(data) {
  let a = 1, b = 0;
  const mod = 65521;
  for (let i = 0; i < data.length; i += 5552) {
    const end = Math.min(i + 5552, data.length);
    for (let j = i; j < end; j++) {
      a += data[j];
      b += a;
    }
    a %= mod;
    b %= mod;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * zlib.NewWriter(w); Write(data); Flush(); Close(): a zlib stream at the default level. Returns a Uint8Array.
 * Empty data writes only the header, the sync marker and the final block, as Go does.
 */
export function zlibCompress(data) {
  const c = new Compressor();
  const out = [];
  // writeHeader (level -1 = 6): 0x78, 2<<6, fixed up so the 16 bit header is a multiple of 31
  let h1 = 0x78, h2 = 2 << 6;
  h2 += 31 - ((h1 << 8) | h2) % 31;
  out.push(h1, h2 & 0xff);
  if (data.length > 0) c.write(data);
  c.syncFlush();
  c.close();
  const body = c.w.out;
  const res = new Uint8Array(2 + body.length + 4);
  res[0] = h1; res[1] = h2 & 0xff;
  for (let i = 0; i < body.length; i++) res[2 + i] = body[i];
  const sum = adler32(data);
  res[res.length - 4] = sum >>> 24; res[res.length - 3] = (sum >>> 16) & 0xff; res[res.length - 2] = (sum >>> 8) & 0xff; res[res.length - 1] = sum & 0xff;
  return res;
}
