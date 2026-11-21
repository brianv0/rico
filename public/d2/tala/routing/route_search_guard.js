// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): route_search_guard.go.
//
// A `workBudget` is any object with step(), add(units) and check() (the standalone route-stage guard RouteWorkGuard and the
// route-search guard RouteSearchWorkGuard). Each throws a GoError where the Go method returns an error.

import { errorf, errorsNew } from '../goerrors.js';
import * as limits from '../limits.js';
import { withValue } from '../context.js';
import { cachedContextErr } from './work.js';
import { RouteWorkGuard, routeAggregateWorkFromContext } from './route_stage_guard.js';
import { maxEdgeRoutingStageWorkUnits, maxRouteSearchFlavors, maxRouteSearchWorkUnits, routeSearchContextCheckStride } from './route_limits.js';

export { maxRouteSearchFlavors, maxRouteSearchWorkUnits, routeSearchContextCheckStride };

export const errRouteSearchWorkLimit = errorsNew('TALA route-search work limit exceeded');

export class RouteSearchWorkGuard {
  constructor(ctx, flavor, limit) {
    this.ctx = ctx;
    this.done = ctx.hasDone();
    this.flavor = flavor;
    this.used = 0;
    this.limit = limit;
    this.metrics = routeSearchTelemetryFromContext(ctx);
    this.metricID = -1; // telemetry only; initialized to -1 before concurrent workers
    this.aggregate = routeAggregateWorkFromContext(ctx);
    this.nextCheck = 0;
    // The production stage envelope is the sum of independently enforced OVG, flavor, and post-route envelopes. Charge a flavor's
    // actual total when it joins instead of contending on the shared counter for every inner-loop operation. Injected limits retain
    // exact per-operation accounting.
    this.deferAggregate = false;
    this.aggregateCharged = 0;
  }

  /** bind switches from the caller context used during router construction to the worker context. */
  bind(ctx) {
    if (ctx == null) throw errorf('TALA EdgeRouting requires a context');
    this.ctx = ctx;
    this.done = ctx.hasDone();
    this.check();
    this.nextCheck = this.used + routeSearchContextCheckStride;
  }

  step() {
    // Single-step calls sit in the innermost scans. Poll every iteration so a synthetic context without a Done signal remains
    // observable immediately. Standard contexts use the same bounded polling stride as the bulk path.
    if (!this.done || this.used >= this.nextCheck) {
      this.check();
      this.nextCheck = this.used + routeSearchContextCheckStride;
    }
    if (this.used >= this.limit) {
      this.check();
      throw errorf(
        `${errRouteSearchWorkLimit.message}: TALA EdgeRouting flavor ${this.flavor} work exceeds limit ${this.limit}`,
        errRouteSearchWorkLimit,
      );
    }
    this.used++;
    if (this.deferAggregate || this.aggregate === null) return;
    this.aggregate.add(1);
  }

  add(units) {
    if (this.used > this.limit || units > this.limit - this.used) {
      this.check();
      throw errorf(
        `${errRouteSearchWorkLimit.message}: TALA EdgeRouting flavor ${this.flavor} work exceeds limit ${this.limit}`,
        errRouteSearchWorkLimit,
      );
    }
    this.used += units;
    if (!this.deferAggregate && this.aggregate !== null) this.aggregate.add(units);
    if (!this.done || units === 0 || this.used >= this.nextCheck) {
      this.check();
      this.nextCheck = this.used + routeSearchContextCheckStride;
    }
  }

  check() {
    const err = cachedContextErr(this.ctx, this.done);
    if (err) throw errorf(`EdgeRouting: ${err.message}`, err);
  }

  reserveProduct(a, b) {
    const [product, ok] = limits.checkedMulUint64(a, b);
    if (!ok) {
      this.check();
      throw errorf(`${errRouteSearchWorkLimit.message}: route-search work arithmetic overflow`, errRouteSearchWorkLimit);
    }
    this.add(product);
  }

  reserveSum(a, b) {
    const [sum, ok] = limits.checkedAddUint64(a, b);
    if (!ok) {
      this.check();
      throw errorf(`${errRouteSearchWorkLimit.message}: route-search work arithmetic overflow`, errRouteSearchWorkLimit);
    }
    this.add(sum);
  }

  reserveSort(length) {
    if (length < 2) {
      this.step();
      return;
    }
    let levels = 0;
    for (let remaining = length - 1; remaining > 0; remaining = Math.floor(remaining / 2)) levels++;
    this.reserveProduct(length, levels);
  }

