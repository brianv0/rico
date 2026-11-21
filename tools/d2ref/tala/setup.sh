#!/usr/bin/env bash
# Builds the Go reference harness of the TALA port.
#
# TALA's packages are Go `internal` packages, so nothing outside d2layouts/d2talalayout can import them, and the Go module
# cache is read-only. This script copies the D2 v0.9.0 module tree to a writable directory ($TALA_REF, default /tmp/tala-ref),
# installs the overlay files of this directory into it and builds the debug program:
#
#   engine_xdump.go -> d2layouts/d2talalayout/internal/engine/xdump_hook.go   (stage observer around the unexported pipeline)
#   root_xdump.go   -> d2layouts/d2talalayout/xdump_export.go                 (sequential seeds + records, uses the real selection)
#   xdump/*.go      -> d2layouts/d2talalayout/internal/xdump/                  (package main: the dump modes)
#
# and writes the binary to $TALA_REF/xdump.bin (tools/d2ref/diff.mjs runs it; env TALA_REF points it elsewhere).
# Re-run it after editing any overlay file (it only recopies and rebuilds). Needs Go 1.27 (GOTOOLCHAIN=auto downloads it).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${TALA_REF:-/tmp/tala-ref}"
src="${D2_SRC:-}"
if [ -z "$src" ]; then
  src="$(cd "$here/.." && GOFLAGS=-mod=mod go list -m -f '{{.Dir}}' github.com/d2lang/d2)"
fi
if [ ! -d "$dest/d2layouts" ]; then
  mkdir -p "$dest"
  cp -r "$src"/. "$dest"/
  chmod -R u+w "$dest"
fi
t="$dest/d2layouts/d2talalayout"
cp "$here/engine_xdump.go" "$t/internal/engine/xdump_hook.go"
cp "$here/root_xdump.go" "$t/xdump_export.go"
rm -rf "$t/internal/xdump"
mkdir -p "$t/internal/xdump"
cp "$here"/xdump/*.go "$t/internal/xdump/"
(cd "$dest" && go build -o "$dest/xdump.bin" ./d2layouts/d2talalayout/internal/xdump)
echo "built $dest/xdump.bin"
