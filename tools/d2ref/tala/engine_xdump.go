package engine

// Overlay file of the TALA port harness (tools/d2ref/tala/setup.sh copies it into
// d2layouts/d2talalayout/internal/engine/xdump_hook.go of a writable copy of the D2 module).
// It exposes the unexported pipeline of one seed with an observer that runs after every stage, so
// internal/xdump can dump the graph at each stage boundary. It reimplements runAllStages and Layout
// by copy: keep it equal to pipeline.go.

import (
	"context"
	"fmt"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/grouping"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/invariant"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XStageObserver is called with stage index -1 and name "input" for the cloned input, then after every stage.
type XStageObserver func(index int, name string, g *layoutgraph.Graph) error

// XStageNames returns the names of the default pipeline stages in order.
func XStageNames() []string {
	names := make([]string, len(defaultPipelineStages))
	for i, s := range defaultPipelineStages {
		names[i] = s.name
	}
	return names
}

// XLayoutObserved is engine.Layout with an observer.
func XLayoutObserved(ctx context.Context, graph *layoutgraph.Graph, options LayoutOptions, observer XStageObserver) (*layoutgraph.Graph, error) {
	if graph == nil {
		return nil, fmt.Errorf("TALA Autolayout requires a graph")
	}
	workspace, err := layoutgraph.Clone(ctx, graph)
	if err != nil {
		return nil, err
	}
	if len(workspace.Nodes) == 0 {
		return workspace, nil
	}
	if observer != nil {
		if err := observer(-1, "input", workspace); err != nil {
			return nil, err
		}
	}
	p := newPipeline(workspace, options.Seed, false)
	XFlags = func() (bool, bool) { return p.forceReroute, p.edgeRoutingComplete } // routing stage checks (overlay/engine/xdump_flags.go)
	if err := p.xRunAllStages(ctx, observer); err != nil {
		return nil, err
	}
	return workspace, nil
}

func (p *pipeline) xRunAllStages(ctx context.Context, observer XStageObserver) error {
	ctx, _, err := layoutgraph.EnsureTransactionWorkGuard(ctx, "AutolayoutTransactions")
	if err != nil {
		return err
	}
	stages := p.stagePlan()
	for stageIndex := range stages {
		stage := &stages[stageIndex]
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s: %w", stage.name, err)
		}
		if stageIndex == 0 {
			grouping.ResetClusters(p.graph)
			p.resetFullLayoutRouteState()
		}
		if err := stage.run(p, ctx); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s: %w", stage.name, err)
		}
		tl, br := p.graph.BoundingBox()
		if tl != nil && br != nil {
			width := br.X - tl.X
			height := br.Y - tl.Y
			if (width > maxGraphSize) || (height > maxGraphSize) {
				return invariant.Errorf("Dimensions w:%v, h:%v reached after stage %v", width, height, stage.name)
			}
		}
		if observer != nil {
			if err := observer(stageIndex, stage.name, p.graph); err != nil {
				return err
			}
		}
	}
	return nil
}
