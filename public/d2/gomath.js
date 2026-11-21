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

// Go evaluates constant expressions with arbitrary precision and rounds once, so `a/b` of two decimal constants is
// the correctly rounded exact quotient, not fl(a)/fl(b). exactDiv does that for decimal strings ("18.925", "1.5e3").
function decToBig(s) {
  const m = /^([+-]?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(s);
  const frac = m[3] || '';
  let exp = Number(m[4] || 0) - frac.length;
  let n = BigInt((m[2] || '0') + frac);
  if (m[1] === '-') n = -n;
  return [n, exp]; // n * 10^exp
}
const bitLength = (x) => x.toString(2).length;
/** correctly rounded (half-to-even) double of the exact quotient of two decimal constants */
export function exactDiv(a, b) {
  let [an, ae] = decToBig(a);
  let [bn, be] = decToBig(b);
  let num = an, den = bn;
  const e = ae - be;
  if (e >= 0) num *= 10n ** BigInt(e); else den *= 10n ** BigInt(-e);
  const neg = (num < 0n) !== (den < 0n);
  if (num < 0n) num = -num;
  if (den < 0n) den = -den;
  if (num === 0n) return 0;
  // scale so the integer quotient has at least 66 bits
  const k = Math.max(0, 66 - (bitLength(num) - bitLength(den)));
  const q0 = (num << BigInt(k)) / den;
  const sticky = (num << BigInt(k)) % den !== 0n;
  let q = (q0 << 1n) | (sticky ? 1n : 0n);
  const L = bitLength(q);
  const shift = L - 53;
  let mant = q >> BigInt(shift);
  const rem = q & ((1n << BigInt(shift)) - 1n);
  const half = 1n << BigInt(shift - 1);
  if (rem > half || (rem === half && (mant & 1n) === 1n)) mant += 1n;
  const v = Number(mant) * 2 ** (shift - k - 1);
  return neg ? -v : v;
}
/** Go's untyped constant math.Sqrt2 to 64 digits, for exactDiv expressions such as 40/math.Sqrt2 */
export const SQRT2_DEC = '1.41421356237309504880168872420969807856967187537694807317667974';

/** Go's math.Log2 and math.Log10: Log2(x) = Log(frac)*(1/Ln2) + exp (exact for powers of two); Log10 = Log2 * (Ln2/Ln10). */
export function goLog2(x) {
  const [frac, exp] = frexp(x);
  // Frexp returns frac in [0.5, 1); Go special-cases exactly 0.5 (powers of two)
  if (frac === 0.5) return exp - 1;
  return Math.log(frac) * 1.442695040888963407359924681001892137 + exp;
}
export const goLog10 = (x) => goLog2(x) * 0.30102999566398119521373889472449302677;

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
