package main

// t1ops: direct calls of the exported functions of the T1 packages (loops, grouping, proximity, trees) on a graphjson graph.
// Input {"graph": <graphjson>, "args": {"op": ..., ...}}; the JS twin is `opsT1Stage` in tools/d2ref/tala/t1check.mjs.

import (
	"context"
	"fmt"
	"math/rand"
	"sort"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/grouping"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/loops"
	"github.com/d2lang/d2/lib/geo"
)

func runT1Ops(in input, args t1Args) (res interface{}) {
	if args.Op == "slices" {
		return t1Slices(in)
	}
	ctx := context.Background()
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, in.Graph, g); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	defer func() {
		if r := recover(); r != nil {
			res = map[string]interface{}{"panic": fmt.Sprint(r)}
		}
	}()
	switch args.Op {
	case "loops":
		return t1Loops(ctx, in, g)
	case "resetClusters":
		grouping.ResetClusters(g)
		return t1Record(g)
	case "seqEdges":
		ids, err := grouping.SequenceDefiningEdges(ctx, g)
		list := []int64{}
		for id := range ids {
			list = append(list, int64(id))
		}
		sort.Slice(list, func(i, j int) bool { return list[i] < list[j] })
		return map[string]interface{}{"ids": list, "err": errString(err)}
	case "cluster":
		return t1Cluster(g)
	case "join":
		return t1Join(ctx, g)
	}
	if r, ok := t1OpsMore(ctx, g, args); ok {
		return r
	}
	return map[string]interface{}{"panic": "unknown t1 op " + args.Op}
}

func t1Loops(ctx context.Context, in input, g *layoutgraph.Graph) interface{} {
	out := map[string]interface{}{}
	// 1. Route every node's loops (a node without a position is routed at the origin, as UpdateOffsets does)
	for _, n := range g.Nodes {
		nilTL := n.TopLeft == nil
		if nilTL {
			n.TopLeft = geo.NewPoint(0, 0)
		}
		loops.Route(n)
		if nilTL {
			n.TopLeft = nil
		}
	}
	out["route"] = t1Deep(g)
	// 2. ComputeOffsets
	loops.ComputeOffsets(g)
	out["offsets"] = t1Deep(g)
	// 3. UpdateOffsets one node at a time on a fresh copy without positions
	g2 := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, in.Graph, g2); err == nil {
		for _, n := range g2.Nodes {
			n.TopLeft = nil
		}
		for _, n := range g2.Nodes {
			loops.UpdateOffsets(n)
		}
		out["nilTL"] = t1Deep(g2)
	}
	return out
}

func t1Cluster(g *layoutgraph.Graph) interface{} {
	out := []interface{}{}
	allPositioned := func(c *layoutgraph.Cluster) bool {
		for _, n := range c.Nodes {
			if n.TopLeft == nil {
				return false
			}
		}
		return true
	}
	for _, v := range g.ClusterOrder() {
		c := g.Clusters[v]
		rec := map[string]interface{}{"vessel": v.IDValue()}
		rec["padding"] = grouping.PaddingBetween(c, false)
		if allPositioned(c) && len(c.Nodes) > 1 {
			rec["paddingPositions"] = grouping.PaddingBetween(c, true)
		}
		arr := []interface{}{}
		for _, seq := range []bool{false, true} {
			for _, seed := range []int64{1, 2, 3} {
				r := rand.New(rand.NewSource(seed))
				a := grouping.AssignArrangement(c, seq, r)
				arr = append(arr, []interface{}{string(a), r.Float64()})
			}
		}
		rec["arrangements"] = arr
		out = append(out, rec)
	}
	return out
}

// t1Join calls JoinDistancedClusters the way placement does: on the children graph of every container (innermost first, the root level last).
func t1Join(ctx context.Context, g *layoutgraph.Graph) interface{} {
	steps := []interface{}{}
	roots := append(g.ContainerRDFSOrderUnbounded(nil), nil)
	for _, root := range roots {
		children := append([]*layoutgraph.Node(nil), g.Containers[root]...)
		if len(children) == 0 {
			continue
		}
		ok := true
		for _, c := range children {
			if c.TopLeft == nil {
				ok = false
			}
		}
		if !ok {
			continue
		}
		sub := layoutgraph.NewGraph()
		sub.CopyEntitiesFrom(g)
		for _, c := range children {
			sub.AddNodeUnchecked(c)
		}
		abductions := g.AbductEdges(root, sub)
		sub.ComputeCellSize()
		var err error
		panicked := ""
		func() {
			defer func() {
				if r := recover(); r != nil {
					panicked = fmt.Sprint(r)
				}
			}()
			err = grouping.JoinDistancedClusters(ctx, sub)
		}()
		steps = append(steps, map[string]interface{}{"root": idOrNil(root), "err": errString(err), "panic": panicked})
		g.RestoreEdgeAbductions(abductions)
		layoutgraph.Nodes(g.Nodes).SetGraphReference(g)
	}
	layoutgraph.Nodes(g.Nodes).SetGraphReference(g)
	return map[string]interface{}{"steps": steps, "deep": t1Deep(g)}
}
