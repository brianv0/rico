package main

// Modes of the labeling port check (public/d2/tala/labeling.js; JS twin: tools/d2ref/tala/pkgcheck.mjs):
//
//	pkgplace  {graph, args:{deep?, expect?, op?, edges?, limits?}}: label placement. With args.expect the recording of the pipeline stage
//	          (PlaceLabels) is the reference and is returned as it is. Otherwise Go runs on the unmarshalled graph and prints
//	          {err, used, graph}: op "" is labeling.Place, "new" is PlaceNewEdges for the edges g.Edges[args.edges[i]], "init" is
//	          labeling.Initialize (prints the graph and the positionFixed flags), "arrowheads" is PositionArrowheadLabel for both ends of
//	          every edge (prints the boxes). args.limits (non-empty) adds `limits`: the same run with limits used-1, used/2, 1, 0.

import (

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/labeling"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/lib/textmeasure"
)

func init() {
	pkgModes["pkgplace"] = runPkgPlace
}

func runPkgPlace(in input, _ *textmeasure.Ruler) interface{} {
	a := parseArgs(in)
	if len(a.Expect) > 0 {
		return a.Expect
	}
	ctx := argsCtx(a)
	switch a.Op {
	case "init":
		g, err := unmarshalGraph(in)
		if err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		labeling.Initialize(g)
		fixed := []bool{}
		for _, n := range g.Nodes {
			fixed = append(fixed, n.Label != nil && n.Label.PositionFixed(), n.Icon != nil && n.Icon.PositionFixed())
		}
		return map[string]interface{}{"graph": serRaw(g), "fixed": fixed}
	case "arrowheads":
		g, err := unmarshalGraph(in)
		if err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		out := []interface{}{}
		for _, e := range g.Edges {
			for _, isTarget := range []bool{false, true} {
				pal := labeling.PositionArrowheadLabel(e, isTarget, e.Points)
				if pal == nil {
					out = append(out, nil)
					continue
				}
				out = append(out, map[string]interface{}{"x": pal.TopLeft.X, "y": pal.TopLeft.Y, "w": pal.Width, "h": pal.Height, "target": pal.IsTarget, "text": pal.Text})
			}
		}
		return map[string]interface{}{"boxes": out}
	}
	run := func(limit int64) map[string]interface{} {
		g, err := unmarshalGraph(in)
		if err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		var used int64
		if a.Op == "new" {
			var edges []*layoutgraph.Edge
			for _, i := range a.Edges {
				if i >= 0 && i < len(g.Edges) {
					edges = append(edges, g.Edges[i])
				}
			}
			used, err = labeling.XPlaceNewEdgesLimit(ctx, g, edges, limit)
		} else {
			used, err = labeling.XPlaceLimit(ctx, g, limit)
		}
		return map[string]interface{}{"err": errString(err), "used": used, "graph": serRaw(g)}
	}
	res := run(50_000_000)
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
