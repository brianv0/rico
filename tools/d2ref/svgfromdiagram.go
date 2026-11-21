package main

import (
	"context"
	"encoding/json"
	"io/fs"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2dagrelayout"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/d2target"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

// ropts are the render options a case can set on top of what d2lib.Compile fills in from d2-config.
type ropts struct {
	Pad                *int64                   `json:"pad"`
	Sketch             *bool                    `json:"sketch"`
	Center             *bool                    `json:"center"`
	ThemeID            *int64                   `json:"themeID"`
	DarkThemeID        *int64                   `json:"darkThemeID"`
	ThemeOverrides     *d2target.ThemeOverrides `json:"themeOverrides"`
	DarkThemeOverrides *d2target.ThemeOverrides `json:"darkThemeOverrides"`
	Scale              *float64                 `json:"scale"`
	MasterID           string                   `json:"masterID"`
	NoXMLTag           *bool                    `json:"noXMLTag"`
	Salt               *string                  `json:"salt"`
	OmitVersion        *bool                    `json:"omitVersion"`
	Multiboard         bool                     `json:"multiboard"`
}

func (r *ropts) apply(ro *d2svg.RenderOpts) {
	if r == nil {
		return
	}
	if r.Pad != nil {
		ro.Pad = r.Pad
	}
	if r.Sketch != nil {
		ro.Sketch = r.Sketch
	}
	if r.Center != nil {
		ro.Center = r.Center
	}
	if r.ThemeID != nil {
		ro.ThemeID = r.ThemeID
	}
	if r.DarkThemeID != nil {
		ro.DarkThemeID = r.DarkThemeID
	}
	if r.ThemeOverrides != nil {
		ro.ThemeOverrides = r.ThemeOverrides
	}
	if r.DarkThemeOverrides != nil {
		ro.DarkThemeOverrides = r.DarkThemeOverrides
	}
	if r.Scale != nil {
		ro.Scale = r.Scale
	}
	ro.MasterID = r.MasterID
	if r.NoXMLTag != nil {
		ro.NoXMLTag = r.NoXMLTag
	}
	if r.Salt != nil {
		ro.Salt = r.Salt
	}
	if r.OmitVersion != nil {
		ro.OmitVersion = r.OmitVersion
	}
}

// roJSON is RenderOpts as the JS renderer takes it (camelCase).
func roJSON(ro *d2svg.RenderOpts) map[string]interface{} {
	return map[string]interface{}{
		"pad": ro.Pad, "sketch": ro.Sketch, "center": ro.Center, "themeID": ro.ThemeID, "darkThemeID": ro.DarkThemeID,
		"themeOverrides": ro.ThemeOverrides, "darkThemeOverrides": ro.DarkThemeOverrides, "scale": ro.Scale,
		"masterID": ro.MasterID, "noXMLTag": ro.NoXMLTag, "salt": ro.Salt, "omitVersion": ro.OmitVersion,
	}
}

// svgFromDiagram: {diagram, ro, svg, err}. With "text" it runs d2lib.Compile (dagre) first; with "diagram" (a
// d2target.Diagram as JSON, such as D2's board.exp.json) it renders that directly. "ropts" overrides render options.
func svgFromDiagram(in input, ruler *textmeasure.Ruler, fsys fs.FS) interface{} {
	ro := &d2svg.RenderOpts{}
	var diagram *d2target.Diagram
	if len(in.Diagram) > 0 {
		diagram = &d2target.Diagram{}
		if err := json.Unmarshal(in.Diagram, diagram); err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		ro.ThemeID = go2.Pointer(int64(0))
		if diagram.Config != nil {
			if diagram.Config.ThemeID != nil {
				ro.ThemeID = diagram.Config.ThemeID
			}
			ro.DarkThemeID = diagram.Config.DarkThemeID
			ro.Sketch = diagram.Config.Sketch
			ro.Pad = diagram.Config.Pad
			ro.Center = diagram.Config.Center
			ro.ThemeOverrides = diagram.Config.ThemeOverrides
			ro.DarkThemeOverrides = diagram.Config.DarkThemeOverrides
		}
		in.Ropts.apply(ro)
	} else {
		ctx := log.WithDefault(context.Background())
		layout := in.Layout
		if layout == "" {
			layout = "dagre"
		}
		opts := &d2lib.CompileOptions{
			UTF16Pos: in.UTF16Pos, FS: fsys, Ruler: ruler, InputPath: in.Path, Layout: go2.Pointer(layout),
			LayoutResolver: func(engine string) (d2graph.LayoutGraph, error) {
				return d2dagrelayout.DefaultLayout, nil
			},
		}
		in.Ropts.apply(ro)
		var err error
		diagram, _, err = d2lib.Compile(ctx, in.Text, opts, ro)
		if err != nil {
			return map[string]interface{}{"diagram": diagram, "err": errString(err)}
		}
	}
	var svgOut interface{}
	var err error
	if in.Ropts != nil && in.Ropts.Multiboard {
		var boards [][]byte
		boards, err = d2svg.RenderMultiboard(diagram, ro)
		ss := []string{}
		for _, b := range boards {
			ss = append(ss, string(b))
		}
		svgOut = ss
	} else {
		var b []byte
		b, err = d2svg.Render(diagram, ro)
		svgOut = string(b)
	}
	return map[string]interface{}{"diagram": diagram, "ro": roJSON(ro), "svg": svgOut, "err": errString(err)}
}
