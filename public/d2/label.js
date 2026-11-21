// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's lib/label package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.).
// Go's `Position` (an int8 with methods) is a plain number here; its methods are functions taking the position first
// (positionString, isShapePosition, mirrored, getPointOnBox, getPointOnRoute, ...).

import { newPoint, getUnitNormalVector, Route } from './geo.js';
import { goRound, float32 } from './gomath.js';

/** These are % locations where labels will be placed along the connection */
export const LEFT_LABEL_POSITION = 1.0 / 4.0;
export const CENTER_LABEL_POSITION = 2.0 / 4.0;
export const RIGHT_LABEL_POSITION = 3.0 / 4.0;

/** This is the space between a node border and its outside label */
export const PADDING = 5;

// iota order of Go's Position constants
const NAMES = [
  'Unset',
  'OutsideTopLeft', 'OutsideTopCenter', 'OutsideTopRight',
  'OutsideLeftTop', 'OutsideLeftMiddle', 'OutsideLeftBottom',
  'OutsideRightTop', 'OutsideRightMiddle', 'OutsideRightBottom',
  'OutsideBottomLeft', 'OutsideBottomCenter', 'OutsideBottomRight',
  'InsideTopLeft', 'InsideTopCenter', 'InsideTopRight',
  'InsideMiddleLeft', 'InsideMiddleCenter', 'InsideMiddleRight',
  'InsideBottomLeft', 'InsideBottomCenter', 'InsideBottomRight',
  'BorderTopLeft', 'BorderTopCenter', 'BorderTopRight',
  'BorderLeftTop', 'BorderLeftMiddle', 'BorderLeftBottom',
  'BorderRightTop', 'BorderRightMiddle', 'BorderRightBottom',
  'BorderBottomLeft', 'BorderBottomCenter', 'BorderBottomRight',
  'UnlockedTop', 'UnlockedMiddle', 'UnlockedBottom',
];
/** Position constants: Position.OutsideTopLeft etc. */
export const Position = Object.freeze(Object.fromEntries(NAMES.map((n, i) => [n, i])));
export const {
  Unset,
  OutsideTopLeft, OutsideTopCenter, OutsideTopRight,
  OutsideLeftTop, OutsideLeftMiddle, OutsideLeftBottom,
  OutsideRightTop, OutsideRightMiddle, OutsideRightBottom,
  OutsideBottomLeft, OutsideBottomCenter, OutsideBottomRight,
  InsideTopLeft, InsideTopCenter, InsideTopRight,
  InsideMiddleLeft, InsideMiddleCenter, InsideMiddleRight,
  InsideBottomLeft, InsideBottomCenter, InsideBottomRight,
  BorderTopLeft, BorderTopCenter, BorderTopRight,
  BorderLeftTop, BorderLeftMiddle, BorderLeftBottom,
  BorderRightTop, BorderRightMiddle, BorderRightBottom,
  BorderBottomLeft, BorderBottomCenter, BorderBottomRight,
  UnlockedTop, UnlockedMiddle, UnlockedBottom,
} = Position;

const snake = (n) => n.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
const TO_STRING = NAMES.map((n, i) => (i === 0 ? '' : snake(n)));
const FROM_STRING = new Map(TO_STRING.map((s, i) => [s, i]).filter(([s]) => s !== ''));

export function fromString(s) {
  return FROM_STRING.get(s) ?? Unset;
}

export function positionString(position) {
  return TO_STRING[position] ?? '';
}

const SHAPE_POSITIONS = new Set([
  OutsideTopLeft, OutsideTopCenter, OutsideTopRight,
  OutsideBottomLeft, OutsideBottomCenter, OutsideBottomRight,
  OutsideLeftTop, OutsideLeftMiddle, OutsideLeftBottom,
  OutsideRightTop, OutsideRightMiddle, OutsideRightBottom,
  InsideTopLeft, InsideTopCenter, InsideTopRight,
  InsideMiddleLeft, InsideMiddleCenter, InsideMiddleRight,
  InsideBottomLeft, InsideBottomCenter, InsideBottomRight,
  BorderTopLeft, BorderTopCenter, BorderTopRight,
  BorderLeftTop, BorderLeftMiddle, BorderLeftBottom,
  BorderRightTop, BorderRightMiddle, BorderRightBottom,
  BorderBottomLeft, BorderBottomCenter, BorderBottomRight,
]);
export const isShapePosition = (position) => SHAPE_POSITIONS.has(position);

