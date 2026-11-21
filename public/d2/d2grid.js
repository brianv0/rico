// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2layouts/d2grid package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.):
// constants.go, grid_diagram.go and layout.go. Conventions as in d2graph.js.

import * as d2target from './target.js';
import * as geo from './geo.js';
import * as label from './label.js';
import { posBefore } from './ast.js';
import { atoi as strconvAtoi } from './strconv.js';
import { goInt } from './gomath.js';

// don't consider layouts with rows longer than targetSize*1.2 or shorter than targetSize/1.2
export const STARTING_THRESHOLD = 1.2;
// next try layouts with a 25% larger threshold
export const THRESHOLD_STEP_SIZE = 0.25;
export const MIN_THRESHOLD_ATTEMPTS = 1;
export const MAX_THRESHOLD_ATTEMPTS = 3;

export const ATTEMPT_LIMIT = 100_000;
export const SKIP_LIMIT = 10_000_000;

export const CONTAINER_PADDING = 60;
export const DEFAULT_GAP = 40;

const MAX_FLOAT64 = Number.MAX_VALUE;
const pos = (s) => label.positionString(s);
const atoi = (s) => strconvAtoi(s)[0];

class GridDiagram {
  constructor(root) {
    this.root = root;
    this.objects = root.childrenArray;
    this.edges = null;
    this.rows = 0;
    this.columns = 0;

    // if true, place objects left to right along rows
    // if false, place objects top to bottom along columns
    this.rowDirected = false;

    this.width = 0;
    this.height = 0;

    this.verticalGap = DEFAULT_GAP;
    this.horizontalGap = DEFAULT_GAP;
  }

  shift(dx, dy) {
    for (const obj of this.objects || []) obj.moveWithDescendants(dx, dy);
    for (const e of this.edges || []) e.move(dx, dy);
  }
}

function newGridDiagram(root) {
  const gd = new GridDiagram(root);
  const nobjects = (gd.objects || []).length;

  if (root.attributes.gridRows !== null) gd.rows = atoi(root.attributes.gridRows.value);
  if (root.attributes.gridColumns !== null) gd.columns = atoi(root.attributes.gridColumns.value);

  if (gd.rows !== 0 && gd.columns !== 0) {
    // . row-directed  column-directed
    // .  ┌───────┐    ┌───────┐
    // .  │ a b c │    │ a d g │
    // .  │ d e f │    │ b e h │
    // .  │ g h i │    │ c f i │
    // .  └───────┘    └───────┘
    // if keyword rows is first, make it row-directed, if columns is first it is column-directed
    if (posBefore(root.attributes.gridRows.mapKey.range.start, root.attributes.gridColumns.mapKey.range.start)) gd.rowDirected = true;

    // rows and columns specified, but we want to continue naturally if user enters more objects
    let capacity = gd.rows * gd.columns;
    while (capacity < nobjects) {
      if (gd.rowDirected) {
        gd.rows++;
        capacity += gd.columns;
      } else {
        gd.columns++;
        capacity += gd.rows;
      }
    }
  } else if (gd.columns === 0) {
    gd.rowDirected = true;
    // we can only make N rows with N objects
    if (nobjects < gd.rows) gd.rows = nobjects;
  } else if (nobjects < gd.columns) gd.columns = nobjects;

  // grid gap sets both, but can be overridden
  if (root.attributes.gridGap !== null) {
    gd.verticalGap = atoi(root.attributes.gridGap.value);
    gd.horizontalGap = gd.verticalGap;
  }
  if (root.attributes.verticalGap !== null) gd.verticalGap = atoi(root.attributes.verticalGap.value);
  if (root.attributes.horizontalGap !== null) gd.horizontalGap = atoi(root.attributes.horizontalGap.value);

  for (const o of gd.objects || []) o.box.TopLeft = geo.newPoint(0, 0);

  return gd;
}

/**
 * Layout runs the grid layout on containers with rows/columns
 * Note: children are not allowed edges or descendants
 * 1. Run grid layout on the graph root
 * 2. Set the resulting dimensions to the graph root
 */
