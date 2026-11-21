// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/nodeshape (D2 v0.9.0): TALA's shape-specific port and
// label-position policy on top of D2's geometric shapes (lib/shape, public/d2/shape.js). The per-shape classes were translated from
// the Go files by tools/d2ref/tala/gennodeshape.py (shape_*.go -> one class each; the table helpers are written by hand below) and are
// checked against Go by `diff.mjs talanodeshape`.
//
// A nodeshape Shape wraps the base shape of shape.js (`this.base`) and forwards its methods, so it can be used wherever a shape.js
// shape is expected. labelPositionPreferences returns a Set of label positions (Go: map[label.Position]struct{}).

import * as geo from '../geo.js';
import * as label from '../label.js';
import * as shape from '../shape.js';
import { goRound } from '../gomath.js';
import { GoPanic } from './goerrors.js';

const { Orientation } = geo;

/** LabelTier groups label positions by how suitable they are for a shape. */
export const Good = 0;
export const OK = 1;
export const Unideal = 2;
export const Bad = 3;

/** Kind identifies the TALA behavior associated with a node shape (Go: uint8 iota, in this order). */
export const Square = 0;
export const RealSquare = 1;
export const Parallelogram = 2;
export const Document = 3;
export const Cylinder = 4;
export const Queue = 5;
export const Page = 6;
export const Package = 7;
export const Step = 8;
export const Callout = 9;
export const StoredData = 10;
export const Person = 11;
export const C4Person = 12;
export const Diamond = 13;
export const Oval = 14;
export const Circle = 15;
export const Hexagon = 16;
export const Cloud = 17;
export const Table = 18;
export const Class = 19;
export const Text = 20;
export const Code = 21;
export const Image = 22;

const KIND_STRINGS = new Map([
  [Callout, shape.CALLOUT_TYPE], [Circle, shape.CIRCLE_TYPE], [Cloud, shape.CLOUD_TYPE], [Cylinder, shape.CYLINDER_TYPE],
  [Diamond, shape.DIAMOND_TYPE], [Document, shape.DOCUMENT_TYPE], [Hexagon, shape.HEXAGON_TYPE], [Image, shape.IMAGE_TYPE],
  [Oval, shape.OVAL_TYPE], [Package, shape.PACKAGE_TYPE], [Page, shape.PAGE_TYPE], [Parallelogram, shape.PARALLELOGRAM_TYPE],
  [Person, shape.PERSON_TYPE], [C4Person, shape.C4_PERSON_TYPE], [Queue, shape.QUEUE_TYPE], [RealSquare, shape.REAL_SQUARE_TYPE],
  [Square, shape.SQUARE_TYPE], [Step, shape.STEP_TYPE], [StoredData, shape.STORED_DATA_TYPE], [Text, shape.TEXT_TYPE],
  [Class, shape.CLASS_TYPE], [Table, shape.TABLE_TYPE], [Code, shape.CODE_TYPE],
]);

/** Kind.String(): the D2 shape type represented by kind. */
export const kindString = (kind) => KIND_STRINGS.get(kind) ?? '';

/**
 * ShapeBase: the embedded shape.Shape of the Go structs. `base` is a shape.js shape built on the node's box.
 */
class ShapeBase {
  constructor(base) {
    this.base = base;
  }

  is(shapeType) { return this.base.is(shapeType); }
  getType() { return this.base.getType(); }
  aspectRatio1() { return this.base.aspectRatio1(); }
  isRectangular() { return this.base.isRectangular(); }
  getBox() { return this.base.getBox(); }
  getInnerBox() { return this.base.getInnerBox(); }
  getInnerBoxForContent(w, h) { return this.base.getInnerBoxForContent(w, h); }
  setInnerBoxAspectRatio(ar) { this.base.setInnerBoxAspectRatio(ar); }
  getInsidePlacement(w, h, padX, padY) { return this.base.getInsidePlacement(w, h, padX, padY); }
  getDimensionsToFit(w, h, padX, padY) { return this.base.getDimensionsToFit(w, h, padX, padY); }
  getDefaultPadding() { return this.base.getDefaultPadding(); }
  perimeter() { return this.base.perimeter(); }
  getSVGPathData() { return this.base.getSVGPathData(); }
}

