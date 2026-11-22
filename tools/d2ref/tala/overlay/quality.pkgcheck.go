package quality

// Overlay of the TALA port harness (installed as internal/quality/xdump_pkgcheck.go): the unexported evaluators with a chosen work limit
// that also report the work units used.

import (
	"context"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

func XEvaluateLimit(ctx context.Context, g *layoutgraph.Graph, limit int64) (float64, float64, int64, error) {
	return evaluateWithAreaLimit(ctx, g, limit)
}

func XInspectLimit(ctx context.Context, g *layoutgraph.Graph, limit int64) (Metrics, int64, error) {
	return inspectWithLimit(ctx, g, limit)
}