export function layout(g) {
  const obj = g.root;

  const gd = layoutGrid(g, obj);

  if (obj.hasLabel() && obj.labelPosition === null) obj.labelPosition = pos(label.InsideTopCenter);
  if (obj.attributes.icon !== null && obj.iconPosition === null) obj.iconPosition = pos(label.InsideTopLeft);

  if (obj.box !== null) {
    // CONTAINER_PADDING is default, but use gap value if set
    let horizontalPadding = CONTAINER_PADDING, verticalPadding = CONTAINER_PADDING;
    if (obj.attributes.gridGap !== null || obj.attributes.horizontalGap !== null) horizontalPadding = gd.horizontalGap;
    if (obj.attributes.gridGap !== null || obj.attributes.verticalGap !== null) verticalPadding = gd.verticalGap;

    const contentWidth = gd.width, contentHeight = gd.height;

    let labelPosition = label.Unset, iconPosition = label.Unset;
    if (obj.labelPosition !== null) labelPosition = label.fromString(obj.labelPosition);
    if (obj.iconPosition !== null) iconPosition = label.fromString(obj.iconPosition);

    // compute how much space the label and icon occupy
    const [, padding] = obj.spacing();

    let labelWidth = 0, labelHeight = 0;
    if (obj.attributes.labelDimensions.width > 0) labelWidth = obj.attributes.labelDimensions.width + 2 * label.PADDING;
    if (obj.attributes.labelDimensions.height > 0) labelHeight = obj.attributes.labelDimensions.height + 2 * label.PADDING;

    if (labelWidth > 0) {
      switch (labelPosition) {
        case label.OutsideTopLeft: case label.OutsideTopCenter: case label.OutsideTopRight:
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
        case label.OutsideBottomLeft: case label.OutsideBottomCenter: case label.OutsideBottomRight: {
          const overflow = labelWidth - contentWidth;
          if (overflow > 0) {
            padding.Left += overflow / 2;
            padding.Right += overflow / 2;
          }
        }
      }
    }
    if (labelHeight > 0) {
      switch (labelPosition) {
        case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
        case label.InsideMiddleLeft: case label.InsideMiddleCenter: case label.InsideMiddleRight:
        case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom: {
          const overflow = labelHeight - contentHeight;
          if (overflow > 0) {
            padding.Top += overflow / 2;
            padding.Bottom += overflow / 2;
          }
        }
      }
    }

    // configure spacing for default label+icon
    if (iconPosition === label.InsideTopLeft && labelPosition === label.InsideTopCenter) {
      // . ├────┤───────├────┤
      // .  icon  label  icon
      // with an icon in top left we need 2x the space to fit the label in the center
      const iconSize = d2target.MAX_ICON_SIZE + 2 * label.PADDING;
      padding.Left = Math.max(padding.Left, iconSize);
      padding.Right = Math.max(padding.Right, iconSize);
      const minWidth = 2 * iconSize + obj.attributes.labelDimensions.width + 2 * label.PADDING;
      const overflow = minWidth - contentWidth;
      if (overflow > 0) {
        padding.Left = Math.max(padding.Left, overflow / 2);
        padding.Right = Math.max(padding.Right, overflow / 2);
      }
    }

    padding.Top = Math.max(padding.Top, verticalPadding);
    padding.Bottom = Math.max(padding.Bottom, verticalPadding);
    padding.Left = Math.max(padding.Left, horizontalPadding);
    padding.Right = Math.max(padding.Right, horizontalPadding);

    const totalWidth = padding.Left + contentWidth + padding.Right;
    const totalHeight = padding.Top + contentHeight + padding.Bottom;
    obj.sizeToContent(totalWidth, totalHeight, 0, 0);

    // compute where the grid should be placed inside shape
    const s = obj.toShape();
    const innerTL = s.getInsidePlacement(totalWidth, totalHeight, 0, 0);
    // depending on the shape innerBox may be larger than totalWidth, totalHeight
    // if this is the case, we want to center the cells within the larger innerBox
    const innerBox = s.getInnerBox();
    let resizeDx = 0, resizeDy = 0;
    if (innerBox.Width > totalWidth) resizeDx = (innerBox.Width - totalWidth) / 2;
    if (innerBox.Height > totalHeight) resizeDy = (innerBox.Height - totalHeight) / 2;

    // move from horizontalPadding,verticalPadding to innerTL.X+padding.Left, innerTL.Y+padding.Top
    // and if innerBox is larger than content dimensions, adjust to center within innerBox
    const dx = -horizontalPadding + innerTL.x + padding.Left + resizeDx;
    const dy = -verticalPadding + innerTL.y + padding.Top + resizeDy;
    if (dx !== 0 || dy !== 0) gd.shift(dx, dy);
  }

  // simple straight line edge routing between grid objects
  for (const e of g.edges || []) {
    if (!e.src.parent.isDescendantOf(obj) && !e.dst.parent.isDescendantOf(obj)) continue;
    // if edge is within grid, remove it from outer layout
    (gd.edges ||= []).push(e);

    if (e.src.parent !== obj || e.dst.parent !== obj) continue;
    // if edge is grid child, use simple routing
    e.route = [e.src.box.center(), e.dst.box.center()];
    e.traceToShape(e.route, 0, 1);
    if (e.attributes.label.value !== '') e.labelPosition = pos(label.InsideMiddleCenter);
  }

  if (g.root.isGridDiagram() && (g.root.childrenArray || []).length !== 0) g.root.box.TopLeft = geo.newPoint(0, 0);

  if (g.rootLevel > 0) {
    let horizontalPadding = CONTAINER_PADDING, verticalPadding = CONTAINER_PADDING;
    if (obj.attributes.gridGap !== null || obj.attributes.horizontalGap !== null) horizontalPadding = gd.horizontalGap;
    if (obj.attributes.gridGap !== null || obj.attributes.verticalGap !== null) verticalPadding = gd.verticalGap;

    // shift the grid from (0, 0)
    gd.shift(obj.box.TopLeft.x + horizontalPadding, obj.box.TopLeft.y + verticalPadding);
  }
}

