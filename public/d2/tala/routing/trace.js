// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): trace.go.
//
// TraceEdgesToShapeBorder / traceEdgesToShapeBorderWithWorkLimit are stage entry points built on runAtomicRouteStage (second half of
// the package); only the per-edge traceToShapeBorder is here.

import * as geo from '../../geo.js';
import { traceToShapeBorder as shapeTraceToShapeBorder } from '../../shape.js';

const { Orientation } = geo;

export function traceToShapeBorder(edge) {
  if (edge === null || edge.from === null || edge.to === null || edge.points.length < 2) return;
  const fromNode = edge.from, toNode = edge.to;
  let originalFromTopLeft = null, originalToTopLeft = null;
  let originalFromPointer = null, originalToPointer = null;
  try {
    // If an edge passes through a 3D/multiple modifier, use the offset box for tracing to the rendered border.
    {
      const [dx, dy] = edge.from.modifierElementAdjustments();
      if (dx !== 0 || dy !== 0) {
        const start = edge.points[0];
        if (start.x > edge.from.topLeft.x + dx && start.y < edge.from.topLeft.y + edge.from.height - dy) {
          originalFromPointer = edge.from.topLeft;
          originalFromTopLeft = edge.from.topLeft.copy();
          const orientation = edge.from.portOrientation(start);

          // If connected to the top or right side, move the segment back before tracing to the border.
          const next = edge.points[1];
          if (orientation === Orientation.Right || start.x === originalFromTopLeft.x + edge.from.width) {
            edge.from.topLeft.x += dx;
            const topRight = edge.from.topLeft.addVector(geo.newVector(edge.from.width, 0));
            const bottomRight = topRight.addVector(geo.newVector(0, edge.from.height));
            const newStart = geo.intersectionPoint(start, next, topRight, bottomRight);
            if (newStart !== null) {
              start.x = newStart.x;
              start.y = newStart.y;
            }
          } else if (orientation === Orientation.Top || start.y === originalFromTopLeft.y) {
            edge.from.topLeft.y -= dy;
            const topRight = edge.from.topLeft.addVector(geo.newVector(edge.from.width, 0));
            const newStart = geo.intersectionPoint(start, next, edge.from.topLeft, topRight);
            if (newStart !== null) {
              start.x = newStart.x;
              start.y = newStart.y;
            }
          }
        }
      }
    }
    {
      const [dx, dy] = edge.to.modifierElementAdjustments();
      if (dx !== 0 || dy !== 0) {
        const end = edge.points[edge.points.length - 1];
        if (end.x > edge.to.topLeft.x + dx && end.y < edge.to.topLeft.y + edge.to.height - dy) {
          originalToPointer = edge.to.topLeft;
          originalToTopLeft = edge.to.topLeft.copy();
          const orientation = edge.to.portOrientation(end);

          const previous = edge.points[edge.points.length - 2];
          if (orientation === Orientation.Right || end.x === originalToTopLeft.x + edge.to.width) {
            edge.to.topLeft.x += dx;
            const topRight = edge.to.topLeft.addVector(geo.newVector(edge.to.width, 0));
            const bottomRight = topRight.addVector(geo.newVector(0, edge.to.height));
            const newEnd = geo.intersectionPoint(end, previous, topRight, bottomRight);
            if (newEnd !== null) {
              end.x = newEnd.x;
              end.y = newEnd.y;
            }
          } else if (orientation === Orientation.Top || end.y === originalToTopLeft.y) {
            edge.to.topLeft.y -= dy;
            const topRight = edge.to.topLeft.addVector(geo.newVector(edge.to.width, 0));
            const newEnd = geo.intersectionPoint(end, previous, edge.to.topLeft, topRight);
            if (newEnd !== null) {
              end.x = newEnd.x;
              end.y = newEnd.y;
            }
          }
        }
      }
    }

    let borderPoint = shapeTraceToShapeBorder(edge.from.shape, edge.points[0], edge.points[1]);
    if (borderPoint !== null && borderPoint !== undefined) edge.points[0] = borderPoint;
    borderPoint = shapeTraceToShapeBorder(edge.to.shape, edge.points[edge.points.length - 1], edge.points[edge.points.length - 2]);
    if (borderPoint !== null && borderPoint !== undefined) edge.points[edge.points.length - 1] = borderPoint;
  } finally {
    // Restore in reverse mutation order in case both endpoints share a node.
    if (originalToTopLeft !== null) {
      originalToPointer.x = originalToTopLeft.x;
      originalToPointer.y = originalToTopLeft.y;
      toNode.topLeft = originalToPointer;
    }
    if (originalFromTopLeft !== null) {
      originalFromPointer.x = originalFromTopLeft.x;
      originalFromPointer.y = originalFromTopLeft.y;
      fromNode.topLeft = originalFromPointer;
    }
  }
}
