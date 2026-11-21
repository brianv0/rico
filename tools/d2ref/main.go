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

	"github.com/d2lang/d2/d2ast"
	"github.com/d2lang/d2/d2compiler"
	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2ir"
	"github.com/d2lang/d2/d2layouts/d2dagrelayout"
	"github.com/d2lang/d2/d2layouts/d2elklayout"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2parser"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/memfs"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
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

	// target mode
	Diagram json.RawMessage `json:"diagram"`

	// svgfromdiagram mode
	Ropts *ropts `json:"ropts"`

	// rough mode
	Rough json.RawMessage `json:"rough"`

	// zlib / woff / fontsubset modes
	Data   string `json:"data"`
	Corpus string `json:"corpus"`
	Family string `json:"family"`
	Style  string `json:"style"`

	// label mode
	Route  [][]float64 `json:"route"`
	Stroke float64     `json:"stroke"`
	Pct    float64     `json:"pct"`
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
	if os.Args[1] == "chromadump" {
		chromadump(os.Args[2:])
		return
	}
	if os.Args[1] == "themes" {
		themesdump()
		return
	}
	if os.Args[1] == "unicodeprobe" {
		unicodeprobe()
		return
	}
	if os.Args[1] == "uniprops" {
		uniprops()
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
		if err := out.Encode(run(os.Args[1], in, ruler)); err != nil {
			// e.g. NaN in a float field: encoding/json refuses and prints nothing; keep the output aligned with the input
			out.Encode(map[string]string{"panic": err.Error()})
		}
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
	case "label":
		return labelCheck(in)
	case "color":
		return colorCheck(in)
	case "mdtree":
		return mdtree(in)
	case "element":
		return elementCheck(in)
	case "url":
		return urlCheck(in)
	case "htmlunescape":
		return htmlUnescapeCheck(in)
	case "xml":
		return xmlCheck(in)
	case "dims":
		return dimsCheck(in, ruler)
	case "dagro":
		return dagroCheck(in)
	case "graphmethods":
		return graphMethods(in)
	case "sprintf":
		return sprintfCheck(in)
	case "strconv":
		return strconvCheck(in)
	case "sortslice":
		return sortCheck(in)
	case "target":
		return targetCheck(in)
	case "targetstatics":
		return targetStatics()
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
	case "zlib":
		return zlibCheck(in)
	case "latex":
		return latexCheck(in)
	case "regexp2":
		return regexp2Probe(in)
	case "highlight":
		return highlightCheck(in)
	case "linebreak":
		return linebreakCheck(in)
	case "svgfromdiagram":
		return svgFromDiagram(in, ruler, fsys)
	case "rough":
		return roughCheck(in)
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
// Test cases that come with imported files (a `files:` map, or d2ir's compileFS calls) also carry {"fs"} and
// path index.d2.
func corpus(root string) {
	out := json.NewEncoder(os.Stdout)
	seen := map[string]bool{}
	var cases []map[string]interface{}
	add := func(from, text string) {
		if seen[text] || strings.TrimSpace(text) == "" {
			return
		}
		seen[text] = true
		cases = append(cases, map[string]interface{}{"from": from, "text": text})
	}
	// Cases with imports: the main file is index.d2 and `files` holds the rest.
	addFS := func(from, text string, files map[string]string) {
		b, _ := json.Marshal(files)
		key := "fs:" + text + string(b)
		if seen[key] || strings.TrimSpace(text) == "" {
			return
		}
		seen[key] = true
		cases = append(cases, map[string]interface{}{"from": from, "text": text, "fs": files, "path": "index.d2"})
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
				// compileFS(t, "index.d2", map[string]string{...}) in d2ir's import tests.
				if call, ok := n.(*ast.CallExpr); ok && len(call.Args) >= 3 {
					if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "compileFS" {
						if files, ok := stringMap(call.Args[2]); ok {
							if name, ok := stringLit(call.Args[1]); ok && files[name] != "" {
								rest := map[string]string{}
								for k, v := range files {
									if k != name {
										rest[k] = v
									}
								}
								addFS(rel+":compileFS", files[name], rest)
							}
						}
					}
				}
				// Test cases that have both `text` and `files`.
				if lit, ok := n.(*ast.CompositeLit); ok {
					var text string
					var files map[string]string
					var haveText bool
					for _, el := range lit.Elts {
						kv, ok := el.(*ast.KeyValueExpr)
						if !ok {
							continue
						}
						k, ok := kv.Key.(*ast.Ident)
						if !ok {
							continue
						}
						switch k.Name {
						case "text", "script":
							text, haveText = stringLit(kv.Value)
						case "files":
							files, _ = stringMap(kv.Value)
						}
					}
					if haveText && files != nil {
						addFS(rel+":files", text, files)
					}
				}
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
	sort.SliceStable(cases, func(i, j int) bool { return cases[i]["from"].(string) < cases[j]["from"].(string) })
	for i, c := range cases {
		if _, ok := c["path"]; !ok {
			c["path"] = fmt.Sprintf("corpus/%04d.d2", i)
		}
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

// stringMap evaluates a map[string]string literal.
func stringMap(e ast.Expr) (map[string]string, bool) {
	lit, ok := e.(*ast.CompositeLit)
	if !ok {
		return nil, false
	}
	m := map[string]string{}
	for _, el := range lit.Elts {
		kv, ok := el.(*ast.KeyValueExpr)
		if !ok {
			return nil, false
		}
		k, ok1 := stringLit(kv.Key)
		v, ok2 := stringLit(kv.Value)
		if !ok1 || !ok2 {
			return nil, false
		}
		m[k] = v
	}
	return m, true
}