// ---- shape_square.go ----
class ShapeSquare extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideTopCenter,
      label.InsideTopCenter,
      label.InsideMiddleCenter,
      label.InsideBottomCenter,
      label.OutsideBottomCenter,
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideBottomLeft,
      label.InsideBottomRight,
    ])
    break;
  case OK:
    return new Set([
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
    break;
  case Bad:
    return new Set();
  }
  return new Set();
  }

  snapPointPercentages() {
  return [
    // Top
    [
      geo.newRelativePoint(0.25, 0),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(0.75, 0),
    ],
    // Left
    [
      geo.newRelativePoint(0, 0.25),
      geo.newRelativePoint(0, 0.5),
      geo.newRelativePoint(0, 0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.25, 1),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 1),
    ],
    // Right
    [
      geo.newRelativePoint(1, 0.25),
      geo.newRelativePoint(1, 0.5),
      geo.newRelativePoint(1, 0.75),
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0, 1, 2];
  case Orientation.Left:
    return [3, 4, 5];
  case Orientation.Bottom:
    return [6, 7, 8];
  case Orientation.Right:
    return [9, 10, 11];
  case Orientation.TopLeft:
    return [0, 1, 2, 3, 4, 5];
  case Orientation.TopRight:
    return [0, 1, 2, 9, 10, 11];
  case Orientation.BottomLeft:
    return [6, 7, 8, 3, 4, 5];
  case Orientation.BottomRight:
    return [6, 7, 8, 9, 10, 11];
  default:
    return [];
  }
  }

  mirroredPortIndices() {
  return new Map([
    // Top and bottom
    [1, 7],
    [7, 1],
    // Left and right
    [4, 10],
    [10, 4],
  ])
  }

  centerPortIndices() {
  return [1, 4, 7, 10];
  }

  centerPortIndex(o) {
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_c4person.go ----
class ShapeC4Person extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideMiddleCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideTopCenter,
      label.InsideBottomCenter,
    ])
    break;
  case Unideal:
    return new Set([
      label.InsideBottomLeft,
      label.InsideBottomRight,
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopCenter,
      label.OutsideBottomCenter,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
      label.OutsideLeftMiddle,
      label.OutsideLeftBottom,
      label.OutsideRightMiddle,
      label.OutsideRightBottom,
      label.OutsideRightTop,
      label.OutsideLeftTop,
      label.OutsideTopLeft,
      label.OutsideTopRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  return [
    // Top (1 port at center of head)
    [
      geo.newRelativePoint(0.5, 0),
    ],
    // Left (3 ports on body only)
    [
      geo.newRelativePoint(0, 0.45), // Just below where body starts
      geo.newRelativePoint(0, 0.65), // Middle of body
      geo.newRelativePoint(0, 0.85), // Lower part of body
    ],
    // Bottom (3 ports)
    [
      geo.newRelativePoint(0.25, 1),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 1),
    ],
    // Right (3 ports on body only)
    [
      geo.newRelativePoint(1, 0.45), // Just below where body starts
      geo.newRelativePoint(1, 0.65), // Middle of body
      geo.newRelativePoint(1, 0.85), // Lower part of body
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0];
  case Orientation.Left:
    return [1, 2, 3];
  case Orientation.Bottom:
    return [4, 5, 6];
  case Orientation.Right:
    return [7, 8, 9];
  case Orientation.TopLeft:
    return [0, 1, 2, 3];
  case Orientation.TopRight:
    return [0, 7, 8, 9];
  case Orientation.BottomLeft:
    return [4, 5, 6, 1, 2, 3];
  case Orientation.BottomRight:
    return [4, 5, 6, 7, 8, 9];
  default:
    return [];
  }
  }

  mirroredPortIndices() {
  return new Map([
    // Top and bottom
    [1, 6],
    [6, 1],
    // Left and right
    [3, 8],
    [8, 3],
  ])
  }

  centerPortIndices() {
  return [0, 2, 5, 7];
  }

  centerPortIndex(o) {
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_callout.go ----
class ShapeCallout extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideTopLeft,
      label.InsideTopCenter,
      label.InsideTopRight,
      label.InsideMiddleLeft,
      label.InsideMiddleCenter,
      label.InsideMiddleRight,
      label.InsideBottomLeft,
      label.InsideBottomCenter,
      label.InsideBottomRight,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopCenter,
      label.OutsideTopRight,
      label.OutsideBottomCenter,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftTop,
      label.OutsideLeftMiddle,
      label.OutsideRightTop,
      label.OutsideRightMiddle,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  let box = this.getBox();
  let width = box.Width;
  let height = box.Height;
  let tipWidth = 30.0;
  let tipHeight = 45.0;

  if (width < tipWidth*2) {
    tipWidth = width / 2.0;
  }

  if (height < tipHeight*2) {
    tipHeight = height / 2.0;
  }

  return [
    // Top
    [
      geo.newRelativePoint(0.25, 0),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(0.75, 0),
    ],
    // Left
    [
      geo.newRelativePoint(0, ((height-tipHeight)/height)*0.25),
      geo.newRelativePoint(0, ((height-tipHeight)/height)*0.5),
      geo.newRelativePoint(0, ((height-tipHeight)/height)*0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.5*0.33, (height-tipHeight)/height),
      geo.newRelativePoint(0.5*0.66, (height-tipHeight)/height),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(
        1-((width/2.0-tipWidth)/width)*0.5,
        (height-tipHeight)/height,
      ),
    ],
    // Right
    [
      geo.newRelativePoint(1, ((height-tipHeight)/height)*0.25),
      geo.newRelativePoint(1, ((height-tipHeight)/height)*0.5),
      geo.newRelativePoint(1, ((height-tipHeight)/height)*0.75),
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0, 1, 2];
  case Orientation.Left:
    return [3, 4, 5];
  case Orientation.Bottom:
    return [6, 7, 8, 9];
  case Orientation.Right:
    return [10, 11, 12];
  case Orientation.TopLeft:
    return [0, 1, 2, 3, 4, 5];
  case Orientation.TopRight:
    return [0, 1, 2, 10, 11, 12];
  case Orientation.BottomLeft:
    return [6, 7, 8, 9, 3, 4, 5];
  case Orientation.BottomRight:
    return [6, 7, 8, 9, 10, 11, 12];
  default:
    return [];
  }
  }

  centerPortIndices() {
  return [1, 4, 8, 11];
  }

  mirroredPortIndices() {
  // Left and right
  return new Map([[4, 11], [11, 4]]);
  }

  centerPortIndex(o) {
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_circle.go ----
class ShapeCircle extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideTopCenter,
      label.InsideMiddleCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideBottomCenter,
      label.InsideTopCenter,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideBottomLeft,
      label.InsideBottomRight,
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
  }
  return new Set();
  }
}


