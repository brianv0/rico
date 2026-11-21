package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters/svg"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"
)

// chromadump prints what the JS code highlighter (public/d2/highlight.js) needs from chroma v2.27.0, as one JSON document:
//
//	lexers: name -> the lexer's XML (chroma.Marshal) as a {n, a, c, t} tree, for the lexers listed in args
//	names:  every string lexers.Get resolves (names, aliases, file extensions) -> the lexer's name ("" = the fallback lexer)
//	types:  every token type -> its category and sub category (what d2svg's styleAttr falls back to)
//	styles: style name -> {background, svg: token type -> fill/font attributes as svg.StyleEntryToSVG prints them}
//
// usage: go run . chromadump <lexer name>... > chroma.json
func chromadump(names []string) {
	out := map[string]interface{}{}

	lx := map[string]interface{}{}
	for _, n := range names {
		l := lexers.Get(n)
		rl, ok := l.(*chroma.RegexLexer)
		if !ok {
			if w, ok := wrapLexer(l); ok {
				lx[l.Config().Name] = w
				continue
			}
			lx[n] = map[string]string{"error": "not a RegexLexer"}
			continue
		}
		if rl.Config().Name == "Go" {
			// the Go lexer styles `...` strings with UsingLexer(TypeRemappingLexer(GoTextTemplate, Other -> LiteralString)), a closure:
			// export it as using go-text-template; highlight.js applies the remapping for this one case
			rules, _ := rl.Rules()
			clone := rules.Clone()
			for i, r := range clone["root"] {
				if r.Pattern == "(`)([^`]*)(`)" {
					clone["root"][i].Type = chroma.ByGroups(chroma.LiteralString, chroma.Using("go-text-template"), chroma.LiteralString)
				}
			}
			rl = chroma.MustNewLexer(rl.Config(), func() chroma.Rules { return clone })
		}
		if rl.Config().Name == "reStructuredText" {
			rl = patchFuncs(rl, map[string]string{"(?:source)?code": "rstCodeBlock"})
		}
		data, err := chroma.Marshal(rl)
		if err != nil {
			lx[n] = map[string]string{"error": err.Error()}
			continue
		}
		lx[rl.Config().Name] = xmlTree(data)
	}
	out["lexers"] = lx

	cands := map[string]bool{}
	for _, l := range lexers.GlobalLexerRegistry.Lexers {
		c := l.Config()
		cands[c.Name] = true
		cands[strings.ToLower(c.Name)] = true
		for _, a := range c.Aliases {
			cands[a] = true
		}
		for _, f := range append(append([]string{}, c.Filenames...), c.AliasFilenames...) {
			if strings.HasPrefix(f, "*.") && !strings.ContainsAny(f[2:], "*?[") {
				cands[f[2:]] = true
			} else if !strings.ContainsAny(f, "*?[") {
				cands[f] = true
			}
		}
	}
	table := map[string]string{}
	keys := []string{}
	for c := range cands {
		keys = append(keys, c)
	}
	sort.Strings(keys)
	for _, c := range keys {
		l := lexers.GlobalLexerRegistry.Get(c)
		if l == nil {
			continue
		}
		table[c] = l.Config().Name
	}
	out["names"] = table

	// every MIME type -> the lexer lexers.MatchMimeType returns (the HTTP lexer lexes a body by its Content-Type)
	mimes := map[string]string{}
	for _, l := range lexers.GlobalLexerRegistry.Lexers {
		for _, m := range l.Config().MimeTypes {
			if ml := lexers.MatchMimeType(m); ml != nil {
				mimes[m] = ml.Config().Name
			}
		}
	}
	out["mimes"] = mimes

	types := map[string][]string{}
	for _, t := range chroma.TokenTypeValues() {
		types[t.String()] = []string{t.Category().String(), t.SubCategory().String()}
	}
	out["types"] = types

	st := map[string]interface{}{}
	for _, name := range []string{"github", "catppuccin-mocha"} {
		style := styles.Get(name)
		conv := map[string]string{}
		for t := range chroma.StandardTypes {
			entry := style.Get(t)
			if entry.IsZero() {
				continue
			}
			conv[t.String()] = svg.StyleEntryToSVG(entry)
		}
		st[name] = map[string]interface{}{"background": style.Get(chroma.Background).Background.String(), "svg": conv}
	}
	out["styles"] = st

	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.Encode(out)
}

type xnode struct {
	N string            `json:"n"`
	A map[string]string `json:"a,omitempty"`
	C []*xnode          `json:"c,omitempty"`
	T string            `json:"t,omitempty"`
}

func xmlTree(data []byte) *xnode {
	dec := xml.NewDecoder(bytes.NewReader(data))
	root := &xnode{N: "#root"}
	stack := []*xnode{root}
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			panic(err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &xnode{N: t.Name.Local}
			for _, a := range t.Attr {
				if n.A == nil {
					n.A = map[string]string{}
				}
				// a repeated attribute (push state="a" state="b") keeps all values, NUL separated
				if old, ok := n.A[a.Name.Local]; ok {
					n.A[a.Name.Local] = old + "\x00" + a.Value
				} else {
					n.A[a.Name.Local] = a.Value
				}
			}
			top := stack[len(stack)-1]
			top.C = append(top.C, n)
			stack = append(stack, n)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if s := strings.TrimSpace(string(t)); s != "" {
				stack[len(stack)-1].T += string(t)
			}
		}
	}
	return root.C[0]
}
