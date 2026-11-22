#!/usr/bin/env bash
# Patches of the module copy for the packing/labeling/quality checks (called by setup.sh with the d2layouts/d2talalayout directory). Idempotent.
# The work units of BinPack and label placement are local to the guard of one call; the patched functions store them in the XLastUsed
# variable of the overlay files (overlay/packing.pkgcheck.go, overlay/labeling.pkgcheck.go) so the stage observer can report them.
set -euo pipefail
t="$1"
f="$t/internal/packing/binpack.go"
if ! grep -q XLastUsed "$f"; then
  perl -0pi -e 's/\treturn packAtomic\(ctx, g, root, guard\)\n/\terr = packAtomic(ctx, g, root, guard)\n\tXLastUsed = guard.Used()\n\treturn err\n/' "$f"
  grep -q XLastUsed "$f" || { echo "pkghooks: packing patch failed" >&2; exit 1; }
fi
f="$t/internal/labeling/placement.go"
if ! grep -q XLastUsed "$f"; then
  perl -0pi -e 's/(\tcheckCanceled := guard\.step\n)/$1\tdefer func() { XLastUsed = guard.used }()\n/g' "$f"
  [ "$(grep -c XLastUsed "$f")" = 2 ] || { echo "pkghooks: labeling patch failed" >&2; exit 1; }
fi
