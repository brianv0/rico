package main

import (
	"encoding/json"
	"math"

	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/shape"
)

// F is a float64 whose JSON form survives NaN and Inf (as strings), so the JS side can reproduce it.
type F float64

func (f F) MarshalJSON() ([]byte, error) {
	v := float64(f)
	switch {
	case math.IsNaN(v):
		return []byte(`"NaN"`), nil
	case math.IsInf(v, 1):
		return []byte(`"+Inf"`), nil
	case math.IsInf(v, -1):
		return []byte(`"-Inf"`), nil
	}
	return json.Marshal(v)
}

func pt(p *geo.Point) []F {
	if p == nil {
		return nil
	}
	return []F{F(p.X), F(p.Y)}
}

func boxOut(b *geo.Box) interface{} {
	if b == nil {
		return nil
	}
	return map[string]interface{}{"tl": pt(b.TopLeft), "w": F(b.Width), "h": F(b.Height)}
}

func pts(ps []*geo.Point) [][]F {
	out := [][]F{}
	for _, p := range ps {
		out = append(out, pt(p))
	}
	return out
}

// shapeCheck exercises lib/shape for one shape type and box size: inner box, placements, fit, padding, SVG path
// data, perimeter, perimeter/segment intersections and TraceToShapeBorder.
func shapeCheck(in input) interface{} {
	box := geo.NewBox(geo.NewPoint(10, 20), in.Width, in.Height)
	s := shape.NewShape(in.Shape, box)
	out := map[string]interface{}{}
	out["type"] = s.GetType()
	out["ar1"] = s.AspectRatio1()
	out["rect"] = s.IsRectangular()
	if s.Is(shape.CLOUD_TYPE) {
		s.SetInnerBoxAspectRatio(1.7)
		out["cloudInner"] = boxOut(s.GetInnerBox())
		s.SetInnerBoxAspectRatio(0)
	}
	out["inner"] = boxOut(s.GetInnerBox())
	out["innerForContent"] = boxOut(s.GetInnerBoxForContent(50, 20))
	out["innerForContent2"] = boxOut(s.GetInnerBoxForContent(20, 50))
	for i, a := range [][4]float64{{in.Width / 3, in.Height / 4, 6, 8}, {30, 20, 0, 0}, {100, 100, 40, 40}} {
		p := s.GetInsidePlacement(a[0], a[1], a[2], a[3])
		out["inside"+string(rune('0'+i))] = pt(&p)
	}
	px, py := s.GetDefaultPadding()
	out["padding"] = []F{F(px), F(py)}
	fits := [][]F{}
	for _, c := range [][2]float64{{30, 20}, {100, 40}, {10, 10}, {400, 300}, {1, 1}, {0, 0}, {123.5, 17.25}} {
		for _, p := range [][2]float64{{px, py}, {0, 0}, {20, 30}, {8, 6}} {
			w, h := s.GetDimensionsToFit(c[0], c[1], p[0], p[1])
			fits = append(fits, []F{F(w), F(h)})
		}
	}
	out["fit"] = fits
	out["path"] = s.GetSVGPathData()

	per := []interface{}{}
	hits := []interface{}{}
	tests := []geo.Segment{
		{Start: geo.NewPoint(box.TopLeft.X-50, box.TopLeft.Y+box.Height/2), End: geo.NewPoint(box.TopLeft.X+box.Width+50, box.TopLeft.Y+box.Height/2)},
		{Start: geo.NewPoint(box.TopLeft.X+box.Width/2, box.TopLeft.Y-50), End: geo.NewPoint(box.TopLeft.X+box.Width/2, box.TopLeft.Y+box.Height+50)},
		{Start: geo.NewPoint(box.TopLeft.X-20, box.TopLeft.Y-20), End: geo.NewPoint(box.TopLeft.X+box.Width+20, box.TopLeft.Y+box.Height+20)},
		{Start: geo.NewPoint(box.TopLeft.X+box.Width+20, box.TopLeft.Y-20), End: geo.NewPoint(box.TopLeft.X-20, box.TopLeft.Y+box.Height+20)},
		{Start: geo.NewPoint(box.TopLeft.X+box.Width/3, box.TopLeft.Y-30), End: geo.NewPoint(box.TopLeft.X+box.Width/5, box.TopLeft.Y+box.Height+40)},
		{Start: geo.NewPoint(box.TopLeft.X-10, box.TopLeft.Y+box.Height/3), End: geo.NewPoint(box.TopLeft.X+box.Width+10, box.TopLeft.Y+box.Height/4)},
	}
	for _, p := range s.Perimeter() {
		switch v := p.(type) {
		case *geo.Segment:
			per = append(per, map[string]interface{}{"seg": append(pt(v.Start), pt(v.End)...)})
		case *geo.BezierCurve:
			b := []interface{}{}
			for _, t := range []float64{0, 0.25, 0.5, 0.75, 1} {
				b = append(b, pt(v.At(t)))
			}
			per = append(per, map[string]interface{}{"bez": b})
		case *geo.Ellipse:
			per = append(per, map[string]interface{}{"ell": []F{F(v.Center.X), F(v.Center.Y), F(v.Rx), F(v.Ry)}})
		default:
			per = append(per, "?")
		}
		h := []interface{}{}
		for _, t := range tests {
			h = append(h, pts(p.Intersections(t)))
		}
		hits = append(hits, h)
	}
	out["perimeter"] = per
	out["hits"] = hits

	trace := [][]F{}
	l, t, r, b := box.TopLeft.X, box.TopLeft.Y, box.TopLeft.X+box.Width, box.TopLeft.Y+box.Height
	for _, c := range [][4]float64{
		{r, t + box.Height/2, r + 40, t + box.Height/2},
		{l, t + box.Height/3, l - 40, t + box.Height/3},
		{l + box.Width/2, t, l + box.Width/2, t - 40},
		{l + box.Width/3, b, l + box.Width/3, b + 40},
		{r, t + box.Height/4, r + 30, t + box.Height/4 - 17},
	} {
		tp := shape.TraceToShapeBorder(s, geo.NewPoint(c[0], c[1]), geo.NewPoint(c[2], c[3]))
		trace = append(trace, pt(tp))
	}
	out["trace"] = trace
	return out
}
