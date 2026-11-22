package main

import (
	"context"
	"io/fs"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/routing"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/memfs"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

// Modes of the routing core check (tools/d2ref/tala/routingcheck.mjs). Both record every call of routing.RouteGraph (the two
// EdgeRouting stages and the compound candidate) with routing_xdump.go's observer:
//
//	routing   D2 text: {"invocations":[{"seeds":[{"seed","err","calls":[{"stage","name","call"}]}],"compound":[...],"err"}],"err"}
//	frouting  {"graph", "seeds":[123]}: the engine pipeline on a graphjson fixture -> {"err","calls":[{"stage","name","call"}]}
//
// "stage" is the index of the pipeline stage during which the call happened (21 and 24: EdgeRouting) or -2 for the compound candidate.
type routingCall struct {
	Stage int              `json:"stage"`
	Name  string           `json:"name"`
	Call  *routing.XCall   `json:"call"`
}

type routingSeed struct {
	Seed  int64         `json:"seed"`
	Err   string        `json:"err,omitempty"`
	Calls []routingCall `json:"calls"`
}

type routingInvocation struct {
	Seeds    []routingSeed `json:"seeds"`
	Compound []routingCall `json:"compound,omitempty"`
	Err      string        `json:"err,omitempty"`
}

func runRouting(mode string, in input, ruler *textmeasure.Ruler) interface{} {
	routing.XObserve = true
	routing.XDeterministicLevels = true
	routing.XConsiderNodeLabels = mode == "routinglabels" || mode == "froutinglabels"
	routing.XSerialize = func(g *layoutgraph.Graph) interface{} { return ser(g) }
	defer func() { routing.XObserve = false; routing.XConsiderNodeLabels = false; routing.XCollect() }()
	if mode == "frouting" || mode == "froutinglabels" {
		return runFRouting(in)
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
	var invocations []routingInvocation
	layoutFn := func(ctx context.Context, g *d2graph.Graph) error {
		rec := routingInvocation{}
		routing.XCollect()
		seedCalls := map[int64][]routingCall{}
		inv, err := d2talalayout.XDumpLayout(ctx, g, &opts, func(seed int64, index int, name string, tg *layoutgraph.Graph) {
			for _, c := range routing.XCollect() {
				seedCalls[seed] = append(seedCalls[seed], routingCall{Stage: index, Name: name, Call: c})
			}
		})
		for _, c := range routing.XCollect() {
			rec.Compound = append(rec.Compound, routingCall{Stage: -2, Name: "compound", Call: c})
		}
		if inv != nil {
			for _, r := range inv.Runs {
				rec.Seeds = append(rec.Seeds, routingSeed{Seed: r.Seed, Err: r.Err, Calls: seedCalls[r.Seed]})
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
		RouterResolver: func(engine string) (d2graph.RouteEdges, error) { return d2talalayout.RouteEdges, nil },
	}
	_, _, err := d2lib.Compile(ctx, in.Text, copts, nil)
	return map[string]interface{}{"invocations": invocations, "err": errString(err)}
}

func runFRouting(in input) interface{} {
	ctx := context.Background()
	g := layoutgraph.NewGraph()
	if err := unmarshalFixture(ctx, in, g); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	seed := int64(123)
	if len(in.Seeds) > 0 {
		seed = in.Seeds[0]
	}
	var calls []routingCall
	routing.XCollect()
	_, err := engine.XLayoutObserved(ctx, g, engine.LayoutOptions{Seed: seed}, func(index int, name string, tg *layoutgraph.Graph) error {
		for _, c := range routing.XCollect() {
			calls = append(calls, routingCall{Stage: index, Name: name, Call: c})
		}
		return nil
	})
	return map[string]interface{}{"err": errString(err), "calls": calls}
}

func unmarshalFixture(ctx context.Context, in input, g *layoutgraph.Graph) error {
	return graphjson.Unmarshal(ctx, in.Graph, g)
}
