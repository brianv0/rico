package main

// unicodeprobe: what public/d2/regexp2.js needs from Go's `unicode` package, for checking its JavaScript stand-ins over every code point:
// {"lower": [[r, unicode.ToLower(r)]...] (where it differs), "orbit": [[r, SimpleFold orbit without r]...], and the range tables of the
// categories regexp2 asks for (L Lu Ll N Mn Nd Pc), unicode.IsSpace, unicode.IsLower and unicode.IsUpper}.
//
//	go run . unicodeprobe > unicode.json ; node regexp2check.mjs unicode.json

import (
	"encoding/json"
	"os"
	"unicode"
)

func unicodeprobe() {
	out := map[string]interface{}{}
	var lower [][2]int
	var orbit [][]int
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if l := unicode.ToLower(r); l != r {
			lower = append(lower, [2]int{int(r), int(l)})
		}
		if f := unicode.SimpleFold(r); f != r {
			o := []int{int(r)}
			for x := f; x != r; x = unicode.SimpleFold(x) {
				o = append(o, int(x))
			}
			orbit = append(orbit, o)
		}
	}
	out["lower"] = lower
	out["orbit"] = orbit
	tables := map[string]func(rune) bool{
		"L":       func(r rune) bool { return unicode.Is(unicode.L, r) },
		"Lu":      func(r rune) bool { return unicode.Is(unicode.Lu, r) },
		"Ll":      func(r rune) bool { return unicode.Is(unicode.Ll, r) },
		"N":       func(r rune) bool { return unicode.Is(unicode.N, r) },
		"Mn":      func(r rune) bool { return unicode.Is(unicode.Mn, r) },
		"Nd":      func(r rune) bool { return unicode.Is(unicode.Nd, r) },
		"Pc":      func(r rune) bool { return unicode.Is(unicode.Pc, r) },
		"IsSpace": unicode.IsSpace,
		"IsLower": unicode.IsLower,
		"IsUpper": unicode.IsUpper,
	}
	for name, in := range tables {
		var ranges []int
		for r := rune(0); r <= unicode.MaxRune; {
			if !in(r) {
				r++
				continue
			}
			lo := r
			for r <= unicode.MaxRune && in(r) {
				r++
			}
			ranges = append(ranges, int(lo), int(r-1))
		}
		out[name] = ranges
	}
	enc := json.NewEncoder(os.Stdout)
	enc.Encode(out)
}
