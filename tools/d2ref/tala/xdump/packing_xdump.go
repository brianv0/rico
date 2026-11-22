package main

// Modes of the packing port check (public/d2/tala/packing.js; JS twin: tools/d2ref/tala/pkgcheck.mjs):
//
//	pkgpack     {graph, args:{deep?, expect?, root?, limits?}}: packing.Pack (BinPack) on the graph. With args.expect the recording of the
//	            pipeline stage is the reference and is returned as it is. Otherwise Go runs Pack on the unmarshalled graph and prints
//	            {err, used, graph}; args.root (a node ID) packs inside that container; args.limits (any non-empty list) adds `limits`,
//	            the same run with work limits used-1, used/2, 1 and 0 on fresh copies (the exhaustion error and the rollback).
//	pkgcombine  {graph, args:{offsets, obstacles, split, dupe}}: packing.CombineSubgraphs of the subgraphs of a positioned graph, each
//	            shifted by offsets[i % len] -> {err, nodes, edges, master}.

import (
	"context"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/limits"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/packing"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/textmeasure"
)

func init() {
	pkgModes["pkgpack"] = runPkgPack
	pkgModes["pkgcombine"] = runPkgCombine
}

func limitList(used int64) []int64 {
	out := []int64{}
	seen := map[int64]bool{}
	for _, l := range []int64{used - 1, used / 2, 1, 0} {
		if l >= 0 && l < used && !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}

func runPkgPack(in input, _ *textmeasure.Ruler) interface{} {
	a := parseArgs(in)
	if len(a.Expect) > 0 {
		return a.Expect
	}
	run := func(limit int64) map[string]interface{} {
		g, err := unmarshalGraph(in)
		if err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		var root *layoutgraph.Node
		if a.Root != "" {
			root = findNode(g, a.Root)
		}
		used, err := packing.XPackLimit(argsCtx(a), g, root, limit)
		return map[string]interface{}{"err": errString(err), "used": used, "graph": serRaw(g)}
	}
	res := run(limits.MaxBinPackWorkUnits)
	if len(a.Limits) > 0 {
		used, _ := res["used"].(int64)
		list := []interface{}{}
		for _, l := range limitList(used) {
			r := run(l)
			r["limit"] = l
			list = append(list, r)
		}
		res["limits"] = list
	}
	return res
}

func runPkgCombine(in input, _ *textmeasure.Ruler) interface{} {
	a := parseArgs(in)
	ctx := context.Background()
	g, err := unmarshalGraph(in)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	if !positioned(g) {
		return map[string]interface{}{"skipped": true}
	}
	opts := layoutgraph.SplitOptions{IncludeContainers: a.Split[0], IncludeNears: a.Split[1], TraverseTrees: a.Split[2]}
	subgraphs, journal, err := g.SplitSubgraphsTracked(ctx, opts, nil)
	if err != nil {
		return map[string]interface{}{"splitErr": err.Error()}
	}
	for i, sg := range subgraphs {
		layoutgraph.Nodes(sg.Nodes).SetGraphReference(sg)
		if len(a.Offsets) > 0 {
			off := a.Offsets[i%len(a.Offsets)]
			for _, n := range sg.Nodes {
				n.MoveWithChildren(off[0], off[1])
			}
			for _, e := range sg.Edges {
				for _, p := range e.Points {
					p.X += off[0]
					p.Y += off[1]
				}
			}
		}
	}
	var obstacles []geo.Box
	for _, o := range a.Obstacles {
		obstacles = append(obstacles, geo.Box{TopLeft: geo.NewPoint(o[0], o[1]), Width: o[2], Height: o[3]})
	}
	arg := subgraphs
	if a.Dupe && len(subgraphs) > 0 {
		arg = append(append([]*layoutgraph.Graph(nil), subgraphs...), subgraphs[0])
	}
	combined, cerr := packing.CombineSubgraphs(ctx, g, arg, obstacles)
	out := map[string]interface{}{"err": errString(cerr), "subgraphs": len(subgraphs)}
	if cerr == nil {
		out["nodes"] = ids(combined.Nodes)
		edgeIDs := []int64{}
		for _, e := range combined.Edges {
			edgeIDs = append(edgeIDs, e.IDValue())
		}
		out["edges"] = edgeIDs
		tl, br := combined.BoundingBox()
		out["bounds"] = []interface{}{p2(tl), p2(br)}
	}
	journal.Restore()
	out["master"] = serRaw(g)
	return out
}
