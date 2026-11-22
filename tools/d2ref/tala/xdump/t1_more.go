package main

// Ops of the proximity and trees packages (see t1check.mjs `opsMore` for the JS twins).

import (
	"context"
	"fmt"
	"math/rand"
	"sort"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/grouping"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/proximity"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/trees"
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
	case "trees":
		return t1Trees(ctx, g), true
	case "rebuild":
		return t1Rebuild(ctx, g), true
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

// t1Rebuild: the groups of a laid-out graph are retired by Cleanup and discovered again (the sequences come back with their remembered vessel
// IDs, the clusters are rediscovered from the positions of their nodes), the way a second layout of the same graph does.
func t1Rebuild(ctx context.Context, g *layoutgraph.Graph) interface{} {
	out := []interface{}{}
	step := func(name string, fn func() error) {
		e, p := guarded(fn)
		out = append(out, map[string]interface{}{"step": name, "err": e, "panic": p, "deep": t1Deep(g)})
	}
	step("cleanup", func() error { grouping.Cleanup(g); return nil })
	step("sequences", func() error { return grouping.AddSequences(ctx, g, rand.New(rand.NewSource(1))) })
	step("clusters", func() error { return grouping.AddClusters(ctx, g, 1, rand.New(rand.NewSource(2))) })
	step("cleanup2", func() error { grouping.Cleanup(g); return nil })
	step("reset", func() error { grouping.ResetClusters(g); return nil })
	step("sequences2", func() error { return grouping.AddSequences(ctx, g, rand.New(rand.NewSource(3))) })
	step("clusters2", func() error { return grouping.AddClusters(ctx, g, 4, rand.New(rand.NewSource(5))) })
	return out
}

// guarded runs fn and turns a Go panic into its message.
func guarded(fn func() error) (errMsg interface{}, panicMsg string) {
	defer func() {
		if r := recover(); r != nil {
			panicMsg = fmt.Sprint(r)
		}
	}()
	return errString(fn()), ""
}

// t1Trees: trees.Preprocess on the graph, then trees.Place the way placement calls it: for every container (innermost first, the root level
// last) the children graph with its abducted edges, split into subgraphs (nears and trees traversed), Place on each, and the tree nodes and
// edges copied back into g. The input should be positioned (a later pipeline stage or a layout fixture).
func t1Trees(ctx context.Context, g *layoutgraph.Graph) interface{} {
	out := map[string]interface{}{}
	e, p := guarded(func() error { return trees.Preprocess(ctx, g) })
	out["preprocess"] = map[string]interface{}{"err": e, "panic": p, "deep": t1Deep(g)}
	if e != nil || p != "" {
		return out
	}
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
		childrenGraph := layoutgraph.NewGraph()
		childrenGraph.CopyEntitiesFrom(g)
		for _, c := range children {
			childrenGraph.AddNodeUnchecked(c)
		}
		abductions := g.AbductEdges(root, childrenGraph)
		subgraphs, ownership, err := childrenGraph.SplitSubgraphsTracked(ctx, layoutgraph.SplitOptions{IncludeNears: true, TraverseTrees: true}, nil)
		step := map[string]interface{}{"root": idOrNil(root), "split": errString(err), "places": []interface{}{}}
		if err == nil {
			for _, sub := range subgraphs {
				sub.ComputeCellSize()
				layoutgraph.Nodes(sub.Nodes).SetGraphReference(sub)
				pe, pp := guarded(func() error { return trees.Place(ctx, sub, root) })
				step["places"] = append(step["places"].([]interface{}), map[string]interface{}{"err": pe, "panic": pp, "nodes": len(sub.Nodes)})
				if pe != nil || pp != "" {
					break
				}
				for _, n := range sub.Nodes {
					for _, treeRoot := range g.Trees[n] {
						for _, tree := range append(trees.Descendants(treeRoot), treeRoot) {
							g.AddNodeUnchecked(tree.Node)
							g.AddEdge(tree.SentinelEdge)
						}
					}
				}
				g.Containers[root] = sub.Containers[root]
				for _, other := range subgraphs {
					other.Containers[root] = sub.Containers[root]
				}
			}
			ownership.Restore()
		}
		g.RestoreEdgeAbductions(abductions)
		layoutgraph.Nodes(g.Nodes).SetGraphReference(g)
		steps = append(steps, step)
	}
	out["steps"] = steps
	out["final"] = t1Record(g)
	return out
}
