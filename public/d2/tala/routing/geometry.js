// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): geometry.go.

export function segmentIntersectsBox(first, second, box) {
  if (first == null || second == null || box == null || box.TopLeft == null) return false;
  const left = Math.min(box.TopLeft.x, box.TopLeft.x + box.Width);
  const right = Math.max(box.TopLeft.x, box.TopLeft.x + box.Width);
  const top = Math.min(box.TopLeft.y, box.TopLeft.y + box.Height);
  const bottom = Math.max(box.TopLeft.y, box.TopLeft.y + box.Height);
  if (Math.max(first.x, second.x) < left || right < Math.min(first.x, second.x) ||
    Math.max(first.y, second.y) < top || bottom < Math.min(first.y, second.y)) {
    return false;
  }
  const contains = (point) => left <= point.x && point.x <= right && top <= point.y && point.y <= bottom;
  if (contains(first) || contains(second)) return true;
  let tEnter = 0.0, tExit = 1.0;
  const clipAxis = (start, delta, minCoord, maxCoord) => {
    if (delta === 0) return minCoord <= start && start <= maxCoord;
    let one = (minCoord - start) / delta;
    let two = (maxCoord - start) / delta;
    if (one > two) { const t = one; one = two; two = t; }
    tEnter = Math.max(tEnter, one);
    tExit = Math.min(tExit, two);
    return tEnter <= tExit;
  };
  if (!clipAxis(first.x, second.x - first.x, left, right) || !clipAxis(first.y, second.y - first.y, top, bottom)) return false;
  return tEnter < tExit;
}

export function orientation(first, second, third) {
  const firstSecondX = second.x - first.x;
  const firstSecondY = second.y - first.y;
  const firstThirdX = third.x - first.x;
  const firstThirdY = third.y - first.y;
  return firstSecondY * firstThirdX - firstSecondX * firstThirdY;
}

export function intersects(firstStart, firstEnd, secondStart, secondEnd) {
  const secondStartSide = orientation(firstStart, firstEnd, secondStart);
  const secondEndSide = orientation(firstStart, firstEnd, secondEnd);
  const firstStartSide = orientation(secondStart, secondEnd, firstStart);
  const firstEndSide = orientation(secondStart, secondEnd, firstEnd);
  if (secondStartSide === 0 && secondEndSide === 0 && firstStartSide === 0 && firstEndSide === 0) {
    return closedIntervalsOverlap(firstStart.x, firstEnd.x, secondStart.x, secondEnd.x) &&
      closedIntervalsOverlap(firstStart.y, firstEnd.y, secondStart.y, secondEnd.y);
  }
  return straddlesLine(secondStartSide, secondEndSide) && straddlesLine(firstStartSide, firstEndSide);
}

export function straddlesLine(first, second) {
  return first === 0 || second === 0 || (first < 0) !== (second < 0);
}

export function closedIntervalsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  const firstMin = Math.min(firstStart, firstEnd), firstMax = Math.max(firstStart, firstEnd);
  const secondMin = Math.min(secondStart, secondEnd), secondMax = Math.max(secondStart, secondEnd);
  return firstMin <= secondMax && secondMin <= firstMax;
}
