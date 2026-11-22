package main

import (
	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2renderers/d2fonts"
	"github.com/d2lang/d2/d2target"
	"github.com/d2lang/d2/lib/textmeasure"
)

// measure runs the call shapes d2graph.SetDimensions uses: markdown labels go to textmeasure.MeasureMarkdown,
// everything else to d2graph.GetTextDimensionsWithMono (code blocks when "language" is set).
// Input {"text","fontFamily","monoFamily","fontSize","bold","italic","language","markdown"}.
func measure(in input, ruler *textmeasure.Ruler) interface{} {
	var family, mono *d2fonts.FontFamily
	if in.FontFamily != "" {
		f := d2fonts.FontFamily(in.FontFamily)
		family = &f
	}
	if in.MonoFamily != "" {
		f := d2fonts.FontFamily(in.MonoFamily)
		mono = &f
	}
	if in.Markdown {
		w, h, err := textmeasure.MeasureMarkdown(in.Text, ruler, family, mono, in.FontSize)
		return map[string]interface{}{"width": w, "height": h, "err": errString(err)}
	}
	t := &d2target.MText{Text: in.Text, FontSize: in.FontSize, IsBold: in.Bold, IsItalic: in.Italic, Language: in.Language}
	dims := d2graph.GetTextDimensionsWithMono(nil, ruler, t, family, mono)
	out := map[string]interface{}{"width": dims.Width, "height": dims.Height}
	if in.Language == "" {
		style := d2fonts.FONT_STYLE_REGULAR
		if in.Bold {
			style = d2fonts.FONT_STYLE_BOLD
		} else if in.Italic {
			style = d2fonts.FONT_STYLE_ITALIC
		}
		fam := d2fonts.SourceSansPro
		if family != nil {
			fam = *family
		}
		pw, ph := ruler.MeasurePrecise(fam.Font(in.FontSize, style), in.Text)
		out["precise"] = []float64{pw, ph}
	}
	return out
}
