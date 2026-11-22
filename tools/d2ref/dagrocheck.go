package main

import (
	"encoding/json"

	"github.com/d2lang/dagro"
)

// dagrocheck runs dagro (the native Go dagre D2 v0.9.0 calls) on a graph description captured from the JS glue
// (see dagrocmp.mjs): {graph: {ranksep, edgesep, nodesep, rankdir}, nodes: [{id, width, height, parent?}], edges: [{v, w, name, width, height}]}
// and prints the layout: every node's x, y, width, height and every edge's points, in the order dagro returns them.
type dagroNode struct {
	ID     string  `json:"id"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Parent string  `json:"parent"`
}

type dagroEdge struct {
	V      string  `json:"v"`
	W      string  `json:"w"`
	Name   string  `json:"name"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type dagroGraph struct {
	Ranksep float64     `json:"ranksep"`
	Edgesep float64     `json:"edgesep"`
	Nodesep float64     `json:"nodesep"`
	Rankdir string      `json:"rankdir"`
	Nodes   []dagroNode `json:"nodes"`
	Edges   []dagroEdge `json:"edges"`
}

func dagroCheck(in input) interface{} {
	var gd dagroGraph
	if err := json.Unmarshal(in.Diagram, &gd); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	g := dagro.NewGraph(dagro.GraphOptions{Compound: true, Multigraph: true}).SetGraph(dagro.Attrs{
		"ranksep": gd.Ranksep, "edgesep": gd.Edgesep, "nodesep": gd.Nodesep, "rankdir": gd.Rankdir,
	})
	for _, n := range gd.Nodes {
		g.SetNode(n.ID, dagro.Attrs{"id": n.ID, "width": n.Width, "height": n.Height})
		if n.Parent != "" {
			if err := g.SetParent(n.ID, n.Parent); err != nil {
				return map[string]interface{}{"err": err.Error()}
			}
		}
	}
	for _, e := range gd.Edges {
		g.SetEdge(e.V, e.W, dagro.Attrs{"width": e.Width, "height": e.Height, "labelpos": "c"}, e.Name)
	}
	if err := dagro.Layout(g); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	var nodes, edges []interface{}
	for _, id := range g.Nodes() {
		a := g.Node(id).(dagro.Attrs)
		nodes = append(nodes, map[string]interface{}{"id": id, "x": a["x"], "y": a["y"], "width": a["width"], "height": a["height"]})
	}
	for _, e := range g.Edges() {
		a := g.Edge(e).(dagro.Attrs)
		var pts [][]float64
		for _, p := range a["points"].([]dagro.Point) {
			pts = append(pts, []float64{p.X, p.Y})
		}
		edges = append(edges, map[string]interface{}{"v": e.V, "w": e.W, "name": e.Name, "points": pts, "x": a["x"], "y": a["y"]})
	}
	return map[string]interface{}{"nodes": nodes, "edges": edges}
}
