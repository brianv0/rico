// xdump: stage-by-stage dumps of the TALA layout engine (the Go reference of the JS port in public/d2/tala/).
// It lives in d2layouts/d2talalayout/internal/xdump of a writable copy of the D2 module (tools/d2ref/tala/setup.sh
// installs it) because TALA's packages are Go internal packages.
//
//	xdump <mode> < cases.jsonl > out.jsonl
//
// Input: one JSON object per line, {"path","text","utf16"?,"fs"?,"seeds"?,"maxConcurrency"?} (the d2ref case format; seeds
// default to TALA's {1,2,3}; the e2e tests use {1}). Output: one JSON line per case.
//
// Modes on D2 text (each runs d2lib.Compile with layout 'tala' and a recording layout function; the record has one
// invocation per call of the layout function, because boards/layers/scenarios/steps are laid out one by one):
//
//	adapter   {"invocations":[{"adapter": <graphjson of the D2 -> TALA translation>}], "err"}  (no layout is run)
//	scores    adapter + per seed {seed, err, penalty, area}, selected, compound, final graph
//	stages    scores + per seed "stages": [{index, name, graph}] after every pipeline stage ("input" = index -1)
//	layout    {"diagram", "err"} like d2ref's layout mode with the full d2talalayout.Layout (concurrent as in production)
//	times     {"ms": wall time of one full d2talalayout.Layout compile}
//
// Modes on graphjson fixtures ({"graph": <graphjson>}): see fixtures.go.
//
// Graph dumps are graphjson.Serialize output (int64 IDs print as JSON numbers: read with tools/d2ref/tala/bigjson.mjs).
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"time"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
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

type input struct {
	Path           string            `json:"path"`
	Text           string            `json:"text"`
	UTF16Pos       bool              `json:"utf16"`
	FS             map[string]string `json:"fs"`
	Seeds          []int64           `json:"seeds"`
	MaxConcurrency int               `json:"maxConcurrency"`
	ThemeID        *int64            `json:"themeID"`

	// rand mode
	Seed int64    `json:"seed"`

	// nodeshape mode
	Shape      string  `json:"shape"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Width      float64 `json:"width"`
	Height     float64 `json:"height"`
	NumColumns int     `json:"numColumns"`

	Ops  []randOp `json:"ops"`

	// fixture modes
	Graph json.RawMessage `json:"graph"`
	Op    string          `json:"op"`
	Args  json.RawMessage `json:"args"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: xdump <adapter|scores|stages|layout|times|graphjson|...> < cases.jsonl")
		os.Exit(2)
	}
	mode := os.Args[1]
	ruler, err := textmeasure.NewRuler()
	if err != nil {
		panic(err)
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 256<<20)
	out := json.NewEncoder(os.Stdout)
	for sc.Scan() {
		var in input
		if err := json.Unmarshal(sc.Bytes(), &in); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		res := run(mode, in, ruler)
		if err := out.Encode(res); err != nil {
			if err2 := out.Encode(sanitize(res)); err2 != nil {
				out.Encode(map[string]string{"panic": err2.Error()})
			}
		}
	}
}

func run(mode string, in input, ruler *textmeasure.Ruler) (res interface{}) {
	defer func() {
		if r := recover(); r != nil {
			res = map[string]string{"panic": fmt.Sprint(r)}
		}
	}()
	switch mode {
	case "adapter", "scores", "stages", "layout", "times", "svg":
		return runD2(mode, in, ruler)
	case "rand":
		return runRand(in)
	case "nodeshape":
		return runNodeshape(in)
	case "lgops":
		return runOps(in)
	case "routing", "frouting":
		return runRouting(mode, in, ruler)
	}
	return runFixture(mode, in)
}

func ser(g *layoutgraph.Graph) interface{} {
	if g == nil {
		return nil
	}
	s, err := graphjson.Serialize(context.Background(), g)
	if err != nil {
		return map[string]string{"serializeError": err.Error()}
	}
	return s
}

type stageRecord struct {
	Index int         `json:"index"`
	Name  string      `json:"name"`
	Graph interface{} `json:"graph"`
}