function layoutGrid(g, obj) {
  const gd = newGridDiagram(obj);

  // position labels and icons
  for (const o of gd.objects || []) {
    let positionedLabel = false;
    if (o.attributes.icon !== null && o.iconPosition === null) {
      if ((o.childrenArray || []).length > 0) {
        o.iconPosition = pos(label.OutsideTopLeft);
        // don't overwrite position if nested graph layout positioned label/icon
        if (o.labelPosition === null) {
          o.labelPosition = pos(label.OutsideTopRight);
          positionedLabel = true;
        }
      } else o.iconPosition = pos(label.InsideMiddleCenter);
    }
    if (!positionedLabel && o.hasLabel() && o.labelPosition === null) {
      if ((o.childrenArray || []).length > 0) o.labelPosition = pos(label.OutsideTopCenter);
      else if (o.hasOutsideBottomLabel()) o.labelPosition = pos(label.OutsideBottomCenter);
      else if (o.attributes.icon !== null) o.labelPosition = pos(label.InsideTopCenter);
      else o.labelPosition = pos(label.InsideMiddleCenter);
    }
  }

  // to handle objects with outside labels, we adjust their dimensions before layout and
  // after layout, we remove the label adjustment and reposition TopLeft if needed
  const revertAdjustments = gd.sizeForOutsideLabels();

  if (gd.rows !== 0 && gd.columns !== 0) gd.layoutEvenly(g, obj);
  else gd.layoutDynamic(g, obj);

  revertAdjustments();

  return gd;
}

