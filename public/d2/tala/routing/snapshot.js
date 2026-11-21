// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): snapshot.go.
//
// Go's pointerSnapshot[T] saves a pointer and a copy of its pointee, restore() writes the copy back into the pointee (so identity
// survives). In JS the pointee is an object (geo.Point, layoutgraph.Label, ...): the copy is a shallow own-property copy and restore
// assigns the properties back. `*string` and `*int` fields (D2ID, the table column indices) are plain values or null in the JS
// layoutgraph, so their snapshots just remember the value. exactSliceSnapshot copies array contents and restores them in place
// (Go restores the slice's full backing array; JS arrays have no spare capacity).

/** snapshotPointer(pointer): `pointer` is an object, null, or (for *string, *int fields) a primitive. */
export function snapshotPointer(pointer) {
  if (pointer === null || pointer === undefined) return { pointer: null, value: null };
  if (typeof pointer !== 'object') return { pointer, value: pointer, primitive: true, restore() { return this.pointer; } };
  return { pointer, value: copyOwn(pointer), restore() { Object.assign(this.pointer, this.value); return this.pointer; } };
}

/** shallow copy of an object's own properties keeping its prototype (a Go struct value copy) */
export function copyOwn(obj) {
  return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj);
}

export function snapshotNullRestore() {
  return null;
}

/** exactSliceSnapshot: { original, backing } */
export function snapshotExactSlice(original) {
  if (original === null) return { original: null, backing: null, restore() { return null; } };
  return {
    original,
    backing: original.slice(),
    restore() {
      this.original.splice(0, this.original.length, ...this.backing);
      return this.original;
    },
  };
}

export function snapshotEdge(edge) {
  return {
    value: copyOwn(edge),
    d2ID: snapshotPointer(edge.d2ID),
    points: snapshotExactSlice(edge.points),
    pointValues: (edge.points ?? []).map((p) => snapshotPointer(p)),
    label: snapshotPointer(edge.label),
    sourceArrowheadLabel: snapshotPointer(edge.sourceArrowheadLabel),
    targetArrowheadLabel: snapshotPointer(edge.targetArrowheadLabel),
    fromTableColumnIndex: snapshotPointer(edge.fromTableColumnIndex),
    toTableColumnIndex: snapshotPointer(edge.toTableColumnIndex),
  };
}

export function restoreEdge(snapshot, edge) {
  snapshot.d2ID.restore();
  snapshot.label.restore();
  snapshot.sourceArrowheadLabel.restore();
  snapshot.targetArrowheadLabel.restore();
  snapshot.fromTableColumnIndex.restore();
  snapshot.toTableColumnIndex.restore();
  for (const point of snapshot.pointValues) point.restore();
  const originalPoints = snapshot.points.restore();

  Object.assign(edge, snapshot.value);
  edge.d2ID = snapshot.d2ID.pointer;
  edge.points = originalPoints;
  edge.label = snapshot.label.pointer;
  edge.sourceArrowheadLabel = snapshot.sourceArrowheadLabel.pointer;
  edge.targetArrowheadLabel = snapshot.targetArrowheadLabel.pointer;
  edge.fromTableColumnIndex = snapshot.fromTableColumnIndex.pointer;
  edge.toTableColumnIndex = snapshot.toTableColumnIndex.pointer;
}
