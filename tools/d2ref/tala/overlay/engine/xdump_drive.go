package engine

// Overlay file of the TALA port harness (setup.sh copies overlay/<package>/*.go into internal/<package>/ of the module copy).
// The check of the pipeline DRIVER (runAllStages, runLayout, Layout; docs/d2-tala-port.md, "engine"): XInstallScript replaces the `run` of
// every entry of defaultPipelineStages by a scripted stub, so the real driver code runs with stage bodies that only record the graph they
// are entered with and then do what the script says (nothing, fail, cancel the context, widen a node, panic). XDrive then runs the real
// Layout or runLayout. XCompoundTrace is the decision part of CompoundCandidate (before the routing trial) with its admission data.

import (
	"context"
	"fmt"
	"math/rand"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/hierarchy"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XStep is what one stage of the script does after it recorded its entry.
type XStep struct {
	Op  string  `json:"op"` // "", "err", "cancel", "grow", "move", "panic", "errf" (an error wrapping context.Canceled)
	Msg string  `json:"msg,omitempty"`
	W   float64 `json:"w,omitempty"`
	H   float64 `json:"h,omitempty"`
	DX  float64 `json:"dx,omitempty"`
	DY  float64 `json:"dy,omitempty"`
}

// XOnStage is called when a stub stage is entered (graph = the state after the previous stage).
var XOnStage func(index int, name string, g *layoutgraph.Graph)

// XCancel is called by the "cancel" step.
var XCancel func()

var xOriginalStages [len(defaultPipelineStages)]pipelineStage

// XInstallScript replaces the stages by stubs executing script[index] (missing entries do nothing); returns the restore function.
func XInstallScript(script map[int]XStep) func() {
	xOriginalStages = defaultPipelineStages
	for i := range defaultPipelineStages {
		index, name := i, defaultPipelineStages[i].name
		defaultPipelineStages[i].run = func(p *pipeline, ctx context.Context) error {
			if XOnStage != nil {
				XOnStage(index, name, p.graph)
			}
			step := script[index]
			switch step.Op {
			case "err":
				return fmt.Errorf("%s", step.Msg)
			case "errf":
				return fmt.Errorf("scripted: %w", context.Canceled)
			case "cancel":
				if XCancel != nil {
					XCancel()
				}
			case "grow":
				if len(p.graph.Nodes) > 0 {
					p.graph.Nodes[0].Width = step.W
					p.graph.Nodes[0].Height = step.H
				}
			case "move":
				for _, n := range p.graph.Nodes {
					if n.TopLeft != nil {
						n.TopLeft.X += step.DX
						n.TopLeft.Y += step.DY
					}
				}
			case "panic":
				panic(step.Msg)
			}
			return nil
		}
	}
	return func() { defaultPipelineStages = xOriginalStages }
}

// XDriveResult is what XDrive reports besides the error and the graph.
type XDriveResult struct {
	NilPipeline    bool
	DurationsLen   int
	DurationsUsed  []bool // stageDurations[i] > 0
	Workspace      *layoutgraph.Graph
}

// XDrive runs the real runLayout (clone first, as Layout does) with instrumentation and reports the pipeline's observable state.
func XDrive(ctx context.Context, graph *layoutgraph.Graph, seed int64, timing, validate bool) (res XDriveResult, err error) {
	workspace, err := layoutgraph.Clone(ctx, graph)
	if err != nil {
		return res, err
	}
	res.Workspace = workspace
	p, err := runLayout(ctx, workspace, LayoutOptions{Seed: seed}, pipelineInstrumentation{measureStageDurations: timing}, validate)
	res.NilPipeline = p == nil
	if p != nil {
		res.DurationsLen = len(p.stageDurations)
		for _, d := range p.stageDurations {
			res.DurationsUsed = append(res.DurationsUsed, d > 0)
		}
	}
	return res, err
}

// XCompoundDetours is compoundCrossAxisDetours.
func XCompoundDetours(g *layoutgraph.Graph) int { return compoundCrossAxisDetours(g) }

// XCompoundTrace walks CompoundCandidate up to the routing trial: Reason is why it returned the graph itself ("size", "nocontainer",
// "unchanged", "worse"), or "route" when the candidate would be routed.
type XCompoundRecord struct {
	Reason         string
	DetoursBefore  int
	DetoursAfter   int
	Candidate      *layoutgraph.Graph // the placed candidate (before routing)
}

func XCompoundTrace(ctx context.Context, graph *layoutgraph.Graph) (rec XCompoundRecord, err error) {
	if len(graph.Nodes) > 128 || len(graph.Edges) > 256 || len(graph.Containers[nil]) < 3 || len(graph.Containers[nil]) > 64 {
		rec.Reason = "size"
		return
	}
	detailed := false
	for _, node := range graph.Containers[nil] {
		detailed = detailed || node.IsContainer()
	}
	if !detailed || graph.HasFixedNode() {
		rec.Reason = "nocontainer"
		return
	}
	candidate, err := layoutgraph.Clone(ctx, graph)
	if err != nil {
		return
	}
	changed, err := hierarchy.PlaceCompound(ctx, candidate, rand.New(rand.NewSource(0)))
	if err != nil {
		return
	}
	if !changed {
		rec.Reason = "unchanged"
		return
	}
	rec.DetoursBefore = compoundCrossAxisDetours(graph)
	rec.DetoursAfter = compoundCrossAxisDetours(candidate)
	rec.Candidate = candidate
	if rec.DetoursAfter > rec.DetoursBefore {
		rec.Reason = "worse"
		return
	}
	rec.Reason = "route"
	return
}
