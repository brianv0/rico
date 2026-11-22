package main

// Modes of the hierarchy and placementcost checks (docs/d2-tala-port.md, "hierarchy" and "placementcost"). main.go dispatches every
// mode of hierModes here. Identifiers of this file and placementcost_xdump.go start with hier/pc so that they cannot collide with
// the files of the other packages' checks.
//
//	hiergen        D2 text -> {"records": [{inv, seed, index, name, graph, deep}]}: the graph (and its deep state) after the pipeline
//	               stages listed in "args": {"stages": [..], "seeds": [..], "deep": true}. The generator of the stage cases
//	hierrank       {"args": {"nodes": [ids], "edges": [{id, from, to, weight}], "limits": [..]}} -> rankDAG on that DAG (pure function)
//	hiersimple     graph -> makeSimpleDAG and build (force false/true) on any graph: {"dag", "build"}
//	hierstage      graph (+ "args": {deep, golden}, "seeds": [seed], "op": assign|all|place) -> Candidates, Assign, Place,
//	               RemoveIsolatedMemberships (the body of the PreprocessHierarchies stage) on the graph
//	hiercompound   graph -> layoutgraph.Clone + PlaceCompound (what engine.CompoundCandidate does) with rand seed 0

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"math/rand"
	"reflect"
	"sort"
	"unsafe"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/hierarchy"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/limits"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/memfs"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

// hierModes is the registry of the modes of this file and placementcost_xdump.go (main.go's run() consults it first).
var hierModes = map[string]func(input, *textmeasure.Ruler) interface{}{}

func init() {
	hierModes["hiergen"] = runHierGen
	hierModes["hierrank"] = func(in input, _ *textmeasure.Ruler) interface{} { return runHierRank(in) }
	hierModes["hiersimple"] = func(in input, _ *textmeasure.Ruler) interface{} { return runHierSimple(in) }
	hierModes["hierstage"] = func(in input, _ *textmeasure.Ruler) interface{} { return runHierStage(in) }
	hierModes["hiercompound"] = func(in input, _ *textmeasure.Ruler) interface{} { return runHierCompound(in) }
}

// ---- deep state: what graphjson does not carry (margins, paddings, loop offsets, herd assignments, long distance neighbor
// requirements, common uncle siblings), read and written by reflection because the fields are unexported ----

type hierDeepNode struct {
	ID          int64              `json:"id"`
	Margin      *[4]float64        `json:"margin,omitempty"`  // top, bottom, left, right
	Padding     *[4]float64        `json:"padding,omitempty"` // top, bottom, left, right
	LoopOffsets map[string]float64 `json:"loopOffsets,omitempty"`
	Herd        *hierDeepHerd      `json:"herd,omitempty"`
	LDNR        map[string][3]int  `json:"ldnr,omitempty"` // by neighbor ID: edge count, max width, max height
}

type hierDeepHerd struct {
	Orientation int     `json:"orientation"`
	Val         float64 `json:"val"`
}

type hierDeep struct {
	Nodes       []hierDeepNode     `json:"nodes"`
	CommonUncle map[string][]int64 `json:"commonUncle,omitempty"`
}

// hierAllNodes lists every node reachable from the graph's records in a fixed order (graph nodes first), as serialization does.
func hierAllNodes(g *layoutgraph.Graph) []*layoutgraph.Node {
	var out []*layoutgraph.Node
	seen := map[*layoutgraph.Node]bool{}
	add := func(n *layoutgraph.Node) {
		if n != nil && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	for _, n := range g.Nodes {
		add(n)
	}
	var vessels []*layoutgraph.Node
	for v := range g.Clusters {
		vessels = append(vessels, v)
	}
	for v := range g.Sequences {
		vessels = append(vessels, v)
	}
	sort.Slice(vessels, func(i, j int) bool { return vessels[i].IDValue() < vessels[j].IDValue() })
	for _, v := range vessels {
		add(v)
		if c := g.Clusters[v]; c != nil {
			for _, n := range c.Nodes {
				add(n)
			}
		}
		if s := g.Sequences[v]; s != nil {
			for _, n := range s.Nodes {
				add(n)
			}
		}
	}
	var walkTree func(t *layoutgraph.Tree)
	walkTree = func(t *layoutgraph.Tree) {
		if t == nil {
			return
		}
		add(t.Node)
		for _, c := range t.Children {
			walkTree(c)
		}
	}
	var roots []*layoutgraph.Node
	for r := range g.Trees {
		roots = append(roots, r)
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].IDValue() < roots[j].IDValue() })
	for _, r := range roots {
		add(r)
		for _, t := range g.Trees[r] {
			walkTree(t)
		}
	}
	for i := 0; i < len(out); i++ {
		for _, e := range out[i].Edges {
			add(e.From)
			add(e.To)
		}
		add(out[i].Container)
		for near := range out[i].Nears {
			add(near)
		}
	}
	return out
}

