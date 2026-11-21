package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"unsafe"

	"github.com/alecthomas/chroma/v2"
)

// The chroma lexers that are not plain RegexLexers: delegating lexers (DelegatingLexer(root, language)), type remapping lexers (TypeRemappingLexer) and
// the markdown lexer (front matter + a RegexLexer). chromadump exports them as {"wrap": kind, ...} with their RegexLexers as XML trees; their unexported
// fields are read with reflect/unsafe, and the word lists of the remapping lexers (closures in chroma) are read from chroma's own source.

// unexported returns v readable even when it is an unexported struct field.
func unexported(v reflect.Value) reflect.Value {
	return reflect.NewAt(v.Type(), unsafe.Pointer(v.UnsafeAddr())).Elem()
}

func lexerField(l chroma.Lexer, name string) chroma.Lexer {
	v := reflect.ValueOf(l).Elem().FieldByName(name)
	return unexported(v).Interface().(chroma.Lexer)
}

func treeOf(l chroma.Lexer) interface{} {
	rl, ok := l.(*chroma.RegexLexer)
	if !ok {
		return map[string]string{"error": fmt.Sprintf("%T is not a RegexLexer", l)}
	}
	data, err := chroma.Marshal(rl)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	return xmlTree(data)
}

// wrapLexer describes a lexer that is not a RegexLexer; ok is false when it is of a kind that is not handled.
func wrapLexer(l chroma.Lexer) (out interface{}, ok bool) {
	t := reflect.TypeOf(l).String()
	switch t {
	case "*chroma.delegatingLexer":
		return map[string]interface{}{"wrap": "delegate", "root": treeOf(lexerField(l, "root")), "language": treeOf(lexerField(l, "language"))}, true
	case "*lexers.markdownLexer":
		inner := reflect.ValueOf(l).Elem().FieldByName("Lexer").Interface().(chroma.Lexer)
		return map[string]interface{}{"wrap": "markdown", "lexer": treeOf(inner)}, true
	case "*lexers.httpBodyContentTyper":
		inner := reflect.ValueOf(l).Elem().FieldByName("Lexer").Interface().(*chroma.RegexLexer)
		return map[string]interface{}{"wrap": "http", "lexer": treeOf(patchFuncs(inner, map[string]string{
			"([^\\s:]+)( *)(:)":       "httpHeaderBlock",
			"([\\t ]+)([^\\r\\n]+)": "httpContinuousHeaderBlock",
			".+":                     "httpContentBlock",
		}))}, true
	case "*chroma.remappingLexer":
		mapping, ok := remapping(l.Config().Name) // the mapping is a closure in chroma: it is read from the source
		if !ok {
			return nil, false
		}
		return map[string]interface{}{"wrap": "remap", "lexer": treeOf(lexerField(l, "lexer")), "mapping": mapping}, true
	}
	return nil, false
}

var remapSources = map[string]struct{ file string }{
	"Common Lisp": {"cl.go"},
	"EmacsLisp":   {"emacs.go"},
}

// remapping reads the TypeMapping literal of the lexer's Go source: [[from, to, words]...]
func remapping(name string) (interface{}, bool) {
	src, ok := remapSources[name]
	if !ok {
		return nil, false
	}
	dirOut, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/alecthomas/chroma/v2").Output()
	if err != nil {
		return nil, false
	}
	dir := filepath.Join(strings.TrimSpace(string(dirOut)), "lexers")
	fset := token.NewFileSet()
	vars := map[string][]string{}
	var mapping [][3]interface{}
	for _, f := range []string{"cl.go", "emacs.go"} {
		file, err := parser.ParseFile(fset, filepath.Join(dir, f), nil, 0)
		if err != nil {
			return nil, false
		}
		for _, d := range file.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok {
				continue
			}
			for _, sp := range gd.Specs {
				vs, ok := sp.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, n := range vs.Names {
					if i < len(vs.Values) {
						if words, ok := evalWords(vs.Values[i], vars); ok {
							vars[n.Name] = words
						}
					}
				}
			}
		}
		if f != src.file {
			continue
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if id, ok := call.Fun.(*ast.Ident); !ok || id.Name != "TypeRemappingLexer" || len(call.Args) != 2 {
				return true
			}
			lit := call.Args[1].(*ast.CompositeLit)
			for _, e := range lit.Elts {
				el := e.(*ast.CompositeLit)
				words, _ := evalWords(el.Elts[2], vars)
				mapping = append(mapping, [3]interface{}{el.Elts[0].(*ast.Ident).Name, el.Elts[1].(*ast.Ident).Name, words})
			}
			return false
		})
	}
	return mapping, true
}

// evalWords evaluates a []string literal, an identifier of one, or append(a, b...).
func evalWords(e ast.Expr, vars map[string][]string) ([]string, bool) {
	switch x := e.(type) {
	case *ast.CompositeLit:
		var out []string
		for _, el := range x.Elts {
			bl, ok := el.(*ast.BasicLit)
			if !ok {
				return nil, false
			}
			s, err := strconv.Unquote(bl.Value)
			if err != nil {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	case *ast.Ident:
		w, ok := vars[x.Name]
		return w, ok
	case *ast.CallExpr:
		if id, ok := x.Fun.(*ast.Ident); ok && id.Name == "append" && len(x.Args) == 2 {
			a, ok1 := evalWords(x.Args[0], vars)
			b, ok2 := evalWords(x.Args[1], vars)
			return append(append([]string{}, a...), b...), ok1 && ok2
		}
	}
	return nil, false
}

// patchFuncs replaces the EmitterFunc rules of a lexer by `using "@fn:<name>"` (the name is chosen by a substring of the rule's pattern), which chroma.Marshal
// can serialise and genlexers.mjs turns into a named built-in emitter of public/d2/highlight.js.
func patchFuncs(rl *chroma.RegexLexer, byPattern map[string]string) *chroma.RegexLexer {
	rules, _ := rl.Rules()
	clone := rules.Clone()
	for state, list := range clone {
		for i, r := range list {
			if _, ok := r.Type.(chroma.EmitterFunc); !ok {
				continue
			}
			for sub, name := range byPattern {
				if strings.Contains(r.Pattern, sub) {
					clone[state][i].Type = chroma.Using("@fn:" + name)
				}
			}
		}
	}
	return chroma.MustNewLexer(rl.Config(), func() chroma.Rules { return clone })
}