// ---- shape_cloud.go ----
class ShapeCloud extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideMiddleCenter,
      label.InsideBottomCenter,
      label.OutsideBottomCenter,
      label.InsideTopCenter,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopCenter,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideBottomLeft,
      label.InsideBottomRight,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideLeftTop,
      label.OutsideRightTop,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  return [
    // Top
    [
      geo.newRelativePoint(0.16, 0.368),
      geo.newRelativePoint(0.378, 0.155),
      geo.newRelativePoint(0.815, 0.328),
    ],
    // Left
    [
      geo.newRelativePoint(0, 0.7),
      geo.newRelativePoint(0.066, 0.935),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.25, 1),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 1),
    ],
    // Right
    [
      geo.newRelativePoint(1, 0.7),
      geo.newRelativePoint(0.95, 0.89),
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0, 1, 2];
  case Orientation.Left:
    return [3, 4];
  case Orientation.Bottom:
    return [5, 6, 7];
  case Orientation.Right:
    return [8, 9];
  case Orientation.TopLeft:
    return [0, 1, 2, 3, 4];
  case Orientation.TopRight:
    return [0, 1, 2, 8, 9];
  case Orientation.BottomLeft:
    return [5, 6, 7, 3, 4];
  case Orientation.BottomRight:
    return [5, 6, 7, 8, 9];
  default:
    return [];
  }
  }

  mirroredPortIndices() {
  // Left and right
  return new Map([
    [3, 8],
    [8, 3],
  ])
  }

  centerPortIndices() {
  return [1, 3, 6, 8];
  }

  centerPortIndex(o) {
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_cylinder.go ----
class ShapeCylinder extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideTopCenter,
      label.InsideMiddleCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideTopCenter,
      label.InsideBottomCenter,
      label.InsideMiddleLeft,
      label.OutsideTopRight,
      label.OutsideBottomRight,
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
      label.OutsideTopLeft,
      label.OutsideBottomLeft,
      label.InsideTopLeft,
      label.InsideBottomLeft,
      label.InsideMiddleRight,
      label.InsideTopRight,
      label.InsideBottomRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
    break;
  case Bad:
    return new Set();
  }
  return new Set();
  }

  snapPointPercentages() {
  let box = this.getBox();
  let width = box.Width;
  let height = box.Height;
  let arcDepth = 24.0;
  let controlPointsMultiplier = 0.45;

  if (height < arcDepth*2) {
    arcDepth = height / 2.0;
  }

  let topLeftMidpoint = geo.newBezierCurve([
    geo.newPoint(0, arcDepth),
    geo.newPoint(0, 0),
    geo.newPoint(width*controlPointsMultiplier, 0),
    geo.newPoint(width/2.0, 0),
  ]).at(0.5)
  let topRightMidpoint = geo.newBezierCurve([
    geo.newPoint(width/2.0, 0),
    geo.newPoint(width-(width*controlPointsMultiplier), 0),
    geo.newPoint(width, 0),
    geo.newPoint(width, arcDepth),
  ]).at(0.5)
  let bottomRightMidpoint = geo.newBezierCurve([
    geo.newPoint(width, height-arcDepth),
    geo.newPoint(width, height),
    geo.newPoint(width-width*controlPointsMultiplier, height),
    geo.newPoint(width/2.0, height),
  ]).at(0.5)
  let bottomLeftMidpoint = geo.newBezierCurve([
    geo.newPoint(width/2.0, height),
    geo.newPoint(width*controlPointsMultiplier, height),
    geo.newPoint(0, height),
    geo.newPoint(0, height-arcDepth),
  ]).at(0.5)

  return [
    // Top
    [
      geo.newRelativePoint(topLeftMidpoint.x/width, topLeftMidpoint.y/height),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(topRightMidpoint.x/width, topRightMidpoint.y/height),
    ],
    // Left
    [
      geo.newRelativePoint(0, arcDepth/height+((height-arcDepth*2)/height)*0.25),
      geo.newRelativePoint(0, arcDepth/height+((height-arcDepth*2)/height)*0.5),
      geo.newRelativePoint(0, arcDepth/height+((height-arcDepth*2)/height)*0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(bottomLeftMidpoint.x/width, bottomLeftMidpoint.y/height),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(bottomRightMidpoint.x/width, bottomRightMidpoint.y/height),
    ],
    // Right
    [
      geo.newRelativePoint(1, arcDepth/height+((height-arcDepth*2)/height)*0.25),
      geo.newRelativePoint(1, arcDepth/height+((height-arcDepth*2)/height)*0.5),
      geo.newRelativePoint(1, arcDepth/height+((height-arcDepth*2)/height)*0.75),
    ],
  ]
  }
}


// ---- shape_diamond.go ----
class ShapeDiamond extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideMiddleCenter,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopCenter,
      label.OutsideBottomCenter,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
      label.InsideBottomCenter,
      label.InsideTopCenter,
    ])
    break;
  case Unideal:
    return new Set([
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideBottomLeft,
      label.InsideBottomRight,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  return [
    // Top
    [
      geo.newRelativePoint(0.5, 0),
    ],
    // Left
    [
      geo.newRelativePoint(0, 0.5),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.5, 1),
    ],
    // Right
    [
      geo.newRelativePoint(1, 0.5),
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0];
  case Orientation.Left:
    return [1];
  case Orientation.Bottom:
    return [2];
  case Orientation.Right:
    return [3];
  case Orientation.TopLeft:
    return [0, 1];
  case Orientation.TopRight:
    return [0, 3];
  case Orientation.BottomLeft:
    return [2, 1];
  case Orientation.BottomRight:
    return [2, 3];
  default:
    return [];
  }
  }

  mirroredPortIndices() {
  return new Map([
    // Top and bottom
    [0, 2],
    [2, 0],
    // Left and right
    [1, 3],
    [3, 1],
  ])
  }

  centerPortIndices() {
  return [0, 1, 2, 3];
  }

  centerPortIndex(o) {
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_document.go ----
class ShapeDocument extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideTopLeft,
      label.InsideTopCenter,
      label.InsideTopRight,
      label.InsideMiddleCenter,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopCenter,
      label.OutsideTopRight,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftTop,
      label.OutsideLeftMiddle,
      label.OutsideLeftBottom,
      label.OutsideRightTop,
      label.OutsideRightMiddle,
      label.OutsideRightBottom,
      label.InsideBottomCenter,
      label.InsideBottomLeft,
      label.InsideBottomRight,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideBottomLeft,
      label.OutsideBottomCenter,
      label.OutsideBottomRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  let box = this.getBox();
  let width = box.Width;
  let height = box.Height;
  let bottomLeftMidpoint = geo.newBezierCurve([
    geo.newPoint(0, height*(16.3/18.925)),
    geo.newPoint(width/6, height*(19.8/18.925)),
    geo.newPoint(width/3, height*(19.8/18.925)),
    geo.newPoint(width/2, height*(16.3/18.925)),
  ]).at(0.5)
  let bottomRightCurve = geo.newBezierCurve([
    geo.newPoint(width/2, height*(16.3/18.925)),
    geo.newPoint(width*2/3, height*(12.8/18.925)),
    geo.newPoint(width*5/6, height*(12.8/18.925)),
    geo.newPoint(width, height*(16.3/18.925)),
  ])
  return [
    // Top
    [
      geo.newRelativePoint(0.25, 0),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(0.75, 0),
    ],
    // Left
    [
      geo.newRelativePoint(0, 0.25),
      geo.newRelativePoint(0, 0.5),
      geo.newRelativePoint(0, 0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(bottomLeftMidpoint.x/width, bottomLeftMidpoint.y/height),
      geo.newRelativePoint(bottomRightCurve.at(0).x/width, bottomRightCurve.at(0).y/height),
      geo.newRelativePoint(bottomRightCurve.at(0.5).x/width, bottomRightCurve.at(0.5).y/height),
    ],
    // Right
    [
      geo.newRelativePoint(1, 0.25),
      geo.newRelativePoint(1, 0.5),
      geo.newRelativePoint(1, 0.75),
    ],
  ]
  }
}


