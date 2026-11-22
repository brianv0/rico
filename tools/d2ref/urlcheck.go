package main

import (
	"encoding/xml"
	"fmt"
	"html"
	"math"
	"net/url"
	"sort"
	"strconv"
)

// urlCheck runs net/url's Parse and ParseRequestURI on in.Text.
func urlCheck(in input) interface{} {
	out := map[string]interface{}{}
	for name, f := range map[string]func(string) (*url.URL, error){"parse": url.Parse, "parseRequestURI": url.ParseRequestURI} {
		u, err := f(in.Text)
		if err != nil {
			out[name] = map[string]interface{}{"err": err.Error()}
			continue
		}
		out[name] = map[string]interface{}{"url": u, "string": u.String(), "path": u.EscapedPath(), "hostname": u.Hostname(), "port": u.Port()}
	}
	return out
}

// htmlUnescapeCheck runs html.UnescapeString on in.Text.
func htmlUnescapeCheck(in input) interface{} {
	return map[string]interface{}{"s": html.UnescapeString(in.Text)}
}

// xmlCheck mirrors d2compiler's markdown validation: xml.Unmarshal into an interface{}.
func xmlCheck(in input) interface{} {
	var xmlParsed interface{}
	err := xml.Unmarshal([]byte(in.Text), &xmlParsed)
	if err == nil {
		return map[string]interface{}{"err": nil}
	}
	switch xmlErr := err.(type) {
	case *xml.SyntaxError:
		return map[string]interface{}{"err": xmlErr.Msg, "syntax": true}
	default:
		return map[string]interface{}{"err": err.Error()}
	}
}

// sortCheck runs sort.Slice with a comparator like SortObjectsByAST's: elements are [id, key, flag]; if either element
// has flag != 0 the comparator answers i < j, else it compares keys.
func sortCheck(in input) interface{} {
	xs := make([][]float64, len(in.Route))
	copy(xs, in.Route)
	sort.Slice(xs, func(i, j int) bool {
		if xs[i][2] != 0 || xs[j][2] != 0 {
			return i < j
		}
		return xs[i][1] < xs[j][1]
	})
	ids := make([]int, len(xs))
	for i, x := range xs {
		ids[i] = int(x[0])
	}
	return map[string]interface{}{"ids": ids}
}

// strconvCheck runs the strconv functions d2compiler uses on in.Text.
func strconvCheck(in input) interface{} {
	out := map[string]interface{}{}
	i, err := strconv.Atoi(in.Text)
	out["atoi"] = map[string]interface{}{"v": float64(i), "err": errString(err)}
	f, err := strconv.ParseFloat(in.Text, 64)
	fv := interface{}(f)
	if math.IsNaN(f) {
		fv = "NaN"
	} else if math.IsInf(f, 0) {
		fv = fmt.Sprint(f)
	}
	out["float"] = map[string]interface{}{"v": fv, "err": errString(err)}
	b, err := strconv.ParseBool(in.Text)
	out["bool"] = map[string]interface{}{"v": b, "err": errString(err)}
	return out
}

// sprintfCheck runs fmt.Sprintf with in.Text as the format and no arguments, and with one string argument.
func sprintfCheck(in input) interface{} {
	out := map[string]interface{}{"none": fmt.Sprintf(in.Text)}
	if in.Bold { // formats D2 itself builds: only %v %s %q %#v on strings
		out["one"] = fmt.Sprintf(in.Text, "arg")
		out["two"] = fmt.Sprintf(in.Text, "a b", "c")
	}
	return out
}
