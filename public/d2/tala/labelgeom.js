// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/labelgeom (D2 v0.9.0): renderer-compatible label geometry shared by
// the mutable graph bounds and label placement.

import * as d2target from '../target.js';
import { goInt } from '../gomath.js';

/**
 * ArrowheadTopLeft returns the renderer-compatible top-left position (a geo.Point) for an arrowhead label. D2 stores rendered text
 * dimensions as integers, so the float dimensions are intentionally truncated here to preserve historical TALA output.
 * `route` is an array of geo.Point; sourceArrowhead/targetArrowhead are the arrowhead strings.
 */
export function arrowheadTopLeft(route, isTarget, sourceArrowhead, targetArrowhead, width, height) {
  const connection = d2target.baseConnection();
  connection.route = route;
  connection.srcArrow = sourceArrowhead;
  connection.dstArrow = targetArrowhead;

  const text = new d2target.Text({ labelWidth: goInt(width), labelHeight: goInt(height) });
  if (isTarget) connection.dstLabel = text;
  else connection.srcLabel = text;
  return connection.getArrowheadLabelPosition(isTarget);
}
