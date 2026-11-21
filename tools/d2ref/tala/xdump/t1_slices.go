package main

import (
	"cmp"
	"encoding/json"
	"slices"
)

// t1Slices: slices.SortFunc and slices.SortStableFunc on the comparators the T1 packages use (and non-strict ones) for public/d2/tala/goslices.js.
// args {"op":"slices","kind":"stable"|"func","cmp":"loops"|"num"|"cyc","items":[[class,area],...]}; the result is the order of the input indexes.
func t1Slices(in input) interface{} {
	var a struct {
		Kind  string      `json:"kind"`
		Cmp   string      `json:"cmp"`
		Items [][]float64 `json:"items"`
	}
	json.Unmarshal(in.Args, &a)
	type item struct {
		idx   int
		class float64
		area  float64
	}
	items := make([]item, len(a.Items))
	for i, it := range a.Items {
		items[i] = item{i, it[0], it[1]}
	}
	var cmpFn func(x, y item) int
	switch a.Cmp {
	case "loops":
		// edgesInOrder: classes 0..2 are the arrowhead scores, 3 and 4 (one-sided arrows) also score 0
		score := func(c float64) int {
			if c >= 3 {
				return 0
			}
			return int(c)
		}
		cmpFn = func(x, y item) int {
			if x.class != y.class {
				xs, ys := score(x.class), score(y.class)
				switch {
				case xs < ys:
					return -1
				case ys < xs:
					return 1
				default:
					return 0
				}
			}
			switch {
			case x.area < y.area:
				return -1
			case y.area < x.area:
				return 1
			default:
				return 0
			}
		}
	case "num":
		cmpFn = func(x, y item) int { return cmp.Compare(x.area, y.area) }
	default: // "cyc": not a strict weak ordering
		n := len(items)
		cmpFn = func(x, y item) int {
			switch (x.idx - y.idx + 3*n) % 3 {
			case 0:
				return 0
			case 1:
				return -1
			}
			return 1
		}
	}
	if a.Kind == "stable" {
		slices.SortStableFunc(items, cmpFn)
	} else {
		slices.SortFunc(items, cmpFn)
	}
	order := make([]int, len(items))
	for i, it := range items {
		order[i] = it.idx
	}
	return map[string]interface{}{"order": order}
}
