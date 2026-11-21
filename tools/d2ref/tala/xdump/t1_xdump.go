package main

// T1 modes (the packages loops, grouping, proximity, trees): the Go side of tools/d2ref/tala/t1check.mjs.
//
//	t1stages  {text|graph, seeds?, args?: {stages: [indexes]}}  the pipeline up to stage 20 for each seed, and after each recorded stage
//	          the graph (graphjson) plus the deep state graphjson does not carry (`t1Deep`: margins, paddings, loop offsets, herd
//	          assignments, nears, long-distance requirements, cluster/sequence/tree records, edge abductions, containers, commonUncleSiblings).
//	          D2 text: one run per layout invocation and seed; graph: the fixture with the given seeds (default 123).
//	t1ops     {graph, args: {op, ...}}  direct calls of the exported functions of the T1 packages on a graphjson graph (ops in t1_ops.go)
//
// The JS twin of the deep dump is `deepState` in t1check.mjs: keep both in step.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"reflect"
	"sort"
	"unsafe"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/memfs"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

func idOrNil(n *layoutgraph.Node) interface{} {
	if n == nil {
		return nil
	}
	return n.IDValue()
}

func unexportedField(ptr interface{}, name string) reflect.Value {
	f := reflect.ValueOf(ptr).Elem().FieldByName(name)
	return reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem()
}

