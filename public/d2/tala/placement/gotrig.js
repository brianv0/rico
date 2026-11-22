// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Go's math.Sin and math.Cos (sin.go, Go 1.24, BSD-3-Clause, Copyright 2009 The Go Authors: the Cephes based implementation that
// amd64 uses) and the pieces of math.Pow that placement needs, for bit-identical results where V8's fdlibm differs in the last bit.
// Used by the stress initialization of the placement package (D2 v0.9.0, d2layouts/d2talalayout/internal/placement).

import { exactDiv } from '../../gomath.js';

const _sin = [
  1.58962301576546568060e-10,
  -2.50507477628578072866e-8,
  2.75573136213857245213e-6,
  -1.98412698295895385996e-4,
  8.33333333332211858878e-3,
  -1.66666666666666307295e-1,
];
const _cos = [
  -1.13585365213876817300e-11,
  2.08757008419747316778e-9,
  -2.75573141792967388112e-7,
  2.48015872888517045348e-5,
  -1.38888888888730564116e-3,
  4.16666666666665929218e-2,
];
const PI4A = 7.85398125648498535156e-1;
const PI4B = 3.77489470793079817668e-8;
const PI4C = 2.69515142907905952645e-15;
const reduceThreshold = 2 ** 29;
/** The Go constant expression 4/Pi, rounded once (Go folds constants with arbitrary precision). */
const FOUR_OVER_PI = exactDiv('4', '3.14159265358979323846264338327950288419716939937510582097494459');

export function goCos(x) {
  if (Number.isNaN(x) || !Number.isFinite(x)) return NaN;
  let sign = false;
  x = Math.abs(x);
  if (x >= reduceThreshold) return Math.cos(x); // Payne-Hanek reduction is not ported: unreachable for placement
  let j = Math.trunc(x * FOUR_OVER_PI);
  let y = j;
  // map zeros to origin
  if (j % 2 === 1) {
    j++;
    y++;
  }
  j &= 7;
  const z = ((x - y * PI4A) - y * PI4B) - y * PI4C;
  if (j > 3) {
    j -= 4;
    sign = !sign;
  }
  if (j > 1) sign = !sign;

  const zz = z * z;
  if (j === 1 || j === 2) {
    y = z + z * zz * ((((((_sin[0] * zz) + _sin[1]) * zz + _sin[2]) * zz + _sin[3]) * zz + _sin[4]) * zz + _sin[5]);
  } else {
    y = 1.0 - 0.5 * zz + zz * zz * ((((((_cos[0] * zz) + _cos[1]) * zz + _cos[2]) * zz + _cos[3]) * zz + _cos[4]) * zz + _cos[5]);
  }
  if (sign) y = -y;
  return y;
}

export function goSin(x) {
  if (x === 0 || Number.isNaN(x)) return x;
  if (!Number.isFinite(x)) return NaN;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  if (x >= reduceThreshold) return sign ? -Math.sin(x) : Math.sin(x);
  let j = Math.trunc(x * FOUR_OVER_PI);
  let y = j;
  if (j % 2 === 1) {
    j++;
    y++;
  }
  j &= 7;
  const z = ((x - y * PI4A) - y * PI4B) - y * PI4C;
  // reflect in x axis
  if (j > 3) {
    sign = !sign;
    j -= 4;
  }
  const zz = z * z;
  if (j === 1 || j === 2) {
    y = 1.0 - 0.5 * zz + zz * zz * ((((((_cos[0] * zz) + _cos[1]) * zz + _cos[2]) * zz + _cos[3]) * zz + _cos[4]) * zz + _cos[5]);
  } else {
    y = z + z * zz * ((((((_sin[0] * zz) + _sin[1]) * zz + _sin[2]) * zz + _sin[3]) * zz + _sin[4]) * zz + _sin[5]);
  }
  if (sign) y = -y;
  return y;
}

function frexp(f) {
  if (f === 0 || !Number.isFinite(f)) return [f, 0];
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, f);
  let hi = buf.getUint32(0);
  let exp = (hi >>> 20) & 0x7ff;
  let add = 0;
  if (exp === 0) { // subnormal
    f *= 2 ** 52;
    add = -52;
    buf.setFloat64(0, f);
    hi = buf.getUint32(0);
    exp = (hi >>> 20) & 0x7ff;
  }
  const e = exp - 1022 + add;
  buf.setUint32(0, (hi & ~(0x7ff << 20)) | (1022 << 20));
  return [buf.getFloat64(0), e];
}

/**
 * math.Pow(x, y) for finite x > 0 and finite y >= 0 (the cases the placement code reaches). The fractional part goes through
 * Exp(yf*Log(x)) as in pow.go; Go's amd64 assembly Exp/Log may differ from V8's in the last bit (the assembly Exp even depends on
 * the CPU's FMA support), so a non-integer exponent can differ from Go by an ulp.
 */
export function goPowPos(x, y) {
  if (y === 0 || x === 1) return 1;
  if (y === 1) return x;
  if (y === 0.5) return Math.sqrt(x);
  let yi = Math.floor(y);
  let yf = y - yi;
  let a1 = 1.0;
  let ae = 0;
  if (yf !== 0) {
    if (yf > 0.5) {
      yf--;
      yi++;
    }
    a1 = Math.exp(yf * Math.log(x));
  }
  let [x1, xe] = frexp(x);
  for (let i = BigInt(yi); i !== 0n; i >>= 1n) {
    if (xe < -(1 << 12) || (1 << 12) < xe) {
      ae += xe;
      break;
    }
    if (i & 1n) {
      a1 *= x1;
      ae += xe;
    }
    x1 *= x1;
    xe <<= 1;
    if (x1 < 0.5) {
      x1 += x1;
      xe--;
    }
  }
  return a1 * 2 ** ae;
}
