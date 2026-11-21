// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Helpers that reproduce Go semantics the D2 port depends on (see docs/d2-port.md, "Go semantics to watch"):
// math.Round, int conversion, math.Pow, strconv.FormatFloat and fmt's %f/%v/%.Nf for float64.

/** Go's math.Round: half away from zero (JS Math.round rounds half up). */
export const goRound = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Go's int(f): truncation toward zero (NaN and out-of-range are implementation defined in Go; 0 here). */
export const goInt = (f) => (Number.isFinite(f) ? Math.trunc(f) : 0);

/** Go's float64(float32(x)). */
export const float32 = (x) => Math.fround(x);

// Go's math.Pow for an integer exponent uses repeated squaring over frexp'd mantissas, which can differ from
// V8's pow in the last bit. Port of the integer path; other cases fall back to Math.pow.
function frexp(f) {
  if (f === 0 || !Number.isFinite(f)) return [f, 0];
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, f);
  let hi = buf.getUint32(0);
  let exp = (hi >>> 20) & 0x7ff;
  let add = 0;
  if (exp === 0) { // subnormal
    f *= 2 ** 52; add = -52;
    buf.setFloat64(0, f); hi = buf.getUint32(0); exp = (hi >>> 20) & 0x7ff;
  }
  const e = exp - 1022 + add;
  buf.setUint32(0, (hi & ~(0x7ff << 20)) | (1022 << 20));
  return [buf.getFloat64(0), e];
}
function ldexp(frac, exp) {
  // exact for the ranges used here
  return frac * 2 ** exp;
}
export function goPow(x, y) {
  if (y === 0 || x === 1) return 1;
  if (y === 1) return x;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return Math.pow(x, y);
  if (y === 0.5) return Math.sqrt(x);
  if (y === -0.5) return 1 / Math.sqrt(x);
  let yi = Math.trunc(Math.abs(y));
  const yf = Math.abs(y) - yi;
  if (yf !== 0) return Math.pow(x, y); // Go uses Exp(yf*Log(x)) here; not bit-identical to V8
  if (yi >= 2 ** 63) return Math.pow(x, y);
  let a1 = 1.0, ae = 0;
  let [x1, xe] = frexp(x);
  for (let i = BigInt(yi); i !== 0n; i >>= 1n) {
    if (xe < -(1 << 12) || (1 << 12) < xe) {
      ae += xe;
      break;
    }
    if (i & 1n) { a1 *= x1; ae += xe; }
    x1 *= x1;
    xe <<= 1;
    if (x1 < 0.5) { x1 += x1; xe--; }
  }
  if (y < 0) { a1 = 1 / a1; ae = -ae; }
  return ldexp(a1, ae);
}

/** Expand a JS number's shortest round-trip digits to a plain decimal string (no exponent). */
function plain(n) {
  let s = String(Math.abs(n));
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (m) {
    const digits = m[1] + (m[2] || '');
    const exp = Number(m[3]) + m[1].length; // position of the decimal point within digits
    if (exp <= 0) s = '0.' + '0'.repeat(-exp) + digits;
    else if (exp >= digits.length) s = digits + '0'.repeat(exp - digits.length);
    else s = digits.slice(0, exp) + '.' + digits.slice(exp);
  }
  return s;
}

/** strconv.FormatFloat(f, 'f', -1, 64). */
export function goFloat(f) {
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  const neg = f < 0 || Object.is(f, -0);
  return (neg ? '-' : '') + plain(f);
}

/** fmt's %v / %g for float64 (shortest repr, exponent if exp < -4 || exp >= 21). */
export function goV(f) {
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  const neg = f < 0 || Object.is(f, -0);
  const a = Math.abs(f);
  if (a === 0) return neg ? '-0' : '0';
  // decimal exponent of the leading digit
  const e = Number(a.toExponential().split('e')[1]);
  if (e < -4 || e >= 21) {
    const [mant, ex] = a.toExponential().split('e');
    const exn = Number(ex);
    return (neg ? '-' : '') + mant + 'e' + (exn < 0 ? '-' : '+') + String(Math.abs(exn)).padStart(2, '0');
  }
  return (neg ? '-' : '') + plain(a);
}

/** fmt's %.{prec}f for float64 (exact decimal expansion, ties to even like Go). */
export function goFixed(f, prec = 6) {
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  const neg = f < 0 || Object.is(f, -0);
  const a = Math.abs(f);
  if (a >= 1e21) {
    let s = BigInt(a).toString();
    if (prec > 0) s += '.' + '0'.repeat(prec);
    return (neg ? '-' : '') + s;
  }
  let s = a.toFixed(prec);
  // JS toFixed rounds exact ties up; Go rounds them to even
  const long = a.toFixed(Math.min(100, prec + 40));
  const tail = long.slice(long.indexOf('.') + 1 + prec);
  if (/^50*$/.test(tail)) {
    const trunc = long.slice(0, long.indexOf('.') + 1 + prec).replace(/\.$/, '');
    const lastDigit = Number(trunc[trunc.length - 1] === '.' ? trunc[trunc.length - 2] : trunc[trunc.length - 1]);
    if (lastDigit % 2 === 0) s = trunc;
  }
  return (neg ? '-' : '') + s;
}

/** Go's %d / strconv.Itoa of int(f). */
export const goItoa = (f) => String(goInt(f));
