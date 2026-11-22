// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): tuning.go.
// Routing tuning constants (see routing/core.js for the package split and conventions).

export const basicallyInfinity = 10_000_000.0;
export const extraInterestingPointLayers = 3.0;
export const ovgPadding = 20.0;
export const overshootAmount = 100.0;
export const pathNodeProximityFloor = 5.0;
export const nodeProximityThreshold = 30.0;
export const idealTurnAxisTolerance = 4.0;
export const idealTurnMultiplier = 0.98;
export const idealTurnEvenClusterMultiplier = 0.10;
export const nodeProximityPenalty = 1.0;
export const turnEndpointClearance = 20.0;
export const lowerJitterThreshold = 5.0;
export const minStraightEdgeAngle = 30.0;
export const nonOrthogonalFactor = 4.0;
export const turnPenalty = 1.4;
export const segmentSpacingBuffer = 40.0;
export const unboundedSegmentMove = 100.0;
export const treeChildAlignmentTolerance = 10.0;
