// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): work.go.
//
// Go's `done <-chan struct{}` is `ctx.hasDone()` here (a context that can be canceled); a closed Done channel is observable exactly
// when ctx.err() is non-null, so both branches of cachedContextErr reduce to ctx.err().

import { errorf, errorsIs } from '../goerrors.js';
import { Canceled, DeadlineExceeded } from '../context.js';
import { RouteSearchWorkGuard } from './route_search_guard.js';

/** checkEdgeRoutingCanceled (ovg_edge_router.go): throws when the context is done. */
export function checkEdgeRoutingCanceled(ctx) {
  const err = ctx.err();
  if (err) throw errorf(`EdgeRouting: ${err.message}`, err);
}

/** isContextTermination (ovg_edge_router.go): errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) */
export function isContextTermination(err) {
  return errorsIs(err, Canceled) || errorsIs(err, DeadlineExceeded);
}

/**
 * cachedContextErr avoids repeatedly traversing context value wrappers in hot guarded loops. Standard cancellable contexts close
 * Done before Err becomes observable; synthetic contexts without Done retain per-call Err polling.
 */
export function cachedContextErr(ctx, done) {
  return ctx.err();
}

/**
 * chargeSkippedRouteWork retains the logical work of a linear scan after its irrelevant prefix has been found by binary search.
 * Nonstandard budgets and synthetic contexts retain exact step-by-step accounting and cancellation.
 */
export function chargeSkippedRouteWork(guard, amount) {
  if (guard == null || amount === 0) return;
  const search = guard instanceof RouteSearchWorkGuard ? guard : null;
  if (search === null || !search.done || (search.aggregate !== null && !search.deferAggregate)) {
    for (let i = 0; i < amount; i++) guard.step();
    return;
  }
  const units = amount;
  if (search.used >= search.limit) {
    search.step();
    return;
  }
  const remaining = search.limit - search.used;
  if (units > remaining) {
    search.add(remaining);
    search.step();
    return;
  }
  search.add(units);
}
