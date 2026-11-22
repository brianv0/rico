package main

import (
	"encoding/json"

	rough "github.com/d2lang/rough-go"
)

// roughcheck runs one rough-go generator call the way d2sketch makes it and prints ToPaths of the drawable (every path's d, stroke,
// strokeWidth as JS prints it, fill). Input (field "rough"): {kind: line|rectangle|ellipse|circle|linearPath|polygon|path,
// args: [numbers], pts: [[x, y]...], path: "M...", opts: Options as rough-go's JSON}. Used by roughcmp.mjs, which records the calls
// the JS d2sketch makes into roughjs and compares both engines on them.
type roughCall struct {
	Kind string         `json:"kind"`
	Args []float64      `json:"args"`
	Pts  [][]float64    `json:"pts"`
	Path string         `json:"path"`
	Opts *rough.Options `json:"opts"`
	Gen  *rough.Options `json:"gen"`
}

func roughCheck(in input) interface{} {
	var c roughCall
	if err := json.Unmarshal(in.Rough, &c); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	g := rough.NewGenerator(&rough.Config{Options: c.Gen})
	var d rough.Drawable
	pts := make([]rough.Point, len(c.Pts))
	for i, p := range c.Pts {
		pts[i] = rough.Point{p[0], p[1]}
	}
	switch c.Kind {
	case "line":
		d = g.Line(c.Args[0], c.Args[1], c.Args[2], c.Args[3], c.Opts)
	case "rectangle":
		d = g.Rectangle(c.Args[0], c.Args[1], c.Args[2], c.Args[3], c.Opts)
	case "ellipse":
		d = g.Ellipse(c.Args[0], c.Args[1], c.Args[2], c.Args[3], c.Opts)
	case "circle":
		d = g.Circle(c.Args[0], c.Args[1], c.Args[2], c.Opts)
	case "linearPath":
		d = g.LinearPath(pts, c.Opts)
	case "polygon":
		d = g.Polygon(pts, c.Opts)
	case "path":
		d = g.Path(c.Path, c.Opts)
	default:
		return map[string]interface{}{"err": "unknown kind " + c.Kind}
	}
	paths := []map[string]string{}
	for _, p := range g.ToPaths(d) {
		paths = append(paths, map[string]string{"d": p.D, "stroke": p.Stroke, "strokeWidth": rough.NumberString(p.StrokeWidth), "fill": p.Fill})
	}
	return map[string]interface{}{"paths": paths}
}
