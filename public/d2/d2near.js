// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2layouts/d2near package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.).
// d2near applies near keywords when they're constants.
// Intended to be run as the last stage of layout after the diagram has already undergone layout.

import * as d2graph from './d2graph.js';
import * as geo from './geo.js';
import * as label from './label.js';
import { goLower } from './ast.js';

const pad = 20;

export const HorizontalCenterNears = new Set(['center-left', 'center-right']);
export const VerticalCenterNears = new Set(['top-center', 'bottom-center']);
export const NonCenterNears = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

/** Layout finds the shapes which are assigned constant near keywords and places them. */
export function layout(g, constantNearGraphs) {
  if (constantNearGraphs.length === 0) return;

  for (const tempGraph of constantNearGraphs) {
    tempGraph.root.childrenArray[0].parent = g.root;
    for (const obj of tempGraph.objects || []) obj.graph = g;
  }

  // Imagine the graph has two long texts, one at top center and one at top left.
  // Top left should go left enough to not collide with center.
  // So place the center ones first, then the later ones will consider them for bounding box
  for (const currentSet of [VerticalCenterNears, HorizontalCenterNears, NonCenterNears]) {
    for (const tempGraph of constantNearGraphs) {
      const obj = tempGraph.root.childrenArray[0];
      const inSet = currentSet.has(d2graph.key(obj.attributes.nearKey)[0]);
      if (inSet) {
        const prevX = obj.box.TopLeft.x, prevY = obj.box.TopLeft.y;
        obj.box.TopLeft = geo.newPoint(...place(obj));
        const dx = obj.box.TopLeft.x - prevX, dy = obj.box.TopLeft.y - prevY;

        for (const subObject of tempGraph.objects || []) {
          // `obj` already been replaced above by `place(obj)`
          if (subObject === obj) continue;
          subObject.box.TopLeft.x += dx;
          subObject.box.TopLeft.y += dy;
        }
        for (const subEdge of tempGraph.edges || []) {
          for (const point of subEdge.route || []) {
            point.x += dx;
            point.y += dy;
          }
        }
      }
    }
    for (const tempGraph of constantNearGraphs) {
      const obj = tempGraph.root.childrenArray[0];
      const inSet = currentSet.has(d2graph.key(obj.attributes.nearKey)[0]);
      if (inSet) {
        // The z-index for constant nears does not matter, as it will not collide
        g.objects = [...(g.objects || []), ...(tempGraph.objects || [])];
        if (obj.parent.children === null) obj.parent.children = new Map();
        obj.parent.children.set(goLower(obj.id), obj);
        obj.parent.childrenArray = [...(obj.parent.childrenArray || []), obj];
        g.edges = [...(g.edges || []), ...(tempGraph.edges || [])];
      }
    }
  }
}

/** place returns the position of obj, taking into consideration its near value and the diagram */
function place(obj) {
  const [tl, br] = boundingBox(obj.graph);
  const w = br.x - tl.x;
  const h = br.y - tl.y;

  const nearKeyStr = d2graph.key(obj.attributes.nearKey)[0];
  let x = 0, y = 0;
  switch (nearKeyStr) {
    case 'top-left':
      [x, y] = [tl.x - obj.box.Width - pad, tl.y - obj.box.Height - pad];
      break;
    case 'top-center':
      [x, y] = [tl.x + w / 2 - obj.box.Width / 2, tl.y - obj.box.Height - pad];
      break;
    case 'top-right':
      [x, y] = [br.x + pad, tl.y - obj.box.Height - pad];
      break;
    case 'center-left':
      [x, y] = [tl.x - obj.box.Width - pad, tl.y + h / 2 - obj.box.Height / 2];
      break;
    case 'center-right':
      [x, y] = [br.x + pad, tl.y + h / 2 - obj.box.Height / 2];
      break;
    case 'bottom-left':
      [x, y] = [tl.x - obj.box.Width - pad, br.y + pad];
      break;
    case 'bottom-center':
      [x, y] = [br.x - w / 2 - obj.box.Width / 2, br.y + pad];
      break;
    case 'bottom-right':
      [x, y] = [br.x + pad, br.y + pad];
      break;
  }

  if (obj.labelPosition !== null && !obj.labelPosition.includes('INSIDE')) {
    if (obj.labelPosition.includes('_TOP_')) {
      // label is on the top, and container is placed on the bottom
      if (nearKeyStr.includes('bottom')) y += obj.attributes.labelDimensions.height;
    } else if (obj.labelPosition.includes('_LEFT_')) {
      // label is on the left, and container is placed on the right
      if (nearKeyStr.includes('right')) x += obj.attributes.labelDimensions.width;
    } else if (obj.labelPosition.includes('_RIGHT_')) {
      // label is on the right, and container is placed on the left
      if (nearKeyStr.includes('left')) x -= obj.attributes.labelDimensions.width;
    } else if (obj.labelPosition.includes('_BOTTOM_')) {
      // label is on the bottom, and container is placed on the top
      if (nearKeyStr.includes('top')) y -= obj.attributes.labelDimensions.height;
    }
  }

  return [x, y];
}

