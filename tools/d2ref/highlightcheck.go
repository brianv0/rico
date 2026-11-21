package main

import (
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
)

// highlightCheck: {"language", "text"} -> {"lines": [[[type, value]...]...], "lexer": name}: what d2svg tokenises a code label into
// (lexers.Get(language), or lexers.Fallback; chroma.SplitTokensIntoLines of the token stream).
func highlightCheck(in input) interface{} {
	lexer := lexers.Get(in.Language)
	if lexer == nil {
		lexer = lexers.Fallback
	}
	it, err := lexer.Tokenise(nil, in.Text)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	lines := [][][2]string{}
	for _, tokens := range chroma.SplitTokensIntoLines(it.Tokens()) {
		l := [][2]string{}
		for _, t := range tokens {
			l = append(l, [2]string{t.Type.String(), t.Value})
		}
		lines = append(lines, l)
	}
	return map[string]interface{}{"lines": lines, "lexer": lexer.Config().Name}
}
