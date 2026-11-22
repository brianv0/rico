package main

// Modes of the placementcost checks (registered in hierModes of hierarchy_xdump.go).
//
//	pcscore   graph (+ "args": {deep}) -> every function of internal/placementcost on the graph: the EdgeLength state hash, EdgeLength
//	          (8 option combinations, evaluated twice: the second call is a cache hit), NodeEdgeLength, NodeSymmetry, flow continuity,
//	          column crossings, axis scores, crossings, helpers of pairs of nodes, the same with the edge abductions of a container
//	          (what node placement passes), the node scorer, and the number of context polls of each of them (the cancellation points)
//	pcunit    {"args": {"pairs": [[x, y]..]}} -> math.Hypot of the pairs, the worker counts, the compass helpers (pure functions)
//
// The JS twin is tools/d2ref/tala/placementcostcheck.mjs: keep both in step.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"runtime"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/placementcost"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/textmeasure"
)

func init() {
	hierModes["pcscore"] = func(in input, _ *textmeasure.Ruler) interface{} { return runPCScore(in) }
	hierModes["pcunit"] = func(in input, _ *textmeasure.Ruler) interface{} { return runPCUnit(in) }
}

type pcCtx struct {
	context.Context
	n      *int
	failAt int
}

func (c pcCtx) Err() error {
	*c.n++
	if c.failAt > 0 && *c.n >= c.failAt {
		return context.Canceled
	}
	return c.Context.Err()
}

// pcTry runs f: its value, {"err"} for an error, "panic" for a panic
func pcTry(f func() (interface{}, error)) (res interface{}) {
	defer func() {
		if r := recover(); r != nil {
			res = "panic"
		}
	}()
	v, err := f()
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	return v
}

func pcOpts(i int, abductions []*layoutgraph.EdgeAbduction) placementcost.EdgeLengthOptions {
	return placementcost.EdgeLengthOptions{
		EdgeAbductions:    abductions,
		IncludeNodeSizes:  i&4 != 0,
		EnforceMinimumGap: i&2 != 0,
		PenalizeDirection: i&1 != 0,
	}
}

func pcKey(i int) string { return fmt.Sprintf("s%de%dp%d", (i>>2)&1, (i>>1)&1, i&1) }

func pcIDs(nodes []*layoutgraph.Node) []int64 {
	if len(nodes) == 0 {
		return nil
	}
	out := make([]int64, len(nodes))
	for i, n := range nodes {
		out[i] = n.IDValue()
	}
	return out
}

func pcNodeID(n *layoutgraph.Node) int64 {
	if n == nil {
		return 0
	}
	return n.IDValue()
}

func pcPositioned(nodes []*layoutgraph.Node) bool {
	for _, n := range nodes {
		if n.TopLeft == nil {
			return false
		}
	}
	return true
}

// pcBattery runs the node-level functions on nodes with the given abductions and records the values.
func pcBattery(ctx context.Context, g *layoutgraph.Graph, nodes []*layoutgraph.Node, abductions []*layoutgraph.EdgeAbduction) map[string]interface{} {
	out := map[string]interface{}{}
	limit := nodes
	if len(limit) > 24 {
		limit = limit[:24]
	}
	nel := [][]interface{}{}
	sym, ccc, flow := []interface{}{}, []interface{}{}, []interface{}{}
	for _, n := range limit {
		var row []interface{}
		for i := 0; i < 8; i++ {
			i := i
			row = append(row, pcTry(func() (interface{}, error) { return placementcost.NodeEdgeLength(ctx, n, pcOpts(i, abductions)) }))
		}
		nel = append(nel, row)
		sym = append(sym, pcTry(func() (interface{}, error) { return placementcost.NodeSymmetry(ctx, n, abductions) }))
		ccc = append(ccc, pcTry(func() (interface{}, error) { return placementcost.ColumnCrossingCost(ctx, n, abductions) }))
		flow = append(flow, pcTry(func() (interface{}, error) { return placementcost.XFlowContinuity(ctx, n, pcOpts(4, abductions)) }))
	}
	out["nodeEdgeLength"] = nel
	out["symmetry"] = sym
	out["columnCrossing"] = ccc
	out["flow"] = flow
	out["nodesSymmetry"] = pcTry(func() (interface{}, error) { return placementcost.NodesSymmetry(ctx, limit, abductions) })
	out["nodesEdgeLength"] = pcTry(func() (interface{}, error) {
		return placementcost.NodesEdgeLength(ctx, limit, pcOpts(5, abductions))
	})
	return out
}

