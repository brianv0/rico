package main

import (
	"github.com/d2lang/d2/d2renderers/d2latex"
)

// latexCheck: {"text": <TeX>} -> {"svg", "width", "height", "err", "merr"} through d2latex (mathjax-go), as d2graph.GetLabelSize and d2svg call it.
func latexCheck(in input) interface{} {
	svg, err := d2latex.Render(in.Text)
	w, h, merr := d2latex.Measure(in.Text)
	return map[string]interface{}{"svg": svg, "err": errString(err), "width": w, "height": h, "merr": errString(merr)}
}