// ---- shape_hexagon.go ----
class ShapeHexagon extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideTopCenter,
      label.InsideMiddleCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
      label.InsideTopCenter,
      label.InsideBottomCenter,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideBottomLeft,
      label.InsideBottomRight,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideLeftTop,
      label.OutsideLeftBottom,
      label.OutsideRightTop,
      label.OutsideRightBottom,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  return [
    // Top
    [
      geo.newRelativePoint(0.25, 0),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(0.75, 0),
    ],
    // Left
    [
      geo.newRelativePoint(0.125, 0.25),
      geo.newRelativePoint(0, 0.5),
      geo.newRelativePoint(0.125, 0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.25, 1),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 1),
    ],
    // Right
    [
      geo.newRelativePoint(0.875, 0.25),
      geo.newRelativePoint(1, 0.5),
      geo.newRelativePoint(0.875, 0.75),
    ],
  ]
  }
}


// ---- shape_image.go ----
class ShapeImage extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideBottomCenter,
      label.OutsideTopCenter,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
    break;
  case Bad:
    return new Set();
  }
  return new Set();
  }
}


// ---- shape_oval.go ----
class ShapeOval extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideTopCenter,
      label.InsideMiddleCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideBottomCenter,
      label.InsideTopCenter,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideBottomLeft,
      label.InsideBottomRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  return [
    // Top
    [
      geo.newRelativePoint(0.25, 0.066),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(0.75, 0.066),
    ],
    // Left
    [
      geo.newRelativePoint(0.066, 0.25),
      geo.newRelativePoint(0, 0.5),
      geo.newRelativePoint(0.066, 0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.25, 0.934),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 0.934),
    ],
    // Right
    [
      geo.newRelativePoint(0.934, 0.25),
      geo.newRelativePoint(1, 0.5),
      geo.newRelativePoint(0.934, 0.75),
    ],
  ]
  }
}


// ---- shape_package.go ----
class ShapePackage extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideMiddleCenter,
      label.InsideMiddleLeft,
      label.InsideBottomLeft,
      label.InsideBottomCenter,
      label.OutsideBottomLeft,
      label.OutsideBottomCenter,
      label.InsideTopLeft,
      label.InsideTopCenter,
      label.InsideTopRight,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopLeft,
      label.InsideMiddleRight,
      label.InsideBottomRight,
      label.OutsideBottomRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideTopCenter,
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
      label.OutsideLeftTop,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopRight,
      label.OutsideRightTop,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  let box = this.getBox();
  let width = box.Width;
  let height = box.Height;
  let verticalScalar = 0.2;
  let horizontalScalar = 0.5;
  let minTopHeight = 34.0;
  let maxTopHeight = 55.0;

  let minTopWidth = 50.0;
  let maxTopWidth = 150.0;

  let topWidth = Math.min(maxTopWidth, Math.max(minTopWidth, width*horizontalScalar));

  if (width < 2*minTopWidth) {
    topWidth = width * horizontalScalar;
  }

  let topHeight = Math.min(maxTopHeight, Math.max(minTopHeight, height*verticalScalar));

  if (height < 2*minTopHeight) {
    topHeight = height * verticalScalar;
  }

  let topWidthRatio = topWidth / width;
  let topHeightRatio = topHeight / height;

  // Space occupied by main shape not overlapping
  let negativeTopWidthRatio = 1 - topWidthRatio;
  let negativeTopHeightRatio = 1 - topHeightRatio;

  return [
    // Top
    [
      geo.newRelativePoint(topWidthRatio*0.33, 0),
      geo.newRelativePoint(topWidthRatio*0.66, 0),
      geo.newRelativePoint(topWidthRatio+negativeTopWidthRatio*0.5, topHeightRatio),
    ],
    // Left
    [
      geo.newRelativePoint(0, topHeightRatio+negativeTopHeightRatio*0.25),
      geo.newRelativePoint(0, topHeightRatio+negativeTopHeightRatio*0.5),
      geo.newRelativePoint(0, topHeightRatio+negativeTopHeightRatio*0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.25, 1),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 1),
    ],
    // Right
    [
      geo.newRelativePoint(1, topHeightRatio+negativeTopHeightRatio*0.25),
      geo.newRelativePoint(1, topHeightRatio+negativeTopHeightRatio*0.5),
      geo.newRelativePoint(1, topHeightRatio+negativeTopHeightRatio*0.75),
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0, 1, 2];
  case Orientation.Left:
    return [3, 4, 5];
  case Orientation.Bottom:
    return [6, 7, 8];
  case Orientation.Right:
    return [9, 10, 11];
  case Orientation.TopLeft:
    return [0, 1, 2, 3, 4, 5];
  case Orientation.TopRight:
    return [0, 1, 2, 9, 10, 11];
  case Orientation.BottomLeft:
    return [6, 7, 8, 3, 4, 5];
  case Orientation.BottomRight:
    return [6, 7, 8, 9, 10, 11];
  default:
    return [];
  }
  }

  mirroredPortIndices() {
  return new Map([
    // Left and right
    [4, 10],
    [10, 4],
  ])
  }

  centerPortIndices() {
  return [0, 1, 4, 7, 10];
  }

  centerPortIndex(o) {
  // Package type has two top center ports: 0 is also a center port, but 1 is closer to the center
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 1;
    break;
  case Orientation.Left:
    centerPortsIndex = 2;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 3;
    break;
  case Orientation.Right:
    centerPortsIndex = 4;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_page.go ----
class ShapePage extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideMiddleCenter,
      label.InsideBottomCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideTopLeft,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
      label.InsideBottomLeft,
      label.InsideBottomRight,
      label.OutsideTopLeft,
      label.OutsideTopCenter,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideTopRight,
      label.InsideTopCenter,
      label.OutsideRightBottom,
      label.OutsideRightMiddle,
      label.OutsideLeftTop,
      label.OutsideLeftMiddle,
      label.OutsideLeftBottom,
    ])
    break;
  case Bad:
    return new Set([
      label.InsideTopRight,
      label.OutsideRightTop,
    ])
  }
  return new Set();
  }
}


