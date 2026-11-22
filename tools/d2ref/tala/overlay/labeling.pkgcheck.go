package labeling

// Overlay of the TALA port harness (installed as internal/labeling/xdump_pkgcheck.go): label placement with a chosen work limit and
// the work units it used (place and placeNewEdges are patched by pkghooks.sh to store them in XLastUsed).

import (
	"context"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XLastUsed is the work units of the latest place/placeNewEdges call.
var XLastUsed int64

func XPlaceLimit(ctx context.Context, g *layoutgraph.Graph, limit int64) (int64, error) {
	XLastUsed = 0
	err := place(ctx, g, limit)
	return XLastUsed, err
}

func XPlaceNewEdgesLimit(ctx context.Context, g *layoutgraph.Graph, edges []*layoutgraph.Edge, limit int64) (int64, error) {
	XLastUsed = 0
	err := placeNewEdges(ctx, g, edges, limit)
	return XLastUsed, err
}
