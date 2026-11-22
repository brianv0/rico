package main

// Modes of the engine and root-package checks (docs/d2-tala-port.md, "engine and root"). Registered in hierModes (main.go consults it first).
//
//	roottrace     D2 text -> {"events": [...], "diagram", "err"}: d2lib.Compile with the sequential trace of Layout (d2talalayout.XTraceLayout:
//	              the real plan, seeds, selection, compound candidate and patch) and of RouteEdges (XTraceRouteEdges). `events` has one entry per
//	              call of the layout function ({kind: "layout", adapter, seeds: [{seed, err, hasGraph, graph, penalty, area, hasScore}], selected,
//	              compound, compoundErr, compoundGraph, final, err}) or of the edge router ({kind: "route", graph (the routed TALA graph), edges:
//	              [{id, isCurve}], err}), in call order. `diagram` and `err` are what d2lib.Compile gave.
//	rootcheck     {"graph": result graphjson, "args": {"input": input graphjson}} -> {completed, topology, metadata, evaluate}: the error text
//	              ("" = passes) of each validation of a seed result against its input (the error-injection cases mutate the JSON)
//	rootscore     {"args": {"pairs": [[p1, a1, p2, a2], ...]}} -> layoutScore.compare of each pair
//	enginestages  -> {"names": [...]}: the names of defaultPipelineStages in order
//	enginedrive   {"graph", "seeds": [seed], "args": {"script": {"<index>": XStep}, "timing", "validate", "precancel", "kind": "layout"|"run"}} ->
//	              {"err", "stages": [{index, name, graph}] (entry states), "final", "nilPipeline", "durationsLen", "durationsUsed"}:
//	              the real Layout / runLayout with scripted stage bodies
//	enginecompound {"graph", "args": {}} -> {"reason", "detoursBefore", "detoursAfter", "candidate", "full": {"same": bool, "err", "graph"}}: the
//	              decisions of CompoundCandidate before its routing trial, and the real CompoundCandidate on the graph

import (
	"context"
	"encoding/json"
	"io/fs"
	"math"
	"strconv"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/memfs"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

func init() {
	hierModes["roottrace"] = runRootTrace
	hierModes["rootcheck"] = func(in input, _ *textmeasure.Ruler) interface{} { return runRootCheck(in) }
	hierModes["rootscore"] = func(in input, _ *textmeasure.Ruler) interface{} { return runRootScore(in) }
	hierModes["enginestages"] = func(in input, _ *textmeasure.Ruler) interface{} {
		return map[string]interface{}{"names": engine.XStageNames()}
	}
	hierModes["enginedrive"] = func(in input, _ *textmeasure.Ruler) interface{} { return runEngineDrive(in) }
	hierModes["enginecompound"] = func(in input, _ *textmeasure.Ruler) interface{} { return runEngineCompound(in) }
}

type rootSeedRecord struct {
	Seed     int64       `json:"seed"`
	Err      string      `json:"err,omitempty"`
	HasGraph bool        `json:"hasGraph"`
	Graph    interface{} `json:"graph,omitempty"`
	Penalty  *float64    `json:"penalty,omitempty"`
	Area     *float64    `json:"area,omitempty"`
	HasScore bool        `json:"hasScore"`
}

func runRootTrace(in input, ruler *textmeasure.Ruler) interface{} {
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
	var events []map[string]interface{}
	layoutFn := func(ctx context.Context, g *d2graph.Graph) error {
		ev := map[string]interface{}{"kind": "layout"}
		inv, err := d2talalayout.XTraceLayout(ctx, g, &opts)
		if inv != nil {
			ev["adapter"] = ser(inv.Input)
			var seeds []rootSeedRecord
			for _, r := range inv.Runs {
				sr := rootSeedRecord{Seed: r.Seed, Err: r.Err, HasGraph: r.HasGraph, HasScore: r.HasScore}
				if r.Graph != nil {
					sr.Graph = ser(r.Graph)
				}
				if r.HasScore {
					p, a := r.Penalty, r.Area
					sr.Penalty, sr.Area = &p, &a
				}
				seeds = append(seeds, sr)
			}
			ev["seeds"] = seeds
			ev["selected"] = inv.Selected
			ev["compound"] = inv.Compound
			if inv.CompoundErr != "" {
				ev["compoundErr"] = inv.CompoundErr
			}
			if inv.CompoundGraph != nil {
				ev["compoundGraph"] = ser(inv.CompoundGraph)
			}
			if inv.Final != nil {
				ev["final"] = ser(inv.Final)
			}
		}
		if err != nil {
			ev["err"] = err.Error()
		}
		events = append(events, ev)
		return err
	}
	routeFn := func(ctx context.Context, g *d2graph.Graph, edges []*d2graph.Edge) error {
		ev := map[string]interface{}{"kind": "route"}
		events = append(events, ev)
		err := d2talalayout.XTraceRouteEdges(func(tg *layoutgraph.Graph, tedges []*layoutgraph.Edge) {
			ev["graph"] = ser(tg)
			var ids []map[string]interface{}
			for _, e := range tedges {
				ids = append(ids, map[string]interface{}{"id": e.ID, "isCurve": e.IsCurve})
			}
			ev["edges"] = ids
		})(ctx, g, edges)
		if err != nil {
			ev["err"] = err.Error()
		}
		return err
	}
	copts := &d2lib.CompileOptions{
		UTF16Pos: in.UTF16Pos, FS: fsys, Ruler: ruler, InputPath: in.Path, Layout: go2.Pointer("tala"),
		LayoutResolver: func(engine string) (d2graph.LayoutGraph, error) { return layoutFn, nil },
		RouterResolver: func(engine string) (d2graph.RouteEdges, error) { return routeFn, nil },
	}
	ro := &d2svg.RenderOpts{ThemeID: in.ThemeID}
	diagram, _, err := d2lib.Compile(ctx, in.Text, copts, ro)
	return map[string]interface{}{"events": events, "diagram": diagram, "err": errString(err)}
}

type rootCheckArgs struct {
	Input json.RawMessage `json:"input"`
}

func runRootCheck(in input) interface{} {
	var args rootCheckArgs
	if err := json.Unmarshal(in.Args, &args); err != nil {
		return map[string]string{"panic": err.Error()}
	}
	ctx := context.Background()
	inputGraph := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, args.Input, inputGraph); err != nil {
		return map[string]interface{}{"inputErr": err.Error()}
	}
	result := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, in.Graph, result); err != nil {
		return map[string]interface{}{"resultErr": err.Error()}
	}
	completed, topology, metadata, evaluate := d2talalayout.XResultCheck(ctx, inputGraph, result)
	return map[string]interface{}{"completed": completed, "topology": topology, "metadata": metadata, "evaluate": evaluate}
}