// ---- shape_parallelogram.go ----
class ShapeParallelogram extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideTopLeft,
      label.InsideMiddleCenter,
      label.InsideBottomRight,
      label.OutsideTopRight,
      label.OutsideBottomLeft,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopCenter,
      label.InsideTopCenter,
      label.InsideBottomCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideLeftMiddle,
      label.OutsideLeftBottom,
      label.OutsideRightTop,
      label.OutsideRightMiddle,
      label.InsideTopRight,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
      label.InsideBottomLeft,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideLeftTop,
      label.OutsideRightBottom,
      label.OutsideBottomRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  let width = this.getBox().Width;
  let wedgeWidth = 26.0;
  if (width < wedgeWidth) {
    wedgeWidth = width / 2.0;
  }

  return [
    // Top
    [
      geo.newRelativePoint(wedgeWidth/width+((width-wedgeWidth)/width)*0.25, 0),
      geo.newRelativePoint(wedgeWidth/width+((width-wedgeWidth)/width)*0.5, 0),
      geo.newRelativePoint(wedgeWidth/width+((width-wedgeWidth)/width)*0.75, 0),
    ],
    // Left
    [
      geo.newRelativePoint((wedgeWidth/2.0+wedgeWidth)/2.0/width, 0.25),
      geo.newRelativePoint(wedgeWidth/2.0/width, 0.5),
      geo.newRelativePoint(wedgeWidth/2.0/2.0/width, 0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.25, 1),
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.5, 1),
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.75, 1),
    ],
    // Right
    [
      geo.newRelativePoint((width-wedgeWidth)/width+(wedgeWidth/2.0+wedgeWidth)/2.0/width, 0.25),
      geo.newRelativePoint((width-wedgeWidth)/width+wedgeWidth/2.0/width, 0.5),
      geo.newRelativePoint((width-wedgeWidth)/width+wedgeWidth/2.0/2.0/width, 0.75),
    ],
  ]
  }
}


// ---- shape_person.go ----
class ShapePerson extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopCenter,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.InsideTopCenter,
      label.InsideMiddleCenter,
      label.InsideBottomCenter,
      label.InsideBottomLeft,
      label.InsideBottomRight,
      label.OutsideLeftMiddle,
      label.OutsideLeftBottom,
      label.OutsideRightMiddle,
      label.OutsideRightBottom,
    ])
    break;
  case Bad:
    return new Set([
      label.InsideTopLeft,
      label.InsideTopRight,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
      label.OutsideRightTop,
      label.OutsideLeftTop,
      label.OutsideTopLeft,
      label.OutsideTopRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  return [
    // Top
    [
      geo.newRelativePoint(0.21, 0.122),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(0.79, 0.122),
    ],
    // Left
    [
      geo.newRelativePoint(0.135, 0.35),
      geo.newRelativePoint(0.08, 0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(0.25, 0.985),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 0.985),
    ],
    // Right
    [
      geo.newRelativePoint(0.865, 0.35),
      geo.newRelativePoint(0.92, 0.75),
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0, 1, 2];
  case Orientation.Left:
    return [3, 4];
  case Orientation.Bottom:
    return [5, 6, 7];
  case Orientation.Right:
    return [8, 9];
  case Orientation.TopLeft:
    return [0, 1, 2, 3, 4];
  case Orientation.TopRight:
    return [0, 1, 2, 8, 9];
  case Orientation.BottomLeft:
    return [5, 6, 7, 3, 4];
  case Orientation.BottomRight:
    return [5, 6, 7, 8, 9];
  default:
    return [];
  }
  }

  mirroredPortIndices() {
  return new Map([
    // Top and bottom
    [1, 6],
    [6, 1],
    // Left and right
    [3, 8],
    [8, 3],
  ])
  }

  centerPortIndices() {
  return [1, 3, 6, 8];
  }

  centerPortIndex(o) {
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_queue.go ----
class ShapeQueue extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideTopCenter,
      label.InsideTopCenter,
      label.InsideMiddleCenter,
      label.InsideBottomCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideTopLeft,
      label.InsideBottomLeft,
      label.InsideMiddleRight,
    ])
    break;
  case Unideal:
    return new Set([
      label.InsideTopRight,
      label.InsideBottomRight,
      label.OutsideLeftMiddle,
      label.OutsideRightMiddle,
      label.InsideMiddleLeft,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopLeft,
      label.OutsideTopRight,
      label.OutsideBottomLeft,
      label.OutsideBottomRight,
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  let box = this.getBox();
  let width = box.Width;
  let height = box.Height;
  let arcDepth = 24.0;
  let controlPointsMultiplier = 0.45;

  if (width < arcDepth*2) {
    arcDepth = width / 2.0;
  }

  let topLeftMidpoint = geo.newBezierCurve([
    geo.newPoint(arcDepth, 0),
    geo.newPoint(0, 0),
    geo.newPoint(0, height*controlPointsMultiplier),
    geo.newPoint(0, height/2.0),
  ]).at(0.5)
  let topRightMidpoint = geo.newBezierCurve([
    geo.newPoint(width-arcDepth, 0),
    geo.newPoint(width, 0),
    geo.newPoint(width, height*controlPointsMultiplier),
    geo.newPoint(width, height/2.0),
  ]).at(0.5)
  let bottomRightMidpoint = geo.newBezierCurve([
    geo.newPoint(width, height/2.0),
    geo.newPoint(width, height-height*controlPointsMultiplier),
    geo.newPoint(width, height),
    geo.newPoint(width-arcDepth, height),
  ]).at(0.5)
  let bottomLeftMidpoint = geo.newBezierCurve([
    geo.newPoint(0, height/2.0),
    geo.newPoint(0, height-height*controlPointsMultiplier),
    geo.newPoint(0, height),
    geo.newPoint(arcDepth, height),
  ]).at(0.5)

  return [
    // Top
    [
      geo.newRelativePoint(arcDepth/width+((width-arcDepth*2)/width)*0.25, 0),
      geo.newRelativePoint(arcDepth/width+((width-arcDepth*2)/width)*0.5, 0),
      geo.newRelativePoint(arcDepth/width+((width-arcDepth*2)/width)*0.75, 0),
    ],
    // Left
    [
      geo.newRelativePoint(topLeftMidpoint.x/width, topLeftMidpoint.y/height),
      geo.newRelativePoint(0, 0.5),
      geo.newRelativePoint(bottomLeftMidpoint.x/width, bottomLeftMidpoint.y/height),
    ],
    // Bottom
    [
      geo.newRelativePoint(arcDepth/width+((width-arcDepth*2)/width)*0.25, 1),
      geo.newRelativePoint(arcDepth/width+((width-arcDepth*2)/width)*0.5, 1),
      geo.newRelativePoint(arcDepth/width+((width-arcDepth*2)/width)*0.75, 1),
    ],
    // Right
    [
      geo.newRelativePoint(topRightMidpoint.x/width, topRightMidpoint.y/height),
      geo.newRelativePoint(1, 0.5),
      geo.newRelativePoint(bottomRightMidpoint.x/width, bottomRightMidpoint.y/height),
    ],
  ]
  }
}


