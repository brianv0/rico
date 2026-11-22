package main

import (
	"github.com/dlclark/regexp2/v2"
)

// regexp2Groups: {"text": rule pattern, "language": flags such as "mi" (the lexer's flags), "corpus": strings separated by NUL} ->
// {"matches": per string, per rune position, the group texts of the match the lexer's matchRules finds there (null when none)}.
// The pattern is compiled exactly as chroma's RegexLexer does: `\G(?flags)(?:pattern)`.
func regexp2Groups(in input) interface{} {
	pattern := "(?:" + in.Text + ")"
	if in.Language != "" {
		pattern = "(?" + in.Language + ")" + pattern
	}
	re, err := regexp2.Compile(`\G` + pattern)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	out := [][][]string{}
	for _, s := range splitNUL(in.Corpus) {
		text := []rune(s)
		per := [][]string{}
		for pos := 0; pos <= len(text); pos++ {
			m, err := re.FindRunesMatchStartingAt(text, pos)
			if err != nil || m == nil || m.RuneIndex != pos {
				per = append(per, nil)
				continue
			}
			gs := []string{}
			for _, g := range m.Groups() {
				gs = append(gs, g.String())
			}
			per = append(per, gs)
		}
		out = append(out, per)
	}
	return map[string]interface{}{"matches": out}
}
