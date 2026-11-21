package main

import (
	"context"
	"encoding/json"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/engine"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/quality"
)

// runFixture handles the modes that take a graphjson fixture ({"graph": ...}) instead of D2 text.
//
//	graphjson   Unmarshal + Serialize round trip -> {"graph"} (or {"err"})
//	fstages     the engine pipeline on the fixture for one seed ("seed", default 123 as in the engine's golden tests)
//	            -> {"err", "penalty", "area", "stages": [{index, name, graph}], "final"}
//	fscore      quality.EvaluateWithArea of the fixture as it is -> {"penalty", "area", "err"}
func runFixture(mode string, in input) interface{} {
	ctx := context.Background()
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, in.Graph, g); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	switch mode {
	case "graphjson":
		return map[string]interface{}{"graph": ser(g)}
	case "fscore":
		penalty, area, err := quality.EvaluateWithArea(ctx, g)
		return map[string]interface{}{"penalty": penalty, "area": area, "err": errString(err)}
	case "fstages":
		seed := int64(123)
		if len(in.Seeds) > 0 {
			seed = in.Seeds[0]
		}
		var stages []stageRecord
		out, err := engine.XLayoutObserved(ctx, g, engine.LayoutOptions{Seed: seed}, func(index int, name string, tg *layoutgraph.Graph) error {
			stages = append(stages, stageRecord{Index: index, Name: name, Graph: ser(tg)})
			return nil
		})
		res := map[string]interface{}{"err": errString(err), "stages": stages}
		if err == nil {
			penalty, area, qerr := quality.EvaluateWithArea(ctx, out)
			res["penalty"], res["area"], res["scoreErr"] = penalty, area, errString(qerr)
			res["final"] = ser(out)
		}
		return res
	}
	return map[string]string{"panic": "unknown mode " + mode}
}

var _ json.RawMessage