// ---- shape_step.go ----
class ShapeStep extends ShapeBase {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.InsideMiddleCenter,
    ])
    break;
  case OK:
    return new Set([
      label.InsideTopCenter,
      label.InsideTopRight,
      label.InsideBottomRight,
      label.InsideMiddleLeft,
      label.InsideMiddleRight,
      label.InsideBottomCenter,
      label.OutsideTopLeft,
      label.OutsideTopCenter,
      label.OutsideBottomLeft,
      label.OutsideBottomCenter,
    ])
    break;
  case Unideal:
    return new Set([
      label.OutsideRightMiddle,
      label.OutsideLeftTop,
      label.OutsideLeftBottom,
      label.InsideTopLeft,
      label.InsideBottomLeft,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideTopRight,
      label.OutsideLeftMiddle,
      label.OutsideRightTop,
      label.OutsideRightBottom,
      label.OutsideBottomRight,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  let width = this.getBox().Width;
  let wedgeWidth = shape.STEP_WEDGE_WIDTH;
  if (width < wedgeWidth) {
    wedgeWidth = width / 2.0;
  }

  return [
    // Top
    [
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.25, 0),
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.5, 0),
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.75, 0),
    ],
    // Left
    [
      geo.newRelativePoint(wedgeWidth/width/2, 0.25),
      geo.newRelativePoint(wedgeWidth/width, 0.5),
      geo.newRelativePoint(wedgeWidth/width/2, 0.75),
    ],
    // Bottom
    [
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.25, 1),
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.5, 1),
      geo.newRelativePoint(((width-wedgeWidth)/width)*0.75, 1),
    ],
    // Right
    [
      geo.newRelativePoint(1, 0.5),
    ],
  ]
  }

  portIndices(orientation) {
  switch (orientation) {
  case Orientation.Top:
    return [0, 1, 2];
  case Orientation.Left:
    return [3, 4, 5];
  case Orientation.Bottom:
    return [6, 7, 8];
  case Orientation.Right:
    return [9];
  case Orientation.TopLeft:
    return [0, 1, 2, 3, 4, 5];
  case Orientation.TopRight:
    return [0, 1, 2, 9];
  case Orientation.BottomLeft:
    return [6, 7, 8, 3, 4, 5];
  case Orientation.BottomRight:
    return [6, 7, 8, 9];
  default:
    return [];
  }
  }

  mirroredPortIndices() {
  return new Map([
    // Top and bottom
    [1, 7],
    [7, 1],
    // Left and right
    [4, 9],
    [9, 4],
  ])
  }

  centerPortIndices() {
  return [1, 4, 7, 9];
  }

  centerPortIndex(o) {
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }
}


// ---- shape_stored_data.go ----
class ShapeStoredData extends ShapeSquare {
  labelPositionPreferences(preferenceSet) {
  switch (preferenceSet) {
  case Good:
    return new Set([
      label.OutsideTopCenter,
      label.InsideTopCenter,
      label.InsideMiddleCenter,
      label.InsideBottomCenter,
      label.OutsideBottomCenter,
    ])
    break;
  case OK:
    return new Set([
      label.OutsideTopRight,
      label.OutsideBottomRight,
      label.InsideTopRight,
      label.InsideBottomRight,
      label.InsideMiddleRight,
      label.InsideTopLeft,
      label.InsideBottomLeft,
    ])
    break;
  case Unideal:
    return new Set([
      label.InsideMiddleLeft,
      label.OutsideLeftMiddle,
      label.OutsideTopLeft,
      label.OutsideBottomLeft,
    ])
    break;
  case Bad:
    return new Set([
      label.OutsideRightMiddle,
      label.OutsideLeftTop,
      label.OutsideRightTop,
      label.OutsideLeftBottom,
      label.OutsideRightBottom,
    ])
  }
  return new Set();
  }

