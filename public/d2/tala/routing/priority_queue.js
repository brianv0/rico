// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): priority_queue.go.
//
// An indexed binary min-heap. Entries keep their heap index so Dijkstra's algorithm can lower a queued distance without a map lookup.
// Equal priorities are popped in insertion order. (Go reuses entry storage in chunks; JS allocates entries, which is
// unobservable: entries returned before a reset must not be used afterward.)

import { errorf } from '../goerrors.js';
import { goV } from '../../gomath.js';

/** bits.Len(uint(n)) */
function bitsLen(n) {
  let l = 0;
  while (n > 0) { n = Math.floor(n / 2); l++; }
  return l;
}

export class PriorityQueueEntry {
  constructor(priority) {
    this.node = null;
    this.isHorizontal = false;
    this.priority = priority;
    this.index = -1;
    this.order = 0;
  }
}

export class PriorityQueue {
  constructor() {
    this.items = [];
    this.nextOrder = 0;
  }

  /** reset empties the queue while retaining storage. */
  reset() {
    this.items.length = 0;
    this.nextOrder = 0;
  }

  empty() {
    return this.items.length === 0;
  }

  push(priority, node, isHorizontal, guard) {
    reservePriorityQueueWork(guard, this.items.length + 1, 1);

    const entry = new PriorityQueueEntry(priority);
    entry.node = node;
    entry.isHorizontal = isHorizontal;
    entry.index = this.items.length;
    entry.order = this.nextOrder;
    this.nextOrder++;
    this.items.push(entry);
    this.siftUp(entry.index);
    return entry;
  }

  pop(guard) {
    if (this.empty()) throw errorf('cannot dequeue minimum of empty priority queue');
    reservePriorityQueueWork(guard, this.items.length, 2);

    const min = this.items[0];
    const lastIndex = this.items.length - 1;
    const last = this.items[lastIndex];
    this.items[lastIndex] = null;
    this.items.length = lastIndex;
    min.index = -1;

    if (lastIndex !== 0) {
      this.items[0] = last;
      last.index = 0;
      this.siftDown(0);
    }
    return min;
  }

  decrease(entry, priority, guard) {
    if (this.empty()) throw errorf('cannot decrease priority in an empty priority queue');
    if (entry == null) throw errorf('cannot decrease priority: entry is nil');
    if (entry.index < 0 || entry.index >= this.items.length || this.items[entry.index] !== entry) {
      throw errorf('cannot decrease priority: entry is not in the priority queue');
    }
    if (priority >= entry.priority) {
      throw errorf(`new priority ${goV(priority)} is not less than old priority ${goV(entry.priority)}`);
    }
    reservePriorityQueueWork(guard, entry.index + 1, 1);

    entry.priority = priority;
    this.siftUp(entry.index);
  }

  siftUp(index) {
    while (index > 0) {
      const parent = Math.trunc((index - 1) / 2);
      if (!this.less(index, parent)) return;
      this.swap(index, parent);
      index = parent;
    }
  }

  siftDown(index) {
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.items.length) return;
      let smallest = left;
      const right = left + 1;
      if (right < this.items.length && this.less(right, left)) smallest = right;
      if (!this.less(smallest, index)) return;
      this.swap(index, smallest);
      index = smallest;
    }
  }

  less(left, right) {
    return priorityQueueEntryLess(this.items[left], this.items[right]);
  }

  swap(left, right) {
    const items = this.items;
    const t = items[left]; items[left] = items[right]; items[right] = t;
    items[left].index = left;
    items[right].index = right;
  }
}

export function reservePriorityQueueWork(guard, upperBound, unitsPerLevel) {
  if (guard == null) return;
  guard.add(bitsLen(upperBound) * unitsPerLevel);
}

export function priorityQueueEntryLess(a, b) {
  if (a.priority !== b.priority) return a.priority < b.priority;
  // Preserve insertion order for equal-cost states. Route selection should not depend on the binary heap's internal shape.
  return a.order < b.order;
}