func runRootScore(in input) interface{} {
	var args struct {
		Pairs [][4]interface{} `json:"pairs"`
	}
	if err := json.Unmarshal(in.Args, &args); err != nil {
		return map[string]string{"panic": err.Error()}
	}
	num := func(v interface{}) float64 {
		switch x := v.(type) {
		case float64:
			return x
		case string:
			switch x {
			case "+Inf":
				return posInf()
			case "-Inf":
				return -posInf()
			}
			return nan()
		}
		return 0
	}
	var out []int
	for _, p := range args.Pairs {
		out = append(out, d2talalayout.XCompareScores(num(p[0]), num(p[1]), num(p[2]), num(p[3])))
	}
	return map[string]interface{}{"cmp": out}
}

type driveArgs struct {
	Script    map[string]engine.XStep `json:"script"`
	Timing    bool                    `json:"timing"`
	Validate  bool                    `json:"validate"`
	Precancel bool                    `json:"precancel"`
	Kind      string                  `json:"kind"`
}

func runEngineDrive(in input) interface{} {
	var args driveArgs
	if in.Args != nil {
		if err := json.Unmarshal(in.Args, &args); err != nil {
			return map[string]string{"panic": err.Error()}
		}
	}
	bg := context.Background()
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(bg, in.Graph, g); err != nil {
		return map[string]interface{}{"unmarshalErr": err.Error()}
	}
	script := map[int]engine.XStep{}
	for k, v := range args.Script {
		i, _ := strconv.Atoi(k)
		script[i] = v
	}
	restore := engine.XInstallScript(script)
	defer restore()
	var stages []stageRecord
	engine.XOnStage = func(index int, name string, tg *layoutgraph.Graph) {
		stages = append(stages, stageRecord{Index: index, Name: name, Graph: ser(tg)})
	}
	defer func() { engine.XOnStage = nil; engine.XCancel = nil }()
	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	engine.XCancel = cancel
	if args.Precancel {
		cancel()
	}
	seed := int64(1)
	if len(in.Seeds) > 0 {
		seed = in.Seeds[0]
	}
	res := map[string]interface{}{}
	if args.Kind == "run" {
		r, err := engine.XDrive(ctx, g, seed, args.Timing, args.Validate)
		res["err"] = errString(err)
		res["nilPipeline"] = r.NilPipeline
		res["durationsLen"] = r.DurationsLen
		res["durationsUsed"] = r.DurationsUsed
		if r.Workspace != nil {
			res["final"] = ser(r.Workspace)
		}
	} else {
		out, err := engine.Layout(ctx, g, engine.LayoutOptions{Seed: seed})
		res["err"] = errString(err)
		if out != nil {
			res["final"] = ser(out)
		}
	}
	res["stages"] = stages
	return res
}

func runEngineCompound(in input) interface{} {
	ctx := context.Background()
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, in.Graph, g); err != nil {
		return map[string]interface{}{"unmarshalErr": err.Error()}
	}
	rec, err := engine.XCompoundTrace(ctx, g)
	res := map[string]interface{}{"reason": rec.Reason, "detoursBefore": rec.DetoursBefore, "detoursAfter": rec.DetoursAfter, "err": errString(err)}
	if rec.Candidate != nil {
		res["candidate"] = ser(rec.Candidate)
	}
	cg := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, in.Graph, cg); err == nil {
		full, ferr := engine.CompoundCandidate(ctx, cg)
		f := map[string]interface{}{"same": full == cg, "err": errString(ferr)}
		if full != nil && full != cg {
			f["graph"] = ser(full)
		}
		res["full"] = f
	}
	return res
}

func posInf() float64 { return math.Inf(1) }
func nan() float64    { return math.NaN() }