func hierField(n *layoutgraph.Node, name string) reflect.Value {
	f := reflect.ValueOf(n).Elem().FieldByName(name)
	return reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem()
}

func hierSpacing(v reflect.Value) [4]float64 {
	var out [4]float64
	for i, name := range []string{"top", "bottom", "left", "right"} {
		f := v.FieldByName(name)
		out[i] = reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem().Float()
	}
	return out
}

func hierSetSpacing(v reflect.Value, s [4]float64) {
	for i, name := range []string{"top", "bottom", "left", "right"} {
		f := v.FieldByName(name)
		reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem().SetFloat(s[i])
	}
}

func hierDeepDump(g *layoutgraph.Graph) *hierDeep {
	d := &hierDeep{}
	for _, n := range hierAllNodes(g) {
		dn := hierDeepNode{ID: n.IDValue()}
		any := false
		if m := hierSpacing(hierField(n, "margin")); m != [4]float64{} {
			dn.Margin = &m
			any = true
		}
		if p := hierSpacing(hierField(n, "padding")); p != [4]float64{} {
			dn.Padding = &p
			any = true
		}
		if len(n.LoopOffsets) > 0 {
			dn.LoopOffsets = map[string]float64{}
			for o, v := range n.LoopOffsets {
				dn.LoopOffsets[fmt.Sprint(int(o))] = v
			}
			any = true
		}
		if n.HerdAssignment != nil {
			dn.Herd = &hierDeepHerd{Orientation: int(n.HerdAssignment.Orientation), Val: n.HerdAssignment.Val}
			any = true
		}
		if len(n.LongDistanceNeighborRequirements) > 0 {
			dn.LDNR = map[string][3]int{}
			for o, v := range n.LongDistanceNeighborRequirements {
				dn.LDNR[fmt.Sprint(o.IDValue())] = [3]int{v.EdgeCount, v.MaxWidth, v.MaxHeight}
			}
			any = true
		}
		if any {
			d.Nodes = append(d.Nodes, dn)
		}
	}
	if g.CommonUncleSiblings != nil {
		d.CommonUncle = map[string][]int64{}
		for n, sibs := range g.CommonUncleSiblings {
			ids := make([]int64, len(sibs))
			for i, s := range sibs {
				ids[i] = s.IDValue()
			}
			d.CommonUncle[fmt.Sprint(n.IDValue())] = ids
		}
	}
	return d
}

func hierDeepApply(g *layoutgraph.Graph, d *hierDeep) {
	if d == nil {
		return
	}
	byID := map[int64]*layoutgraph.Node{}
	for _, n := range hierAllNodes(g) {
		byID[n.IDValue()] = n
	}
	for _, dn := range d.Nodes {
		n := byID[dn.ID]
		if n == nil {
			continue
		}
		if dn.Margin != nil {
			hierSetSpacing(hierField(n, "margin"), *dn.Margin)
		}
		if dn.Padding != nil {
			hierSetSpacing(hierField(n, "padding"), *dn.Padding)
		}
		if dn.LoopOffsets != nil {
			n.LoopOffsets = map[geo.Orientation]float64{}
			for k, v := range dn.LoopOffsets {
				var o int
				fmt.Sscan(k, &o)
				n.LoopOffsets[geo.Orientation(o)] = v
			}
		}
		if dn.Herd != nil {
			h := layoutgraph.NewHerdAssignment()
			h.Orientation = geo.Orientation(dn.Herd.Orientation)
			h.Val = dn.Herd.Val
			n.HerdAssignment = h
		}
		if dn.LDNR != nil {
			n.LongDistanceNeighborRequirements = map[*layoutgraph.Node]layoutgraph.LongDistanceNeighborRequirements{}
			for k, v := range dn.LDNR {
				var id int64
				fmt.Sscan(k, &id)
				if o := byID[id]; o != nil {
					n.LongDistanceNeighborRequirements[o] = layoutgraph.LongDistanceNeighborRequirements{EdgeCount: v[0], MaxWidth: v[1], MaxHeight: v[2]}
				}
			}
		}
	}
	if d.CommonUncle != nil {
		g.CommonUncleSiblings = map[*layoutgraph.Node]layoutgraph.Nodes{}
		for k, ids := range d.CommonUncle {
			var id int64
			fmt.Sscan(k, &id)
			n := byID[id]
			if n == nil {
				continue
			}
			sibs := make(layoutgraph.Nodes, 0, len(ids))
			for _, sid := range ids {
				if s := byID[sid]; s != nil {
					sibs = append(sibs, s)
				}
			}
			g.CommonUncleSiblings[n] = sibs
		}
	}
}

