package d2talalayout

// Overlay file of the TALA port harness (tools/d2ref/tala/setup.sh copies it into
// d2layouts/d2talalayout/xdump_trace.go of a writable copy of the D2 module).
//
// XTraceLayout is Layout with every step recorded: the real layoutPlan, newSeedInput, runSeed, evaluateSeedResult,
// coordinateLocalSeeds (one worker, so the seeds run in index order), considerSeedCandidate, engine.CompoundCandidate and
// applySeedResult, so the error texts and the patched D2 graph are those of the real Layout. It is a copy of Layout and
// runLocalSeed (below): keep it equal to layout.go. XTraceRouteEdges is RouteEdges (adapter.go) with a callback after the
// routing call. The validation helpers are exported for the error-injection mode (XValidate*).

import (
	"context"
	"fmt"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/routing"
)

// XTraceSeed is the record of one seed attempt: the graph the engine produced (even when its evaluation failed).
type XTraceSeed struct {
	Seed     int64
	Err      string // the error of the attempt (engine or evaluation), as runLocalSeed reports it
	HasGraph bool   // the engine finished: Graph is its result and Err (if any) is the evaluation error
	Penalty  float64
	Area     float64
	HasScore bool
	Graph    *layoutgraph.Graph
}

// XTraceInvocation is the record of one Layout call.
type XTraceInvocation struct {
	Seeds         []int64
	Input         *layoutgraph.Graph
	Runs          []XTraceSeed
	Selected      int    // index into Runs of the best seed before the compound candidate; -1 if none
	Compound      string // "none", "unchanged", "kept", "rejected", "error"
	CompoundErr   string
	CompoundGraph *layoutgraph.Graph
	Final         *layoutgraph.Graph
}

