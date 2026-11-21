// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The part of Go's context package that the TALA engine uses (D2 v0.9.0, d2layouts/d2talalayout): Background, WithCancel,
// WithValue, Err and a Done test. JS code runs to completion, so cancellation can only be requested from a callback that runs
// inside the engine (a deadline checked in err(), or a cancel() called by a guard hook).

import { errorsNew } from './goerrors.js';

export const Canceled = errorsNew('context canceled');
export const DeadlineExceeded = errorsNew('context deadline exceeded');

export class Context {
  constructor(parent = null) {
    this.parent = parent;
    this.cancelErr = null;
    this.deadline = null; // Date.now() value
    this.key = undefined;
    this.val = undefined;
    this.hasValue = false;
    this.cancellable = parent ? parent.cancellable : false; // Done() != nil
  }

  /** ctx.Err() */
  err() {
    for (let c = this; c; c = c.parent) {
      if (c.cancelErr) return c.cancelErr;
      if (c.deadline !== null && Date.now() >= c.deadline) return DeadlineExceeded;
    }
    return null;
  }

  /** ctx.Done() != nil */
  hasDone() {
    return this.cancellable;
  }

  /** ctx.Value(key) */
  value(key) {
    for (let c = this; c; c = c.parent) if (c.hasValue && c.key === key) return c.val;
    return undefined;
  }
}

export const background = () => new Context(null);

/** context.WithCancel: [ctx, cancel] */
export function withCancel(parent) {
  const ctx = new Context(parent);
  ctx.cancellable = true;
  return [ctx, () => { if (!ctx.cancelErr) ctx.cancelErr = Canceled; }];
}

/** context.WithTimeout: ms from now. */
export function withTimeout(parent, ms) {
  const [ctx, cancel] = withCancel(parent);
  ctx.deadline = Date.now() + ms;
  return [ctx, cancel];
}

/** context.WithValue */
export function withValue(parent, key, val) {
  const ctx = new Context(parent);
  ctx.key = key;
  ctx.val = val;
  ctx.hasValue = true;
  return ctx;
}
