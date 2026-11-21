// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/invariant (D2 v0.9.0): classification of violations of
// TALA's internal layout invariants.

import { GoError, errorsNew } from './goerrors.js';

/** ErrViolation identifies an internal layout invariant violation. */
export const ErrViolation = errorsNew('layout invariant violated');

/** New returns an invariant violation with the supplied reason (a GoError wrapping ErrViolation: "layout invariant violated: reason"). */
export function newError(reason) {
  return new GoError(`${ErrViolation.message}: ${reason}`, ErrViolation);
}

/** Errorf formats an invariant violation: the caller formats `message`. */
export function errorf(message) {
  return newError(message);
}