GridDiagram.prototype.layoutEvenly = function layoutEvenly() {
  const gd = this;
  // layout objects in a grid with these 2 properties:
  // all objects in the same row should have the same height
  // all objects in the same column should have the same width

  const getObject = (rowIndex, columnIndex) => {
    let index;
    if (gd.rowDirected) index = rowIndex * gd.columns + columnIndex;
    else index = columnIndex * gd.rows + rowIndex;
    if (index < (gd.objects || []).length) return gd.objects[index];
    return null;
  };

  const rowHeights = [];
  const colWidths = [];
  for (let i = 0; i < gd.rows; i++) {
    let rowHeight = 0.;
    for (let j = 0; j < gd.columns; j++) {
      const o = getObject(i, j);
      if (o === null) break;
      rowHeight = Math.max(rowHeight, o.box.Height);
    }
    rowHeights.push(rowHeight);
  }
  for (let j = 0; j < gd.columns; j++) {
    let columnWidth = 0.;
    for (let i = 0; i < gd.rows; i++) {
      const o = getObject(i, j);
      if (o === null) break;
      columnWidth = Math.max(columnWidth, o.box.Width);
    }
    colWidths.push(columnWidth);
  }

  const horizontalGap = gd.horizontalGap;
  const verticalGap = gd.verticalGap;

  const cursor = geo.newPoint(0, 0);
  if (gd.rowDirected) {
    for (let i = 0; i < gd.rows; i++) {
      for (let j = 0; j < gd.columns; j++) {
        const o = getObject(i, j);
        if (o === null) break;
        o.box.Width = colWidths[j];
        o.box.Height = rowHeights[i];
        o.moveWithDescendantsTo(cursor.x, cursor.y);
        cursor.x += o.box.Width + horizontalGap;
      }
      cursor.x = 0;
      cursor.y += rowHeights[i] + verticalGap;
    }
  } else {
    for (let j = 0; j < gd.columns; j++) {
      for (let i = 0; i < gd.rows; i++) {
        const o = getObject(i, j);
        if (o === null) break;
        o.box.Width = colWidths[j];
        o.box.Height = rowHeights[i];
        o.moveWithDescendantsTo(cursor.x, cursor.y);
        cursor.y += o.box.Height + verticalGap;
      }
      cursor.x += colWidths[j] + horizontalGap;
      cursor.y = 0;
    }
  }

  let totalWidth = 0, totalHeight = 0;
  for (const w of colWidths) totalWidth += w + horizontalGap;
  for (const h of rowHeights) totalHeight += h + verticalGap;
  totalWidth -= horizontalGap;
  totalHeight -= verticalGap;
  gd.width = totalWidth;
  gd.height = totalHeight;
};