// hierLoad builds the graph of a graphjson case and applies its deep state ("args": {"deep": ...}).
func hierLoad(in input) (*layoutgraph.Graph, *hierDeep, error) {
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(context.Background(), in.Graph, g); err != nil {
		return nil, nil, err
	}
	var args struct {
		Deep *hierDeep `json:"deep"`
	}
	if len(in.Args) > 0 {
		json.Unmarshal(in.Args, &args)
	}
	hierDeepApply(g, args.Deep)
	return g, args.Deep, nil
}

// ---- hiergen ----

type hierGenRecord struct {
	Inv   int         `json:"inv"`
	Seed  int64       `json:"seed"`
	Index int         `json:"index"`
	Name  string      `json:"name"`
	Graph interface{} `json:"graph"`
	Deep  *hierDeep   `json:"deep,omitempty"`
}

func runHierGen(in input, ruler *textmeasure.Ruler) interface{} {
	var args struct {
		Stages []int   `json:"stages"`
		Seeds  []int64 `json:"seeds"`
		Deep   bool    `json:"deep"`
	}
	json.Unmarshal(in.Args, &args)
	want := map[int]bool{}
	for _, s := range args.Stages {
		want[s] = true
	}
	wantSeed := map[int64]bool{}
	for _, s := range args.Seeds {
		wantSeed[s] = true
	}
	if len(in.Graph) > 0 {
		// a graphjson fixture: the engine pipeline on it (like fstages), seeds from the case (default 123)
		g := layoutgraph.NewGraph()
		if err := graphjson.Unmarshal(context.Background(), in.Graph, g); err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		seeds := in.Seeds
		if len(seeds) == 0 {
			seeds = []int64{123}
		}
		var records []hierGenRecord
		for _, seed := range seeds {
			if len(wantSeed) > 0 && !wantSeed[seed] {
				continue
			}
			clone, err := layoutgraph.Clone(context.Background(), g)
			if err != nil {
				return map[string]interface{}{"err": err.Error()}
			}
			engine.XLayoutObserved(context.Background(), clone, engine.LayoutOptions{Seed: seed}, func(index int, name string, tg *layoutgraph.Graph) error {
				if !want[index] {
					return nil
				}
				rec := hierGenRecord{Inv: 0, Seed: seed, Index: index, Name: name, Graph: ser(tg)}
				if args.Deep {
					rec.Deep = hierDeepDump(tg)
				}
				records = append(records, rec)
				return nil
			})
		}
		return map[string]interface{}{"records": records}
	}
	var fsys fs.FS
	if in.FS != nil {
		files := map[string]string{in.Path: in.Text}
		for k, v := range in.FS {
			files[k] = v
		}
		fsys, _ = memfs.New(files)
	}
	ctx := log.WithDefault(context.Background())
	opts := d2talalayout.DefaultOptions()
	if in.Seeds != nil {
		opts.Seeds = in.Seeds
	}
	var records []hierGenRecord
	inv := 0
	var layoutErr string
	layoutFn := func(ctx context.Context, g *d2graph.Graph) error {
		cur := inv
		inv++
		_, err := d2talalayout.XDumpLayout(ctx, g, &opts, func(seed int64, index int, name string, tg *layoutgraph.Graph) {
			if !want[index] || (len(wantSeed) > 0 && !wantSeed[seed]) {
				return
			}
			rec := hierGenRecord{Inv: cur, Seed: seed, Index: index, Name: name, Graph: ser(tg)}
			if args.Deep {
				rec.Deep = hierDeepDump(tg)
			}
			records = append(records, rec)
		})
		if err != nil {
			layoutErr = err.Error()
		}
		return err
	}
	copts := &d2lib.CompileOptions{
		UTF16Pos: in.UTF16Pos, FS: fsys, Ruler: ruler, InputPath: in.Path, Layout: go2.Pointer("tala"),
		LayoutResolver: func(engine string) (d2graph.LayoutGraph, error) { return layoutFn, nil },
		RouterResolver: func(engine string) (d2graph.RouteEdges, error) { return d2talalayout.RouteEdges, nil },
	}
	_, _, err := d2lib.Compile(ctx, in.Text, copts, &d2svg.RenderOpts{ThemeID: in.ThemeID})
	return map[string]interface{}{"records": records, "err": errString(err), "layoutErr": layoutErr}
}