  snapPointPercentages() {
  let box = this.getBox();
  let width = box.Width;
  let height = box.Height;
  let wedgeWidth = 15.0;
  if (width < wedgeWidth) {
    wedgeWidth = width / 2;
  }
  let controlPointsMultiplier = 0.27;

  let topLeftMidpoint = geo.newBezierCurve([
    geo.newPoint(wedgeWidth, 0.0),
    geo.newPoint(wedgeWidth-(wedgeWidth*controlPointsMultiplier), 0.0),
    geo.newPoint(0.0, height*controlPointsMultiplier),
    geo.newPoint(0.0, height/2.0),
  ]).at(0.5)

  let bottomLeftMidpoint = geo.newBezierCurve([
    geo.newPoint(wedgeWidth, height),
    geo.newPoint(wedgeWidth-(wedgeWidth*controlPointsMultiplier), height),
    geo.newPoint(0.0, height-height*controlPointsMultiplier),
    geo.newPoint(0.0, height/2.0),
  ]).at(0.5)

  let topRightMidpoint = geo.newBezierCurve([
    geo.newPoint(width, 0),
    geo.newPoint(width-(wedgeWidth*controlPointsMultiplier), 0),
    geo.newPoint(width-wedgeWidth, height*controlPointsMultiplier),
    geo.newPoint(width-wedgeWidth, height/2.0),
  ]).at(0.5)

  let bottomRightMidpoint = geo.newBezierCurve([
    geo.newPoint(width-wedgeWidth, height/2.0),
    geo.newPoint(width-wedgeWidth, height-height*controlPointsMultiplier),
    geo.newPoint(width-wedgeWidth*controlPointsMultiplier, height),
    geo.newPoint(width, height),
  ]).at(0.5)

  let sideWidthPercentage = (width - wedgeWidth) / width;
  let sideWidthStartPercentage = 1 - sideWidthPercentage;

  return [
    // Top
    [
      geo.newRelativePoint(sideWidthStartPercentage+(0.25*sideWidthPercentage), 0),
      geo.newRelativePoint(sideWidthStartPercentage+(0.5*sideWidthPercentage), 0),
      geo.newRelativePoint(sideWidthStartPercentage+(0.75*sideWidthPercentage), 0),
    ],
    // Left
    [
      geo.newRelativePoint(topLeftMidpoint.x/width, topLeftMidpoint.y/height),
      geo.newRelativePoint(0.0, 0.5),
      geo.newRelativePoint(bottomLeftMidpoint.x/width, bottomLeftMidpoint.y/height),
    ],
    // Bottom
    [
      geo.newRelativePoint(sideWidthStartPercentage+(0.25*sideWidthPercentage), 1),
      geo.newRelativePoint(sideWidthStartPercentage+(0.5*sideWidthPercentage), 1),
      geo.newRelativePoint(sideWidthStartPercentage+(0.75*sideWidthPercentage), 1),
    ],
    // Right
    [
      geo.newRelativePoint(topRightMidpoint.x/width, topRightMidpoint.y/height),
      geo.newRelativePoint((width-wedgeWidth)/width, 0.5),
      geo.newRelativePoint(bottomRightMidpoint.x/width, bottomRightMidpoint.y/height),
    ],
  ]
  }
}


// ---- shape_table.go ----
class ShapeTable extends ShapeSquare {
  constructor(base) {
    super(base);
    this.numColumns = 0;
  }

  snapPointPercentages() {
  let left, right;
  if (this.numColumns === 0) {
    left = [geo.newRelativePoint(0., 0.5)];
    right = [geo.newRelativePoint(1., 0.5)];
  } else {
    left = [];
    right = [];
    // *row* is used here instead of *column* because during rendering of this shape, columns are drawn in rows
    let rowHeightPercentage = 1. / ((this.numColumns) + 1.) // +1 because of the table header;
    let midRowPercentage = rowHeightPercentage / 2.;
    // start in rowHeightPercentage + midRowPercentage to skip the header
    for (let perc = rowHeightPercentage + midRowPercentage; perc < 1.; perc += rowHeightPercentage) {
      let h = goRound(perc*10_000) / 10_000 // clips decimal places to avoid numerical issues;
      left.push(geo.newRelativePoint(0., h));
      right.push(geo.newRelativePoint(1., h));
    }
  }
  return [
    // Top
    [
      geo.newRelativePoint(0.25, 0),
      geo.newRelativePoint(0.5, 0),
      geo.newRelativePoint(0.75, 0),
    ],
    left,
    // Bottom
    [
      geo.newRelativePoint(0.25, 1),
      geo.newRelativePoint(0.5, 1),
      geo.newRelativePoint(0.75, 1),
    ],
    right,
  ]
  }

  centerPortIndices() {
  if (this.numColumns > 0) {
    return []; // Go: nil
  }
  return [
    1,
    3,
    5,
    7,
  ]
  }

  centerPortIndex(o) {
  if (this.numColumns > 0) {
    return -1;
  }
  let centerPorts = this.centerPortIndices();
  let centerPortsIndex = 0;
  switch (o) {
  case Orientation.Top:
    centerPortsIndex = 0;
    break;
  case Orientation.Left:
    centerPortsIndex = 1;
    break;
  case Orientation.Bottom:
    centerPortsIndex = 2;
    break;
  case Orientation.Right:
    centerPortsIndex = 3;
    break;
  default:
    return -1;
  }

  return centerPorts[centerPortsIndex];
  }

  mirroredPortIndices() {
  if (this.numColumns > 0) {
    return new Map(); // Go: nil
  }
  let centerPorts = this.centerPortIndices();
  return new Map([
    // Top and bottom
    [centerPorts[0], centerPorts[2]],
    [centerPorts[2], centerPorts[0]],
    // Left and right
    [centerPorts[1], centerPorts[3]],
    [centerPorts[3], centerPorts[1]],
  ])
  }