GridDiagram.prototype.layoutDynamic = function layoutDynamic() {
  const gd = this;
  // assume we have the following objects to layout:
  // . ┌A──────────────┐  ┌B──┐  ┌C─────────┐  ┌D────────┐  ┌E────────────────┐
  // . └───────────────┘  │   │  │          │  │         │  │                 │
  // .                    │   │  └──────────┘  │         │  │                 │
  // .                    │   │                │         │  └─────────────────┘
  // .                    └───┘                │         │
  // .                                         └─────────┘
  // Note: if the grid is row dominant, all objects should be the same height (same width if column dominant)

  const objects = gd.objects || [];
  const horizontalGap = gd.horizontalGap;
  const verticalGap = gd.verticalGap;

  // we want to split up the total width across the N rows or columns as evenly as possible
  let totalWidth = 0, totalHeight = 0;
  for (const o of objects) {
    totalWidth += o.box.Width;
    totalHeight += o.box.Height;
  }
  totalWidth += horizontalGap * (objects.length - gd.rows);
  totalHeight += verticalGap * (objects.length - gd.columns);

  let layout;
  if (gd.rowDirected) {
    const targetWidth = totalWidth / gd.rows;
    layout = gd.getBestLayout(targetWidth, false);
  } else {
    const targetHeight = totalHeight / gd.columns;
    layout = gd.getBestLayout(targetHeight, true);
  }
  layout = layout || [];

  const cursor = geo.newPoint(0, 0);
  let maxY = 0, maxX = 0;
  if (gd.rowDirected) {
    // measure row widths
    const rowWidths = [];
    for (const row of layout) {
      let x = 0.;
      for (const o of row) x += o.box.Width + horizontalGap;
      const rowWidth = x - horizontalGap;
      rowWidths.push(rowWidth);
      maxX = Math.max(maxX, rowWidth);
    }

    // TODO if object is a nested grid, consider growing descendants according to the inner grid layout

    // then expand thinnest objects to make each row the same width
    for (let i = 0; i < layout.length; i++) {
      const row = layout[i];
      const rowWidth = rowWidths[i];
      if (rowWidth === maxX) continue;
      const delta = maxX - rowWidth;
      let widest = 0;
      for (const o of row) widest = Math.max(widest, o.box.Width);
      const diffs = new Array(row.length).fill(0);
      let totalDiff = 0.;
      for (let k = 0; k < row.length; k++) {
        diffs[k] = widest - row[k].box.Width;
        totalDiff += diffs[k];
      }
      if (totalDiff > 0) {
        // expand smaller nodes up to the size of the larger ones with delta
        // percentage diff
        for (let k = 0; k < diffs.length; k++) diffs[k] /= totalDiff;
        const growth = Math.min(delta, totalDiff);
        // expand smaller objects to fill remaining space
        for (let k = 0; k < row.length; k++) row[k].box.Width += diffs[k] * growth;
      }
      if (delta > totalDiff) {
        const growth = (delta - totalDiff) / row.length;
        for (const o of row) o.box.Width += growth;
      }
    }

    // if we have 2 rows, then each row's objects should have the same height
    for (const row of layout) {
      let rowHeight = 0.;
      for (const o of row) {
        o.moveWithDescendantsTo(cursor.x, cursor.y);
        cursor.x += o.box.Width + horizontalGap;
        rowHeight = Math.max(rowHeight, o.box.Height);
      }

      // set all objects in row to the same height
      for (const o of row) o.box.Height = rowHeight;

      // new row
      cursor.x = 0;
      cursor.y += rowHeight + verticalGap;
    }
    maxY = cursor.y - verticalGap;
  } else {
    // measure column heights
    const colHeights = [];
    for (const column of layout) {
      let y = 0.;
      for (const o of column) y += o.box.Height + verticalGap;
      const colHeight = y - verticalGap;
      colHeights.push(colHeight);
      maxY = Math.max(maxY, colHeight);
    }

    // then expand shortest objects to make each column the same height
    for (let i = 0; i < layout.length; i++) {
      const column = layout[i];
      const colHeight = colHeights[i];
      if (colHeight === maxY) continue;
      const delta = maxY - colHeight;
      let tallest = 0;
      for (const o of column) tallest = Math.max(tallest, o.box.Height);
      const diffs = new Array(column.length).fill(0);
      let totalDiff = 0.;
      for (let k = 0; k < column.length; k++) {
        diffs[k] = tallest - column[k].box.Height;
        totalDiff += diffs[k];
      }
      if (totalDiff > 0) {
        // expand smaller nodes up to the size of the larger ones with delta
        // percentage diff
        for (let k = 0; k < diffs.length; k++) diffs[k] /= totalDiff;
        const growth = Math.min(delta, totalDiff);
        // expand smaller objects to fill remaining space
        for (let k = 0; k < column.length; k++) column[k].box.Height += diffs[k] * growth;
      }
      if (delta > totalDiff) {
        const growth = (delta - totalDiff) / column.length;
        for (const o of column) o.box.Height += growth;
      }
    }
    // if we have 3 columns, then each column's objects should have the same width
    for (const column of layout) {
      let colWidth = 0.;
      for (const o of column) {
        o.moveWithDescendantsTo(cursor.x, cursor.y);
        cursor.y += o.box.Height + verticalGap;
        colWidth = Math.max(colWidth, o.box.Width);
      }
      // set all objects in column to the same width
      for (const o of column) o.box.Width = colWidth;

      // new column
      cursor.y = 0;
      cursor.x += colWidth + horizontalGap;
    }
    maxX = cursor.x - horizontalGap;
  }
  gd.width = maxX;
  gd.height = maxY;
};

/**
 * generate the best layout of objects aiming for each row to be the targetSize width
 * if columns is true, each column aims to have the targetSize height
 */