// XTraceLayout runs Layout with the seeds one after another and records what the selection saw.
func XTraceLayout(ctx context.Context, graph *d2graph.Graph, opts *Options) (inv *XTraceInvocation, err error) {
	defer recoverAsError("layout", &err)

	if ctx == nil {
		return nil, fmt.Errorf("TALA layout requires a context")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if graph == nil || graph.Root == nil {
		return nil, fmt.Errorf("tala requires a D2 graph with a root object")
	}
	seeds, concurrency, err := layoutPlan(graph, opts)
	if err != nil {
		return nil, err
	}
	_ = concurrency
	input, err := newSeedInput(ctx, graph)
	if err != nil {
		return nil, err
	}
	inv = &XTraceInvocation{Seeds: seeds, Input: input.graph, Selected: -1, Compound: "none"}
	workCtx := ctx
	cancelWork := func() {}
	if ctx.Done() == nil {
		workCtx, cancelWork = context.WithCancel(ctx)
	}
	defer cancelWork()
	best, err := coordinateLocalSeeds(workCtx, seeds, 1, func(index int, seed int64) (attempt localSeedAttempt) {
		attempt.index = index
		attempt.seed = seed
		run := XTraceSeed{Seed: seed}
		defer func() {
			if r := recover(); r != nil {
				attempt.result = seedResult{}
				attempt.err = fmt.Errorf("TALA seed layout failed due to an internal invariant")
			}
			if attempt.err != nil {
				run.Err = attempt.err.Error()
			}
			inv.Runs = append(inv.Runs, run)
		}()
		laidOut, err := runSeed(workCtx, input, seed)
		if err != nil {
			attempt.err = err
			return attempt
		}
		run.HasGraph = true
		run.Graph = laidOut
		attempt.result, attempt.err = evaluateSeedResult(workCtx, input, laidOut)
		if attempt.err == nil {
			run.HasScore = true
			run.Penalty = attempt.result.score.penalty
			run.Area = attempt.result.score.area
		}
		return attempt
	})
	for i, run := range inv.Runs {
		if run.HasScore && best.graph == run.Graph {
			inv.Selected = i
		}
	}
	if err != nil {
		return inv, err
	}
	before := best.graph
	best, err = considerSeedCandidate(workCtx, best, func() (seedResult, error) {
		candidate, err := engine.CompoundCandidate(workCtx, best.graph)
		if err != nil {
			inv.Compound = "error"
			inv.CompoundErr = err.Error()
			return seedResult{}, err
		}
		if candidate == best.graph {
			inv.Compound = "unchanged"
			return best, nil
		}
		inv.CompoundGraph = candidate
		return evaluateSeedResult(workCtx, input, candidate)
	})
	if err != nil {
		return inv, err
	}
	if best.graph != before {
		inv.Compound = "kept"
	} else if inv.CompoundGraph != nil {
		inv.Compound = "rejected"
	}
	inv.Final = best.graph
	return inv, applySeedResult(workCtx, graph, best)
}

// XTraceRouteEdges is RouteEdges with rec called after routing.RouteEdges succeeded (the routed TALA graph and edges).
func XTraceRouteEdges(rec func(g *layoutgraph.Graph, edges []*layoutgraph.Edge)) func(ctx context.Context, g *d2graph.Graph, edges []*d2graph.Edge) error {
	return func(ctx context.Context, g *d2graph.Graph, edges []*d2graph.Edge) (err error) {
		defer recoverAsError("edge routing", &err)
		if ctx == nil {
			return fmt.Errorf("TALA edge routing requires a context")
		}
		if err := validateRequestedD2Edges(g, edges); err != nil {
			return err
		}

		talaGraph := layoutgraph.NewGraph()
		bindings, err := translateGraph(ctx, g, talaGraph, true)
		if err != nil {
			return err
		}

		talaEdgeByID := make(map[layoutgraph.EntityID]*layoutgraph.Edge, len(talaGraph.Edges))
		for _, edge := range talaGraph.Edges {
			talaEdgeByID[edge.ID] = edge
		}
		talaEdges := make([]*layoutgraph.Edge, 0, len(edges))
		for _, e := range edges {
			if e == nil {
				return fmt.Errorf("cannot route a nil D2 edge")
			}
			talaEdgeID, bound := bindings.edgeIDs[e]
			talaEdge, found := talaEdgeByID[talaEdgeID]
			if !bound || !found {
				return fmt.Errorf("could not find edge %#v in graph", e.AbsID())
			}
			talaEdges = append(talaEdges, talaEdge)
		}

		workCtx := ctx
		cancelWork := func() {}
		if ctx.Done() == nil {
			workCtx, cancelWork = context.WithCancel(ctx)
		}
		defer cancelWork()
		err = routing.RouteEdges(workCtx, talaGraph, talaEdges)
		if err != nil {
			return preferContextError(ctx, "edge routing", err)
		}
		if rec != nil {
			rec(talaGraph, talaEdges)
		}

		patch, err := buildRoutePatch(workCtx, g, bindings, talaEdges)
		if err != nil {
			return preferContextError(ctx, "edge routing", err)
		}
		return commitRoutePatch(workCtx, patch)
	}
}

// XResultCheck runs the three validations of evaluateSeedResult on a graph against an input graph and returns the error text of each
// ("" when it passes): validateCompletedGraph, validateLayoutResultTopology, validateLayoutResultMetadata; and the evaluateSeedResult error.
func XResultCheck(ctx context.Context, input, result *layoutgraph.Graph) (completed, topology, metadata, evaluate string) {
	errText := func(err error) string {
		if err == nil {
			return ""
		}
		return err.Error()
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				completed = "panic"
			}
		}()
		completed = errText(validateCompletedGraph(ctx, result))
	}()
	var seq map[layoutgraph.EntityID]struct{}
	func() {
		defer func() {
			if r := recover(); r != nil {
				topology = "panic"
			}
		}()
		var err error
		seq, err = validateLayoutResultTopology(ctx, input, result)
		topology = errText(err)
	}()
	func() {
		defer func() {
			if r := recover(); r != nil {
				metadata = "panic"
			}
		}()
		metadata = errText(validateLayoutResultMetadata(ctx, input, result, seq))
	}()
	func() {
		defer func() {
			if r := recover(); r != nil {
				evaluate = "panic"
			}
		}()
		_, err := evaluateSeedResult(ctx, seedInput{graph: input}, result)
		evaluate = errText(err)
	}()
	return
}

// XCompareScores is layoutScore.compare on the given values.
func XCompareScores(p1, a1, p2, a2 float64) int {
	return layoutScore{penalty: p1, area: a1}.compare(layoutScore{penalty: p2, area: a2})
}
