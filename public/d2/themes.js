// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// What d2ir needs of D2's theme catalog (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.):
// whether a theme id exists (d2themescatalog.Find(id) != d2themes.Theme{}). The colours arrive with the render stage.

const IDS = new Set([0, 1, 3, 4, 5, 6, 7, 8, 100, 101, 102, 103, 104, 105, 200, 201, 300, 301, 302, 303]);

/** Whether d2themescatalog.Find(id) finds a theme. */
export const themeExists = (id) => IDS.has(id);