GridDiagram.prototype.getBestLayout = function getBestLayout(targetSize, columns) {
  const gd = this;
  const objects = gd.objects || [];
  let nCuts;
  if (columns) nCuts = gd.columns - 1;
  else nCuts = gd.rows - 1;
  if (nCuts === 0) return genLayout(objects, null);

  let bestLayout = null;
  let bestDist = MAX_FLOAT64;
  let fastIsBest = false;
  // try fast layout algorithm as a baseline
  const fast = gd.fastLayout(targetSize, nCuts, columns);
  if (fast !== null) {
    const dist = getDistToTarget(fast, targetSize, gd.horizontalGap, gd.verticalGap, columns);
    if (dist === 0) return fast;
    bestDist = dist;
    bestLayout = fast;
    fastIsBest = true;
  }

  let gap;
  if (columns) gap = gd.verticalGap;
  else gap = gd.horizontalGap;
  const getSize = (o) => (columns ? o.box.Height : o.box.Width);

  const sizes = [];
  for (const obj of objects) sizes.push(getSize(obj));
  const sd = stddev(sizes);

  let skipCount = 0;
  let count = 0;
  // quickly eliminate bad row groupings
  let startingCache = new Map();
  // Note: we want a low threshold to explore good options within attemptLimit,
  // but the best option may require a few rows that are far from the target size.
  let okThreshold = STARTING_THRESHOLD;
  const rowOk0 = (row) => {
    let rowSize = 0.;
    for (const obj of row) rowSize += getSize(obj);
    if (row.length > 1) {
      rowSize += gap * (row.length - 1);
      // if multiple nodes are too big, it isn't ok. but a single node can't shrink so only check here
      if (rowSize > okThreshold * targetSize) {
        skipCount++;
        // there may even be too many to skip
        return skipCount >= SKIP_LIMIT;
      }
    }
    // row is too small to be good overall
    if (rowSize < targetSize / okThreshold) {
      skipCount++;
      return skipCount >= SKIP_LIMIT;
    }
    return true;
  };
  const rowOk = (row, starting) => {
    if (starting) {
      // we can cache results from starting positions since they repeat and don't change
      // with starting=true it will always be the 1st N objects based on len(row)
      if (startingCache.has(row.length)) return startingCache.get(row.length);
      const ok = rowOk0(row);
      // cache result before returning
      startingCache.set(row.length, ok);
      return ok;
    }
    return rowOk0(row);
  };

  // get all options for where to place these cuts, preferring later cuts over earlier cuts
  // of these divisions, find the layout with rows closest to the targetSize
  const tryDivision = (division) => {
    const layout = genLayout(objects, division);
    const dist = getDistToTarget(layout, targetSize, gd.horizontalGap, gd.verticalGap, columns);
    if (dist < bestDist) {
      bestLayout = layout;
      bestDist = dist;
      fastIsBest = false;
    } else if (fastIsBest && dist === bestDist) {
      // prefer ordered search solution to fast layout solution
      bestLayout = layout;
      fastIsBest = false;
    }
    count++;
    // with few objects we can try all options to get best result but this won't scale, so only try up to 100k options
    return count >= ATTEMPT_LIMIT || skipCount >= SKIP_LIMIT;
  };

  // try number of different okThresholds depending on std deviation of sizes
  let thresholdAttempts = goInt(Math.ceil(sd));
  if (thresholdAttempts < MIN_THRESHOLD_ATTEMPTS) thresholdAttempts = MIN_THRESHOLD_ATTEMPTS;
  else if (thresholdAttempts > MAX_THRESHOLD_ATTEMPTS) thresholdAttempts = MAX_THRESHOLD_ATTEMPTS;
  for (let i = 0; i < thresholdAttempts || bestLayout === null; i++) {
    count = 0;
    skipCount = 0;
    iterDivisions(objects, nCuts, tryDivision, rowOk);
    okThreshold += THRESHOLD_STEP_SIZE;
    startingCache = new Map();
    if (skipCount === 0) {
      // threshold isn't skipping anything so increasing it won't help
      break;
    }
    // okThreshold isn't high enough yet, we skipped every option so don't count it
    if (count === 0 && thresholdAttempts < MAX_THRESHOLD_ATTEMPTS) thresholdAttempts++;
  }

  return bestLayout;
};

function sum(values) {
  let s = 0.;
  for (const v of values) s += v;
  return s;
}

function avg(values) {
  return sum(values) / values.length;
}

function variance(values) {
  const mean = avg(values);
  let total = 0.;
  for (const value of values) {
    const dev = mean - value;
    total += dev * dev;
  }
  return total / values.length;
}

function stddev(values) {
  return Math.sqrt(variance(values));
}