// ---- hierrank ----

func runHierRank(in input) interface{} {
	var args struct {
		Nodes []int64 `json:"nodes"`
		Edges []struct {
			ID     int64 `json:"id"`
			From   int64 `json:"from"`
			To     int64 `json:"to"`
			Weight int   `json:"weight"`
		} `json:"edges"`
		Limits []uint64 `json:"limits"`
	}
	json.Unmarshal(in.Args, &args)
	build := func() *layoutgraph.Graph {
		g := layoutgraph.NewGraph()
		byID := map[int64]*layoutgraph.Node{}
		for _, id := range args.Nodes {
			n := g.AddNode(layoutgraph.NewNode(id, 10, 10))
			byID[id] = n
		}
		for _, e := range args.Edges {
			ed := g.Connect(byID[e.From], byID[e.To])
			ed.SourceArrowhead = layoutgraph.NoArrowhead
			ed.TargetArrowhead = layoutgraph.TriangleArrowhead
			ed.ID = e.ID
			ed.SetHierarchyRankWeight(e.Weight)
		}
		return g
	}
	limits := append([]uint64{0}, args.Limits...)
	var results []interface{}
	for _, limit := range limits {
		g := build()
		levels, count, err := hierarchy.XRankDAG(context.Background(), g, limit)
		res := map[string]interface{}{"limit": limit, "err": errString(err)}
		if err == nil {
			pairs := make([][2]int64, 0, len(levels))
			for n, l := range levels {
				pairs = append(pairs, [2]int64{n.IDValue(), int64(l)})
			}
			sort.Slice(pairs, func(i, j int) bool { return pairs[i][0] < pairs[j][0] })
			res["levels"] = pairs
			res["count"] = count
		}
		results = append(results, res)
	}
	return map[string]interface{}{"results": results}
}

// ---- hiersimple ----

func hierLevelsJSON(h *layoutgraph.Hierarchy) interface{} {
	if h == nil {
		return nil
	}
	pairs := make([][2]int64, 0, len(h.Levels()))
	for n, l := range h.Levels() {
		pairs = append(pairs, [2]int64{n.IDValue(), int64(l)})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i][0] < pairs[j][0] })
	return map[string]interface{}{"levels": pairs, "count": h.LevelCount}
}

func runHierSimple(in input) interface{} {
	g, _, err := hierLoad(in)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	ctx := context.Background()
	out := map[string]interface{}{}
	func() {
		defer func() {
			if r := recover(); r != nil {
				out["dag"] = map[string]string{"panic": fmt.Sprint(r)}
			}
		}()
		dag, err := hierarchy.XMakeSimpleDAG(ctx, g)
		if err != nil {
			out["dag"] = map[string]interface{}{"err": err.Error()}
			return
		}
		type edgeRec struct {
			ID     int64 `json:"id"`
			From   int64 `json:"from"`
			To     int64 `json:"to"`
			Weight int   `json:"weight"`
		}
		var edges []edgeRec
		for _, e := range dag.Edges {
			edges = append(edges, edgeRec{e.ID, e.From.IDValue(), e.To.IDValue(), e.HierarchyRankWeight()})
		}
		var nodes []int64
		for _, n := range dag.Nodes {
			nodes = append(nodes, n.IDValue())
		}
		out["dag"] = map[string]interface{}{"nodes": nodes, "edges": edges}
	}()
	for _, force := range []bool{false, true} {
		key := fmt.Sprintf("build%v", force)
		func() {
			defer func() {
				if r := recover(); r != nil {
					out[key] = map[string]string{"panic": fmt.Sprint(r)}
				}
			}()
			h, err := hierarchy.XBuild(ctx, g, force)
			if err != nil {
				out[key] = map[string]interface{}{"err": err.Error()}
				return
			}
			out[key] = map[string]interface{}{"hierarchy": hierLevelsJSON(h)}
		}()
	}
	return out
}

// ---- hierstage ----

