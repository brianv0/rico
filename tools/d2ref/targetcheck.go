package main

import (
	"encoding/json"

	"oss.terrastruct.com/d2/d2target"
	"oss.terrastruct.com/d2/lib/geo"
)

// targetCheck takes {"diagram": <d2target.Diagram JSON>} (as printed by `layout`), loads it into the Go structs and
// reports re-marshaled JSON, hashes, bounding boxes, corpus and the per-shape / per-connection helpers.
func targetCheck(in input) interface{} {
	var d d2target.Diagram
	if err := json.Unmarshal(in.Diagram, &d); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	out := map[string]interface{}{}
	b, err := d.Bytes()
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	out["bytes"] = string(b)
	h, _ := d.HashID(nil)
	out["hash"] = h
	salt := "salty"
	h2, _ := d.HashID(&salt)
	out["hashSalt"] = h2
	tl, br := d.BoundingBox()
	out["bbox"] = []int{tl.X, tl.Y, br.X, br.Y}
	tl, br = d.NestedBoundingBox()
	out["nbbox"] = []int{tl.X, tl.Y, br.X, br.Y}
	out["corpus"] = d.GetCorpus()
	out["ncorpus"] = d.GetNestedCorpus()
	out["hasHexagon"] = d.HasShape(func(s d2target.Shape) bool { return s.Type == d2target.ShapeHexagon })

	shapes := []interface{}{}
	for _, s := range d.Shapes {
		shapes = append(shapes, map[string]interface{}{"css": s.CSSStyle(), "font": s.GetFontColor(), "z": s.GetZIndex(), "id": s.GetID()})
	}
	out["shapes"] = shapes
	conns := []interface{}{}
	for _, c := range d.Connections {
		e := map[string]interface{}{"css": c.CSSStyle(), "font": c.GetFontColor(), "z": c.GetZIndex(), "id": c.GetID()}
		if len(c.Route) >= 2 {
			if c.Label != "" {
				e["labelTL"] = pt(c.GetLabelTopLeft())
			}
			if c.Icon != nil {
				e["icon"] = pt(c.GetIconPosition())
			}
			if c.SrcLabel != nil {
				e["srcTL"] = pt(c.GetArrowheadLabelPosition(false))
			}
			if c.DstLabel != nil {
				e["dstTL"] = pt(c.GetArrowheadLabelPosition(true))
			}
		}
		conns = append(conns, e)
	}
	out["conns"] = conns
	return out
}

// targetStatics covers the pure helpers that need no diagram: arrowheads, icon sizes, tooltip positions, shape names.
func targetStatics() interface{} {
	out := map[string]interface{}{}
	heads := []d2target.Arrowhead{
		d2target.NoArrowhead, d2target.ArrowArrowhead, d2target.UnfilledTriangleArrowhead, d2target.TriangleArrowhead, d2target.DiamondArrowhead,
		d2target.FilledDiamondArrowhead, d2target.CircleArrowhead, d2target.FilledCircleArrowhead, d2target.CrossArrowhead, d2target.BoxArrowhead,
		d2target.FilledBoxArrowhead, d2target.LineArrowhead, d2target.CfOne, d2target.CfMany, d2target.CfOneRequired, d2target.CfManyRequired, "bogus",
	}
	dims := [][]F{}
	for _, h := range heads {
		for _, sw := range []float64{0, 1, 2, 3, 5.5, 10} {
			w, hh := h.Dimensions(sw)
			dims = append(dims, []F{F(w), F(hh)})
		}
	}
	out["dims"] = dims
	to := []string{}
	t, f := true, false
	for _, name := range []string{"diamond", "circle", "none", "arrow", "triangle", "cross", "box", "cf-one", "cf-many", "cf-one-required", "cf-many-required", "bogus", ""} {
		for _, filled := range []*bool{nil, &t, &f} {
			to = append(to, string(d2target.ToArrowhead(name, filled)))
		}
	}
	out["toArrowhead"] = to
	sizes := []int{}
	for _, pos := range []string{"", "INSIDE_MIDDLE_CENTER", "INSIDE_TOP_LEFT", "OUTSIDE_TOP_LEFT", "BORDER_LEFT_TOP", "bogus"} {
		for _, wh := range [][2]float64{{10, 10}, {40, 40}, {100, 30}, {500, 500}, {64, 200}, {7.9, 100}} {
			sizes = append(sizes, d2target.GetIconSize(geo.NewBox(geo.NewPoint(0, 0), wh[0], wh[1]), pos))
		}
	}
	out["iconSizes"] = sizes
	tips := [][]F{}
	for _, pos := range []string{"top-left", "top-center", "top-right", "center-left", "center-right", "bottom-left", "bottom-center", "bottom-right", "", "x"} {
		x, y := d2target.CalculateTooltipPosition(10, 20, 100.5, 40, 80, 33, pos)
		tips = append(tips, []F{F(x), F(y)})
	}
	out["tooltipPos"] = tips
	names := []bool{}
	for _, n := range []string{"", "Rectangle", "SQUARE", "sql_table", "nope", "C4-Person", "Hierarchy"} {
		names = append(names, d2target.IsShape(n))
	}
	out["isShape"] = names
	setTypes := []string{}
	for _, n := range []string{"Circle", "SQUARE", "Rectangle", "Hexagon", "", "CLASS"} {
		var s d2target.Shape
		s.SetType(n)
		setTypes = append(setTypes, s.Type)
	}
	out["setType"] = setTypes
	dsl := map[string]string{}
	for k, v := range d2target.SHAPE_TYPE_TO_DSL_SHAPE {
		dsl[k] = v
	}
	out["shapeTypeToDSL"] = dsl
	zeroS, _ := json.Marshal(d2target.Shape{})
	zeroC, _ := json.Marshal(d2target.Connection{})
	zeroD, _ := json.Marshal(d2target.Diagram{})
	baseS, _ := json.Marshal(d2target.BaseShape())
	baseC, _ := json.Marshal(d2target.BaseConnection())
	newD, _ := json.Marshal(d2target.NewDiagram())
	out["zeroShape"] = string(zeroS)
	out["zeroConnection"] = string(zeroC)
	out["zeroDiagram"] = string(zeroD)
	out["baseShape"] = string(baseS)
	out["baseConnection"] = string(baseC)
	out["newDiagram"] = string(newD)
	return out
}
