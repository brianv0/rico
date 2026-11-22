// node genfonts.mjs <D2 source dir>: writes public/d2/fonts/<name>.ttf, D2's bundled TrueType fonts (d2renderers/d2fonts/ttf) with only the
// tables lib/font's subsetter reads (head hhea maxp cmap loca glyf hmtx name cvt fpgm prep gasp post OS/2). Kerning/GPOS/GSUB are dropped, as
// they are in the subsets D2 embeds. The result is a valid sfnt (checksums recomputed) with the same subsets as the original.
import fs from 'node:fs';
import path from 'node:path';

const KEEP = new Set(['head', 'hhea', 'maxp', 'cmap', 'loca', 'glyf', 'hmtx', 'name', 'cvt ', 'fpgm', 'prep', 'gasp', 'post', 'OS/2']);
const srcDir = path.join(process.argv[2], 'd2renderers/d2fonts/ttf');
const outDir = new URL('../../public/d2/fonts/', import.meta.url);

function checksum(b) {
  let sum = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength - (b.byteLength % 4));
  for (let i = 0; i < dv.byteLength; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}

for (const f of fs.readdirSync(srcDir)) {
  if (!f.endsWith('.ttf')) continue;
  const buf = new Uint8Array(fs.readFileSync(path.join(srcDir, f)));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint16(4);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    const tag = String.fromCharCode(...buf.subarray(o, o + 4));
    if (!KEEP.has(tag)) continue;
    const off = dv.getUint32(o + 8), len = dv.getUint32(o + 12);
    const data = new Uint8Array(len + ((4 - (len % 4)) % 4));
    data.set(buf.subarray(off, off + len));
    tables.push({ tag, len, data });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const count = tables.length;
  let pow = 1, sel = 0;
  while (pow * 2 <= count) { pow *= 2; sel++; }
  const searchRange = pow * 16;
  let size = 12 + 16 * count;
  const offs = [];
  for (const t of tables) { offs.push(size); size += t.data.length; }
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x00010000);
  ov.setUint16(4, count); ov.setUint16(6, searchRange); ov.setUint16(8, sel); ov.setUint16(10, count * 16 - searchRange);
  tables.forEach((t, i) => {
    const o = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[o + k] = t.tag.charCodeAt(k);
    if (t.tag === 'head') t.data.set([0, 0, 0, 0], 8);
    ov.setUint32(o + 4, checksum(t.data));
    ov.setUint32(o + 8, offs[i]);
    ov.setUint32(o + 12, t.len);
    out.set(t.data, offs[i]);
  });
  const headIdx = tables.findIndex((t) => t.tag === 'head');
  const total = checksum(out);
  ov.setUint32(offs[headIdx] + 8, (0xB1B0AFBA - total) >>> 0);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(new URL(f, outDir), out);
  console.log(f, buf.length, '->', out.length);
}
