package main

// Modes of the routing stage checks (tools/d2ref/tala/routestagecheck.mjs): the stage half of internal/routing (EdgeRouting, Crosshatch,
// SimplifyEdgeRoutes, SwapEdgePorts, StraightEdgesFallback, BalanceEdgeSegments, FixClusterEdgeBranching, TraceEdgesToShapeBorder,
// ReorderDuplicates, NudgeEdgeChannels, ShortcutEdgeRoutes) and RouteEdges.
//
//	routecases   D2 text or {"graph": <graphjson>, "seeds":[123]} -> {"cases": [...], "err", "seedErrs"}: for every stage above one case
//	             {name, kind, graph, args:{deep, spare, force, complete, expect:{graph, deep}}}: `graph` is the graphjson of the stage k-1
//	             graph with `args.deep` (pkg_xdump.go: margins, paddings, loop offsets, the nodes' own edge order, ...), `force` and
//	             `complete` the pipeline flags the stage was entered with (forceReroute, edgeRoutingComplete), `args.expect` the graph and
//	             deep state Go's stage k produced on the live graph. Stage 24 is kind "route2".
//	routeedges   D2 text or {"graph", "seeds"}: for the final graph of every seed, the standalone RouteEdges on edge subsets (see runRouteEdges).
//	routestage   {graph, args:{deep, kind, force, complete, limits:[..]}}: runs the stage with every work limit and returns {results:[{limit, err}]}.
//
// The Go routing level order is random for nodes of equal X in a hierarchy: like the routing core check the harness orders ties by ID
// (routing.XDeterministicLevels), and the JS check does the same (setDeterministicHierarchyLevels).

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/routing"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/memfs"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

func init() {
	pkgModes["routecases"] = runRouteCases
	pkgModes["routeedges"] = runRouteEdges
	pkgModes["routestage"] = runRouteStage
}

// routeStageKinds maps the pipeline stage index to the kind of the case.
var routeStageKinds = map[int]string{
	21: "route", 22: "crosshatch", 24: "route2", 25: "simplify", 26: "swap", 27: "straight", 28: "balance", 29: "fixcluster",
	30: "trace", 31: "reorder", 34: "nudge", 35: "shortcut",
}

type routeSeedCases struct {
	name  string
	snaps map[int]pkgSnap
	flags map[int][2]bool
	out   *[]map[string]interface{}
}

func (sc *routeSeedCases) observe(index int, g *layoutgraph.Graph) {
	if index == 36 {
		sc.observeEdges(g)
	}
	if index >= 20 && index <= 35 {
		sc.snaps[index] = takeSnap(g)
		if engine.XFlags != nil {
			f, c := engine.XFlags()
			sc.flags[index] = [2]bool{f, c}
		}
	}
	kind, ok := routeStageKinds[index]
	if !ok {
		return
	}
	pre := sc.snaps[index-1]
	if pre.graph == nil {
		return
	}
	fl := sc.flags[index-1]
	*sc.out = append(*sc.out, map[string]interface{}{
		"name": fmt.Sprintf("%s/%d-%s", sc.name, index, kind), "kind": kind, "graph": pre.graph,
		"args": map[string]interface{}{
			"deep": pre.deep, "spare": pre.spare, "force": fl[0], "complete": fl[1],
			"expect": map[string]interface{}{"err": nil, "graph": sc.snaps[index].graph, "deep": sc.snaps[index].deep},
		},
	})
}

// observeEdges adds the standalone RouteEdges cases of the final graph: five edge selections (all edges, the first one, every second,
// every third from the second, the last one), the selected routes either kept (stale) or removed.
func (sc *routeSeedCases) observeEdges(g *layoutgraph.Graph) {
	if len(g.Edges) == 0 {
		return
	}
	snap := takeSnap(g)
	raw, _ := snap.graph.(json.RawMessage)
	type variant struct {
		name  string
		pick  func(i, n int) bool
		reset bool
	}
	variants := []variant{
		{"all", func(i, n int) bool { return true }, false},
		{"first", func(i, n int) bool { return i == 0 }, true},
		{"even", func(i, n int) bool { return i%2 == 0 }, false},
		{"third", func(i, n int) bool { return i%3 == 1 }, true},
		{"last", func(i, n int) bool { return i == n-1 }, false},
	}
	for _, v := range variants {
		live, err := loadDeepGraph(raw, snap.deep)
		if err != nil {
			return
		}
		var edges []*layoutgraph.Edge
		var ids []int64
		for i, e := range live.Edges {
			if v.pick(i, len(live.Edges)) {
				edges = append(edges, e)
				ids = append(ids, e.IDValue())
				if v.reset {
					e.Points = nil
				}
			}
		}
		if len(edges) == 0 {
			continue
		}
		before := takeSnap(live)
		err = routing.XRouteEdges(context.Background(), live, edges, routing.XMaxStageWork)
		after := takeSnap(live)
		*sc.out = append(*sc.out, map[string]interface{}{
			"name": fmt.Sprintf("%s/36-routeedges-%s", sc.name, v.name), "kind": "routeedges", "graph": before.graph,
			"args": map[string]interface{}{
				"deep": before.deep, "spare": before.spare, "edges": ids,
				"expect": map[string]interface{}{"err": errString(err), "graph": after.graph, "deep": after.deep},
			},
		})
	}
}

