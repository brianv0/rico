// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): turns.go.

/** idealTurnAxes returns the midpoint axes where a route can turn between two node boxes without adding avoidable distance. */
export function idealTurnAxes(nodeA, nodeB) {
  const x1 = nodeA.topLeft.x;
  const y1 = nodeA.topLeft.y;
  const x1b = nodeA.topLeft.x + nodeA.width;
  const y1b = nodeA.topLeft.y + nodeA.height;

  const x2 = nodeB.topLeft.x;
  const y2 = nodeB.topLeft.y;
  const x2b = nodeB.topLeft.x + nodeB.width;
  const y2b = nodeB.topLeft.y + nodeB.height;

  const left = x2b < x1;
  const right = x1b < x2;
  const top = y2b < y1;
  const bottom = y1b < y2;

  const axes = [];
  if (top && left) {
    axes.push({ isX: true, val: (x1 + x2b) / 2 }, { isX: false, val: (y1 + y2b) / 2 });
  } else if (left && bottom) {
    axes.push({ isX: true, val: (x1 + x2b) / 2 }, { isX: false, val: (y2 + y1b) / 2 });
  } else if (bottom && right) {
    axes.push({ isX: true, val: (x2 + x1b) / 2 }, { isX: false, val: (y2 + y1b) / 2 });
  } else if (right && top) {
    axes.push({ isX: true, val: (x2 + x1b) / 2 }, { isX: false, val: (y1 + y2b) / 2 });
  } else if (left) {
    axes.push({ isX: true, val: (x1 + x2b) / 2 });
  } else if (right) {
    axes.push({ isX: true, val: (x2 + x1b) / 2 });
  } else if (bottom) {
    axes.push({ isX: false, val: (y2 + y1b) / 2 });
  } else if (top) {
    axes.push({ isX: false, val: (y1 + y2b) / 2 });
  }

  return axes;
}
