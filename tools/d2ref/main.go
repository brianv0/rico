// d2ref runs the reference (Go) D2 implementation so the JS port in public/d2/ can be diffed against it.
//
//	echo '{"path":"x.d2","text":"a -> b"}' | go run . parse
//
// Input: one JSON object per line on stdin. Output: one JSON object per line on stdout.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"oss.terrastruct.com/d2/d2ast"
	"oss.terrastruct.com/d2/d2parser"
)

type input struct {
	Path     string `json:"path"`
	Text     string `json:"text"`
	UTF16Pos bool   `json:"utf16"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: d2ref parse < cases.jsonl")
		os.Exit(2)
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	out := json.NewEncoder(os.Stdout)
	for sc.Scan() {
		var in input
		if err := json.Unmarshal(sc.Bytes(), &in); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		switch os.Args[1] {
		case "parse":
			ast, err := d2parser.Parse(in.Path, strings.NewReader(in.Text), &d2parser.ParseOptions{UTF16Pos: in.UTF16Pos})
			out.Encode(struct {
				AST *d2ast.Map `json:"ast"`
				Err error      `json:"err"`
			}{ast, err})
		default:
			fmt.Fprintln(os.Stderr, "unknown mode", os.Args[1])
			os.Exit(2)
		}
	}
}