func runRouteCases(in input, ruler *textmeasure.Ruler) interface{} {
	routing.XDeterministicLevels = true
	var cases []map[string]interface{}
	if len(in.Graph) > 0 {
		ctx := context.Background()
		g := layoutgraph.NewGraph()
		if err := graphjson.Unmarshal(ctx, in.Graph, g); err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		seed := int64(123)
		if len(in.Seeds) > 0 {
			seed = in.Seeds[0]
		}
		sc := &routeSeedCases{name: fmt.Sprintf("%s/s%d", in.Path, seed), snaps: map[int]pkgSnap{}, flags: map[int][2]bool{}, out: &cases}
		_, err := engine.XLayoutObserved(ctx, g, engine.LayoutOptions{Seed: seed}, func(index int, name string, tg *layoutgraph.Graph) error {
			sc.observe(index, tg)
			return nil
		})
		return map[string]interface{}{"cases": cases, "err": errString(err)}
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
	invocation := 0
	var runErrs []string
	layoutFn := func(ctx context.Context, g *d2graph.Graph) error {
		inv := invocation
		invocation++
		perSeed := map[int64]*routeSeedCases{}
		inv2, err := d2talalayout.XDumpLayout(ctx, g, &opts, func(seed int64, index int, name string, tg *layoutgraph.Graph) {
			sc := perSeed[seed]
			if sc == nil {
				sc = &routeSeedCases{name: fmt.Sprintf("%s/%d/s%d", in.Path, inv, seed), snaps: map[int]pkgSnap{}, flags: map[int][2]bool{}, out: &cases}
				perSeed[seed] = sc
			}
			sc.observe(index, tg)
		})
		if inv2 != nil {
			for _, r := range inv2.Runs {
				if r.Err != "" {
					runErrs = append(runErrs, fmt.Sprintf("%s/%d/s%d: %s", in.Path, inv, r.Seed, r.Err))
				}
			}
		}
		return err
	}
	copts := &d2lib.CompileOptions{
		UTF16Pos: in.UTF16Pos, FS: fsys, Ruler: ruler, InputPath: in.Path, Layout: go2.Pointer("tala"),
		LayoutResolver: func(engine string) (d2graph.LayoutGraph, error) { return layoutFn, nil },
		RouterResolver: func(engine string) (d2graph.RouteEdges, error) { return d2talalayout.RouteEdges, nil },
	}
	_, _, err := d2lib.Compile(ctx, in.Text, copts, &d2svg.RenderOpts{ThemeID: in.ThemeID})
	return map[string]interface{}{"cases": cases, "err": errString(err), "seedErrs": runErrs}
}

// ---- routestage: the stage with explicit work limits ----

type routeStageArgs struct {
	Deep   map[string]deepNode `json:"deep"`
	Kind   string              `json:"kind"`
	Force  bool                `json:"force"`
	Done   bool                `json:"complete"`
	Limits []uint64            `json:"limits"`
	Cancel bool                `json:"cancel"`
}

var routeStageNames = map[string]string{
	"route": "route", "route2": "route", "crosshatch": "crosshatch", "simplify": "simplify", "swap": "swap", "straight": "straight",
	"balance": "balance", "fixcluster": "fixcluster", "trace": "trace", "reorder": "reorder", "nudge": "nudge", "shortcut": "shortcut",
}

// loadDeepGraph unmarshals a case graph and applies the deep state (the Go twin of pkgcheck.mjs loadGraph).
func loadDeepGraph(raw json.RawMessage, deep map[string]deepNode) (*layoutgraph.Graph, error) {
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(context.Background(), raw, g); err != nil {
		return nil, err
	}
	byID := map[int64]*layoutgraph.Node{}
	for _, n := range graphNodes(g) {
		byID[n.IDValue()] = n
	}
	edgeByID := map[int64]*layoutgraph.Edge{}
	for _, e := range g.Edges {
		edgeByID[e.IDValue()] = e
	}
	for id, d := range deep {
		var nid int64
		fmt.Sscan(id, &nid)
		n := byID[nid]
		if n == nil {
			return nil, fmt.Errorf("deep state of node %s: no such node", id)
		}
		n.XSetMargin(d.Margin[0], d.Margin[1], d.Margin[2], d.Margin[3])
		n.XSetPadding(d.Padding[0], d.Padding[1], d.Padding[2], d.Padding[3])
		n.LoopOffsets = nil
		if d.Loop != nil {
			n.LoopOffsets = map[geo.Orientation]float64{}
			for k, v := range d.Loop {
				var o int
				fmt.Sscan(k, &o)
				n.LoopOffsets[geo.Orientation(o)] = v
			}
		}
		n.Nears = map[*layoutgraph.Node]struct{}{}
		for _, nr := range d.Nears {
			n.Nears[byID[nr]] = struct{}{}
		}
		n.Edges = nil
		for _, e := range d.Edges {
			n.Edges = append(n.Edges, edgeByID[e])
		}
		if d.LabelFixed {
			n.Label.FixPosition()
		}
		if d.IconFixed {
			n.Icon.FixPosition()
		}
	}
	return g, nil
}

func runRouteStage(in input, ruler *textmeasure.Ruler) interface{} {
	routing.XDeterministicLevels = true
	var a routeStageArgs
	json.Unmarshal(in.Args, &a)
	stage, ok := routeStageNames[a.Kind]
	if !ok {
		return map[string]interface{}{"err": "unknown kind " + a.Kind}
	}
	type result struct {
		Limit uint64 `json:"limit"`
		Err   interface{} `json:"err"`
	}
	var results []result
	for _, limit := range a.Limits {
		g, err := loadDeepGraph(in.Graph, a.Deep)
		if err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		ctx := context.Background()
		if a.Cancel {
			c, cancel := context.WithCancel(ctx)
			cancel()
			ctx = c
		}
		err = routing.XRunStage(ctx, stage, g, limit, a.Force, a.Done)
		results = append(results, result{Limit: limit, Err: errString(err)})
	}
	return map[string]interface{}{"results": results}
}

// ---- routeedges: the standalone router ----

func runRouteEdges(in input, ruler *textmeasure.Ruler) interface{} {
	return map[string]interface{}{"err": "not implemented"}
}