  finish() {
    if (this.metrics !== null) this.metrics.record(this, this.used);
    if (this.deferAggregate && this.used !== this.aggregateCharged) {
      const pending = this.used - this.aggregateCharged;
      this.aggregate.add(pending);
      this.aggregateCharged = this.used;
    }
    this.check();
  }
}

/** newRouteSearchWorkGuard(ctx, flavor, limit) */
export function newRouteSearchWorkGuard(ctx, flavor, limit) {
  if (ctx == null) throw errorf('TALA EdgeRouting requires a context');
  const guard = new RouteSearchWorkGuard(ctx, flavor, limit);
  if (guard.aggregate instanceof RouteWorkGuard) {
    guard.aggregate.enableParallel();
    guard.deferAggregate = guard.aggregate.limit === maxEdgeRoutingStageWorkUnits && limit === maxRouteSearchWorkUnits;
  }
  guard.check();
  guard.nextCheck = routeSearchContextCheckStride;
  return guard;
}

// routeSearchTelemetry is installed by calibration tests through context.
class RouteSearchTelemetry {
  constructor() {
    this.samples = [];
  }

  record(guard, work) {
    if (guard.metricID < 0) {
      guard.metricID = this.samples.length;
      this.samples.push(work);
    } else {
      this.samples[guard.metricID] = work;
    }
  }

  snapshot() {
    return [...this.samples];
  }
}

/** SearchTelemetry collects per-flavor work samples for routing diagnostics and calibration. */
export class SearchTelemetry {
  constructor() {
    this.state = new RouteSearchTelemetry();
  }

  /** WorkSamples returns a stable copy of the recorded per-flavor work totals. */
  workSamples() {
    return this === null ? null : this.state.snapshot();
  }
}

/** MaxSearchWorkUnits is the calibrated per-flavor route-search budget. */
export const MaxSearchWorkUnits = maxRouteSearchWorkUnits;

const routeSearchTelemetryKey = { name: 'routeSearchTelemetryKey' };

/** WithSearchTelemetry attaches route-search diagnostics to a routing context. */
export function withSearchTelemetry(ctx, telemetry) {
  if (telemetry == null) return ctx;
  return withValue(ctx, routeSearchTelemetryKey, telemetry.state);
}

export function routeSearchTelemetryFromContext(ctx) {
  const telemetry = ctx.value(routeSearchTelemetryKey);
  return telemetry === undefined ? null : telemetry;
}

export function routeSearchIsDescendantOf(guard, maybeDescendant, maybeAncestor) {
  for (;;) {
    guard.step();
    if (maybeAncestor === maybeDescendant) return true;
    if (maybeDescendant === null) return false;
    if (maybeDescendant.container !== null) maybeDescendant = maybeDescendant.container;
    else if (maybeDescendant.cluster !== null) maybeDescendant = maybeDescendant.cluster.vessel;
    else if (maybeDescendant.sequence !== null) maybeDescendant = maybeDescendant.sequence.vessel;
    else return maybeAncestor === null;
  }
}

export function routeSearchHasFixedAncestor(guard, node) {
  for (let current = node; current !== null; current = current.owningContainer()) {
    guard.step();
    if (current.fixedTopLeft !== null) return true;
  }
  return false;
}

/**
 * fixedOverlapsForRoute mirrors fixedOverlapsFor while accounting hierarchy and pair scans. Each flavor derives its own immutable
 * result so budget use is independent of worker scheduling and shared-cache ownership. Returns Set<Node>.
 */
export function fixedOverlapsForRoute(nodes, guard) {
  const fixedNodes = [];
  for (const node of nodes) {
    guard.step();
    const fixed = routeSearchHasFixedAncestor(guard, node);
    if (fixed) fixedNodes.push(node);
  }

  const overlaps = new Set();
  for (const node of fixedNodes) {
    guard.step();
    if (overlaps.has(node)) continue;
    for (const other of nodes) {
      guard.step();
      const nodeBelowOther = routeSearchIsDescendantOf(guard, node, other);
      const otherBelowNode = routeSearchIsDescendantOf(guard, other, node);
      if (node === other || nodeBelowOther || otherBelowNode) continue;
      if (node.box.overlaps(other.box)) {
        overlaps.add(node);
        const fixed = routeSearchHasFixedAncestor(guard, other);
        if (fixed) overlaps.add(other);
        break;
      }
    }
  }

  guard.check();
  return overlaps;
}
