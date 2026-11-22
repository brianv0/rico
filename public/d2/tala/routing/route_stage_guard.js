// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): route_stage_guard.go (the work
// guard half: RouteWorkGuard, the aggregate-work context key, the constants and stableSortRouteValues).
//
// NOT PORTED here (stage level, the second half of the package; they need snapshot.go and the layoutgraph rollback state):
// captureRouteMutations / routeMutationSnapshot, validateRouteStageGeometry, routeStageGraphBoundingBox, runAtomicRouteStage*.

import { errorf, errorsNew } from '../goerrors.js';
import { withValue } from '../context.js';
import { cachedContextErr } from './work.js';
import { maxRouteStageWorkUnits, routeStageContextCheckStride, maxEdgeRoutingStageWorkUnits } from './route_limits.js';

export { maxRouteStageWorkUnits, routeStageContextCheckStride, maxEdgeRoutingStageWorkUnits };

export const errRouteStageWorkLimit = errorsNew('TALA route-stage work limit exceeded');

/**
 * RouteWorkGuard is shared by every helper in a route post-processing stage. Work is unsigned and checked before addition, so even
 * injected limits and hostile inputs cannot wrap the counter. (Go's atomic parallel path is the same arithmetic here: JS runs the
 * flavors one after another.)
 */
export class RouteWorkGuard {
  constructor(ctx, location, limit) {
    this.parallel = false;
    this.ctx = ctx;
    this.done = ctx.hasDone();
    this.location = location;
    this.used = 0;
    this.limit = limit;
  }

  step() {
    this.add(1);
  }

  add(units) {
    if (this.used > this.limit || units > this.limit - this.used) {
      this.check();
      throw errorf(`${errRouteStageWorkLimit.message}: TALA ${this.location} work exceeds limit ${this.limit}`, errRouteStageWorkLimit);
    }
    const previous = this.used;
    this.used += units;
    if (units === 0 || Math.floor(previous / routeStageContextCheckStride) !== Math.floor(this.used / routeStageContextCheckStride)) {
      this.check();
    }
  }

  enableParallel() {
    this.parallel = true;
  }

  check() {
    const err = cachedContextErr(this.ctx, this.done);
    if (err) throw errorf(`${this.location}: ${err.message}`, err);
  }

  finish() {
    this.check();
  }

  /** Step and Finish let routing share its exact aggregate budget with lower layout-domain kernels. */
  Step() { this.step(); }
  Finish() { this.finish(); }

  /** reserveSort (standalone_route_guard.go) */
  reserveSort(length) {
    if (length < 2) {
      this.step();
      return;
    }
    // Go's comparison sort is O(n log n). Reserve that worst-case work before entering the non-interruptible standard-library
    // sort, while retaining its exact ordering behavior for equal values.
    for (let width = 1; width < length;) {
      this.add(length);
      if (width > Math.trunc(length / 2)) break;
      width *= 2;
    }
    this.check();
  }
}

/** newRouteWorkGuard(ctx, location, limit) */
export function newRouteWorkGuard(ctx, location, limit) {
  if (ctx == null) throw errorf(`TALA ${location} requires a context`);
  const guard = new RouteWorkGuard(ctx, location, limit);
  guard.check();
  return guard;
}

const routeAggregateWorkKey = { name: 'routeAggregateWorkKey' };

export function contextWithRouteAggregateWork(ctx, guard) {
  if (ctx == null || guard == null) return ctx;
  return withValue(ctx, routeAggregateWorkKey, guard);
}

/** routeAggregateWorkFromContext returns the aggregate workBudget or null. */
export function routeAggregateWorkFromContext(ctx) {
  if (ctx == null) return null;
  const guard = ctx.value(routeAggregateWorkKey);
  return guard === undefined ? null : guard;
}

/**
 * stableSortRouteValues is a cancellable bottom-up stable merge sort. Stable ordering is important to layout determinism,
 * including for values that compare equal.
 */
export function stableSortRouteValues(values, less, guard) {
  if (values.length < 2) {
    guard.step();
    return;
  }
  const temporary = new Array(values.length);
  for (let width = 1; width < values.length;) {
    for (let start = 0; start < values.length; start += 2 * width) {
      const middle = Math.min(start + width, values.length);
      const end = Math.min(start + 2 * width, values.length);
      let left = start, right = middle, output = start;
      while (left < middle && right < end) {
        guard.step();
        // Prefer the left value when equivalent to preserve stability.
        if (less(values[right], values[left])) {
          temporary[output] = values[right];
          right++;
        } else {
          temporary[output] = values[left];
          left++;
        }
        output++;
      }
      while (left < middle) {
        guard.step();
        temporary[output] = values[left];
        left++;
        output++;
      }
      while (right < end) {
        guard.step();
        temporary[output] = values[right];
        right++;
        output++;
      }
    }
    guard.add(values.length);
    for (let i = 0; i < values.length; i++) values[i] = temporary[i];
    if (width > Math.trunc(values.length / 2)) break;
    width *= 2;
  }
}
