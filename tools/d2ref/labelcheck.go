package main

import (
	"oss.terrastruct.com/d2/lib/geo"
	"oss.terrastruct.com/d2/lib/label"
)

// labelCheck exercises lib/label for every Position over one box (Width x Height at 10,20) and, if given, one route.
func labelCheck(in input) interface{} {
	box := geo.NewBox(geo.NewPoint(10, 20), in.Width, in.Height)
	var route geo.Route
	for _, p := range in.Route {
		route = append(route, geo.NewPoint(p[0], p[1]))
	}
	out := []interface{}{}
	for p := label.Unset; p <= label.UnlockedBottom+1; p++ {
		e := map[string]interface{}{
			"s":        p.String(),
			"from":     label.FromString(p.String()),
			"shape":    p.IsShapePosition(),
			"edge":     p.IsEdgePosition(),
			"outside":  p.IsOutside(),
			"unlocked": p.IsUnlocked(),
			"border":   p.IsBorder(),
			"onEdge":   p.IsOnEdge(),
			"mirror":   p.Mirrored(),
			"onBox":    pt(p.GetPointOnBox(box, label.PADDING, 33, 17)),
			"onBox2":   pt(p.GetPointOnBox(box, 0, 50.5, 12.25)),
		}
		if len(route) >= 2 {
			pnt, idx := p.GetPointOnRoute(route, in.Stroke, in.Pct, 40, 18)
			e["onRoute"] = pt(pnt)
			e["routeIdx"] = idx
		}
		out = append(out, e)
	}
	return out
}
