package main

import (
	"github.com/dlclark/regexp2/v2"
)

// regexp2Probe: {"text": pattern, "corpus": strings separated by NUL} -> {"matches": [[start, end] or null per string]}: how chroma's regexp
// engine (`\G(?:pattern)`, anchored at 0) matches each string. Used to check how patterns translate to JavaScript.
func regexp2Probe(in input) interface{} {
	re, err := regexp2.Compile(`\G(?:` + in.Text + `)`)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	out := [][]int{}
	for _, s := range splitNUL(in.Corpus) {
		m, err := re.FindStringMatch(s)
		if err != nil || m == nil {
			out = append(out, nil)
			continue
		}
		out = append(out, []int{m.RuneIndex, m.RuneIndex + m.RuneLength})
	}
	return map[string]interface{}{"matches": out}
}

func splitNUL(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == 0 {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	return append(out, cur)
}
