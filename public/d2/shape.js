// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's lib/shape package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.).
// Go's embedded structs become class inheritance: a method that Go dispatches through `FullShape` (the concrete
// shape) is an ordinary `this.method()` call here. Shapes are created with newShape(type, box).

import {
  Box, Point, Segment, Ellipse, newPoint, newBox, newEllipse, euclideanDistance,
} from './geo.js';
import { newSVGPathContext } from './svg.js';
import { goRound, float32, goPow, exactDiv, SQRT2_DEC } from './gomath.js';

// Go folds constant expressions exactly and rounds once; these are those expressions (see gomath.exactDiv).
const DOC_BOTTOM = exactDiv('16.3', '18.925'); // docPathBottom/docPathHeight
const DOC_12_8 = exactDiv('12.8', '18.925'); // 12.8/docPathHeight
const DOC_19_8 = exactDiv('19.8', '18.925'); // 19.8/docPathHeight
const DOC_PADDING_Y = exactDiv('560', '18.925'); // defaultPadding * docPathInnerBottom / docPathHeight
const PAGE_PADDING_Y = exactDiv('60.348', '1'); // pageCornerHeight + defaultPadding
const PAGE_3H = exactDiv('61.044', '1'); // 3*pageCornerHeight
const CIRCLE_PADDING = exactDiv('40', SQRT2_DEC); // defaultPadding / math.Sqrt2
const PERSON_F = exactDiv('20.2', '68.3'); // personShoulderWidthFactor
const PERSON_G = exactDiv('27.9', '68.3'); // 1 - 2*personShoulderWidthFactor
const HEX_HALF_Y = exactDiv('43.6', '87.3');

export const SQUARE_TYPE = 'Square';
export const REAL_SQUARE_TYPE = 'RealSquare';
export const PARALLELOGRAM_TYPE = 'Parallelogram';
export const DOCUMENT_TYPE = 'Document';
export const CYLINDER_TYPE = 'Cylinder';
export const QUEUE_TYPE = 'Queue';
export const PAGE_TYPE = 'Page';
export const PACKAGE_TYPE = 'Package';
export const STEP_TYPE = 'Step';
export const CALLOUT_TYPE = 'Callout';
export const STORED_DATA_TYPE = 'StoredData';
export const PERSON_TYPE = 'Person';
export const C4_PERSON_TYPE = 'C4Person';
export const DIAMOND_TYPE = 'Diamond';
export const OVAL_TYPE = 'Oval';
export const CIRCLE_TYPE = 'Circle';
export const HEXAGON_TYPE = 'Hexagon';
export const CLOUD_TYPE = 'Cloud';

export const TABLE_TYPE = 'Table';
export const CLASS_TYPE = 'Class';
export const TEXT_TYPE = 'Text';
export const CODE_TYPE = 'Code';
export const IMAGE_TYPE = 'Image';

const defaultPadding = 40.;

/** Go's baseShape; also the interface every shape implements. */
class BaseShape {
  constructor(type, box) {
    this.Type = type;
    this.Box = box;
  }
  is(shapeType) { return this.Type === shapeType; }
  getType() { return this.Type; }
  aspectRatio1() { return false; }
  isRectangular() { return false; }
  getBox() { return this.Box; }
  getInnerBox() { return this.Box; }
  /** only cloud shape needs this right now */
  getInnerBoxForContent(_width, _height) { return null; }
  setInnerBoxAspectRatio(_aspectRatio) { /* only used for cloud */ }
  /** placing a rectangle of the given size and padding inside the shape, return the position relative to the shape's TopLeft */
  getInsidePlacement(_w, _h, paddingX, paddingY) {
    const innerTL = this.getInnerBox().TopLeft;
    return newPoint(innerTL.x + paddingX / 2, innerTL.y + paddingY / 2);
  }
  /** return the minimum shape dimensions needed to fit content (width x height) in the shape's innerBox with padding: [w, h] */
  getDimensionsToFit(width, height, paddingX, paddingY) {
    return [Math.ceil(width + paddingX), Math.ceil(height + paddingY)];
  }
  /** [paddingX, paddingY] */
  getDefaultPadding() { return [defaultPadding, defaultPadding]; }
  /** Perimeter returns a slice of Intersectables that together constitute the shape border */
  perimeter() { return null; }
  getSVGPathData() { return null; }
}

class ShapeSquare extends BaseShape {
  constructor(box, type = SQUARE_TYPE) { super(type, box); }
  isRectangular() { return true; }
}
export const newSquare = (box) => new ShapeSquare(box);

class ShapeRealSquare extends BaseShape {
  constructor(box) { super(REAL_SQUARE_TYPE, box); }
  aspectRatio1() { return true; }
  isRectangular() { return true; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const sideLength = Math.ceil(Math.max(width + paddingX, height + paddingY));
    return [sideLength, sideLength];
  }
}
export const newRealSquare = (box) => new ShapeRealSquare(box);

