package main

import (
	"strings"

	"github.com/d2lang/d2/d2compiler"
	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/lib/textmeasure"
)

// dimsCheck compiles in.Text, applies the default theme and calls SetDimensions on every board, printing what it set:
// object sizes, label dimensions and label/icon positions, edge label dimensions (the stage before any layout).
func dimsCheck(in input, ruler *textmeasure.Ruler) interface{} {
	g, _, err := d2compiler.Compile(in.Path, strings.NewReader(in.Text), &d2compiler.CompileOptions{UTF16Pos: in.UTF16Pos})
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	boards, err := dimsBoards(g, ruler)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	return map[string]interface{}{"boards": boards}
}

func dimsBoards(g *d2graph.Graph, ruler *textmeasure.Ruler) ([]interface{}, error) {
	if err := g.ApplyTheme(0); err != nil {
		return nil, err
	}
	if len(g.Objects) > 0 {
		if err := g.SetDimensions(nil, ruler, nil, nil); err != nil {
			return nil, err
		}
	}
	var objs, edges []interface{}
	for _, o := range g.Objects {
		objs = append(objs, map[string]interface{}{
			"id": o.AbsID(), "w": o.Width, "h": o.Height, "label": o.Label.Value, "labelDims": o.LabelDimensions,
			"labelPosition": o.LabelPosition, "iconPosition": o.IconPosition, "car": o.ContentAspectRatio,
		})
	}
	for _, e := range g.Edges {
		edges = append(edges, map[string]interface{}{"id": e.AbsID(), "label": e.Label.Value, "labelDims": e.LabelDimensions,
			"src": e.SrcArrowhead != nil && e.SrcArrowhead.Label.Value != "", "srcDims": srcDims(e.SrcArrowhead), "dstDims": srcDims(e.DstArrowhead)})
	}
	out := []interface{}{map[string]interface{}{"name": g.Name, "objects": objs, "edges": edges}}
	for _, l := range append(append(append([]*d2graph.Graph{}, g.Layers...), g.Scenarios...), g.Steps...) {
		sub, err := dimsBoards(l, ruler)
		if err != nil {
			return nil, err
		}
		out = append(out, sub...)
	}
	return out, nil
}

func srcDims(a *d2graph.Attributes) interface{} {
	if a == nil {
		return nil
	}
	return a.LabelDimensions
}