/**
 * boundingBox gets the center of the graph as defined by shapes
 * The bounds taking into consideration only shapes gives more of a feeling of true center
 * It differs from d2target.BoundingBox which needs to include every visible thing
 */
function boundingBox(g) {
  if ((g.objects || []).length === 0) return [geo.newPoint(0, 0), geo.newPoint(0, 0)];
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;

  for (const obj of g.objects) {
    if (obj.attributes.nearKey !== null) {
      // Top left should not be MORE top than top-center
      // But it should go more left if top-center label extends beyond bounds of diagram
      switch (d2graph.key(obj.attributes.nearKey)[0]) {
        case 'top-center': case 'bottom-center':
          x1 = Math.min(x1, obj.box.TopLeft.x);
          x2 = Math.max(x2, obj.box.TopLeft.x + obj.box.Width);
          break;
        case 'center-left': case 'center-right':
          y1 = Math.min(y1, obj.box.TopLeft.y);
          y2 = Math.max(y2, obj.box.TopLeft.y + obj.box.Height);
          break;
      }
    } else {
      if (obj.outerNearContainer() !== null) continue;
      x1 = Math.min(x1, obj.box.TopLeft.x);
      y1 = Math.min(y1, obj.box.TopLeft.y);
      x2 = Math.max(x2, obj.box.TopLeft.x + obj.box.Width);
      y2 = Math.max(y2, obj.box.TopLeft.y + obj.box.Height);
      if (obj.attributes.label.value !== '' && obj.labelPosition !== null) {
        const labelPosition = label.fromString(obj.labelPosition);
        if (label.isOutside(labelPosition)) {
          const labelTL = label.getPointOnBox(labelPosition, obj.box, label.PADDING, obj.attributes.labelDimensions.width, obj.attributes.labelDimensions.height);
          x1 = Math.min(x1, labelTL.x);
          y1 = Math.min(y1, labelTL.y);
          x2 = Math.max(x2, labelTL.x + obj.attributes.labelDimensions.width);
          y2 = Math.max(y2, labelTL.y + obj.attributes.labelDimensions.height);
        }
      }
    }
  }

  for (const edge of g.edges || []) {
    if (edge.src.outerNearContainer() !== null || edge.dst.outerNearContainer() !== null) continue;
    if (edge.route !== null) {
      for (const point of edge.route) {
        x1 = Math.min(x1, point.x);
        y1 = Math.min(y1, point.y);
        x2 = Math.max(x2, point.x);
        y2 = Math.max(y2, point.y);
      }
    }
  }

  if (x1 === Infinity && x2 === -Infinity) {
    x1 = 0;
    x2 = 0;
  }
  if (y1 === Infinity && y2 === -Infinity) {
    y1 = 0;
    y2 = 0;
  }

  return [geo.newPoint(x1, y1), geo.newPoint(x2, y2)];
}