GridDiagram.prototype.fastLayout = function fastLayout(targetSize, nCuts, columns) {
  const gd = this;
  const objects = gd.objects || [];
  let gap;
  if (columns) gap = gd.verticalGap;
  else gap = gd.horizontalGap;

  let debt = 0.;
  const fastDivision = [];
  let rowSize = 0.;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    let size;
    if (columns) size = o.box.Height;
    else size = o.box.Width;
    if (rowSize === 0) {
      // if a single object meets the target size, end the row here
      if (size > targetSize - debt) {
        // cut row with just this object
        fastDivision.push(i);
        // we build up a debt of distance past the target size across rows
        const newDebt = size - targetSize;
        debt += newDebt;
      } else rowSize += size;
      continue;
    }
    // debt is paid by decreasing threshold to start new row and ending below targetSize
    if (rowSize + gap + (size) / 2. > targetSize - debt) {
      // start a new row before this object since it is mostly past the target size
      fastDivision.push(i - 1);
      const newDebt = rowSize - targetSize;
      debt += newDebt;
      rowSize = size;
    } else rowSize += gap + size;
  }
  let layout = null;
  if (fastDivision.length === nCuts) layout = genLayout(objects, fastDivision);

  return layout;
};

/** get all possible divisions of objects by the number of cuts; f returns true to stop iterating */
function iterDivisions(objects, nCuts, f, check) {
  if (objects.length < 2 || nCuts === 0) return;
  let done = false;
  // we go in this order to prefer extra objects in starting rows rather than later ones
  const lastObj = objects.length - 1;
  for (let index = lastObj; index >= nCuts; index--) {
    if (!check(objects.slice(index), false)) {
      // optimization: if current cut gives a bad grouping, don't recurse
      continue;
    }
    if (nCuts > 1) {
      iterDivisions(objects.slice(0, index), nCuts - 1, (inner) => {
        done = f([...inner, index - 1]);
        return done;
      }, check);
    } else {
      if (!check(objects.slice(0, index), true)) {
        // e.g. [A   B   C | D] if [A,B,C] is bad, skip it
        continue;
      }
      done = f([index - 1]);
    }
    if (done) return;
  }
}

/**
 * generate a grid of objects from the given cut indices
 * each cut index applies after the object at that index
 * e.g. [0 1 2 3 4 5 6 7] with cutIndices [0, 2, 6] => [[0], [1, 2], [3,4,5,6], [7]]
 */
export function genLayout(objects, cutIndices) {
  cutIndices = cutIndices || [];
  const layout = new Array(cutIndices.length + 1);
  let objIndex = 0;
  for (let i = 0; i <= cutIndices.length; i++) {
    let stop;
    if (i < cutIndices.length) stop = cutIndices[i];
    else stop = objects.length - 1;
    layout[i] = [];
    for (; objIndex <= stop; objIndex++) layout[i].push(objects[objIndex]);
  }
  return layout;
}

function getDistToTarget(layout, targetSize, horizontalGap, verticalGap, columns) {
  let totalDelta = 0.;
  for (const row of layout) {
    let rowSize = 0.;
    for (const o of row) {
      if (columns) rowSize += o.box.Height + verticalGap;
      else rowSize += o.box.Width + horizontalGap;
    }
    if (row.length > 0) {
      if (columns) rowSize -= verticalGap;
      else rowSize -= horizontalGap;
    }
    totalDelta += Math.abs(rowSize - targetSize);
  }
  return totalDelta;
}

GridDiagram.prototype.sizeForOutsideLabels = function sizeForOutsideLabels() {
  const gd = this;
  const margins = new Map();

  for (const o of gd.objects || []) {
    const margin = o.getMargin();
    margins.set(o, margin);

    o.box.Height += margin.Top + margin.Bottom;
    o.box.Width += margin.Left + margin.Right;
  }

  return () => {
    for (const o of gd.objects || []) {
      const m = margins.get(o);
      if (m === undefined) continue;
      const dy = m.Top + m.Bottom;
      const dx = m.Left + m.Right;
      o.box.Height -= dy;
      o.box.Width -= dx;

      // less margin may be needed if layout grew the object
      // compute the new margin after removing the old margin we added
      const margin = o.getMargin();
      const marginX = margin.Left + margin.Right;
      const marginY = margin.Top + margin.Bottom;
      if (marginX < dx) {
        // layout grew width and now we need less of a margin (but we subtracted too much)
        // add back dx and subtract the new amount
        o.box.Width += dx - marginX;
      }
      if (marginY < dy) o.box.Height += dy - marginY;

      if (margin.Left > 0 || margin.Top > 0) o.moveWithDescendants(margin.Left, margin.Top);
    }
  };
};
