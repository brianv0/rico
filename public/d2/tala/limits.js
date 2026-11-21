// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/limits (D2 v0.9.0): the engine's topology ceilings and the
// reusable work-accounting primitives. Work counters are JS numbers (int64/uint64 in Go): every counter stays far below 2^53, and
// the uint64 overflow branches (which Go reaches only with math.MaxUint64 limits in tests) report overflow at 2^53 instead.
// Errors are thrown (see goerrors.js).

import { errorf, errorsNew } from './goerrors.js';

export const MaxEngineNodes = 10_000;
export const MaxEngineEdges = 50_000;
export const MaxEngineRoutePoints = 1_000_000;
export const MaxEngineTreeDepth = 256;
export const MaxGraphSize = 30_000;

const contextCheckStride = 64;
const cancellableContextCheckStride = 1024;
const workUnitsPerEntity = 1_024;

export const MaxEngineWorkUnits = (MaxEngineNodes + MaxEngineEdges) * workUnitsPerEntity;
export const MaxTransactionWorkUnits = 1_000_000_000;
export const MaxTransactionOverlapReferences = 4_000_000;
export const MaxBinPackWorkUnits = 1_000_000_000;
export const MaxPlaceTreesWorkUnits = 68_000_000;
export const MaxLabelPlacementWorkUnits = 50_000_000;

const MAX_U64 = Number.MAX_SAFE_INTEGER; // stands for math.MaxUint64

/** math/bits.Len64 for 0 <= n < 2^53. */
function len64(n) {
  let l = 0;
  while (n >= 1) { n = Math.floor(n / 2); l++; }
  return l;
}

// ---- arithmetic.go ----

/** CheckedAddUint64: [sum, ok]. */
export function checkedAddUint64(a, b) {
  if (MAX_U64 - a < b) return [0, false];
  return [a + b, true];
}

/** CheckedMulUint64: [product, ok]. */
export function checkedMulUint64(a, b) {
  if (a !== 0 && Math.floor(MAX_U64 / a) < b) return [0, false];
  return [a * b, true];
}

// ---- work.go ----

/**
 * WorkGuard accounts a complete operation's signed work units and polls its context at a fixed stride. The limit is an
 * explicit non-negative ceiling; zero permits cancellation checks but no charged work.
 */
export class WorkGuard {
  constructor(ctx, location, limit) {
    this.ctx = ctx;
    this.done = ctx.hasDone();
    this.location = location;
    this.used_ = 0;
    this.limit = limit;
  }

  /** Step charges one work unit. */
  step() {
    this.used_++;
    if (this.used_ > this.limit) {
      throw errorf(`TALA ${this.location} work exceeds limit ${this.limit}`);
    }
    this.checkAtStride();
  }

  /** Add records multiple work units as one accounting operation. */
  add(units) {
    if (units < 0) throw errorf(`TALA ${this.location} work charge must not be negative`);
    if (units > this.limit || this.used_ > this.limit - units) {
      const previous = this.used_;
      this.used_ = this.limit + 1;
      const stride = this.pollingStride();
      if (previous <= this.limit && Math.floor(previous / stride) !== Math.floor(this.limit / stride)) {
        this.check();
      }
      throw errorf(`TALA ${this.location} work exceeds limit ${this.limit}`);
    }
    const previous = this.used_;
    this.used_ += units;
    this.checkAfterAdd(previous);
  }

  checkAfterAdd(previous) {
    const stride = this.pollingStride();
    if (this.used_ % stride !== 0 && Math.floor(previous / stride) === Math.floor(this.used_ / stride)) return;
    this.check();
  }

  checkAtStride() {
    const stride = this.pollingStride();
    if (this.used_ % stride !== 0) return;
    this.check();
  }

  pollingStride() {
    // Contexts without Done need the shorter stride because cancellation is observable only by polling Err.
    return this.done ? cancellableContextCheckStride : contextCheckStride;
  }

  /** Check observes cancellation immediately. */
  check() {
    const err = this.ctx.err();
    if (err) throw errorf(`${this.location}: ${err.message}`, err);
  }

  /** Finish observes cancellation regardless of the current work count. */
  finish() {
    this.check();
  }

  /** SetLimit changes the ceiling without resetting already consumed work. */
  setLimit(limit) {
    this.limit = limit;
  }

  /** Used returns the number of charged or first-rejected work units. */
  used() {
    return this.used_;
  }
}

