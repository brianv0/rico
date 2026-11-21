package main

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
)

// zlibCheck: {"data": <base64>} -> {"out": <base64>}: compress/zlib at the default level, Write; Flush; Close, as lib/font does.
func zlibCheck(in input) interface{} {
	data, err := base64.StdEncoding.DecodeString(in.Data)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	w.Write(data)
	w.Flush()
	w.Close()
	return map[string]interface{}{"out": base64.StdEncoding.EncodeToString(buf.Bytes())}
}
