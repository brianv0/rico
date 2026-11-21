package main

// Shared helpers of the packing, labeling and quality checks (modes registered in pkgModes by packing_xdump.go, labeling_xdump.go and
// quality_xdump.go) and the case generator `pkgcases`:
//
//	pkgcases  D2 text or {"graph": <graphjson>, "seeds":[123]} -> {"cases": [...], "err"}: the isolated-stage cases of the pipeline.
//	          Every case is {name, kind, graph, args:{deep, expect}}: `graph` is the graphjson of the stage k-1 graph, `args.deep` the node
//	          state graphjson does not carry (margin, padding, loop offsets, label/icon positionFixed), `args.expect` what Go's stage k (or
//	          the evaluator) produced on the live graph, including the work units used. The modes pkgpack, pkgplace and pkgquality
//	          return `args.expect` when it is present (Go's recording is the reference) and run the Go function themselves otherwise.
//
// Case kinds: pack (stages 18 and 32: BinPack), place (stage 33: PlaceLabels), quality (the evaluators on the graphs after stages 17,
// 24, 32, 33 and 36). The JS twins are in tools/d2ref/tala/pkgcheck.mjs.

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"sort"
	"strconv"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/labeling"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/packing"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/quality"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/memfs"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

// pkgModes are the modes of this file group (main.go's run consults the map for modes it does not know).
var pkgModes = map[string]func(in input, ruler *textmeasure.Ruler) interface{}{}

func init() {
	pkgModes["pkgcases"] = runPkgCases
}

const evaluationWorkUnits = 50_000_000 // quality's maxEvaluationWorkUnits

// ---- deep state ----

type deepNode struct {
	Margin     [4]float64         `json:"m"`
	Padding    [4]float64         `json:"p"`
	Loop       map[string]float64 `json:"loop,omitempty"`
	Nears      []int64            `json:"n"` // exact Nears set (graphjson's Unmarshal adds every near symmetrically, live graphs need not be)
	Edges      []int64            `json:"e"` // the node's own edge list in its own order (Unmarshal rebuilds it in graph.Edges order)
	LabelFixed bool               `json:"lf,omitempty"`
	IconFixed  bool               `json:"if,omitempty"`
}

// graphNodes lists every node the graph reaches (g.Nodes, containers, clusters and sequences with their vessels, edge endpoints, nears)
// in a deterministic order, each once.
func graphNodes(g *layoutgraph.Graph) []*layoutgraph.Node {
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
	for _, n := range sortedKeys(g.Containers) {
		add(n)
		for _, c := range g.Containers[n] {
			add(c)
		}
	}
	for _, v := range sortedClusterKeys(g.Clusters) {
		add(v)
		for _, c := range g.Clusters[v].Nodes {
			add(c)
		}
	}
	for _, v := range sortedSequenceKeys(g.Sequences) {
		add(v)
		for _, c := range g.Sequences[v].Nodes {
			add(c)
		}
	}
	for _, e := range g.Edges {
		add(e.From)
		add(e.To)
	}
	for _, n := range append([]*layoutgraph.Node(nil), out...) {
		for near := range n.Nears {
			add(near)
		}
	}
	return out
}