// hierRunOp runs the body of the PreprocessHierarchies stage (op all), or only its Assign or Place part.
func hierRunOp(ctx context.Context, g *layoutgraph.Graph, op string, seed int64) error {
	hierarchyPlacementRandom := rand.New(rand.NewSource(seed))
	cands := hierarchy.Candidates(g)
	switch op {
	case "assign":
		return hierarchy.Assign(ctx, g, nil, cands)
	case "place":
		return hierarchy.Place(ctx, g, nil, hierarchyPlacementRandom)
	}
	if err := hierarchy.Assign(ctx, g, nil, cands); err != nil {
		return err
	}
	if err := hierarchy.Place(ctx, g, nil, hierarchyPlacementRandom); err != nil {
		return err
	}
	hierarchy.RemoveIsolatedMemberships(g)
	return nil
}

func runHierStage(in input) interface{} {
	g, _, err := hierLoad(in)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	var args struct {
		Golden   json.RawMessage `json:"golden"`
		TxLimits []int64         `json:"txLimits"`
		Polls    bool            `json:"polls"`
	}
	if len(in.Args) > 0 {
		json.Unmarshal(in.Args, &args)
	}
	seed := int64(1)
	if len(in.Seeds) > 0 {
		seed = in.Seeds[0]
	}
	ctx := context.Background()
	op := in.Op
	if op == "" {
		op = "all"
	}
	out := map[string]interface{}{}
	var ids []int64
	cands := hierarchy.Candidates(g)
	for _, n := range g.Nodes {
		if _, ok := cands[n]; ok {
			ids = append(ids, n.IDValue())
		}
	}
	out["candidates"] = ids
	out["horizontal"] = hierarchy.IsHorizontal(g.Nodes)

	// the same operation under a small transaction work budget and under a context that fails after k polls: the error (the exact
	// work unit or poll where it stops) and the rolled-back graph must be the same
	if len(args.TxLimits) > 0 {
		limited := []interface{}{}
		for _, lim := range args.TxLimits {
			g2, _, _ := hierLoad(in)
			guard, _ := limits.NewWorkGuard(ctx, "hierarchy check", lim)
			rec := map[string]interface{}{"limit": lim}
			err := hierRunOp(layoutgraph.ContextWithTransactionWorkGuard(ctx, guard), g2, op, seed)
			rec["err"] = errString(err)
			if err != nil {
				rec["graph"] = ser(g2)
			}
			limited = append(limited, rec)
		}
		out["limited"] = limited
	}
	if args.Polls {
		// findCycleEdges ranges over maps, so the number of work units it charges (and with it the number of context polls) can vary
		// between runs of Go itself: such a case is marked unstable and not compared
		counts := map[int]bool{}
		first := 0
		var firstErr error
		for i := 0; i < 24; i++ {
			g2, _, _ := hierLoad(in)
			n := 0
			err := hierRunOp(pcCtx{Context: ctx, n: &n}, g2, op, seed)
			if i == 0 {
				first, firstErr = n, err
			}
			counts[n] = true
		}
		if len(counts) > 1 {
			out["pollsUnstable"] = true
		} else {
			rec := []interface{}{first, errString(firstErr)}
			if first > 1 {
				g3, _, _ := hierLoad(in)
				m := 0
				err2 := hierRunOp(pcCtx{Context: ctx, n: &m, failAt: first/2 + 1}, g3, op, seed)
				rec = append(rec, m, errString(err2), ser(g3))
			}
			out["polls"] = rec
		}
	}

	stageErr := hierRunOp(ctx, g, op, seed)
	out["err"] = errString(stageErr)
	out["graph"] = ser(g)
	if len(args.Golden) > 0 && stageErr == nil {
		gg := layoutgraph.NewGraph()
		if err := graphjson.Unmarshal(ctx, args.Golden, gg); err == nil {
			a, _ := json.Marshal(ser(g))
			b, _ := json.Marshal(ser(gg))
			if string(a) != string(b) {
				out["pipelineGolden"] = "mismatch"
			}
		}
	}
	return out
}

// ---- hiercompound ----

func runHierCompound(in input) interface{} {
	g, _, err := hierLoad(in)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	ctx := context.Background()
	cl, err := layoutgraph.Clone(ctx, g)
	if err != nil {
		return map[string]interface{}{"cloneErr": err.Error()}
	}
	changed, err := hierarchy.PlaceCompound(ctx, cl, rand.New(rand.NewSource(0)))
	return map[string]interface{}{"changed": changed, "err": errString(err), "graph": ser(cl)}
}

var _ = engine.LayoutOptions{}