const EDGE_POSITIONS = new Set([
  OutsideTopLeft, OutsideTopCenter, OutsideTopRight,
  InsideMiddleLeft, InsideMiddleCenter, InsideMiddleRight,
  OutsideBottomLeft, OutsideBottomCenter, OutsideBottomRight,
  UnlockedTop, UnlockedMiddle, UnlockedBottom,
]);
export const isEdgePosition = (position) => EDGE_POSITIONS.has(position);

const OUTSIDE = new Set([
  OutsideTopLeft, OutsideTopCenter, OutsideTopRight,
  OutsideBottomLeft, OutsideBottomCenter, OutsideBottomRight,
  OutsideLeftTop, OutsideLeftMiddle, OutsideLeftBottom,
  OutsideRightTop, OutsideRightMiddle, OutsideRightBottom,
]);
export const isOutside = (position) => OUTSIDE.has(position);

export const isUnlocked = (position) => position === UnlockedTop || position === UnlockedMiddle || position === UnlockedBottom;

const BORDER = new Set([
  BorderTopLeft, BorderTopCenter, BorderTopRight,
  BorderLeftTop, BorderLeftMiddle, BorderLeftBottom,
  BorderRightTop, BorderRightMiddle, BorderRightBottom,
  BorderBottomLeft, BorderBottomCenter, BorderBottomRight,
]);
export const isBorder = (position) => BORDER.has(position);

export const isOnEdge = (position) => position === InsideMiddleLeft || position === InsideMiddleCenter || position === InsideMiddleRight || position === UnlockedMiddle;

const MIRRORED = new Map([
  [OutsideTopLeft, OutsideBottomRight],
  [OutsideTopCenter, OutsideBottomCenter],
  [OutsideTopRight, OutsideBottomLeft],

  [OutsideLeftTop, OutsideRightBottom],
  [OutsideLeftMiddle, OutsideRightMiddle],
  [OutsideLeftBottom, OutsideRightTop],

  [OutsideRightTop, OutsideLeftBottom],
  [OutsideRightMiddle, OutsideLeftMiddle],
  [OutsideRightBottom, OutsideLeftTop],

  [OutsideBottomLeft, OutsideTopRight],
  [OutsideBottomCenter, OutsideTopCenter],
  [OutsideBottomRight, OutsideTopLeft],

  [InsideTopLeft, InsideBottomRight],
  [InsideTopCenter, InsideBottomCenter],
  [InsideTopRight, InsideBottomLeft],

  [InsideMiddleLeft, InsideMiddleRight],
  [InsideMiddleCenter, InsideMiddleCenter],
  [InsideMiddleRight, InsideMiddleLeft],

  [InsideBottomLeft, InsideTopRight],
  [InsideBottomCenter, InsideTopCenter],
  [InsideBottomRight, InsideTopLeft],

  [BorderTopLeft, BorderBottomRight],
  [BorderTopCenter, BorderBottomCenter],
  [BorderTopRight, BorderBottomLeft],

  [BorderLeftTop, BorderRightBottom],
  [BorderLeftMiddle, BorderRightMiddle],
  [BorderLeftBottom, BorderRightTop],

  [BorderRightTop, BorderLeftBottom],
  [BorderRightMiddle, BorderLeftMiddle],
  [BorderRightBottom, BorderLeftTop],

  [BorderBottomLeft, BorderTopRight],
  [BorderBottomCenter, BorderTopCenter],
  [BorderBottomRight, BorderTopLeft],

  [UnlockedTop, UnlockedBottom],
  [UnlockedBottom, UnlockedTop],
  [UnlockedMiddle, UnlockedMiddle],
]);
export const mirrored = (position) => MIRRORED.get(position) ?? Unset;

