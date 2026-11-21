package main

import (
	"strings"

	"oss.terrastruct.com/d2/d2compiler"
	"oss.terrastruct.com/d2/d2graph"
)

// graphMethods compiles in.Text and calls d2graph's read-only methods on every object and edge of every board.
func graphMethods(in input) interface{} {
	g, _, err := d2compiler.Compile(in.Path, strings.NewReader(in.Text), &d2compiler.CompileOptions{UTF16Pos: in.UTF16Pos})
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	return map[string]interface{}{"boards": boardMethods(g, g)}
}

func absOrNil(o *d2graph.Object) interface{} {
	if o == nil {
		return nil
	}
	return o.AbsID()
}

func boardMethods(root, g *d2graph.Graph) []interface{} {
	b := map[string]interface{}{"ida": g.IDA(), "texts": g.Texts(), "name": g.Name}
	if g.GetBoard("a") != nil {
		b["hasA"] = true
	}
	var objs []interface{}
	for _, o := range g.Objects {
		m := o.Spacing
		margin, padding := m()
		margin2, padding2 := o.SpacingOpt(3, 4, true)
		objs = append(objs, map[string]interface{}{
			"absID": o.AbsID(), "absIDArray": o.AbsIDArray(), "level": int(o.Level()), "fill": o.GetFill(), "stroke0": o.GetStroke(0.0), "strokeN": o.GetStroke(nil),
			"text": o.Text(), "hasLabel": o.HasLabel(), "hasIcon": o.HasIcon(), "hasOutsideBottomLabel": o.HasOutsideBottomLabel(), "isContainer": o.IsContainer(),
			"isSeq": o.IsSequenceDiagram(), "isGroup": o.IsSequenceDiagramGroup(), "isNote": o.IsSequenceDiagramNote(), "outerSeq": absOrNil(o.OuterSequenceDiagram()),
			"isGrid": o.IsGridDiagram(), "closestGrid": absOrNil(o.ClosestGridDiagram()), "closestCell": absOrNil(o.ClosestGridCell()), "topGrid": absOrNil(o.TopGridDiagram()),
			"outerNear": absOrNil(o.OuterNearContainer()), "isConstNear": o.IsConstantNear(), "isMultiple": o.IsMultiple(), "is3D": o.Is3D(),
			"margin": margin, "padding": padding, "margin2": margin2, "padding2": padding2, "hasEdgeRef": o.IsSequenceDiagramNote(),
			"modifier": []float64{func() float64 { dx, _ := o.GetModifierElementAdjustments(); return dx }(), func() float64 { _, dy := o.GetModifierElementAdjustments(); return dy }()},
			"fillParent": nil,
		})
	}
	b["objects"] = objs
	var edges []interface{}
	for _, e := range g.Edges {
		edges = append(edges, map[string]interface{}{
			"absID": e.AbsID(), "text": e.Text(), "arrow": e.ArrowString(), "group": absOrNil(e.GetGroup()), "stroke0": e.GetStroke(0.0), "strokeN": e.GetStroke(nil),
			"ast": e.GetAstEdge().Range.String(),
		})
	}
	b["edges"] = edges
	out := []interface{}{b}
	for _, l := range g.Layers {
		out = append(out, boardMethods(root, l)...)
	}
	for _, l := range g.Scenarios {
		out = append(out, boardMethods(root, l)...)
	}
	for _, l := range g.Steps {
		out = append(out, boardMethods(root, l)...)
	}
	return out
}
