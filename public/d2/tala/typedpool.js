// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/typedpool (D2 v0.9.0): a sync.Pool wrapper. The pool only
// reuses allocations and never changes results, so this keeps a small free list (single threaded: no locking).

export class Pool {
  constructor(newValue) {
    this.newValue = newValue;
    this.items = [];
  }

  /** Get selects an item from the pool or calls its allocator. */
  get() {
    return this.items.length > 0 ? this.items.pop() : this.newValue();
  }

  /** Put adds value to the pool. */
  put(value) {
    if (this.items.length < 64) this.items.push(value);
  }
}

/** New constructs a typed pool whose allocator returns a fresh value. */
export const newPool = (newValue) => new Pool(newValue);