export function getPointOnBox(labelPosition, box, padding, width, height) {
  const p = box.TopLeft.copy();
  const boxCenter = box.center();

  switch (labelPosition) {
    case OutsideTopLeft:
      p.x -= padding;
      p.y -= padding + height;
      break;
    case OutsideTopCenter:
      p.x = boxCenter.x - width / 2;
      p.y -= padding + height;
      break;
    case OutsideTopRight:
      p.x += box.Width - width - padding;
      p.y -= padding + height;
      break;

    case OutsideLeftTop:
      p.x -= padding + width;
      p.y += padding;
      break;
    case OutsideLeftMiddle:
      p.x -= padding + width;
      p.y = boxCenter.y - height / 2;
      break;
    case OutsideLeftBottom:
      p.x -= padding + width;
      p.y += box.Height - height - padding;
      break;

    case OutsideRightTop:
      p.x += box.Width + padding;
      p.y += padding;
      break;
    case OutsideRightMiddle:
      p.x += box.Width + padding;
      p.y = boxCenter.y - height / 2;
      break;
    case OutsideRightBottom:
      p.x += box.Width + padding;
      p.y += box.Height - height - padding;
      break;

    case OutsideBottomLeft:
      p.x += padding;
      p.y += box.Height + padding;
      break;
    case OutsideBottomCenter:
      p.x = boxCenter.x - width / 2;
      p.y += box.Height + padding;
      break;
    case OutsideBottomRight:
      p.x += box.Width - width - padding;
      p.y += box.Height + padding;
      break;

    case InsideTopLeft:
      p.x += padding;
      p.y += padding;
      break;
    case InsideTopCenter:
      p.x = boxCenter.x - width / 2;
      p.y += padding;
      break;
    case InsideTopRight:
      p.x += box.Width - width - padding;
      p.y += padding;
      break;

    case InsideMiddleLeft:
      p.x += padding;
      p.y = boxCenter.y - height / 2;
      break;
    case InsideMiddleCenter:
      p.x = boxCenter.x - width / 2;
      p.y = boxCenter.y - height / 2;
      break;
    case InsideMiddleRight:
      p.x += box.Width - width - padding;
      p.y = boxCenter.y - height / 2;
      break;

    case InsideBottomLeft:
      p.x += padding;
      p.y += box.Height - height - padding;
      break;
    case InsideBottomCenter:
      p.x = boxCenter.x - width / 2;
      p.y += box.Height - height - padding;
      break;
    case InsideBottomRight:
      p.x += box.Width - width - padding;
      p.y += box.Height - height - padding;
      break;

    case BorderTopLeft:
      p.x += padding;
      p.y -= height / 2;
      break;
    case BorderTopCenter:
      p.x = boxCenter.x - width / 2;
      p.y -= height / 2;
      break;
    case BorderTopRight:
      p.x += box.Width - width - padding;
      p.y -= height / 2;
      break;

    case BorderLeftTop:
      p.x -= width / 2;
      p.y += padding;
      break;
    case BorderLeftMiddle:
      p.x -= width / 2;
      p.y = boxCenter.y - height / 2;
      break;
    case BorderLeftBottom:
      p.x -= width / 2;
      p.y += box.Height - height - padding;
      break;

    case BorderRightTop:
      p.x += box.Width - width / 2;
      p.y += padding;
      break;
    case BorderRightMiddle:
      p.x += box.Width - width / 2;
      p.y = boxCenter.y - height / 2;
      break;
    case BorderRightBottom:
      p.x += box.Width - width / 2;
      p.y += box.Height - height - padding;
      break;

    case BorderBottomLeft:
      p.x += padding;
      p.y += box.Height - height / 2;
      break;
    case BorderBottomCenter:
      p.x = boxCenter.x - width / 2;
      p.y += box.Height - height / 2;
      break;
    case BorderBottomRight:
      p.x += box.Width - width - padding;
      p.y += box.Height - height / 2;
      break;
  }

  return p;
}

