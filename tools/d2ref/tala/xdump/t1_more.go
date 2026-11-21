package main

// Ops of the proximity and trees packages (see t1check.mjs `opsMore` for the JS twins).

import (
	"context"
	"sort"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/proximity"
)

func t1OpsMore(ctx context.Context, g *layoutgraph.Graph, args t1Args) (interface{}, bool) {
	switch args.Op {
	case "commonUncle":
		common := proximity.CommonUncleSiblings(g)
		list := [][]interface{}{}
		for k, vs := range common {
			list = append(list, []interface{}{k.IDValue(), nodeIDList(vs)})
		}
		sort.Slice(list, func(i, j int) bool { return list[i][0].(int64) < list[j][0].(int64) })
		return map[string]interface{}{"commonUncle": list}, true
	case "hubs":
		err := proximity.AddHubs(ctx, g)
		rec := t1Record(g)
		rec["err"] = errString(err)
		return rec, true
	case "nearsHerds":
		return t1NearsHerds(ctx, g), true
	}
	return nil, false
}

// t1NearsHerds replays the calls of placement.placeNodes that feed proximity.AssignNears and AssignHerds: for every container (innermost
// first) the children graph, the abducted edges of this level, the recursion into child containers, then the two assignments with the
// parent's abductions.
func t1NearsHerds(ctx context.Context, g *layoutgraph.Graph) interface{} {
	steps := []interface{}{}
	var visit func(root *layoutgraph.Node, prev []*layoutgraph.EdgeAbduction)
	visit = func(root *layoutgraph.Node, prev []*layoutgraph.EdgeAbduction) {
		children := append([]*layoutgraph.Node(nil), g.Containers[root]...)
		if len(children) == 0 {
			return
		}
		childrenGraph := layoutgraph.NewGraph()
		childrenGraph.CopyEntitiesFrom(g)
		for _, child := range children {
			childrenGraph.AddNodeUnchecked(child)
		}
		abductions := g.AbductEdges(root, childrenGraph)
		for _, child := range children {
			if child.IsContainer() {
				visit(child, abductions)
				childrenGraph.Containers = g.Containers
			}
		}
		err1 := proximity.AssignNears(ctx, childrenGraph, root, prev)
		err2 := proximity.AssignHerds(ctx, childrenGraph, root, prev)
		steps = append(steps, map[string]interface{}{"root": idOrNil(root), "nears": errString(err1), "herds": errString(err2), "abductions": t1Abductions(g, abductions, edgeIndexOf(g))})
		g.RestoreEdgeAbductions(abductions)
		layoutgraph.Nodes(g.Nodes).SetGraphReference(g)
	}
	visit(nil, nil)
	if positioned(g) {
		proximity.SyncHerdFences(g)
	}
	return map[string]interface{}{"steps": steps, "deep": t1Deep(g)}
}

func edgeIndexOf(g *layoutgraph.Graph) map[*layoutgraph.Edge]int {
	m := map[*layoutgraph.Edge]int{}
	for i, e := range g.Edges {
		m[e] = i
	}
	return m
}
