package main

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
)

// encoding/json refuses NaN and Inf, which the layout geometry produces on purpose (empty containers have +Inf sentinel boxes).
// sanitize rewrites a result tree for printing: non-finite floats become the strings "+Inf", "-Inf" and "NaN" (the JS side applies the same
// rule in bigjson.plain), serialized graphs are kept as they are.
func sanitize(v interface{}) interface{} {
	return sanitizeValue(reflect.ValueOf(v))
}

func sanitizeValue(rv reflect.Value) interface{} {
	if !rv.IsValid() {
		return nil
	}
	if rv.Type() == reflect.TypeOf((*graphjson.SerializedGraph)(nil)) || rv.Type() == reflect.TypeOf(graphjson.SerializedGraph{}) {
		b, err := json.Marshal(rv.Interface())
		if err != nil {
			return map[string]string{"serializeError": err.Error()}
		}
		return json.RawMessage(b)
	}
	switch rv.Kind() {
	case reflect.Interface, reflect.Ptr:
		if rv.IsNil() {
			return nil
		}
		return sanitizeValue(rv.Elem())
	case reflect.Float32, reflect.Float64:
		f := rv.Float()
		switch {
		case math.IsNaN(f):
			return "NaN"
		case math.IsInf(f, 1):
			return "+Inf"
		case math.IsInf(f, -1):
			return "-Inf"
		}
		return f
	case reflect.Slice:
		if rv.IsNil() {
			return nil
		}
		fallthrough
	case reflect.Array:
		if rv.Kind() == reflect.Slice && rv.Type().Elem().Kind() == reflect.Uint8 {
			return rv.Interface()
		}
		out := make([]interface{}, rv.Len())
		for i := range out {
			out[i] = sanitizeValue(rv.Index(i))
		}
		return out
	case reflect.Map:
		if rv.IsNil() {
			return nil
		}
		out := map[string]interface{}{}
		for _, k := range rv.MapKeys() {
			out[fmt.Sprint(k.Interface())] = sanitizeValue(rv.MapIndex(k))
		}
		return out
	case reflect.Struct:
		out := map[string]interface{}{}
		t := rv.Type()
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			name := f.Name
			if tag := f.Tag.Get("json"); tag != "" && tag != "-" {
				for j := 0; j < len(tag); j++ {
					if tag[j] == ',' {
						tag = tag[:j]
						break
					}
				}
				if tag != "" {
					name = tag
				}
			}
			out[name] = sanitizeValue(rv.Field(i))
		}
		return out
	}
	return rv.Interface()
}
