package hierarchy

// Overlay file of the TALA port harness (tools/d2ref/tala/setup.sh copies tools/d2ref/tala/overlay/hierarchy/*.go into
// d2layouts/d2talalayout/internal/hierarchy/ of a writable copy of the D2 module). It exports the unexported functions that the
// hierarchy checks of internal/xdump call directly (hierarchy_xdump.go).

import (
	"context"
	"fmt"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XRankDAG is rankDAG with an explicit work limit (0 = the default limit of rankDAG).
func XRankDAG(ctx context.Context, g *layoutgraph.Graph, limit uint64) (map[*layoutgraph.Node]int, int, error) {
	var res rankResult
	var err error
	if limit == 0 {
		res, err = rankDAG(ctx, g)
	} else {
		res, err = rankDAGWithLimit(ctx, g, limit)
		if err != nil {
			err = fmt.Errorf("TALA RankDAG failed: %w", err)
		}
	}
	if err != nil {
		return nil, 0, err
	}
	return res.nodeToLevel, res.levelCount, nil
}

// XMakeSimpleDAG is makeSimpleDAG.
func XMakeSimpleDAG(ctx context.Context, g *layoutgraph.Graph) (*layoutgraph.Graph, error) {
	return makeSimpleDAG(ctx, g)
}

// XBuild is build with every node of g declared hierarchical and no edge abductions.
func XBuild(ctx context.Context, g *layoutgraph.Graph, force bool) (*layoutgraph.Hierarchy, error) {
	all := make(map[*layoutgraph.Node]struct{}, len(g.Nodes))
	for _, n := range g.Nodes {
		all[n] = struct{}{}
	}
	return build(ctx, g, force, all, nil)
}