class ShapeCircle extends BaseShape {
  constructor(box) { super(CIRCLE_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    let height = this.Box.Height;
    const insideTL = this.getInsidePlacement(width, height, 0, 0);
    const tl = this.Box.TopLeft.copy();
    width -= 2 * (insideTL.x - tl.x);
    height -= 2 * (insideTL.y - tl.y);
    return newBox(insideTL, width, height);
  }
  aspectRatio1() { return true; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const length = Math.max(width + paddingX, height + paddingY);
    const diameter = Math.ceil(Math.SQRT2 * length);
    return [diameter, diameter];
  }
  getInsidePlacement(_width, _height, paddingX, paddingY) {
    const r = this.getBox().Width / 2;
    const halfLength = r * Math.SQRT2 / 2.;
    return new Point(
      this.getBox().TopLeft.x + Math.ceil(r - halfLength + paddingX / 2.),
      this.getBox().TopLeft.y + Math.ceil(r - halfLength + paddingY / 2.),
    );
  }
  perimeter() { return [newEllipse(this.Box.center(), this.Box.Width / 2, this.Box.Height / 2)]; }
  getDefaultPadding() { return [CIRCLE_PADDING, CIRCLE_PADDING]; }
}
export const newCircle = (box) => new ShapeCircle(box);

/** Class is basically a rectangle */
class ShapeClass extends ShapeSquare {
  constructor(box) { super(box, CLASS_TYPE); }
  getDefaultPadding() { return [0, 0]; }
}
export const newClass = (box) => new ShapeClass(box);

class ShapeCode extends ShapeSquare {
  constructor(box) { super(box, CODE_TYPE); }
  getDefaultPadding() { return [0, 0]; }
}
export const newCode = (box) => new ShapeCode(box);

class ShapeImage extends BaseShape {
  constructor(box) { super(IMAGE_TYPE, box); }
  isRectangular() { return true; }
  getDefaultPadding() { return [0, 0]; }
}
export const newImage = (box) => new ShapeImage(box);

/** Table is basically a rectangle */
class ShapeTable extends ShapeSquare {
  constructor(box) { super(box, TABLE_TYPE); }
  getDefaultPadding() { return [0, 0]; }
}
export const newTable = (box) => new ShapeTable(box);

/** Text is basically a rectangle */
class ShapeText extends ShapeSquare {
  constructor(box) { super(box, TEXT_TYPE); }
  getDefaultPadding() { return [0, 0]; }
}
export const newText = (box) => new ShapeText(box);

// ---- diamond ----

function diamondPath(box) {
  const pc = newSVGPathContext(box.TopLeft, box.Width / 77, box.Height / 76.9);
  pc.startAt(pc.absolute(38.5, 76.9));
  pc.C(true, -0.3, 0, -0.5, -0.1, -0.7, -0.3);
  pc.L(false, 0.3, 39.2);
  pc.C(true, -0.4, -0.4, -0.4, -1, 0, -1.4);
  pc.L(false, 37.8, 0.3);
  pc.C(true, 0.4, -0.4, 1, -0.4, 1.4, 0);
  pc.L(true, 37.5, 37.5);
  pc.C(true, 0.4, 0.4, 0.4, 1, 0, 1.4);
  pc.L(false, 39.2, 76.6);
  pc.C(false, 39, 76.8, 38.8, 76.9, 38.5, 76.9);
  pc.Z();
  return pc;
}

class ShapeDiamond extends BaseShape {
  constructor(box) { super(DIAMOND_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    let height = this.Box.Height;
    const tl = this.Box.TopLeft.copy();
    tl.x += width / 4.;
    tl.y += height / 4.;
    width /= 2.;
    height /= 2.;
    return newBox(tl, width, height);
  }
  perimeter() { return diamondPath(this.Box).Path; }
  getSVGPathData() { return [diamondPath(this.Box).pathData()]; }
  getPathCommands() { return [diamondPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const totalWidth = 2 * (width + paddingX);
    const totalHeight = 2 * (height + paddingY);
    return [Math.ceil(totalWidth), Math.ceil(totalHeight)];
  }
  getDefaultPadding() { return [defaultPadding / 4, defaultPadding / 2]; }
}
export const newDiamond = (box) => new ShapeDiamond(box);

// ---- oval ----

export const OVAL_AR_LIMIT = 3.;

class ShapeOval extends BaseShape {
  constructor(box) { super(OVAL_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    let height = this.Box.Height;
    const insideTL = this.getInsidePlacement(width, height, 0, 0);
    const tl = this.Box.TopLeft.copy();
    width -= 2 * (insideTL.x - tl.x);
    height -= 2 * (insideTL.y - tl.y);
    return newBox(insideTL, width, height);
  }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const theta = float32(Math.atan2(height, width));
    // add padding in direction of diagonal so there is padding distance between top left and border
    const paddedWidth = width + paddingX * Math.cos(theta);
    const paddedHeight = height + paddingY * Math.sin(theta);
    // see https://stackoverflow.com/questions/433371/ellipse-bounding-a-rectangle
    let totalWidth = Math.ceil(Math.SQRT2 * paddedWidth), totalHeight = Math.ceil(Math.SQRT2 * paddedHeight);

    // prevent oval from becoming too flat
    [totalWidth, totalHeight] = limitAR(totalWidth, totalHeight, OVAL_AR_LIMIT);
    return [totalWidth, totalHeight];
  }
  getInsidePlacement(_width, _height, paddingX, paddingY) {
    // showing the top left arc of the ellipse: rx and ry are the radii, r the radius on the TopLeft-center line
    const rx = this.Box.Width / 2;
    const ry = this.Box.Height / 2;
    const theta = float32(Math.atan2(ry, rx));
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    // r is the ellipse radius on the line between node.TopLeft and the ellipse center
    const r = rx * ry / Math.sqrt(goPow(rx * sin, 2) + goPow(ry * cos, 2));
    // we want to offset r-padding/2 away from the center
    return newPoint(this.Box.TopLeft.x + Math.ceil(rx - cos * (r - paddingX / 2)), this.Box.TopLeft.y + Math.ceil(ry - sin * (r - paddingY / 2)));
  }
  perimeter() { return [newEllipse(this.Box.center(), this.Box.Width / 2, this.Box.Height / 2)]; }
}
export const newOval = (box) => new ShapeOval(box);

// ---- hexagon ----

function hexagonPath(box) {
  const halfYFactor = HEX_HALF_Y;
  const pc = newSVGPathContext(box.TopLeft, box.Width, box.Height);
  pc.startAt(pc.absolute(0.25, 0));
  pc.L(false, 0, halfYFactor);
  pc.L(false, 0.25, 1);
  pc.L(false, 0.75, 1);
  pc.L(false, 1, halfYFactor);
  pc.L(false, 0.75, 0);
  pc.Z();
  return pc;
}

class ShapeHexagon extends BaseShape {
  constructor(box) { super(HEXAGON_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    let height = this.Box.Height;
    const tl = this.Box.TopLeft.copy();
    tl.x += width / 6.;
    width /= 1.5;
    tl.y += height / 6.;
    height /= 1.5;
    return newBox(tl, width, height);
  }
  perimeter() { return hexagonPath(this.Box).Path; }
  getSVGPathData() { return [hexagonPath(this.Box).pathData()]; }
  getPathCommands() { return [hexagonPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const totalWidth = 1.5 * (width + paddingX);
    const totalHeight = 1.5 * (height + paddingY);
    return [Math.ceil(totalWidth), Math.ceil(totalHeight)];
  }
  getDefaultPadding() { return [defaultPadding / 2, defaultPadding / 2]; }
}
export const newHexagon = (box) => new ShapeHexagon(box);

// ---- parallelogram ----

const parallelWedgeWidth = 26.;

function parallelogramPath(box) {
  let wedgeWidth = parallelWedgeWidth;
  // Note: box width should always be larger than parallelWedgeWidth
  // this just handles after collapsing into a line
  if (box.Width <= wedgeWidth) wedgeWidth = box.Width / 2.0;
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(wedgeWidth, 0));
  pc.L(false, box.Width, 0);
  pc.L(false, box.Width - wedgeWidth, box.Height);
  pc.L(false, 0, box.Height);
  pc.L(false, 0, box.Height);
  pc.Z();
  return pc;
}

class ShapeParallelogram extends BaseShape {
  constructor(box) { super(PARALLELOGRAM_TYPE, box); }
  getInnerBox() {
    const tl = this.Box.TopLeft.copy();
    const width = this.Box.Width - 2 * parallelWedgeWidth;
    tl.x += parallelWedgeWidth;
    return newBox(tl, width, this.Box.Height);
  }
  perimeter() { return parallelogramPath(this.Box).Path; }
  getSVGPathData() { return [parallelogramPath(this.Box).pathData()]; }
  getPathCommands() { return [parallelogramPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const totalWidth = width + paddingX + parallelWedgeWidth * 2;
    return [Math.ceil(totalWidth), Math.ceil(height + paddingY)];
  }
}
export const newParallelogram = (box) => new ShapeParallelogram(box);

// ---- step ----

export const STEP_WEDGE_WIDTH = 35.0;

function stepPath(box) {
  let wedgeWidth = STEP_WEDGE_WIDTH;
  if (box.Width <= wedgeWidth) wedgeWidth = box.Width / 2.0;
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(0, 0));
  pc.L(false, box.Width - wedgeWidth, 0);
  pc.L(false, box.Width, box.Height / 2);
  pc.L(false, box.Width - wedgeWidth, box.Height);
  pc.L(false, 0, box.Height);
  pc.L(false, wedgeWidth, box.Height / 2);
  pc.Z();
  return pc;
}

class ShapeStep extends BaseShape {
  constructor(box) { super(STEP_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    const tl = this.Box.TopLeft.copy();
    width -= 2 * STEP_WEDGE_WIDTH;
    tl.x += STEP_WEDGE_WIDTH;
    return newBox(tl, width, this.Box.Height);
  }
  perimeter() { return stepPath(this.Box).Path; }
  getSVGPathData() { return [stepPath(this.Box).pathData()]; }
  getPathCommands() { return [stepPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const totalWidth = width + paddingX + 2 * STEP_WEDGE_WIDTH;
    return [Math.ceil(totalWidth), Math.ceil(height + paddingY)];
  }
  getDefaultPadding() { return [defaultPadding / 4, defaultPadding + STEP_WEDGE_WIDTH]; }
}
export const newStep = (box) => new ShapeStep(box);

// ---- stored data ----

const storedDataWedgeWidth = 15.;

function storedDataPath(box) {
  let wedgeWidth = storedDataWedgeWidth;
  const multiplier = 0.27;
  if (box.Width < wedgeWidth * 2) wedgeWidth = box.Width / 2.0;
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(wedgeWidth, 0));
  pc.H(true, box.Width - wedgeWidth);
  pc.C(false, box.Width - wedgeWidth * multiplier, 0, box.Width - wedgeWidth, box.Height * multiplier, box.Width - wedgeWidth, box.Height / 2.0);
  pc.C(false, box.Width - wedgeWidth, box.Height - box.Height * multiplier, box.Width - wedgeWidth * multiplier, box.Height, box.Width, box.Height);
  pc.H(true, -(box.Width - wedgeWidth));
  pc.C(false, wedgeWidth - wedgeWidth * multiplier, box.Height, 0, box.Height - box.Height * multiplier, 0, box.Height / 2.0);
  pc.C(false, 0, box.Height * multiplier, wedgeWidth - wedgeWidth * multiplier, 0, wedgeWidth, 0);
  pc.Z();
  return pc;
}

class ShapeStoredData extends BaseShape {
  constructor(box) { super(STORED_DATA_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    const tl = this.Box.TopLeft.copy();
    width -= 2 * storedDataWedgeWidth;
    tl.x += storedDataWedgeWidth;
    return newBox(tl, width, this.Box.Height);
  }
  perimeter() { return storedDataPath(this.Box).Path; }
  getSVGPathData() { return [storedDataPath(this.Box).pathData()]; }
  getPathCommands() { return [storedDataPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const totalWidth = width + paddingX + 2 * storedDataWedgeWidth;
    return [Math.ceil(totalWidth), Math.ceil(height + paddingY)];
  }
  getDefaultPadding() { return [defaultPadding - 10, defaultPadding]; }
}
export const newStoredData = (box) => new ShapeStoredData(box);

// ---- document ----

// the shape is taller than where the bottom of the path ends
const docPathHeight = 18.925;
const docPathInnerBottom = 14;
const docPathBottom = 16.3;

function documentPath(box) {
  const pc = newSVGPathContext(box.TopLeft, box.Width, box.Height);
  pc.startAt(pc.absolute(0, DOC_BOTTOM));
  pc.L(false, 0, 0);
  pc.L(false, 1, 0);
  pc.L(false, 1, DOC_BOTTOM);
  pc.C(false, 5 / 6.0, DOC_12_8, 2 / 3.0, DOC_12_8, 1 / 2.0, DOC_BOTTOM);
  pc.C(false, 1 / 3.0, DOC_19_8, 1 / 6.0, DOC_19_8, 0, DOC_BOTTOM);
  pc.Z();
  return pc;
}

class ShapeDocument extends BaseShape {
  constructor(box) { super(DOCUMENT_TYPE, box); }
  getInnerBox() {
    const height = this.Box.Height * docPathInnerBottom / docPathHeight;
    return newBox(this.Box.TopLeft.copy(), this.Box.Width, height);
  }
  perimeter() { return documentPath(this.Box).Path; }
  getSVGPathData() { return [documentPath(this.Box).pathData()]; }
  getPathCommands() { return [documentPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const baseHeight = (height + paddingY) * docPathHeight / docPathInnerBottom;
    return [Math.ceil(width + paddingX), Math.ceil(baseHeight)];
  }
  getDefaultPadding() { return [defaultPadding, DOC_PADDING_Y]; }
}
export const newDocument = (box) => new ShapeDocument(box);

// ---- callout ----

const defaultTipWidth = 30.;
const defaultTipHeight = 45.;

function getTipWidth(box) {
  let tipWidth = defaultTipWidth;
  if (box.Width < tipWidth * 2) tipWidth = box.Width / 2.0;
  return tipWidth;
}

function getTipHeight(box) {
  let tipHeight = defaultTipHeight;
  if (box.Height < tipHeight * 2) tipHeight = box.Height / 2.0;
  return tipHeight;
}

function calloutPath(box) {
  const tipWidth = getTipWidth(box);
  const tipHeight = getTipHeight(box);
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(0, 0));
  pc.V(true, box.Height - tipHeight);
  pc.H(true, box.Width / 2.0);
  pc.V(true, tipHeight);
  pc.L(true, tipWidth, -tipHeight);
  pc.H(true, box.Width / 2.0 - tipWidth);
  pc.V(true, -(box.Height - tipHeight));
  pc.H(true, -box.Width);
  pc.Z();
  return pc;
}

class ShapeCallout extends BaseShape {
  constructor(box) { super(CALLOUT_TYPE, box); }
  getInnerBox() {
    const tipHeight = getTipHeight(this.Box);
    const height = this.Box.Height - tipHeight;
    return newBox(this.Box.TopLeft.copy(), this.Box.Width, height);
  }
  perimeter() { return calloutPath(this.Box).Path; }
  getSVGPathData() { return [calloutPath(this.Box).pathData()]; }
  getPathCommands() { return [calloutPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    // return the minimum shape dimensions needed to fit content (width x height) in the shape's innerBox with padding
    let baseHeight = height + paddingY;
    if (baseHeight < defaultTipHeight) baseHeight *= 2;
    else baseHeight += defaultTipHeight;
    return [Math.ceil(width + paddingX), Math.ceil(baseHeight)];
  }
  getDefaultPadding() { return [defaultPadding, defaultPadding / 2]; }
}
export const newCallout = (box) => new ShapeCallout(box);

// ---- cloud ----

/** The percentage values of the cloud's wide inner box */
export const CLOUD_WIDE_INNER_X = 0.085;
export const CLOUD_WIDE_INNER_Y = 0.409;
export const CLOUD_WIDE_INNER_WIDTH = 0.819;
export const CLOUD_WIDE_INNER_HEIGHT = 0.548;
export const CLOUD_WIDE_ASPECT_BOUNDARY = exactDiv('1.367', '1.096'); // (1 + 0.819/0.548) / 2

/** The percentage values of the cloud's tall inner box */
export const CLOUD_TALL_INNER_X = 0.228;
export const CLOUD_TALL_INNER_Y = 0.179;
export const CLOUD_TALL_INNER_WIDTH = 0.549;
export const CLOUD_TALL_INNER_HEIGHT = 0.820;
export const CLOUD_TALL_ASPECT_BOUNDARY = exactDiv('1.369', '1.64'); // (1 + 0.549/0.820) / 2

/** The percentage values of the cloud's square inner box */
export const CLOUD_SQUARE_INNER_X = 0.167;
export const CLOUD_SQUARE_INNER_Y = 0.335;
export const CLOUD_SQUARE_INNER_WIDTH = 0.663;
export const CLOUD_SQUARE_INNER_HEIGHT = 0.663;

function cloudPath(box) {
  const pc = newSVGPathContext(box.TopLeft, box.Width / 834, box.Height / 523);
  // Note: original path TopLeft=(83, 238), absolute values updated so top left is at 0,0
  pc.startAt(pc.absolute(137.833, 182.833));
  pc.C(true, 0, 5.556, -5.556, 11.111, -11.111, 11.111);
  pc.C(true, -70.833, 6.944, -126.389, 77.778, -126.389, 163.889);
  pc.C(true, 0, 91.667, 62.5, 165.278, 141.667, 165.278);
  pc.H(true, 537.5);
  pc.C(true, 84.723, 0, 154.167, -79.167, 154.167, -175);
  pc.C(true, 0, -91.667, -63.89, -168.056, -144.444, -173.611);
  pc.C(true, -5.556, 0, -11.111, -4.167, -12.5, -11.111);
  pc.C(true, -18.056, -93.055, -101.39, -162.5, -198.611, -162.5);
  pc.C(true, -63.889, 0, -120.834, 29.167, -156.944, 75);
  pc.C(true, -4.167, 5.556, -11.111, 6.945, -15.278, 5.556);
  pc.C(true, -13.889, -5.556, -29.166, -8.333, -45.833, -8.333);
  pc.C(false, 196.167, 71.722, 143.389, 120.333, 137.833, 182.833);
  pc.Z();
  return pc;
}

class ShapeCloud extends BaseShape {
  constructor(box) {
    super(CLOUD_TYPE, box);
    this.innerBoxAspectRatio = 0.;
  }
  getInnerBox() {
    if (this.innerBoxAspectRatio != null && this.innerBoxAspectRatio !== 0.) return this.getInnerBoxForContent(this.innerBoxAspectRatio, 1);
    return this.getInnerBoxForContent(this.Box.Width, this.Box.Height);
  }
  /** we need this since the content's aspect ratio determines which placement is used */
  getInnerBoxForContent(width, height) {
    const insideTL = this.getInsidePlacement(width, height, 0, 0);
    const aspectRatio = width / height;
    // aspect ratio and position are computed with given dimensions, but final box size is determined by shape size
    width = this.Box.Width; height = this.Box.Height;
    if (aspectRatio > CLOUD_WIDE_ASPECT_BOUNDARY) {
      width *= CLOUD_WIDE_INNER_WIDTH;
      height *= CLOUD_WIDE_INNER_HEIGHT;
    } else if (aspectRatio < CLOUD_TALL_ASPECT_BOUNDARY) {
      width *= CLOUD_TALL_INNER_WIDTH;
      height *= CLOUD_TALL_INNER_HEIGHT;
    } else {
      width *= CLOUD_SQUARE_INNER_WIDTH;
      height *= CLOUD_SQUARE_INNER_HEIGHT;
    }
    return newBox(insideTL, width, height);
  }
  setInnerBoxAspectRatio(aspectRatio) { this.innerBoxAspectRatio = aspectRatio; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    width += paddingX;
    height += paddingY;
    const aspectRatio = width / height;
    // use the inner box with the closest aspect ratio (wide, tall, or square box)
    if (aspectRatio > CLOUD_WIDE_ASPECT_BOUNDARY) return [Math.ceil(width / CLOUD_WIDE_INNER_WIDTH), Math.ceil(height / CLOUD_WIDE_INNER_HEIGHT)];
    else if (aspectRatio < CLOUD_TALL_ASPECT_BOUNDARY) return [Math.ceil(width / CLOUD_TALL_INNER_WIDTH), Math.ceil(height / CLOUD_TALL_INNER_HEIGHT)];
    return [Math.ceil(width / CLOUD_SQUARE_INNER_WIDTH), Math.ceil(height / CLOUD_SQUARE_INNER_HEIGHT)];
  }
  getInsidePlacement(width, height, paddingX, paddingY) {
    const r = this.Box;
    width += paddingX;
    height += paddingY;
    const aspectRatio = width / height;
    if (aspectRatio > CLOUD_WIDE_ASPECT_BOUNDARY) {
      return newPoint(r.TopLeft.x + Math.ceil(r.Width * CLOUD_WIDE_INNER_X + paddingX / 2), r.TopLeft.y + Math.ceil(r.Height * CLOUD_WIDE_INNER_Y + paddingY / 2));
    } else if (aspectRatio < CLOUD_TALL_ASPECT_BOUNDARY) {
      return newPoint(r.TopLeft.x + Math.ceil(r.Width * CLOUD_TALL_INNER_X + paddingX / 2), r.TopLeft.y + Math.ceil(r.Height * CLOUD_TALL_INNER_Y + paddingY / 2));
    }
    return newPoint(r.TopLeft.x + Math.ceil(r.Width * CLOUD_SQUARE_INNER_X + paddingX / 2), r.TopLeft.y + Math.ceil(r.Height * CLOUD_SQUARE_INNER_Y + paddingY / 2));
  }
  perimeter() { return cloudPath(this.Box).Path; }
  getSVGPathData() { return [cloudPath(this.Box).pathData()]; }
  getPathCommands() { return [cloudPath(this.Box).pathCommands()]; }
  getDefaultPadding() { return [defaultPadding, defaultPadding / 2]; }
}
export const newCloud = (box) => new ShapeCloud(box);

// ---- cylinder ----

const defaultArcDepth = 24.;

function getArcHeight(box) {
  let arcHeight = defaultArcDepth;
  // Note: box height should always be larger than 3*default
  // this just handles after collapsing into an oval
  if (box.Height < arcHeight * 2) arcHeight = box.Height / 2.0;
  return arcHeight;
}

function cylinderOuterPath(box) {
  const arcHeight = getArcHeight(box);
  const multiplier = 0.45;
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(0, arcHeight));
  pc.C(false, 0, 0, box.Width * multiplier, 0, box.Width / 2, 0);
  pc.C(false, box.Width - box.Width * multiplier, 0, box.Width, 0, box.Width, arcHeight);
  pc.V(true, box.Height - arcHeight * 2);
  pc.C(false, box.Width, box.Height, box.Width - box.Width * multiplier, box.Height, box.Width / 2, box.Height);
  pc.C(false, box.Width * multiplier, box.Height, 0, box.Height, 0, box.Height - arcHeight);
  pc.V(true, -(box.Height - arcHeight * 2));
  pc.Z();
  return pc;
}

function cylinderInnerPath(box) {
  const arcHeight = getArcHeight(box);
  const multiplier = 0.45;
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(0, arcHeight));
  pc.C(false, 0, arcHeight * 2, box.Width * multiplier, arcHeight * 2, box.Width / 2, arcHeight * 2);
  pc.C(false, box.Width - box.Width * multiplier, arcHeight * 2, box.Width, arcHeight * 2, box.Width, arcHeight);
  return pc;
}

class ShapeCylinder extends BaseShape {
  constructor(box) { super(CYLINDER_TYPE, box); }
  getInnerBox() {
    let height = this.Box.Height;
    const tl = this.Box.TopLeft.copy();
    const arc = getArcHeight(this.Box);
    height -= 3 * arc;
    tl.y += 2 * arc;
    return newBox(tl, this.Box.Width, height);
  }
  perimeter() { return cylinderOuterPath(this.Box).Path; }
  getSVGPathData() { return [cylinderOuterPath(this.Box).pathData(), cylinderInnerPath(this.Box).pathData()]; }
  getPathCommands() { return [cylinderOuterPath(this.Box).pathCommands(), cylinderInnerPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    // 2 arcs top, height + padding, 1 arc bottom
    const totalHeight = height + paddingY + 3 * defaultArcDepth;
    return [Math.ceil(width + paddingX), Math.ceil(totalHeight)];
  }
  getDefaultPadding() { return [defaultPadding, defaultPadding / 2]; }
}
export const newCylinder = (box) => new ShapeCylinder(box);

// ---- package ----

const packageTopMinHeight = 34.; // eslint-disable-line no-unused-vars
const packageTopMaxHeight = 55.;
const packageTopMinWidth = 50.;
const packageTopMaxWidth = 150.;
const packageHorizontalScalar = 0.5;
const packageVerticalScalar = 0.2;

/** [width, height] */
function getTopDimensions(box) {
  let width = box.Width * packageHorizontalScalar;
  if (box.Width >= 2 * packageTopMinWidth) width = Math.min(packageTopMaxWidth, Math.max(packageTopMinWidth, width));
  const height = Math.min(packageTopMaxHeight, box.Height * packageVerticalScalar);
  return [width, height];
}

function packagePath(box) {
  const [topWidth, topHeight] = getTopDimensions(box);
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(0, 0));
  pc.L(false, topWidth, 0);
  pc.L(false, topWidth, topHeight);
  pc.L(false, box.Width, topHeight);
  pc.L(false, box.Width, box.Height);
  pc.L(false, 0, box.Height);
  pc.Z();
  return pc;
}

class ShapePackage extends BaseShape {
  constructor(box) { super(PACKAGE_TYPE, box); }
  getInnerBox() {
    const tl = this.Box.TopLeft.copy();
    let height = this.Box.Height;
    const [, topHeight] = getTopDimensions(this.Box);
    tl.y += topHeight;
    height -= topHeight;
    return newBox(tl, this.Box.Width, height);
  }
  perimeter() { return packagePath(this.Box).Path; }
  getSVGPathData() { return [packagePath(this.Box).pathData()]; }
  getPathCommands() { return [packagePath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const innerHeight = height + paddingY;
    // topHeight=(verticalScalar * totalHeight) and totalHeight=(topHeight + innerHeight)
    // so solving for topHeight we get: topHeight=innerHeight * (verticalScalar/(1-verticalScalar))
    const topHeight = innerHeight * packageVerticalScalar / (1. - packageVerticalScalar);
    const totalHeight = innerHeight + Math.min(topHeight, packageTopMaxHeight);
    return [Math.ceil(width + paddingX), Math.ceil(totalHeight)];
  }
  getDefaultPadding() { return [defaultPadding, .8 * defaultPadding]; }
}
export const newPackage = (box) => new ShapePackage(box);

// ---- page ----

// TODO: cleanup
const pageCornerWidth = 20.8164;
const pageCornerHeight = 20.348;

function pageOuterPath(box) {
  const pc = newSVGPathContext(box.TopLeft, 1., 1.);
  pc.startAt(pc.absolute(0.5, 0));
  pc.H(false, box.Width - 20.8164);
  pc.C(false, box.Width - 19.6456, 0.0, box.Width - 18.521, 0.456297, box.Width - 17.6811, 1.27202);
  pc.L(false, box.Width - 1.3647, 17.12);
  pc.C(false, box.Width - 0.4923, 17.9674, box.Width, 19.1318, box.Width, 20.348);
  pc.V(false, box.Height - 0.5);
  pc.C(false, box.Width, box.Height - 0.2239, box.Width - 0.2239, box.Height, box.Width - 0.5, box.Height);

  pc.H(false, 0.499999);
  pc.C(false, 0.223857, box.Height, 0, box.Height - 0.2239, 0, box.Height - 0.5);
  pc.V(false, 0.499999);
  pc.C(false, 0, 0.223857, 0.223857, 0, 0.5, 0);
  pc.Z();
  return pc;
}

function pageInnerPath(box) {
  const pc = newSVGPathContext(box.TopLeft, 1., 1.);
  pc.startAt(pc.absolute(box.Width - 1.08197, box.Height));
  pc.H(false, 1.08196);
  pc.C(true, -0.64918, 0, -1.08196, -0.43287, -1.08196, -1.08219);
  pc.V(false, 1.08219);
  pc.C(true, 0, -0.64931, 0.43278, -1.08219, 1.08196, -1.08219);

  pc.H(true, box.Width - 22.72132);
  pc.C(true, 0.64918, 0, 1.08196, 0.43287, 1.08196, 1.08219);
  pc.V(true, 17.09863);
  pc.C(true, 0, 1.29863, 0.86557, 2.38082, 2.38032, 2.38082);
  pc.H(false, box.Width - 1.08197);
  pc.C(true, .64918, 0, 1.08196, 0.43287, 1.08196, 1.08196);
  pc.V(false, box.Height - 1.0822);
  pc.C(false, box.Width - 1.0, box.Height - 0.43288, box.Width - 0.43279, box.Height, box.Width - 1.08197, box.Height);
  pc.Z();
  return pc;
}

class ShapePage extends BaseShape {
  constructor(box) { super(PAGE_TYPE, box); }
  getInnerBox() {
    // Note: for simplicity this assumes shape padding is greater than pageCornerSize
    let width = this.Box.Width;
    // consider right hand side occupied by corner for short pages
    if (this.Box.Height < PAGE_3H) width -= pageCornerWidth;
    return newBox(this.Box.TopLeft.copy(), width, this.Box.Height);
  }
  perimeter() { return pageOuterPath(this.Box).Path; }
  getSVGPathData() { return [pageOuterPath(this.Box).pathData(), pageInnerPath(this.Box).pathData()]; }
  getPathCommands() { return [pageOuterPath(this.Box).pathCommands(), pageInnerPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    let totalWidth = width + paddingX;
    let totalHeight = height + paddingY;
    // add space for corner with short pages
    if (totalHeight < PAGE_3H) totalWidth += pageCornerWidth;
    totalWidth = Math.max(totalWidth, 2 * pageCornerWidth);
    totalHeight = Math.max(totalHeight, pageCornerHeight);
    return [Math.ceil(totalWidth), Math.ceil(totalHeight)];
  }
  getDefaultPadding() { return [defaultPadding, PAGE_PADDING_Y]; }
}
export const newPage = (box) => new ShapePage(box);

// ---- person ----

export const PERSON_AR_LIMIT = 1.5;
const personShoulderWidthFactor = PERSON_F;

function personPath(box) {
  const pc = newSVGPathContext(box.TopLeft, box.Width / 68.3, box.Height / 77.4);

  // Bottom side
  pc.startAt(pc.absolute(68.3, 77.4));
  pc.H(false, 0);
  pc.V(true, -1.1);
  pc.C(true, 0, -13.2, 7.5, -25.1, 19.3, -30.8);
  pc.C(false, 12.8, 40.9, 8.9, 33.4, 8.9, 25.2);
  pc.C(false, 8.9, 11.3, 20.2, 0, 34.1, 0);

  // TODO: implement s command with mirroring last control point
  // s 			25.2,11.3, 	25.2,25.2
  // mirroring last control point (20.2,0) -> (34.1,0) = relative(13.9,0)
  pc.C(true, 13.9, 0, 25.2, 11.3, 25.2, 25.2);

  pc.C(true, 0, 8.2, -3.8, 15.6, -10.4, 20.4);
  pc.C(true, 11.8, 5.7, 19.3, 17.6, 19.3, 30.8);
  pc.V(true, 1);
  pc.H(false, 68.3);
  pc.Z();
  return pc;
}

class ShapePerson extends BaseShape {
  constructor(box) { super(PERSON_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    const tl = this.Box.TopLeft.copy();
    const shoulderWidth = personShoulderWidthFactor * width;
    tl.x += shoulderWidth;
    width -= shoulderWidth * 2;
    return newBox(tl, width, this.Box.Height);
  }
  perimeter() { return personPath(this.Box).Path; }
  getSVGPathData() { return [personPath(this.Box).pathData()]; }
  getPathCommands() { return [personPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    let totalWidth = width + paddingX;
    // see shapePackage
    const shoulderWidth = totalWidth * personShoulderWidthFactor / PERSON_G;
    totalWidth += 2 * shoulderWidth;
    let totalHeight = height + paddingY;

    // prevent the shape's aspect ratio from becoming too extreme
    [totalWidth, totalHeight] = limitAR(totalWidth, totalHeight, PERSON_AR_LIMIT);
    return [Math.ceil(totalWidth), Math.ceil(totalHeight)];
  }
  getDefaultPadding() { return [10, defaultPadding]; }
}
export const newPerson = (box) => new ShapePerson(box);

// ---- c4 person ----

// Constants to match frontend implementation
export const C4_PERSON_AR_LIMIT = 1.5;
export const HEAD_RADIUS_FACTOR = 0.22;
export const BODY_TOP_FACTOR = 0.8;
export const CORNER_RADIUS_FACTOR = 0.175;

// 4*(math.Sqrt(2)-1)/3 is evaluated left to right in Go as well: ((4*(sqrt2-1))/3)*x
const K = (x) => 4 * (Math.SQRT2 - 1) / 3 * x;

function bodyPath(box) {
  const width = box.Width;
  const height = box.Height;

  const pc = newSVGPathContext(box.TopLeft, 1, 1);

  const headRadius = width * HEAD_RADIUS_FACTOR;
  const headCenterY = headRadius;
  const bodyTop = headCenterY + headRadius * BODY_TOP_FACTOR;
  const bodyWidth = width;
  const bodyHeight = height - bodyTop;
  const bodyLeft = 0;

  // Use the same corner radius calculation as frontend
  const cornerRadius = Math.min(width * CORNER_RADIUS_FACTOR, bodyHeight * 0.25);

  pc.startAt(pc.absolute(bodyLeft, bodyTop + cornerRadius));

  pc.C(true, 0, -K(cornerRadius), K(cornerRadius), -cornerRadius, cornerRadius, -cornerRadius);
  pc.H(true, bodyWidth - 2 * cornerRadius);
  pc.C(true, K(cornerRadius), 0, cornerRadius, K(cornerRadius), cornerRadius, cornerRadius);
  pc.V(true, bodyHeight - 2 * cornerRadius);
  pc.C(true, 0, K(cornerRadius), -K(cornerRadius), cornerRadius, -cornerRadius, cornerRadius);
  pc.H(true, -(bodyWidth - 2 * cornerRadius));
  pc.C(true, -K(cornerRadius), 0, -cornerRadius, -K(cornerRadius), -cornerRadius, -cornerRadius);
  pc.Z();

  return pc;
}

function headPath(box) {
  const width = box.Width;

  const pc = newSVGPathContext(box.TopLeft, 1, 1);

  const headRadius = width * HEAD_RADIUS_FACTOR;
  const headCenterX = width / 2;
  const headCenterY = headRadius;

  pc.startAt(pc.absolute(headCenterX, headCenterY - headRadius));

  pc.C(false,
    headCenterX + K(headRadius), headCenterY - headRadius,
    headCenterX + headRadius, headCenterY - K(headRadius),
    headCenterX + headRadius, headCenterY);

  pc.C(false,
    headCenterX + headRadius, headCenterY + K(headRadius),
    headCenterX + K(headRadius), headCenterY + headRadius,
    headCenterX, headCenterY + headRadius);

  pc.C(false,
    headCenterX - K(headRadius), headCenterY + headRadius,
    headCenterX - headRadius, headCenterY + K(headRadius),
    headCenterX - headRadius, headCenterY);

  pc.C(false,
    headCenterX - headRadius, headCenterY - K(headRadius),
    headCenterX - K(headRadius), headCenterY - headRadius,
    headCenterX, headCenterY - headRadius);

  return pc;
}

class ShapeC4Person extends BaseShape {
  constructor(box) { super(C4_PERSON_TYPE, box); }
  getInnerBox() {
    const width = this.Box.Width;
    const height = this.Box.Height;

    const headRadius = width * HEAD_RADIUS_FACTOR;
    const headCenterY = headRadius;
    const bodyTop = headCenterY + headRadius * BODY_TOP_FACTOR;

    // Horizontal padding = 5% of width
    const horizontalPadding = width * 0.05;
    // Vertical padding = 3% of height
    const verticalPadding = height * 0.03;

    const tl = this.Box.TopLeft.copy();
    tl.x += horizontalPadding;
    tl.y += bodyTop + verticalPadding;

    const innerWidth = width - (horizontalPadding * 2);
    const innerHeight = height - bodyTop - (verticalPadding * 2);

    return newBox(tl, innerWidth, innerHeight);
  }
  perimeter() {
    const width = this.Box.Width;

    const bodyPerimeter = bodyPath(this.Box).Path;

    const headRadius = width * HEAD_RADIUS_FACTOR;
    const headCenterX = this.Box.TopLeft.x + width / 2;
    const headCenterY = this.Box.TopLeft.y + headRadius;
    const headCenter = newPoint(headCenterX, headCenterY);

    const headEllipse = newEllipse(headCenter, headRadius, headRadius);

    return [...bodyPerimeter, headEllipse];
  }
  getSVGPathData() { return [bodyPath(this.Box).pathData(), headPath(this.Box).pathData()]; }
  getPathCommands() { return [bodyPath(this.Box).pathCommands(), headPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    const contentWidth = width + paddingX;
    const contentHeight = height + paddingY;

    // Account for 10% total horizontal padding (5% on each side)
    let totalWidth = contentWidth / 0.9;
    const headRadius = totalWidth * HEAD_RADIUS_FACTOR;

    // Use positioning matching frontend
    const headCenterY = headRadius;
    const bodyTop = headCenterY + headRadius * BODY_TOP_FACTOR;

    // Include vertical padding
    const verticalPadding = totalWidth * 0.06; // 3% top + 3% bottom
    let totalHeight = contentHeight + bodyTop + verticalPadding;

    // Calculate minimum height
    const minHeight = totalWidth * 0.95;
    if (totalHeight < minHeight) totalHeight = minHeight;

    [totalWidth, totalHeight] = limitAR(totalWidth, totalHeight, C4_PERSON_AR_LIMIT);
    return [Math.ceil(totalWidth), Math.ceil(totalHeight)];
  }
  getDefaultPadding() { return [10, defaultPadding]; }
}
export const newC4Person = (box) => new ShapeC4Person(box);

// ---- queue ----

function getArcWidth(box) {
  let arcWidth = defaultArcDepth;
  // Note: box width should always be larger than 3*default
  // this just handles after collaping into an oval
  if (box.Width < arcWidth * 2) arcWidth = box.Width / 2.0;
  return arcWidth;
}

function queueOuterPath(box) {
  const arcWidth = getArcWidth(box);
  const multiplier = 0.45;
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(arcWidth, 0));
  pc.H(true, box.Width - 2 * arcWidth);
  pc.C(false, box.Width, 0, box.Width, box.Height * multiplier, box.Width, box.Height / 2.0);
  pc.C(false, box.Width, box.Height - box.Height * multiplier, box.Width, box.Height, box.Width - arcWidth, box.Height);
  pc.H(true, -1 * (box.Width - 2 * arcWidth));
  pc.C(false, 0, box.Height, 0, box.Height - box.Height * multiplier, 0, box.Height / 2.0);
  pc.C(false, 0, box.Height * multiplier, 0, 0, arcWidth, 0);
  pc.Z();
  return pc;
}

function queueInnerPath(box) {
  const arcWidth = getArcWidth(box);
  const multiplier = 0.45;
  const pc = newSVGPathContext(box.TopLeft, 1, 1);
  pc.startAt(pc.absolute(box.Width - arcWidth, 0));
  pc.C(false, box.Width - 2 * arcWidth, 0, box.Width - 2 * arcWidth, box.Height * multiplier, box.Width - 2 * arcWidth, box.Height / 2.0);
  pc.C(false, box.Width - 2 * arcWidth, box.Height - box.Height * multiplier, box.Width - 2 * arcWidth, box.Height, box.Width - arcWidth, box.Height);
  return pc;
}

class ShapeQueue extends BaseShape {
  constructor(box) { super(QUEUE_TYPE, box); }
  getInnerBox() {
    let width = this.Box.Width;
    const tl = this.Box.TopLeft.copy();
    const arcWidth = getArcWidth(this.Box);
    width -= 3 * arcWidth;
    tl.x += arcWidth;
    return newBox(tl, width, this.Box.Height);
  }
  perimeter() { return queueOuterPath(this.Box).Path; }
  getSVGPathData() { return [queueOuterPath(this.Box).pathData(), queueInnerPath(this.Box).pathData()]; }
  getPathCommands() { return [queueOuterPath(this.Box).pathCommands(), queueInnerPath(this.Box).pathCommands()]; }
  getDimensionsToFit(width, height, paddingX, paddingY) {
    // 1 arc left, width+ padding, 2 arcs right
    const totalWidth = 3 * defaultArcDepth + width + paddingX;
    return [Math.ceil(totalWidth), Math.ceil(height + paddingY)];
  }
  getDefaultPadding() { return [defaultPadding / 2, defaultPadding]; }
}
export const newQueue = (box) => new ShapeQueue(box);

// ---- shape.go ----

/**
 * GetPathCommands returns a shape's absolute custom path commands, or null when the shape is represented by another primitive
 * such as a rectangle or oval.
 */
export function getPathCommands(s) {
  return typeof s.getPathCommands === 'function' ? s.getPathCommands() : null;
}

export function newShape(shapeType, box) {
  switch (shapeType) {
    case CALLOUT_TYPE: return newCallout(box);
    case CIRCLE_TYPE: return newCircle(box);
    case CLASS_TYPE: return newClass(box);
    case CLOUD_TYPE: return newCloud(box);
    case CODE_TYPE: return newCode(box);
    case CYLINDER_TYPE: return newCylinder(box);
    case DIAMOND_TYPE: return newDiamond(box);
    case DOCUMENT_TYPE: return newDocument(box);
    case HEXAGON_TYPE: return newHexagon(box);
    case IMAGE_TYPE: return newImage(box);
    case OVAL_TYPE: return newOval(box);
    case PACKAGE_TYPE: return newPackage(box);
    case PAGE_TYPE: return newPage(box);
    case PARALLELOGRAM_TYPE: return newParallelogram(box);
    case PERSON_TYPE: return newPerson(box);
    case C4_PERSON_TYPE: return newC4Person(box);
    case QUEUE_TYPE: return newQueue(box);
    case REAL_SQUARE_TYPE: return newRealSquare(box);
    case STEP_TYPE: return newStep(box);
    case STORED_DATA_TYPE: return newStoredData(box);
    case SQUARE_TYPE: return newSquare(box);
    case TABLE_TYPE: return newTable(box);
    case TEXT_TYPE: return newText(box);
    default:
      return new ShapeSquare(box, shapeType);
  }
}

/**
 * TraceToShapeBorder takes the point on the rectangular border
 * r here is the point on rectangular border
 * p is the prev point (used to calculate slope)
 * s is the point on the actual shape border that'll be returned
 */
export function traceToShapeBorder(shape, rectBorderPoint, prevPoint) {
  if (shape.is('') || shape.isRectangular()) return rectBorderPoint;

  // We want to extend the line all the way through to the other end of the shape to get the intersections
  let scaleSize = shape.getBox().Width;
  if (prevPoint.x === rectBorderPoint.x) scaleSize = shape.getBox().Height;
  let vector = prevPoint.vectorTo(rectBorderPoint);
  vector = vector.addLength(scaleSize);
  const extendedSegment = new Segment(prevPoint, prevPoint.addVector(vector));

  let closestD = Infinity;
  let closestPoint = rectBorderPoint;

  for (const perimeterSegment of shape.perimeter() ?? []) {
    for (const intersectingPoint of perimeterSegment.intersections(extendedSegment) ?? []) {
      const d = euclideanDistance(rectBorderPoint.x, rectBorderPoint.y, intersectingPoint.x, intersectingPoint.y);
      if (d < closestD) {
        closestD = d;
        closestPoint = intersectingPoint;
      }
    }
  }

  closestPoint.truncateFloat32();
  return newPoint(goRound(closestPoint.x), goRound(closestPoint.y));
}


/** [width, height] */
export function limitAR(width, height, aspectRatio) {
  if (width > aspectRatio * height) height = goRound(width / aspectRatio);
  else if (height > aspectRatio * width) width = goRound(height / aspectRatio);
  return [width, height];
}

export { Box, Ellipse };
