package routing

// Export shims of the routing stage checks (xdump/routestage_xdump.go): the stage entry points with an explicit work limit and the
// standalone router with explicit budgets. The errors are the raw ones (the optional stages Nudge and Shortcut otherwise swallow the
// work-limit error).

import (
	"context"
	"fmt"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XRunStage runs the named stage with the given aggregate work limit.
func XRunStage(ctx context.Context, name string, g *layoutgraph.Graph, limit uint64, forceReroute, routesPreviouslyCompleted bool) error {
	switch name {
	case "route":
		_, err := RouteGraphWithWorkLimit(ctx, g, GraphRouteOptions{ForceReroute: forceReroute, RoutesPreviouslyCompleted: routesPreviouslyCompleted}, limit)
		return err
	case "crosshatch":
		return crosshatchWithWorkLimit(ctx, g, limit)
	case "simplify":
		return simplifyEdgeRoutesWithLimit(ctx, g, limit)
	case "swap":
		return swapAllEdgePortsWithWorkLimit(ctx, g, limit)
	case "straight":
		return StraightEdgesFallback(ctx, g)
	case "balance":
		return balanceEdgeSegmentsWithLimit(ctx, g, limit)
	case "fixcluster":
		return fixClusterEdgeBranchingWithLimit(ctx, g, limit)
	case "trace":
		return traceEdgesToShapeBorderWithWorkLimit(ctx, g, limit)
	case "reorder":
		return ReorderDuplicates(ctx, g)
	case "nudge":
		return nudgeChannelsWithLimit(ctx, g, limit)
	case "shortcut":
		return shortcutRoutesWithLimit(ctx, g, limit)
	}
	return fmt.Errorf("unknown routing stage %q", name)
}

// XRouteEdges is routeEdgesWithBudgets with the default OVG limits and an explicit work limit.
func XRouteEdges(ctx context.Context, g *layoutgraph.Graph, edges []*layoutgraph.Edge, limit uint64) error {
	return routeEdgesWithBudgets(ctx, g, edges, defaultOVGBuildLimits(), limit)
}

// XMaxStageWork is the default aggregate limit of the post-processing stages and XMaxEdgeRoutingWork that of EdgeRouting.
const XMaxStageWork = maxRouteStageWorkUnits
const XMaxEdgeRoutingWork = maxEdgeRoutingStageWorkUnits
