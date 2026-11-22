// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Go's error and panic model for the TALA port (D2 v0.9.0, github.com/d2lang/d2/d2layouts/d2talalayout).
//
// Convention of the whole port: a Go function that returns `(value, error)` returns `value` and THROWS a GoError where Go returns
// a non-nil error; callers that only propagate (`if err != nil { return err }`) need no code, callers that inspect the error
// (`errors.Is`, `if err != nil { handle }`) use try/catch and rethrow what is not theirs. A Go `panic(x)` throws a GoPanic (or
// any non-GoError: a JS TypeError stands for a Go runtime panic such as a nil dereference), and `recover()` is a catch that
// handles only non-GoError exceptions (`isPanic(e)`) and rethrows GoErrors untouched, because a returned Go error never reaches a
// recover.

/** A Go error value. `cause` is the wrapped error (fmt.Errorf %w); `causes` is the list of errors.Join. */
export class GoError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'GoError';
    this.cause = cause;
    this.causes = null;
  }
}

/** panic(value): not catchable by error handlers, only by isPanic-style recover sites. */
export class GoPanic extends Error {
  constructor(value) {
    super(typeof value === 'string' ? value : value instanceof Error ? value.message : String(value));
    this.name = 'GoPanic';
    this.value = value;
  }
}

/** errors.New: each call is a distinct value (identity decides errors.Is). */
export const errorsNew = (message) => new GoError(message);

/** fmt.Errorf(...): the caller formats the message; `cause` is the operand of %w. */
export const errorf = (message, cause = null) => new GoError(message, cause);

/** True for exceptions a Go recover() would catch (everything that is not a returned error). */
export const isPanic = (e) => !(e instanceof GoError);

/** errors.Is */
export function errorsIs(err, target) {
  for (let e = err; e; e = e.cause) {
    if (e === target) return true;
    if (e.causes) for (const c of e.causes) if (errorsIs(c, target)) return true;
  }
  return false;
}

/** errors.Join: null when every error is null. */
export function errorsJoin(...errs) {
  const list = errs.filter((e) => e);
  if (list.length === 0) return null;
  const joined = new GoError(list.map((e) => e.message).join('\n'));
  joined.causes = list;
  return joined;
}

/** errors.Unwrap */
export const errorsUnwrap = (err) => (err && err.cause) || null;
