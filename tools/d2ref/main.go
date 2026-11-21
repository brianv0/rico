// d2ref runs the reference (Go) D2 implementation so the JS port in public/d2/ can be diffed against it.
//
//	go run . corpus <d2 source dir> > corpus.jsonl   # every D2 snippet in D2's own tests
//	go run . parse  < cases.jsonl                    # d2parser.Parse       -> {ast, err}
//	go run . ir     < cases.jsonl                    # d2ir.Compile         -> {ir, err}
//	go run . graph  < cases.jsonl                    # d2compiler.Compile   -> {graph, config, err}
//	go run . layout < cases.jsonl                    # d2lib.Compile        -> {diagram, err}   (dimensions + layout)
//	go run . render < cases.jsonl                    # d2lib.Compile + d2svg -> {svg, err}
//
// Input: one JSON object per line, {"path", "text", "utf16"?, "layout"?, "fs"?}. Output: one JSON object per line.
// A Go panic in one case is reported as {"panic": "..."} so a corpus run never stops early.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"oss.terrastruct.com/d2/d2ast"
	"oss.terrastruct.com/d2/d2compiler"
	"oss.terrastruct.com/d2/d2graph"
	"oss.terrastruct.com/d2/d2ir"
	"oss.terrastruct.com/d2/d2layouts/d2dagrelayout"
	"oss.terrastruct.com/d2/d2layouts/d2elklayout"
	"oss.terrastruct.com/d2/d2lib"
	"oss.terrastruct.com/d2/d2parser"
	"oss.terrastruct.com/d2/d2renderers/d2svg"
	"oss.terrastruct.com/d2/lib/log"
	"oss.terrastruct.com/d2/lib/memfs"
	"oss.terrastruct.com/d2/lib/textmeasure"
	"oss.terrastruct.com/util-go/go2"
)