type seedRecord struct {
	Seed     int64         `json:"seed"`
	Err      string        `json:"err,omitempty"`
	Penalty  *float64      `json:"penalty,omitempty"`
	Area     *float64      `json:"area,omitempty"`
	Stages   []stageRecord `json:"stages,omitempty"`
	Complete interface{}   `json:"graph,omitempty"`
}

type invocationRecord struct {
	Adapter  interface{}  `json:"adapter"`
	Err      string       `json:"err,omitempty"`
	Seeds    []seedRecord `json:"seeds,omitempty"`
	Selected *int         `json:"selected,omitempty"` // index of the selected seed before the compound candidate
	Compound string       `json:"compound,omitempty"`
	Final    interface{}  `json:"final,omitempty"`
}

func runD2(mode string, in input, ruler *textmeasure.Ruler) interface{} {
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
	var invocations []invocationRecord
	layoutFn := func(ctx context.Context, g *d2graph.Graph) error {
		switch mode {
		case "layout", "times", "svg":
			return d2talalayout.Layout(ctx, g, &opts)
		case "adapter":
			rec := invocationRecord{}
			tg, err := d2talalayout.XDumpTranslate(ctx, g)
			if err != nil {
				rec.Err = err.Error()
			} else {
				rec.Adapter = ser(tg)
			}
			invocations = append(invocations, rec)
			// A placeholder placement so that the compile (and later boards) goes on.
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
		rec := invocationRecord{}
		seedStages := map[int64][]stageRecord{}
		inv, err := d2talalayout.XDumpLayout(ctx, g, &opts, func(seed int64, index int, name string, tg *layoutgraph.Graph) {
			if mode == "stages" {
				seedStages[seed] = append(seedStages[seed], stageRecord{Index: index, Name: name, Graph: ser(tg)})
			}
		})
		if inv != nil {
			rec.Adapter = ser(inv.Input)
			for i, r := range inv.Runs {
				sr := seedRecord{Seed: r.Seed, Err: r.Err, Stages: seedStages[r.Seed]}
				if r.HasScore {
					p, a := r.Penalty, r.Area
					sr.Penalty, sr.Area = &p, &a
				}
				if mode == "stages" && r.Graph != nil {
					sr.Complete = nil
				}
				_ = i
				rec.Seeds = append(rec.Seeds, sr)
			}
			if inv.Selected >= 0 {
				s := inv.Selected
				rec.Selected = &s
			}
			rec.Compound = inv.Compound
			if inv.Final != nil {
				rec.Final = ser(inv.Final)
			}
		}
		if err != nil {
			rec.Err = err.Error()
		}
		invocations = append(invocations, rec)
		return err
	}
	copts := &d2lib.CompileOptions{
		UTF16Pos: in.UTF16Pos, FS: fsys, Ruler: ruler, InputPath: in.Path, Layout: go2.Pointer("tala"),
		LayoutResolver: func(engine string) (d2graph.LayoutGraph, error) { return layoutFn, nil },
		RouterResolver: func(engine string) (d2graph.RouteEdges, error) {
			if mode == "adapter" {
				// the placeholder placement of the adapter mode is no input for any router: do not route
				return func(ctx context.Context, g *d2graph.Graph, edges []*d2graph.Edge) error { return nil }, nil
			}
			return d2talalayout.RouteEdges, nil
		},
	}
	ro := &d2svg.RenderOpts{ThemeID: in.ThemeID}
	start := time.Now()
	diagram, _, err := d2lib.Compile(ctx, in.Text, copts, ro)
	elapsed := time.Since(start)
	switch mode {
	case "layout":
		return map[string]interface{}{"diagram": diagram, "err": errString(err)}
	case "times":
		return map[string]interface{}{"ms": float64(elapsed.Microseconds()) / 1000, "err": errString(err)}
	case "svg":
		if err != nil {
			return map[string]interface{}{"err": errString(err)}
		}
		svg, err := d2svg.Render(diagram, ro)
		return map[string]interface{}{"svg": string(svg), "err": errString(err)}
	}
	return map[string]interface{}{"invocations": invocations, "err": errString(err)}
}

func errString(err error) interface{} {
	if err == nil {
		return nil
	}
	return err.Error()
}

