package main

import (
	"encoding/json"

	elk "github.com/d2lang/elk-go"
)

// elkCheck runs elk-go (the native Go ELK D2 v0.9.0 calls) on an ELK JSON graph, the one D2's glue marshals before its elk.LayoutJSON call
// (see elkcmp.mjs, which records the graph the JS glue builds), and prints the layout JSON as elk-go returns it: {"out": <graph>} or {"err": ...}.
func elkCheck(in input) interface{} {
	out, err := elk.LayoutJSON(in.Diagram)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	return map[string]interface{}{"out": json.RawMessage(out)}
}