func runPCScore(in input) interface{} {
	g, _, err := hierLoad(in)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	ctx := context.Background()
	out := map[string]interface{}{}
	positioned := pcPositioned(g.Nodes)
	out["positioned"] = positioned

	// the state hashes, before anything is evaluated (the lazily computed graph costs are still unset here)
	states := map[string]string{}
	for i := 0; i < 8; i++ {
		states[pcKey(i)] = fmt.Sprint(placementcost.XEdgeLengthState(g, pcOpts(i, nil)))
	}
	out["state"] = states
	if !positioned {
		return out
	}

	// EdgeLength twice per option set: the second call must be a cache hit
	el := map[string]interface{}{}
	for i := 0; i < 8; i++ {
		i := i
		first := pcTry(func() (interface{}, error) { return placementcost.EdgeLength(ctx, g, pcOpts(i, nil)) })
		entries := g.EdgeLengthCacheEntries()
		second := pcTry(func() (interface{}, error) { return placementcost.EdgeLength(ctx, g, pcOpts(i, nil)) })
		el[pcKey(i)] = []interface{}{first, entries, second, g.EdgeLengthCacheEntries(), fmt.Sprint(placementcost.XEdgeLengthState(g, pcOpts(i, nil)))}
	}
	out["edgeLength"] = el

	out["crossings"] = pcTry(func() (interface{}, error) { return placementcost.GraphEdgeCrossings(ctx, g) })
	out["containerAlignment"] = pcTry(func() (interface{}, error) { return placementcost.ContainerAlignmentCost(ctx, g) })
	for k, v := range pcBattery(ctx, g, g.Nodes, nil) {
		out[k] = v
	}

	// axis scores of windows of the node list
	axis := []interface{}{}
	for size := 2; size <= 5; size++ {
		for start := 0; start+size <= len(g.Nodes) && start < 12; start++ {
			axis = append(axis, placementcost.AxisScore(g.Nodes[start:start+size]))
		}
	}
	out["axis"] = axis

	// helpers of pairs of nodes
	pairs := []interface{}{}
	lim := g.Nodes
	if len(lim) > 8 {
		lim = lim[:8]
	}
	for _, a := range lim {
		for _, b := range lim {
			if a == b {
				continue
			}
			rec := map[string]interface{}{}
			rec["mirror"] = []bool{placementcost.XIsMirrored(a, b, true, a.TopLeft.X+a.Width/2), placementcost.XIsMirrored(a, b, false, a.TopLeft.Y+a.Height/2)}
			rec["sizeless"] = placementcost.XSizelessOrientation(a, b)
			rec["distance"] = []float64{placementcost.XPlacementDistance(a, b, true), placementcost.XPlacementDistance(a, b, false)}
			pairs = append(pairs, rec)
		}
	}
	out["pairs"] = pairs

	tables := []interface{}{}
	for _, e := range g.Edges {
		if len(tables) >= 12 {
			break
		}
		if e.HasTableColumn() {
			tables = append(tables, pcTry(func() (interface{}, error) {
				return placementcost.XDistanceBetweenTableColumns(g, e, e.From, e.To), nil
			}))
		}
	}
	out["tableDistance"] = tables

	clusters := []interface{}{}
	for _, v := range g.ClusterOrder() {
		if c := g.Clusters[v]; c != nil && len(c.Nodes) > 0 && c.Nodes[0].Graph != nil {
			f, s, ok := placementcost.XClusterExactlyTwo(c)
			clusters = append(clusters, []interface{}{v.IDValue(), pcNodeID(f), pcNodeID(s), ok})
		}
	}
	out["clusters"] = clusters

	// the edge abductions of a container, as node placement passes them
	abducted := []interface{}{}
	var roots []*layoutgraph.Node
	roots = append(roots, nil)
	for _, n := range g.Nodes {
		if n.IsContainer() && len(roots) < 4 {
			roots = append(roots, n)
		}
	}
	for _, root := range roots {
		root := root
		rec := map[string]interface{}{"root": pcNodeID(root)}
		func() {
			defer func() {
				if r := recover(); r != nil {
					rec["panic"] = true
				}
				layoutgraph.Nodes(g.Nodes).SetGraphReference(g)
			}()
			children := g.Containers[root]
			if len(children) == 0 {
				return
			}
			to := layoutgraph.NewGraph()
			to.CopyEntitiesFrom(g)
			for _, child := range children {
				to.AddNodeUnchecked(child)
			}
			abductions := g.AbductEdges(root, to)
			defer g.RestoreEdgeAbductions(abductions)
			to.ComputeCellSize()
			rec["abductions"] = len(abductions)
			els := map[string]interface{}{}
			for i := 0; i < 8; i++ {
				i := i
				els[pcKey(i)] = pcTry(func() (interface{}, error) { return placementcost.EdgeLength(ctx, to, pcOpts(i, abductions)) })
			}
			rec["edgeLength"] = els
			rec["state"] = fmt.Sprint(placementcost.XEdgeLengthState(to, pcOpts(7, abductions)))
			for k, v := range pcBattery(ctx, to, to.Nodes, abductions) {
				rec[k] = v
			}
		}()
		abducted = append(abducted, rec)
	}
	out["abducted"] = abducted

	// the scorer: live geometry on every Score
	scorers := []interface{}{}
	for _, n := range g.Nodes {
		if len(scorers) >= 3 {
			break
		}
		if len(n.Edges) == 0 || n.TopLeft == nil {
			continue
		}
		rec := map[string]interface{}{"id": n.IDValue()}
		for _, oi := range []int{5, 7} {
			sc := placementcost.NewNodeEdgeLengthScorer(n, pcOpts(oi, nil))
			vals := []interface{}{}
			vals = append(vals, pcTry(func() (interface{}, error) { return sc.Score(ctx) }))
			n.Translate(25, -10)
			vals = append(vals, pcTry(func() (interface{}, error) { return sc.Score(ctx) }))
			n.Translate(-25, 10)
			vals = append(vals, pcTry(func() (interface{}, error) { return sc.Score(ctx) }))
			sc.Close()
			vals = append(vals, pcTry(func() (interface{}, error) { return sc.Score(ctx) }))
			rec[fmt.Sprint(oi)] = vals
		}
		scorers = append(scorers, rec)
	}
	out["scorers"] = scorers

	// common uncle siblings (set by node placement only while it runs: no stage graph carries them): three nodes at a time
	prevUncles := g.CommonUncleSiblings
	g.CommonUncleSiblings = map[*layoutgraph.Node]layoutgraph.Nodes{}
	for i := 0; i+2 < len(g.Nodes) && i < 30; i += 3 {
		g.CommonUncleSiblings[g.Nodes[i]] = layoutgraph.Nodes{g.Nodes[i], g.Nodes[i+1], g.Nodes[i+2]}
		g.CommonUncleSiblings[g.Nodes[i+1]] = layoutgraph.Nodes{g.Nodes[i+1], g.Nodes[i+2]}
	}
	g.ResetPlacementCosts()
	uncles := map[string]interface{}{}
	for i := 0; i < 8; i++ {
		i := i
		uncles[pcKey(i)] = pcTry(func() (interface{}, error) { return placementcost.EdgeLength(ctx, g, pcOpts(i, nil)) })
	}
	var uncleNodes []interface{}
	for i := 0; i+2 < len(g.Nodes) && i < 30; i += 3 {
		n := g.Nodes[i]
		uncleNodes = append(uncleNodes, pcTry(func() (interface{}, error) { return placementcost.NodeEdgeLength(ctx, n, pcOpts(5, nil)) }))
		uncleNodes = append(uncleNodes, pcTry(func() (interface{}, error) { return placementcost.NodeEdgeLength(ctx, n, pcOpts(0, nil)) }))
	}
	out["uncles"] = []interface{}{uncles, uncleNodes}
	g.CommonUncleSiblings = prevUncles

	// context polls (the cancellation points): the number of ctx.Err calls of each function and the error when the context fails in the middle
	prev := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(prev)
	var cands []*layoutgraph.Node
	for _, n := range g.Nodes {
		if len(n.Edges) > 0 && len(cands) < 3 {
			cands = append(cands, n)
		}
	}
	type pollFn struct {
		name string
		f    func(ctx context.Context) error
	}
	var fns []pollFn
	for _, n := range cands {
		n := n
		fns = append(fns,
			pollFn{fmt.Sprint("nel5/", n.IDValue()), func(c context.Context) error {
				_, err := placementcost.NodeEdgeLength(c, n, pcOpts(5, nil))
				return err
			}},
			pollFn{fmt.Sprint("nel7/", n.IDValue()), func(c context.Context) error {
				_, err := placementcost.NodeEdgeLength(c, n, pcOpts(7, nil))
				return err
			}},
			pollFn{fmt.Sprint("sym/", n.IDValue()), func(c context.Context) error {
				_, err := placementcost.NodeSymmetry(c, n, nil)
				return err
			}},
			pollFn{fmt.Sprint("ccc/", n.IDValue()), func(c context.Context) error {
				_, err := placementcost.ColumnCrossingCost(c, n, nil)
				return err
			}},
			pollFn{fmt.Sprint("scorer/", n.IDValue()), func(c context.Context) error {
				sc := placementcost.NewNodeEdgeLengthScorer(n, pcOpts(5, nil))
				defer sc.Close()
				if _, err := sc.Score(c); err != nil {
					return err
				}
				_, err := sc.Score(c)
				return err
			}},
		)
	}
	fns = append(fns,
		pollFn{"edgeLength", func(c context.Context) error {
			// a fresh cache: evaluate a graph-state key nobody stored
			g.ResetPlacementCosts()
			_, err := placementcost.EdgeLength(c, g, pcOpts(5, nil))
			return err
		}},
		pollFn{"crossings", func(c context.Context) error { _, err := placementcost.GraphEdgeCrossings(c, g); return err }},
		pollFn{"alignment", func(c context.Context) error { _, err := placementcost.ContainerAlignmentCost(c, g); return err }},
	)
	polls := []interface{}{}
	for _, fn := range fns {
		n := 0
		var err error
		func() {
			defer func() {
				if recover() != nil {
					err = fmt.Errorf("panic")
				}
			}()
			err = fn.f(pcCtx{Context: ctx, n: &n})
		}()
		rec := []interface{}{fn.name, n, errString(err)}
		if n > 1 {
			m := 0
			var err2 error
			func() {
				defer func() {
					if recover() != nil {
						err2 = fmt.Errorf("panic")
					}
				}()
				err2 = fn.f(pcCtx{Context: ctx, n: &m, failAt: n/2 + 1})
			}()
			rec = append(rec, m, errString(err2))
		}
		polls = append(polls, rec)
	}
	out["polls"] = polls
	return out
}

func runPCUnit(in input) interface{} {
	var args struct {
		Pairs [][2]float64 `json:"pairs"`
	}
	if len(in.Args) > 0 {
		json.Unmarshal(in.Args, &args)
	}
	out := map[string]interface{}{}
	var hyp []float64
	for _, p := range args.Pairs {
		hyp = append(hyp, math.Hypot(p[0], p[1]))
	}
	out["hypot"] = hyp
	var workers [][]int
	for n := 0; n <= 40; n++ {
		var row []int
		for p := 0; p <= 8; p++ {
			row = append(row, placementcost.XEdgeLengthWorkerCount(n, p))
		}
		workers = append(workers, row)
	}
	out["workers"] = workers
	var compass [][3]int
	for a := 0; a <= 8; a++ {
		for b := 0; b <= 8; b++ {
			r, d, ax := placementcost.XCompass(geo.Orientation(a), geo.Orientation(b))
			compass = append(compass, [3]int{r, d, ax})
		}
	}
	out["compass"] = compass
	return out
}
