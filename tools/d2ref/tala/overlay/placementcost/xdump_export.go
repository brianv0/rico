package placementcost

// Overlay file of the TALA port harness (installed into internal/placementcost/ of the writable module copy by setup.sh). It exports
// what the placementcost checks of internal/xdump call directly and cannot reach: the unexported state hash and helpers.

import (
	"context"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/lib/geo"
)

// XEdgeLengthState is placementEdgeLengthState.
func XEdgeLengthState(graph *layoutgraph.Graph, options EdgeLengthOptions) uint64 {
	return placementEdgeLengthState(graph, graph.RoutingCosts(), options)
}

// XEdgeLengthWorkerCount is edgeLengthWorkerCount.
func XEdgeLengthWorkerCount(nodeCount, gomaxprocs int) int { return edgeLengthWorkerCount(nodeCount, gomaxprocs) }

// XFlowContinuity is flowContinuityCost with the incident-edge replacements of an options-free preparation.
func XFlowContinuity(ctx context.Context, node *layoutgraph.Node, options EdgeLengthOptions) (float64, error) {
	s := scratchPool.Get()
	defer putEdgeScratch(s)
	if _, err := prepareNodeEdgeLength(ctx, node, options, s); err != nil {
		return 0, err
	}
	return flowContinuityCost(node, s), nil
}

// XIsMirrored is isMirrored.
func XIsMirrored(a, b *layoutgraph.Node, isXAxis bool, axisVal float64) bool {
	return isMirrored(a, b, isXAxis, axisVal)
}

// XCompass exposes the compass helpers: the reading of a, the delta a -> b and the axis delta a -> b.
func XCompass(a, b geo.Orientation) (int, int, int) {
	first, second := directionCompass(a), directionCompass(b)
	return int(first), int(compassDelta(first, second)), int(compassAxisDelta(first, second))
}

// XSizelessOrientation is sizelessOrientation.
func XSizelessOrientation(a, b *layoutgraph.Node) geo.Orientation { return sizelessOrientation(a, b) }

// XPlacementDistance is placementDistance.
func XPlacementDistance(a, b *layoutgraph.Node, includeSizes bool) float64 {
	return placementDistance(a, b, includeSizes)
}

// XDistanceBetweenTableColumns is distanceBetweenTableColumns.
func XDistanceBetweenTableColumns(g *layoutgraph.Graph, e *layoutgraph.Edge, from, to *layoutgraph.Node) float64 {
	return distanceBetweenTableColumns(g, e, from, to)
}

// XClusterExactlyTwo is clusterExactlyTwoExternalConnectedNodes.
func XClusterExactlyTwo(c *layoutgraph.Cluster) (*layoutgraph.Node, *layoutgraph.Node, bool) {
	return clusterExactlyTwoExternalConnectedNodes(c)
}
