package packing

// Overlay of the TALA port harness (tala/setup.sh installs it as internal/packing/xdump_pkgcheck.go of the module copy).
// It reports the work units BinPack used (Pack itself is patched by pkghooks.sh to store them in XLastUsed) and runs BinPack with a
// chosen work limit, so the JS port's work accounting and exhaustion errors can be compared with Go's.

import (
	"context"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XLastUsed is the work units of the latest Pack call (set by the patched Pack).
var XLastUsed int64

// XPackLimit is Pack with the given work limit; it returns the work units used.
func XPackLimit(ctx context.Context, g *layoutgraph.Graph, root *layoutgraph.Node, limit int64) (int64, error) {
	guard, err := newWorkGuard(ctx, limit)
	if err != nil {
		return 0, err
	}
	err = packAtomic(ctx, g, root, guard)
	return guard.Used(), err
}
