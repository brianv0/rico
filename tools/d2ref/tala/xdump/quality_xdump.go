package main

// Modes of the quality port check (public/d2/tala/quality.js; JS twin: tools/d2ref/tala/pkgcheck.mjs):
//
//	pkgquality  {graph, args:{deep?, expect?, limits?}}: the evaluators on a completed layout. With args.expect the recording of the
//	            pipeline is the reference and is returned as it is. Otherwise Go prints {penalty, area, used, err, metrics, mused, merr}
//	            (EvaluateWithArea and Inspect); args.limits (non-empty) adds `limits`: both again with work limits used-1, used/2, 1, 0.
//	pkgscore    {args:{scores:[[penalty1, area1, penalty2, area2]...]}}: Score.Compare of each row (numbers or "NaN", "+Inf", "-Inf").

import (
	"context"
	"math"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/quality"
	"github.com/d2lang/d2/lib/textmeasure"
)

func init() {
	pkgModes["pkgquality"] = runPkgQuality
	pkgModes["pkgscore"] = runPkgScore
}

func metricsJSON(m quality.Metrics) map[string]interface{} {
	return map[string]interface{}{
		"nodeOverlaps": m.NodeOverlaps, "routeObstructions": m.RouteObstructions, "textOcclusions": m.TextOcclusions,
		"crossings": m.Crossings, "detour": m.Detour, "routeLength": m.RouteLength,
	}
}

func evalBoth(ctx context.Context, in input, limit int64) map[string]interface{} {
	g, err := unmarshalGraph(in)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	penalty, area, used, eerr := quality.XEvaluateLimit(ctx, g, limit)
	if eerr != nil {
		penalty, area = 0, 0
	}
	metrics, mused, merr := quality.XInspectLimit(ctx, g, limit)
	return map[string]interface{}{
		"penalty": penalty, "area": area, "used": used, "err": errString(eerr),
		"metrics": metricsJSON(metrics), "mused": mused, "merr": errString(merr),
	}
}

func runPkgQuality(in input, _ *textmeasure.Ruler) interface{} {
	a := parseArgs(in)
	if len(a.Expect) > 0 {
		return a.Expect
	}
	ctx := argsCtx(a)
	res := evalBoth(ctx, in, evaluationWorkUnits)
	if len(a.Limits) > 0 {
		used, _ := res["used"].(int64)
		mused, _ := res["mused"].(int64)
		if mused > used {
			used = mused
		}
		list := []interface{}{}
		for _, l := range limitList(used) {
			r := evalBoth(ctx, in, l)
			r["limit"] = l
			list = append(list, r)
		}
		res["limits"] = list
	}
	return res
}

func scoreValue(v interface{}) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		switch x {
		case "NaN":
			return math.NaN()
		case "+Inf":
			return math.Inf(1)
		case "-Inf":
			return math.Inf(-1)
		}
	}
	return 0
}

func runPkgScore(in input, _ *textmeasure.Ruler) interface{} {
	a := parseArgs(in)
	out := []int{}
	for _, row := range a.Scores {
		s1 := quality.Score{Penalty: scoreValue(row[0]), Area: scoreValue(row[1])}
		s2 := quality.Score{Penalty: scoreValue(row[2]), Area: scoreValue(row[3])}
		out = append(out, s1.Compare(s2))
	}
	return map[string]interface{}{"compare": out}
}
