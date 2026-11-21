package main

import (
	"fmt"
	"sort"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/nodeshape"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/label"
)

// nodeshape mode: {"shape": type, "x","y","width","height", "numColumns"} -> ports and label policies of the TALA shape wrapper.
func runNodeshape(in input) interface{} {
	box := &geo.Box{TopLeft: geo.NewPoint(in.X, in.Y), Width: in.Width, Height: in.Height}
	s, kind, ok := nodeshape.New(in.Shape, box)
	if !ok {
		return map[string]interface{}{"ok": false}
	}
	nodeshape.SetNumColumns(s, in.NumColumns)
	out := map[string]interface{}{"ok": true, "kind": int(kind), "kindString": kind.String(), "numColumns": nodeshape.NumColumns(s), "type": s.GetType()}
	snap := [][]pt{}
	for _, side := range s.SnapPointPercentages() {
		l := []pt{}
		for _, p := range side {
			l = append(l, pt{p.XPercentage, p.YPercentage})
		}
		snap = append(snap, l)
	}
	out["snap"] = snap
	idx := map[string][]int{}
	cidx := map[string]int{}
	for _, o := range allOrientations {
		idx[fmt.Sprint(int(o))] = s.PortIndices(o)
		cidx[fmt.Sprint(int(o))] = s.CenterPortIndex(o)
	}
	out["portIndices"] = idx
	out["centerPortIndex"] = cidx
	out["centerPortIndices"] = s.CenterPortIndices()
	mir := [][2]int{}
	for k, v := range s.MirroredPortIndices() {
		mir = append(mir, [2]int{k, v})
	}
	sort.Slice(mir, func(i, j int) bool { return mir[i][0] < mir[j][0] })
	out["mirrored"] = mir
	tiers := map[string][]string{}
	for _, t := range []nodeshape.LabelTier{nodeshape.Good, nodeshape.OK, nodeshape.Unideal, nodeshape.Bad} {
		l := []string{}
		for p := range s.LabelPositionPreferences(t) {
			l = append(l, p.String())
		}
		sort.Strings(l)
		tiers[fmt.Sprint(int(t))] = l
	}
	out["labelPrefs"] = tiers
	tp := []interface{}{}
	for _, o := range []geo.Orientation{geo.Left, geo.Right, geo.Top} {
		for c := 0; c < 4; c++ {
			func() {
				defer func() {
					if r := recover(); r != nil {
						tp = append(tp, "panic")
					}
				}()
				p, ok := nodeshape.TableColumnPortValue(s, o, c)
				i, ok2 := nodeshape.TablePortIndex(s, o, c)
				tp = append(tp, []interface{}{pv(p), ok, i, ok2})
			}()
		}
	}
	out["tablePorts"] = tp
	ib := s.GetInnerBox()
	out["innerBox"] = []interface{}{p2(ib.TopLeft), ib.Width, ib.Height}
	ip := s.GetInsidePlacement(50, 30, 12, 8)
	out["insidePlacement"] = pv(ip)
	w, h := s.GetDimensionsToFit(70, 40, 20, 20)
	out["dimsToFit"] = []float64{w, h}
	_ = label.Unset
	return out
}