  portIndices(orientation) {
  let numColumns = this.numColumns;
  if (numColumns === 0) {
    // in this case, make the side ports for the table header
    numColumns = 1;
  }
  let topIndices = [0, 1, 2];

  let firstLeftIndex = topIndices[2] + 1;
  let leftIndices = new Array(numColumns).fill(0);
  for (let i = 0; i < numColumns; i++) {
    leftIndices[i] = firstLeftIndex + i
  }

  let firstBottomIndex = leftIndices[numColumns-1] + 1;
  let bottomIndices = new Array(3).fill(0);
  for (let i = 0; i < 3; i++) {
    bottomIndices[i] = firstBottomIndex + i
  }

  let firstRightIndex = bottomIndices[2] + 1;
  let rightIndices = new Array(numColumns).fill(0);
  for (let i = 0; i < numColumns; i++) {
    rightIndices[i] = firstRightIndex + i
  }

  switch (orientation) {
  case Orientation.Top:
    return topIndices;
  case Orientation.Left:
    return leftIndices;
  case Orientation.Bottom:
    return bottomIndices;
  case Orientation.Right:
    return rightIndices;
  case Orientation.TopLeft:
    return topIndices.concat(leftIndices);
  case Orientation.TopRight:
    return topIndices.concat(rightIndices);
  case Orientation.BottomLeft:
    return bottomIndices.concat(leftIndices);
  case Orientation.BottomRight:
    return bottomIndices.concat(rightIndices);
  default:
    return [];
  }
  }
}

// ---- shape.go: New ----

/**
 * New constructs TALA's policy wrapper around a D2 shape: [shape, kind], or null (Go ok=false) for an unsupported nonempty type. An empty
 * type uses square behavior while retaining the empty D2 type.
 */
export function newShape(typeName, box) {
  const base = shape.newShape(typeName, box);
  switch (typeName) {
    case shape.CALLOUT_TYPE: return [new ShapeCallout(base), Callout];
    case shape.CIRCLE_TYPE: return [new ShapeCircle(base), Circle];
    case shape.CLOUD_TYPE: return [new ShapeCloud(base), Cloud];
    case shape.CYLINDER_TYPE: return [new ShapeCylinder(base), Cylinder];
    case shape.DIAMOND_TYPE: return [new ShapeDiamond(base), Diamond];
    case shape.DOCUMENT_TYPE: return [new ShapeDocument(base), Document];
    case shape.HEXAGON_TYPE: return [new ShapeHexagon(base), Hexagon];
    case shape.IMAGE_TYPE: return [new ShapeImage(base), Image];
    case shape.OVAL_TYPE: return [new ShapeOval(base), Oval];
    case shape.PACKAGE_TYPE: return [new ShapePackage(base), Package];
    case shape.PAGE_TYPE: return [new ShapePage(base), Page];
    case shape.PARALLELOGRAM_TYPE: return [new ShapeParallelogram(base), Parallelogram];
    case shape.PERSON_TYPE: return [new ShapePerson(base), Person];
    case shape.C4_PERSON_TYPE: return [new ShapeC4Person(base), C4Person];
    case shape.QUEUE_TYPE: return [new ShapeQueue(base), Queue];
    case shape.REAL_SQUARE_TYPE: return [new ShapeSquare(base), RealSquare];
    case shape.SQUARE_TYPE: return [new ShapeSquare(base), Square];
    case shape.STEP_TYPE: return [new ShapeStep(base), Step];
    case shape.STORED_DATA_TYPE: return [new ShapeStoredData(base), StoredData];
    case shape.TEXT_TYPE: return [new ShapeSquare(base), Text];
    case shape.CLASS_TYPE: return [new ShapeSquare(base), Class];
    case shape.TABLE_TYPE: return [new ShapeTable(base), Table];
    case shape.CODE_TYPE: return [new ShapeSquare(base), Code];
    case '': return [new ShapeSquare(base), Square];
    default: return null;
  }
}

// ---- shape_table.go: the helpers on a Shape ----

/** NumColumns returns the number of row-specific side ports for a table shape. Non-table shapes do not carry this metadata. */
export function numColumns(s) {
  if (!(s instanceof ShapeTable)) return 0;
  return s.numColumns;
}

/** SetNumColumns updates the row-specific side ports for a table shape. It is a no-op for every other shape. */
export function setNumColumns(s, numColumns_) {
  if (s instanceof ShapeTable) s.numColumns = numColumns_;
}

/**
 * TablePortIndex returns the absolute snap-point index for a table column on the requested side: [index, ok]. Non-table shapes and
 * non-side orientations return ok=false so callers can use their generic port policy.
 */
export function tablePortIndex(s, orientation, columnIndex) {
  if (!(s instanceof ShapeTable)) return [0, false];
  let numColumns_ = s.numColumns;
  if (numColumns_ === 0) numColumns_ = 1;
  if (columnIndex < 0 || columnIndex >= numColumns_) throw new GoPanic('table column port index out of range');
  switch (orientation) {
    case Orientation.Left:
      return [3 + columnIndex, true];
    case Orientation.Right:
      return [6 + numColumns_ + columnIndex, true];
    default:
      return [0, false];
  }
}

/**
 * TableColumnPortValue returns the table column's concrete side port without materializing all of the shape's snap points:
 * [geo.Point, ok]. Non-table shapes and non-side orientations return ok=false.
 */
export function tableColumnPortValue(s, orientation, columnIndex) {
  if (!(s instanceof ShapeTable) || (orientation !== Orientation.Left && orientation !== Orientation.Right)) return [new geo.Point(), false];
  const numColumns_ = s.numColumns;
  if (numColumns_ === 0) {
    if (columnIndex !== 0) throw new GoPanic('table column port index out of range');
  } else if (columnIndex < 0 || columnIndex >= numColumns_) {
    throw new GoPanic('table column port index out of range');
  }

  let yPercentage = 0.5;
  if (numColumns_ > 0) {
    const rowHeightPercentage = 1. / (numColumns_ + 1.);
    let percentage = rowHeightPercentage + rowHeightPercentage / 2.;
    for (let i = 0; i < columnIndex; i++) percentage += rowHeightPercentage;
    percentage = goRound(percentage * 10_000) / 10_000;
    yPercentage = geo.truncateDecimals(percentage);
  }
  let xPercentage = 0.0;
  if (orientation === Orientation.Right) xPercentage = 1.0;
  const box = s.getBox();
  return [new geo.Point(box.TopLeft.x + goRound(box.Width * xPercentage), box.TopLeft.y + goRound(box.Height * yPercentage)), true];
}
