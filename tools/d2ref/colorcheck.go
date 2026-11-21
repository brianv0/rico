package main

import (
	"oss.terrastruct.com/d2/lib/color"
)

// colorCheck runs the lib/color entry points on one string (in.Text).
func colorCheck(in input) interface{} {
	s := in.Text
	out := map[string]interface{}{}
	put := func(name string, v interface{}, err error) {
		if err != nil {
			out[name] = map[string]interface{}{"err": err.Error()}
		} else {
			out[name] = v
		}
	}
	d, err := color.Darken(s)
	put("darken", d, err)
	lc, err := color.LuminanceCategory(s)
	put("lumcat", lc, err)
	l, err := color.Luminance(s)
	put("lum", F(l), err)
	out["valid"] = color.ValidColor(s)
	out["isTheme"] = color.IsThemeColor(s)
	out["isGradient"] = color.IsGradient(s)
	out["isURLGradient"] = color.IsURLGradientID(s)
	rgb, err := color.Hex2RGB(s)
	put("hex2rgb", []int{int(rgb.Red), int(rgb.Green), int(rgb.Blue)}, err)
	n := color.Name2RGB(s)
	out["name2rgb"] = []int{int(n.Red), int(n.Green), int(n.Blue)}
	out["isLight"] = n.IsLight()
	g, err := color.ParseGradient(s)
	if err != nil {
		out["gradient"] = map[string]interface{}{"err": err.Error()}
	} else {
		out["gradient"] = map[string]interface{}{"g": g, "svg": color.GradientToSVG(g)}
	}
	return out
}
