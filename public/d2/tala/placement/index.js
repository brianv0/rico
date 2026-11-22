// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): the exported stage functions the pipeline calls (engine.js resolves them by name through stagepkgs.js):
// prescale, prepare, place, swap, transposeAll, align, balanceSymmetry, normalizeGaps, optimizeClusters, equidistance, dejitter,
// pad, normalize. The helpers of the package are in the sibling files (one per Go file or file group).

export { prescale, prepare, place, swap, transposeAll, align, normalizeGaps, pad, normalize } from './stages.js';
export { balanceSymmetry } from './symmetry.js';
export { optimizeClusters } from './cluster_optimization.js';
export { equidistance } from './equidistance.js';
export { dejitter } from './dejitter.js';
