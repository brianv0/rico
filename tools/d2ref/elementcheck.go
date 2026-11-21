package main

import (
	"encoding/json"
	"reflect"

	"github.com/d2lang/d2/d2themes"
	"github.com/d2lang/d2/d2themes/d2themescatalog"
)

// elementCheck renders a d2themes.ThemableElement: in.Text is JSON {"tag", "theme": id|null, "props": {Field: value}}.
func elementCheck(in input) interface{} {
	var c struct {
		Tag     string                 `json:"tag"`
		Theme   *int64                 `json:"theme"`
		Props   map[string]interface{} `json:"props"`
		Overlay string                 `json:"overlay"` // "", "pattern:<name>", "sketch:<fill>"
	}
	if err := json.Unmarshal([]byte(in.Text), &c); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	var th *d2themes.Theme
	if c.Theme != nil {
		t := d2themescatalog.Find(*c.Theme)
		th = &t
	}
	el := d2themes.NewThemableElement(c.Tag, th)
	v := reflect.ValueOf(el).Elem()
	for k, val := range c.Props {
		f := v.FieldByName(k)
		switch x := val.(type) {
		case float64:
			f.SetFloat(x)
		case string:
			f.SetString(x)
		}
	}
	out := map[string]interface{}{}
	switch {
	case len(c.Overlay) > 8 && c.Overlay[:8] == "pattern:":
		s, err := d2themes.NewPatternOverlay(el, c.Overlay[8:]).Render()
		out["overlay"] = s
		out["err"] = errString(err)
	case len(c.Overlay) > 7 && c.Overlay[:7] == "sketch:":
		s, err := d2themes.NewThemableSketchOverlay(el, c.Overlay[7:]).Render()
		out["overlay"] = s
		out["err"] = errString(err)
	}
	out["render"] = el.Render()
	out["after"] = map[string]string{"Fill": el.Fill, "Stroke": el.Stroke, "ClassName": el.ClassName}
	return out
}