/** NewWorkGuard constructs a work guard and observes cancellation before any operation work begins. */
export function newWorkGuard(ctx, location, limit) {
  if (ctx === null || ctx === undefined) throw errorf(`TALA ${location} requires a context`);
  if (limit < 0) throw errorf(`TALA ${location} work limit must not be negative`);
  const guard = new WorkGuard(ctx, location, limit);
  guard.finish();
  return guard;
}

// ---- optimization.go ----

/** MaxOptimizationWorkUnits bounds one hierarchy or placement optimization. */
export const MaxOptimizationWorkUnits = 250_000_000;
const optimizationContextCheckStride = 64;

/** ErrOptimizationResourceLimit reports exhausted or overflowing optimization work accounting. */
export const ErrOptimizationResourceLimit = errorsNew('TALA optimization resource limit exceeded');

/** OptimizationWorkGuard accounts one complete hierarchy or placement optimization. */
export class OptimizationWorkGuard {
  constructor(ctx, location, limit) {
    this.ctx = ctx;
    this.location = location;
    this.used_ = 0;
    this.limit = limit;
  }

  /** Step charges one optimization work unit. */
  step() {
    this.add(1);
  }

  /** Add charges amount optimization work units. */
  add(amount) {
    if (amount === 0) {
      this.check();
      return;
    }
    if (MAX_U64 - this.used_ < amount) {
      throw errorf(`${ErrOptimizationResourceLimit.message}: ${this.location} work arithmetic overflow`, ErrOptimizationResourceLimit);
    }
    const previous = this.used_;
    const next = previous + amount;
    if (next > this.limit) {
      throw errorf(`${ErrOptimizationResourceLimit.message}: TALA ${this.location} work exceeds limit ${this.limit}`, ErrOptimizationResourceLimit);
    }
    this.used_ = next;
    if (Math.floor(previous / optimizationContextCheckStride) !== Math.floor(next / optimizationContextCheckStride)) this.check();
  }

  /** AddProduct multiplies two work dimensions without allowing arithmetic overflow. */
  addProduct(a, b) {
    if (a !== 0 && b > Math.floor(MAX_U64 / a)) {
      throw errorf(`${ErrOptimizationResourceLimit.message}: ${this.location} work arithmetic overflow`, ErrOptimizationResourceLimit);
    }
    this.add(a * b);
  }

  /** AddSort charges the comparison bound for sorting length values. */
  addSort(length) {
    if (length <= 1) {
      this.check();
      return;
    }
    this.addProduct(length, len64(length - 1));
  }

  /** Check observes optimization cancellation immediately. */
  check() {
    const err = this.ctx.err();
    if (err) throw errorf(`${this.location}: ${err.message}`, err);
  }

  /** Finish observes cancellation at an optimization boundary. */
  finish() {
    this.check();
  }

  /** Location returns the operation name used in diagnostics. */
  location_() {
    return this.location;
  }

  /** Used returns the accepted work units. */
  used() {
    return this.used_;
  }
}

/** NewOptimizationWorkGuard constructs a guard and observes cancellation before any optimization work begins. */
export function newOptimizationWorkGuard(ctx, location, limit) {
  if (ctx === null || ctx === undefined) throw errorf(`TALA ${location} requires a context`);
  const guard = new OptimizationWorkGuard(ctx, location, limit);
  guard.finish();
  return guard;
}

/**
 * Shuffle is math/rand.Shuffle's Fisher-Yates implementation with a guard check before every random draw. `values` is an
 * array shuffled in place, `random` a gorand Rand. Its reduction algorithm and draw order are intentionally identical so
 * seeded layout output remains stable.
 */
export function shuffle(values, random, guard) {
  if (random === null || random === undefined) throw errorf(`TALA ${guard.location} shuffle requires a random generator`);
  let i = values.length - 1;
  for (; i > 2147483646; i--) {
    guard.step();
    const j = Number(random.int63n(BigInt(i + 1)));
    const t = values[i]; values[i] = values[j]; values[j] = t;
  }
  for (; i > 0; i--) {
    const j = shuffleIndex(random, i + 1, guard);
    const t = values[i]; values[i] = values[j]; values[j] = t;
  }
}

function shuffleIndex(random, n, guard) {
  guard.step();
  let v = random.uint32();
  let product = BigInt(v) * BigInt(n);
  let low = Number(product & 0xffffffffn);
  if (low < n) {
    const threshold = (4294967296 - n) % n; // uint32(-n) % uint32(n)
    while (low < threshold) {
      guard.step();
      v = random.uint32();
      product = BigInt(v) * BigInt(n);
      low = Number(product & 0xffffffffn);
    }
  }
  return Number(product >> 32n);
}

export { shuffleIndex as _shuffleIndex };