func sortedKeys(m map[*layoutgraph.Node][]*layoutgraph.Node) []*layoutgraph.Node {
	keys := make([]*layoutgraph.Node, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortByID(keys)
	return keys
}

func sortedClusterKeys(m map[*layoutgraph.Node]*layoutgraph.Cluster) []*layoutgraph.Node {
	keys := make([]*layoutgraph.Node, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortByID(keys)
	return keys
}

func sortedSequenceKeys(m map[*layoutgraph.Node]*layoutgraph.Sequence) []*layoutgraph.Node {
	keys := make([]*layoutgraph.Node, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortByID(keys)
	return keys
}

func sortByID(nodes []*layoutgraph.Node) {
	for i := 1; i < len(nodes); i++ {
		for j := i; j > 0 && nodeID(nodes[j]) < nodeID(nodes[j-1]); j-- {
			nodes[j], nodes[j-1] = nodes[j-1], nodes[j]
		}
	}
}

// deepState records, per node ID (decimal string), what graphjson does not carry.
func deepState(g *layoutgraph.Graph) map[string]deepNode {
	out := map[string]deepNode{}
	for _, n := range graphNodes(g) {
		d := deepNode{
			Margin:  [4]float64{n.XMargin().Top(), n.XMargin().Bottom(), n.XMargin().Left(), n.XMargin().Right()},
			Padding: [4]float64{n.XPadding().Top(), n.XPadding().Bottom(), n.XPadding().Left(), n.XPadding().Right()},
		}
		if len(n.LoopOffsets) > 0 {
			d.Loop = map[string]float64{}
			for o, v := range n.LoopOffsets {
				d.Loop[strconv.Itoa(int(o))] = v
			}
		}
		d.Nears = []int64{}
		for near := range n.Nears {
			d.Nears = append(d.Nears, near.IDValue())
		}
		sort.Slice(d.Nears, func(i, j int) bool { return d.Nears[i] < d.Nears[j] })
		d.Edges = []int64{}
		for _, e := range n.Edges {
			d.Edges = append(d.Edges, e.IDValue())
		}
		d.LabelFixed = n.Label != nil && n.Label.PositionFixed()
		d.IconFixed = n.Icon != nil && n.Icon.PositionFixed()
		out[strconv.FormatInt(n.IDValue(), 10)] = d
	}
	return out
}

// ---- case generator ----

type pkgSnap struct {
	graph interface{}
	deep  map[string]deepNode
	spare int
}

// serRaw is graphjson.Serialize printed at once (a later stage mutates the live graph), non-finite floats as strings.
func serRaw(g *layoutgraph.Graph) json.RawMessage {
	v := ser(g)
	b, err := json.Marshal(v)
	if err != nil {
		b, err = json.Marshal(sanitize(v))
		if err != nil {
			b = []byte(`{"serializeError":"marshal"}`)
		}
	}
	return b
}

func takeSnap(g *layoutgraph.Graph) pkgSnap {
	return pkgSnap{graph: serRaw(g), deep: deepState(g), spare: spareCapacity(g)}
}

type seedCases struct {
	name  string
	snaps map[int]pkgSnap
	out   *[]map[string]interface{}
}

func (sc *seedCases) observe(index int, g *layoutgraph.Graph) {
	ctx := context.Background()
	switch index {
	case 17, 31, 32:
		sc.snaps[index] = takeSnap(g)
	}
	switch index {
	case 18, 32, 33:
		pre := sc.snaps[index-1]
		if pre.graph == nil {
			return
		}
		kind, used := "pack", packing.XLastUsed
		if index == 33 {
			kind, used = "place", labeling.XLastUsed
		}
		*sc.out = append(*sc.out, map[string]interface{}{
			"name": fmt.Sprintf("%s/%d-%s", sc.name, index, kind), "kind": kind, "graph": pre.graph,
			"args": map[string]interface{}{"deep": pre.deep, "spare": pre.spare, "expect": map[string]interface{}{"err": nil, "used": used, "graph": serRaw(g)}},
		})
	}
	switch index {
	case 17, 24, 32, 33, 36:
		snap := takeSnap(g)
		*sc.out = append(*sc.out, map[string]interface{}{
			"name": fmt.Sprintf("%s/%d-quality", sc.name, index), "kind": "quality", "graph": snap.graph,
			"args": map[string]interface{}{"deep": snap.deep, "spare": snap.spare, "expect": qualityExpect(ctx, g)},
		})
	}
}

// qualityExpect runs the evaluators on the live graph. The mid-pipeline graphs are not always valid input for them (the evaluator panics
// on some graphs with unplaced vessels): such a panic is recorded as {"panic"} (the diff stage skips those cases) and must not end the seed.
func qualityExpect(ctx context.Context, g *layoutgraph.Graph) (expect map[string]interface{}) {
	defer func() {
		if r := recover(); r != nil {
			expect = map[string]interface{}{"panic": fmt.Sprint(r)}
		}
	}()
	expect = map[string]interface{}{}
	penalty, area, used, err := quality.XEvaluateLimit(ctx, g, evaluationWorkUnits)
	expect["penalty"], expect["area"], expect["used"], expect["err"] = penalty, area, used, errString(err)
	if err != nil {
		expect["penalty"], expect["area"] = 0.0, 0.0
	}
	metrics, mused, merr := quality.XInspectLimit(ctx, g, evaluationWorkUnits)
	expect["metrics"], expect["mused"], expect["merr"] = metricsJSON(metrics), mused, errString(merr)
	return expect
}

func runPkgCases(in input, ruler *textmeasure.Ruler) interface{} {
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
		sc := &seedCases{name: fmt.Sprintf("%s/s%d", in.Path, seed), snaps: map[int]pkgSnap{}, out: &cases}
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
	if in.MaxConcurrency != 0 {
		opts.MaxConcurrency = in.MaxConcurrency
	}
	invocation := 0
	var runErrs []string // errors of single seeds (a seed that fails is not a case)
	layoutFn := func(ctx context.Context, g *d2graph.Graph) error {
		inv := invocation
		invocation++
		perSeed := map[int64]*seedCases{}
		inv2, err := d2talalayout.XDumpLayout(ctx, g, &opts, func(seed int64, index int, name string, tg *layoutgraph.Graph) {
			sc := perSeed[seed]
			if sc == nil {
				sc = &seedCases{name: fmt.Sprintf("%s/%d/s%d", in.Path, inv, seed), snaps: map[int]pkgSnap{}, out: &cases}
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
	ro := &d2svg.RenderOpts{ThemeID: in.ThemeID}
	_, _, err := d2lib.Compile(ctx, in.Text, copts, ro)
	return map[string]interface{}{"cases": cases, "err": errString(err), "seedErrs": runErrs}
}

// ---- shared pieces of the direct modes ----

// pkgArgs is the args object of the pkg modes.
type pkgArgs struct {
	Deep   map[string]deepNode `json:"deep"`
	Expect json.RawMessage     `json:"expect"`
	Limits []int64             `json:"limits"`
	Root   string              `json:"root"`
	Edges  []int               `json:"edges"`
	Op     string              `json:"op"`
	Cancel bool                `json:"cancel"` // run the function with an already canceled context
	// combine
	Offsets   [][2]float64 `json:"offsets"`
	Obstacles [][4]float64 `json:"obstacles"`
	Split     [3]bool      `json:"split"`
	Dupe      bool         `json:"dupe"`
	// score comparisons
	Scores [][4]interface{} `json:"scores"`
}

func parseArgs(in input) pkgArgs {
	var a pkgArgs
	if len(in.Args) > 0 {
		json.Unmarshal(in.Args, &a)
	}
	return a
}

// unmarshalGraph reads the case's graph and clips the slices whose spare capacity Go's work accounting charges (the JS port has no
// slice capacity), so the work units of Go and JS are comparable.
func unmarshalGraph(in input) (*layoutgraph.Graph, error) {
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(context.Background(), in.Graph, g); err != nil {
		return nil, err
	}
	if os.Getenv("PKG_NOCLIP") == "" {
		clipGraph(g)
	}
	return g, nil
}

func clipGraph(g *layoutgraph.Graph) {
	g.Nodes = slices.Clip(g.Nodes)
	g.Edges = slices.Clip(g.Edges)
	for k, v := range g.Containers {
		g.Containers[k] = slices.Clip(v)
	}
	for _, c := range g.Clusters {
		c.Nodes = slices.Clip(c.Nodes)
	}
	for _, s := range g.Sequences {
		s.Nodes = slices.Clip(s.Nodes)
	}
	for _, n := range graphNodes(g) {
		n.Edges = slices.Clip(n.Edges)
	}
	for _, e := range g.Edges {
		e.Points = slices.Clip(e.Points)
	}
}

// spareCapacity totals cap-len of the exported slices that Go's preflights and snapshots charge (the unexported ones are not counted).
func spareCapacity(g *layoutgraph.Graph) int {
	n := cap(g.Nodes) - len(g.Nodes) + cap(g.Edges) - len(g.Edges)
	for _, v := range g.Containers {
		n += cap(v) - len(v)
	}
	for _, c := range g.Clusters {
		n += cap(c.Nodes) - len(c.Nodes)
	}
	for _, s := range g.Sequences {
		n += cap(s.Nodes) - len(s.Nodes)
	}
	for _, nd := range graphNodes(g) {
		n += cap(nd.Edges) - len(nd.Edges)
	}
	for _, e := range g.Edges {
		n += cap(e.Points) - len(e.Points)
	}
	return n
}

func findNode(g *layoutgraph.Graph, id string) *layoutgraph.Node {
	for _, n := range graphNodes(g) {
		if strconv.FormatInt(n.IDValue(), 10) == id {
			return n
		}
	}
	return nil
}

var _ = geo.NewPoint
var _ = labeling.Place

// argsCtx is the context the function under test runs with (canceled before the call when args.cancel is set).
func argsCtx(a pkgArgs) context.Context {
	ctx := context.Background()
	if a.Cancel {
		c, cancel := context.WithCancel(ctx)
		cancel()
		return c
	}
	return ctx
}