/**
 * return the top left point of a width x height label at the given label position on the route
 * also return the index of the route segment that point is on: [point, index]
 *
 * Go quirk kept on purpose: in the Outside and UnlockedTop/UnlockedBottom cases `basePoint, index := ...` declares a new
 * `index` that shadows the named result, so those cases return index 0.
 */
export function getPointOnRoute(labelPosition, route, strokeWidth, labelPercentage, width, height) {
  const totalLength = Route.length(route);
  const leftPosition = LEFT_LABEL_POSITION * totalLength;
  const centerPosition = CENTER_LABEL_POSITION * totalLength;
  const rightPosition = RIGHT_LABEL_POSITION * totalLength;
  const unlockedPosition = labelPercentage * totalLength;

  // outside labels have to be offset in the direction of the edge's normal Vector
  // Note: we flip the normal for Top labels but keep it as is for Bottom labels since positive Y is below in SVG
  const getOffsetLabelPosition = (basePoint, normStart, normEnd, flip) => {
    // get the normal as a unit Vector so we can multiply to project in its direction
    let [normalX, normalY] = getUnitNormalVector(normStart.x, normStart.y, normEnd.x, normEnd.y);
    if (flip) {
      normalX *= -1;
      normalY *= -1;
    }

    // TODO: get actual edge stroke width on edge
    const offsetX = strokeWidth / 2 + PADDING + width / 2;
    const offsetY = strokeWidth / 2 + PADDING + height / 2;

    return newPoint(basePoint.x + normalX * offsetX, basePoint.y + normalY * offsetY);
  };

  let labelCenter;
  let index = 0;
  let basePoint, idx;
  switch (labelPosition) {
    case InsideMiddleLeft:
      [labelCenter, index] = Route.getPointAtDistance(route, leftPosition);
      break;
    case InsideMiddleCenter:
      [labelCenter, index] = Route.getPointAtDistance(route, centerPosition);
      break;
    case InsideMiddleRight:
      [labelCenter, index] = Route.getPointAtDistance(route, rightPosition);
      break;

    case OutsideTopLeft:
      [basePoint, idx] = Route.getPointAtDistance(route, leftPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], true);
      break;
    case OutsideTopCenter:
      [basePoint, idx] = Route.getPointAtDistance(route, centerPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], true);
      break;
    case OutsideTopRight:
      [basePoint, idx] = Route.getPointAtDistance(route, rightPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], true);
      break;

    case OutsideBottomLeft:
      [basePoint, idx] = Route.getPointAtDistance(route, leftPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], false);
      break;
    case OutsideBottomCenter:
      [basePoint, idx] = Route.getPointAtDistance(route, centerPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], false);
      break;
    case OutsideBottomRight:
      [basePoint, idx] = Route.getPointAtDistance(route, rightPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], false);
      break;

    case UnlockedTop:
      [basePoint, idx] = Route.getPointAtDistance(route, unlockedPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], true);
      break;
    case UnlockedMiddle:
      [labelCenter, index] = Route.getPointAtDistance(route, unlockedPosition);
      break;
    case UnlockedBottom:
      [basePoint, idx] = Route.getPointAtDistance(route, unlockedPosition);
      labelCenter = getOffsetLabelPosition(basePoint, route[idx], route[idx + 1], false);
      break;
    default:
      return [null, -1];
  }
  // convert from center to top left
  labelCenter.x = chopPrecision(labelCenter.x - width / 2);
  labelCenter.y = chopPrecision(labelCenter.y - height / 2);
  return [labelCenter, index];
}

// TODO probably use math.Big
function chopPrecision(f) {
  // bring down to float32 precision before rounding for consistency across architectures
  const result = goRound(float32(f * 10000) / 10000);
  // Ensure negative zero becomes positive zero
  if (result === 0) return 0;
  return result;
}