type input struct {
	Path     string            `json:"path"`
	Text     string            `json:"text"`
	UTF16Pos bool              `json:"utf16"`
	Layout   string            `json:"layout"` // dagre (default) or elk
	FS       map[string]string `json:"fs"`     // extra files for imports

	// measure mode
	FontFamily string `json:"fontFamily"`
	MonoFamily string `json:"monoFamily"`
	FontSize   int    `json:"fontSize"`
	Bold       bool   `json:"bold"`
	Italic     bool   `json:"italic"`
	Language   string `json:"language"`
	Markdown   bool   `json:"markdown"`

	// shape mode
	Shape  string  `json:"shape"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: d2ref corpus <dir> | parse | ir | graph | layout | render  (cases as JSON lines on stdin)")
		os.Exit(2)
	}
	if os.Args[1] == "corpus" {
		corpus(os.Args[2])
		return
	}
	if os.Args[1] == "fontmetrics" {
		fontmetrics()
		return
	}
	ruler, err := textmeasure.NewRuler()
	if err != nil {
		panic(err)
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
		out.Encode(run(os.Args[1], in, ruler))
	}
}

func run(mode string, in input, ruler *textmeasure.Ruler) (res interface{}) {
	defer func() {
		if r := recover(); r != nil {
			res = map[string]string{"panic": fmt.Sprint(r)}
		}
	}()
	var fsys fs.FS
	if in.FS != nil {
		files := map[string]string{in.Path: in.Text}
		for k, v := range in.FS {
			files[k] = v
		}
		fsys, _ = memfs.New(files)
	}
	switch mode {
	case "measure":
		return measure(in, ruler)
	case "mdhtml":
		html, err := textmeasure.RenderMarkdown(in.Text)
		return map[string]interface{}{"html": html, "err": errString(err)}
	case "shape":
		return shapeCheck(in)
	case "parse":
		ast, err := d2parser.Parse(in.Path, strings.NewReader(in.Text), &d2parser.ParseOptions{UTF16Pos: in.UTF16Pos})
		return struct {
			AST *d2ast.Map `json:"ast"`
			Err error      `json:"err"`
		}{ast, err}
	case "ir":
		ast, err := d2parser.Parse(in.Path, strings.NewReader(in.Text), &d2parser.ParseOptions{UTF16Pos: in.UTF16Pos})
		if err != nil {
			return map[string]interface{}{"err": err}
		}
		m, _, err := d2ir.Compile(ast, &d2ir.CompileOptions{UTF16Pos: in.UTF16Pos, FS: fsys})
		return struct {
			IR  *d2ir.Map `json:"ir"`
			Err error     `json:"err"`
		}{m, err}
	case "graph":
		g, config, err := d2compiler.Compile(in.Path, strings.NewReader(in.Text), &d2compiler.CompileOptions{UTF16Pos: in.UTF16Pos, FS: fsys})
		return map[string]interface{}{"graph": g, "config": config, "err": errString(err)}
	case "layout", "render":
		ctx := log.WithDefault(context.Background())
		layout := in.Layout
		if layout == "" {
			layout = "dagre"
		}
		opts := &d2lib.CompileOptions{
			UTF16Pos: in.UTF16Pos, FS: fsys, Ruler: ruler, InputPath: in.Path, Layout: go2.Pointer(layout),
			LayoutResolver: func(engine string) (d2graph.LayoutGraph, error) {
				if engine == "elk" {
					return d2elklayout.DefaultLayout, nil
				}
				return d2dagrelayout.DefaultLayout, nil
			},
		}
		ro := &d2svg.RenderOpts{}
		diagram, _, err := d2lib.Compile(ctx, in.Text, opts, ro)
		if err != nil || mode == "layout" {
			return map[string]interface{}{"diagram": diagram, "err": errString(err)}
		}
		svg, err := d2svg.Render(diagram, ro)
		return map[string]interface{}{"svg": string(svg), "err": errString(err)}
	}
	fmt.Fprintln(os.Stderr, "unknown mode", mode)
	os.Exit(2)
	return nil
}

func errString(err error) interface{} {
	if err == nil {
		return nil
	}
	return err.Error()
}

// corpus prints every D2 snippet found in D2's tests: the .d2 files under testdata/ and the
// `text:` / `script:` string fields of test-case literals in *_test.go, as {"path", "text", "from"} lines.
func corpus(root string) {
	out := json.NewEncoder(os.Stdout)
	seen := map[string]bool{}
	var cases []map[string]string
	add := func(from, text string) {
		if seen[text] || strings.TrimSpace(text) == "" {
			return
		}
		seen[text] = true
		cases = append(cases, map[string]string{"from": from, "text": text})
	}
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		switch {
		case strings.HasSuffix(p, ".d2") && strings.Contains(p, "testdata"):
			if b, err := os.ReadFile(p); err == nil && len(b) < 200_000 {
				add(rel, string(b))
			}
		case strings.HasSuffix(p, "_test.go"):
			f, err := parser.ParseFile(token.NewFileSet(), p, nil, 0)
			if err != nil {
				return nil
			}
			ast.Inspect(f, func(n ast.Node) bool {
				kv, ok := n.(*ast.KeyValueExpr)
				if !ok {
					return true
				}
				k, ok := kv.Key.(*ast.Ident)
				if !ok || (k.Name != "text" && k.Name != "script") {
					return true
				}
				if s, ok := stringLit(kv.Value); ok {
					add(rel+":"+k.Name, s)
				}
				return true
			})
		}
		return nil
	})
	sort.SliceStable(cases, func(i, j int) bool { return cases[i]["from"] < cases[j]["from"] })
	for i, c := range cases {
		c["path"] = fmt.Sprintf("corpus/%04d.d2", i)
		out.Encode(c)
	}
}

// stringLit evaluates a string literal or a concatenation of them.
func stringLit(e ast.Expr) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(v.Value)
		return s, err == nil
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return "", false
		}
		a, ok1 := stringLit(v.X)
		b, ok2 := stringLit(v.Y)
		return a + b, ok1 && ok2
	case *ast.ParenExpr:
		return stringLit(v.X)
	}
	return "", false
}