func sortedNodeIDs(v reflect.Value) []int64 {
	out := []int64{}
	for _, k := range v.MapKeys() {
		out = append(out, k.Interface().(*layoutgraph.Node).IDValue())
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func orientationInt(o geo.Orientation) int { return int(o) }

// t1Nodes lists every node reachable from the graph's records, once, sorted by ID.
func t1Nodes(g *layoutgraph.Graph) []*layoutgraph.Node {
	seen := map[*layoutgraph.Node]bool{}
	var out []*layoutgraph.Node
	add := func(n *layoutgraph.Node) {
		if n != nil && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	for _, n := range g.Nodes {
		add(n)
	}
	for _, v := range g.ClusterOrder() {
		add(v)
		c := g.Clusters[v]
		for _, n := range c.Nodes {
			add(n)
		}
		add(c.Container)
	}
	for _, v := range g.SequenceOrder() {
		add(v)
		s := g.Sequences[v]
		for _, n := range s.Nodes {
			add(n)
		}
		add(s.Container)
	}
	var walk func(t *layoutgraph.Tree)
	walk = func(t *layoutgraph.Tree) {
		if t == nil {
			return
		}
		add(t.Node)
		for _, c := range t.Children {
			walk(c)
		}
	}
	for _, s := range g.TreeOrder() {
		add(s)
		for _, r := range g.Trees[s] {
			walk(r)
		}
	}
	for k, vs := range g.Containers {
		add(k)
		for _, v := range vs {
			add(v)
		}
	}
	for k, vs := range g.Hubs {
		add(k)
		for _, v := range vs {
			add(v)
		}
	}
	for i := 0; i < len(out); i++ {
		n := out[i]
		add(n.Container)
		for near := range n.Nears {
			add(near)
		}
		if n.Cluster != nil {
			add(n.Cluster.Vessel)
		}
		if n.Sequence != nil {
			add(n.Sequence.Vessel)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].IDValue() < out[j].IDValue() })
	return out
}

func t1Abductions(g *layoutgraph.Graph, as []*layoutgraph.EdgeAbduction, edgeIdx map[*layoutgraph.Edge]int) interface{} {
	out := []interface{}{}
	for _, a := range as {
		if a == nil {
			out = append(out, nil)
			continue
		}
		ei := -1
		if i, ok := edgeIdx[a.Edge]; ok {
			ei = i
		}
		out = append(out, []interface{}{ei, idOrNil(a.OriginallyFrom), idOrNil(a.OriginallyTo), idOrNil(a.CurrentFrom), idOrNil(a.CurrentTo)})
	}
	return out
}

func t1TreeRec(t *layoutgraph.Tree, edgeIdx map[*layoutgraph.Edge]int) interface{} {
	if t == nil {
		return nil
	}
	ei := -1
	if i, ok := edgeIdx[t.SentinelEdge]; ok {
		ei = i
	}
	children := []interface{}{}
	for _, c := range t.Children {
		children = append(children, t1TreeRec(c, edgeIdx))
	}
	var parent interface{}
	if t.Parent != nil {
		parent = idOrNil(t.Parent.Node)
	}
	return map[string]interface{}{"node": idOrNil(t.Node), "o": orientationInt(t.Orientation), "edge": ei, "parent": parent, "children": children}
}

// t1Deep is the state of the graph that graphjson does not serialize (and a few orderings it does not pin down).
func t1Deep(g *layoutgraph.Graph) interface{} {
	edgeIdx := map[*layoutgraph.Edge]int{}
	for i, e := range g.Edges {
		edgeIdx[e] = i
	}
	nodes := []interface{}{}
	for _, n := range t1Nodes(g) {
		rec := map[string]interface{}{"id": n.IDValue()}
		m := unexportedField(n, "margin").Interface().(layoutgraph.Spacing)
		p := unexportedField(n, "padding").Interface().(layoutgraph.Spacing)
		rec["margin"] = []float64{m.Top(), m.Bottom(), m.Left(), m.Right()}
		rec["padding"] = []float64{p.Top(), p.Bottom(), p.Left(), p.Right()}
		loop := [][2]float64{}
		for o, v := range n.LoopOffsets {
			loop = append(loop, [2]float64{float64(o), v})
		}
		sort.Slice(loop, func(i, j int) bool { return loop[i][0] < loop[j][0] })
		rec["loop"] = loop
		if n.HerdAssignment != nil {
			h := n.HerdAssignment
			rec["herd"] = map[string]interface{}{
				"o": orientationInt(h.Orientation), "val": h.Val,
				"opp":  sortedNodeIDs(unexportedField(h, "oppositeSidePaired")),
				"same": sortedNodeIDs(unexportedField(h, "sameSidePaired")),
			}
		} else {
			rec["herd"] = nil
		}
		nears := []int64{}
		for near := range n.Nears {
			nears = append(nears, near.IDValue())
		}
		sort.Slice(nears, func(i, j int) bool { return nears[i] < nears[j] })
		rec["nears"] = nears
		ldn := [][]interface{}{}
		for other, r := range n.LongDistanceNeighborRequirements {
			ldn = append(ldn, []interface{}{other.IDValue(), r.EdgeCount, r.MaxWidth, r.MaxHeight})
		}
		sort.Slice(ldn, func(i, j int) bool { return ldn[i][0].(int64) < ldn[j][0].(int64) })
		rec["ldn"] = ldn
		rec["inGraph"] = n.Graph != nil
		rec["container"] = idOrNil(n.Container)
		if n.Cluster != nil {
			rec["cluster"] = idOrNil(n.Cluster.Vessel)
		} else {
			rec["cluster"] = nil
		}
		if n.Sequence != nil {
			rec["sequence"] = idOrNil(n.Sequence.Vessel)
		} else {
			rec["sequence"] = nil
		}
		if n.FixedTopLeft != nil {
			rec["fixed"] = pt{n.FixedTopLeft.X, n.FixedTopLeft.Y}
		} else {
			rec["fixed"] = nil
		}
		if n.TopLeft != nil {
			rec["tl"] = pt{n.TopLeft.X, n.TopLeft.Y}
		} else {
			rec["tl"] = nil
		}
		rec["w"], rec["h"] = n.Width, n.Height
		rec["isContainer"] = n.IsContainer()
		rec["isVessel"] = n.IsClusterVessel()
		es := []int{}
		for _, e := range n.Edges {
			if i, ok := edgeIdx[e]; ok {
				es = append(es, i)
			} else {
				es = append(es, -1)
			}
		}
		rec["edges"] = es
		nodes = append(nodes, rec)
	}
	clusters := []interface{}{}
	for _, v := range g.ClusterOrder() {
		c := g.Clusters[v]
		clusters = append(clusters, map[string]interface{}{
			"vessel": idOrNil(c.Vessel), "nodes": nodeIDList(c.Nodes), "arr": string(c.Arrangement), "desired": string(c.DesiredArrangement),
			"padding": c.Padding, "fixed": c.FixedSize, "container": idOrNil(c.Container), "graphSet": c.Graph != nil, "abd": t1Abductions(g, c.EdgeAbductions, edgeIdx),
		})
	}
	sequences := []interface{}{}
	for _, v := range g.SequenceOrder() {
		s := g.Sequences[v]
		sequences = append(sequences, map[string]interface{}{
			"vessel": idOrNil(s.Vessel), "nodes": nodeIDList(s.Nodes), "container": idOrNil(s.Container), "graphSet": s.Graph != nil, "abd": t1Abductions(g, s.EdgeAbductions, edgeIdx),
		})
	}
	trees := []interface{}{}
	for _, s := range g.TreeOrder() {
		roots := []interface{}{}
		for _, r := range g.Trees[s] {
			roots = append(roots, t1TreeRec(r, edgeIdx))
		}
		trees = append(trees, map[string]interface{}{"sentinel": idOrNil(s), "roots": roots})
	}
	n2t := [][]interface{}{}
	for n, t := range g.NodeToTree {
		var parent interface{}
		if t.Parent != nil {
			parent = idOrNil(t.Parent.Node)
		}
		n2t = append(n2t, []interface{}{n.IDValue(), idOrNil(t.Node), parent})
	}
	sort.Slice(n2t, func(i, j int) bool { return n2t[i][0].(int64) < n2t[j][0].(int64) })
	hubs := [][]interface{}{}
	for _, k := range g.HubOrder() {
		hubs = append(hubs, []interface{}{k.IDValue(), nodeIDList(g.Hubs[k])})
	}
	dirs := [][]interface{}{}
	for k, o := range g.Directions {
		dirs = append(dirs, []interface{}{idOrNil(k), orientationInt(o)})
	}
	sort.Slice(dirs, func(i, j int) bool { return keyOf(dirs[i][0]) < keyOf(dirs[j][0]) })
	conts := [][]interface{}{}
	for k, vs := range g.Containers {
		conts = append(conts, []interface{}{idOrNil(k), nodeIDList(vs)})
	}
	sort.Slice(conts, func(i, j int) bool { return keyOf(conts[i][0]) < keyOf(conts[j][0]) })
	var cu interface{}
	if g.CommonUncleSiblings != nil {
		list := [][]interface{}{}
		for k, vs := range g.CommonUncleSiblings {
			list = append(list, []interface{}{k.IDValue(), nodeIDList(vs)})
		}
		sort.Slice(list, func(i, j int) bool { return list[i][0].(int64) < list[j][0].(int64) })
		cu = list
	}
	edges := []interface{}{}
	for _, e := range g.Edges {
		er := map[string]interface{}{"from": idOrNil(e.From), "to": idOrNil(e.To)}
		pts := []interface{}{}
		for _, p := range e.Points {
			pts = append(pts, p2(p))
		}
		er["points"] = pts
		if e.Label != nil {
			er["label"] = []interface{}{int(e.Label.Position), e.Label.Width, e.Label.Height, e.Label.PositionFixed()}
		} else {
			er["label"] = nil
		}
		er["pct"] = e.LabelPercentage
		er["curve"] = e.IsCurve
		edges = append(edges, er)
	}
	return map[string]interface{}{
		"nodes": nodes, "clusters": clusters, "sequences": sequences, "trees": trees, "nodeToTree": n2t, "hubs": hubs, "directions": dirs,
		"containers": conts, "commonUncle": cu, "cellSize": g.CellSize, "edges": edges, "isRootHierarchy": g.IsRootHierarchy,
	}
}

// keyOf orders nil (the root container) before every node ID.
func keyOf(v interface{}) int64 {
	if v == nil {
		return -1 << 62
	}
	return v.(int64)
}

func nodeIDList(ns []*layoutgraph.Node) []interface{} {
	out := []interface{}{}
	for _, n := range ns {
		out = append(out, idOrNil(n))
	}
	return out
}

// t1Record is graphjson + deep state of a graph.
func t1Record(g *layoutgraph.Graph) map[string]interface{} {
	return map[string]interface{}{"graph": ser(g), "deep": t1Deep(g)}
}

type t1Args struct {
	Stages []int  `json:"stages"`
	Op     string `json:"op"`
	// op arguments
	Roots   []int64 `json:"roots"`
	Seed    int64   `json:"seed"`
	Variant string  `json:"variant"`
}

var errT1Stop = errors.New("t1 stop")

func t1Want(args t1Args) map[int]bool {
	want := map[int]bool{}
	if len(args.Stages) == 0 {
		for _, i := range []int{-1, 0, 1, 2, 3, 4, 5, 6, 7, 18, 19} {
			want[i] = true
		}
		return want
	}
	for _, i := range args.Stages {
		want[i] = true
	}
	return want
}

// t1Run runs the pipeline of one seed on tg (a graph that is cloned), stopping after the last wanted stage.
func t1Run(ctx context.Context, tg *layoutgraph.Graph, seed int64, want map[int]bool) map[string]interface{} {
	last := -1
	for i := range want {
		if i > last {
			last = i
		}
	}
	var stages []interface{}
	run := map[string]interface{}{"seed": seed}
	func() {
		defer func() {
			if r := recover(); r != nil {
				run["panic"] = fmt.Sprint(r)
			}
		}()
		_, err := engine.XLayoutObserved(ctx, tg, engine.LayoutOptions{Seed: seed}, func(index int, name string, g *layoutgraph.Graph) error {
			if want[index] {
				rec := t1Record(g)
				rec["index"], rec["name"] = index, name
				stages = append(stages, rec)
			}
			if index >= last {
				return errT1Stop
			}
			return nil
		})
		if err != nil && !errors.Is(err, errT1Stop) {
			run["err"] = err.Error()
		}
	}()
	run["stages"] = stages
	return run
}

func runT1(mode string, in input, ruler *textmeasure.Ruler) interface{} {
	var args t1Args
	if len(in.Args) > 0 {
		json.Unmarshal(in.Args, &args)
	}
	if mode == "t1ops" {
		return runT1Ops(in, args)
	}
	ctx := context.Background()
	if in.Graph != nil {
		g := layoutgraph.NewGraph()
		if err := graphjson.Unmarshal(ctx, in.Graph, g); err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		seeds := in.Seeds
		if len(seeds) == 0 {
			seeds = []int64{123}
		}
		runs := []interface{}{}
		for _, s := range seeds {
			runs = append(runs, t1Run(ctx, g, s, t1Want(args)))
		}
		return map[string]interface{}{"runs": runs}
	}
	// D2 text
	var fsys fs.FS
	if in.FS != nil {
		files := map[string]string{in.Path: in.Text}
		for k, v := range in.FS {
			files[k] = v
		}
		fsys, _ = memfs.New(files)
	}
	dctx := log.WithDefault(context.Background())
	seeds := in.Seeds
	if len(seeds) == 0 {
		seeds = []int64{1}
	}
	runs := []interface{}{}
	invocation := 0
	layoutFn := func(c context.Context, g *d2graph.Graph) error {
		tg, err := d2talalayout.XDumpTranslate(c, g)
		if err != nil {
			runs = append(runs, map[string]interface{}{"inv": invocation, "err": err.Error()})
		} else {
			for _, s := range seeds {
				r := t1Run(c, tg, s, t1Want(args))
				r["inv"] = invocation
				runs = append(runs, r)
			}
		}
		invocation++
		for _, o := range g.Objects {
			o.TopLeft = nil
			if o.Box != nil {
				o.TopLeft = geo.NewPoint(0, 0)
			}
		}
		for _, e := range g.Edges {
			e.Route = []*geo.Point{geo.NewPoint(0, 0), geo.NewPoint(1, 0)}
		}
		return nil
	}
	copts := &d2lib.CompileOptions{
		UTF16Pos: in.UTF16Pos, FS: fsys, Ruler: ruler, InputPath: in.Path, Layout: go2.Pointer("tala"),
		LayoutResolver: func(engine string) (d2graph.LayoutGraph, error) { return layoutFn, nil },
		RouterResolver: func(engine string) (d2graph.RouteEdges, error) {
			return func(ctx context.Context, g *d2graph.Graph, edges []*d2graph.Edge) error { return nil }, nil
		},
	}
	ro := &d2svg.RenderOpts{ThemeID: in.ThemeID}
	_, _, err := d2lib.Compile(dctx, in.Text, copts, ro)
	return map[string]interface{}{"runs": runs, "err": errString(err)}
}
