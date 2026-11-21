package d2talalayout

// Overlay file of the TALA port harness (tools/d2ref/tala/setup.sh copies it into
// d2layouts/d2talalayout/xdump_export.go of a writable copy of the D2 module).
// XDumpLayout is Layout with the seeds run one after the other, an observer for every stage of every seed,
// and a record of what was selected. It reuses the real selection and patch code.

import (
	"context"
	"fmt"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XDumpSeed is the record of one seed attempt.
type XDumpSeed struct {
	Seed    int64
	Err     string
	Penalty float64
	Area    float64
	HasScore bool
	Graph   *layoutgraph.Graph
}

// XDumpInvocation is the record of one Layout call.
type XDumpInvocation struct {
	Seeds         []int64
	Input         *layoutgraph.Graph
	Runs          []XDumpSeed
	Selected      int // index into Runs of the best seed before the compound candidate; -1 if none
	Compound      string // "none", "unchanged", "kept", "rejected"
	CompoundGraph *layoutgraph.Graph
	Final         *layoutgraph.Graph
}

// XDumpTranslate runs only the adapter: D2 graph -> TALA graph.
func XDumpTranslate(ctx context.Context, graph *d2graph.Graph) (*layoutgraph.Graph, error) {
	input, err := newSeedInput(ctx, graph)
	if err != nil {
		return nil, err
	}
	return input.graph, nil
}

// XDumpLayout runs Layout sequentially. stage is called for every seed and every stage (index -1 is the input).
func XDumpLayout(ctx context.Context, graph *d2graph.Graph, opts *Options, stage func(seed int64, index int, name string, g *layoutgraph.Graph)) (inv *XDumpInvocation, err error) {
	defer recoverAsError("layout", &err)
	if graph == nil || graph.Root == nil {
		return nil, fmt.Errorf("tala requires a D2 graph with a root object")
	}
	seeds, _, err := layoutPlan(graph, opts)
	if err != nil {
		return nil, err
	}
	input, err := newSeedInput(ctx, graph)
	if err != nil {
		return nil, err
	}
	inv = &XDumpInvocation{Seeds: seeds, Input: input.graph, Selected: -1, Compound: "none"}
	bestIndex := -1
	var best seedResult
	results := make([]seedResult, len(seeds))
	for i, seed := range seeds {
		run := XDumpSeed{Seed: seed}
		func() {
			defer func() {
				if recover() != nil {
					run.Err = "TALA seed layout failed due to an internal invariant"
				}
			}()
			laidOut, lerr := engine.XLayoutObserved(ctx, input.graph, engine.LayoutOptions{Seed: seed}, func(idx int, name string, g *layoutgraph.Graph) error {
				if stage != nil {
					stage(seed, idx, name, g)
				}
				return nil
			})
			if lerr != nil {
				run.Err = lerr.Error()
				return
			}
			res, eerr := evaluateSeedResult(ctx, input, laidOut)
			if eerr != nil {
				run.Err = eerr.Error()
				return
			}
			run.HasScore = true
			run.Penalty = res.score.penalty
			run.Area = res.score.area
			run.Graph = laidOut
			results[i] = res
			comparison := 0
			if bestIndex >= 0 {
				comparison = res.score.compare(best.score)
			}
			if bestIndex < 0 || comparison < 0 || (comparison == 0 && i > bestIndex) {
				bestIndex = i
				best = res
			}
		}()
		inv.Runs = append(inv.Runs, run)
	}
	inv.Selected = bestIndex
	if bestIndex < 0 {
		return inv, fmt.Errorf("all TALA seed attempts failed")
	}
	before := best.graph
	best, err = considerSeedCandidate(ctx, best, func() (seedResult, error) {
		candidate, err := engine.CompoundCandidate(ctx, best.graph)
		if err != nil {
			return seedResult{}, err
		}
		if candidate == best.graph {
			inv.Compound = "unchanged"
			return best, nil
		}
		inv.CompoundGraph = candidate
		return evaluateSeedResult(ctx, input, candidate)
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
	return inv, applySeedResult(ctx, graph, best)
}
