package main

// uniprops: prints the Unicode range tables of Go's `unicode` package that public/d2/uniprops.js holds (the ones JavaScript's \p{...}
// escapes lack or version differently), as JavaScript `export const` lines:
//
//	go run . uniprops > ../../public/d2/uniprops.js.body   (then paste below the file's header comment)
//
// Cf, Mn, Me, So, Sm, Sc, Sk, P (every punctuation category: Pc Pd Ps Pe Pi Pf Po), Other_Default_Ignorable_Code_Point,
// Variation_Selector, Prepended_Concatenation_Mark.

import (
	"fmt"
	"strings"
	"unicode"
)

func uniprops() {
	tables := []struct {
		name string
		in   func(r rune) bool
	}{
		{"Cf", func(r rune) bool { return unicode.Is(unicode.Cf, r) }},
		{"ODICP", func(r rune) bool { return unicode.Is(unicode.Other_Default_Ignorable_Code_Point, r) }},
		{"VS", func(r rune) bool { return unicode.Is(unicode.Variation_Selector, r) }},
		{"PCM", func(r rune) bool { return unicode.Is(unicode.Prepended_Concatenation_Mark, r) }},
		{"Mn", func(r rune) bool { return unicode.Is(unicode.Mn, r) }},
		{"Me", func(r rune) bool { return unicode.Is(unicode.Me, r) }},
		{"So", func(r rune) bool { return unicode.Is(unicode.So, r) }},
		{"Sm", func(r rune) bool { return unicode.Is(unicode.Sm, r) }},
		{"Sc", func(r rune) bool { return unicode.Is(unicode.Sc, r) }},
		{"Sk", func(r rune) bool { return unicode.Is(unicode.Sk, r) }},
		{"P", func(r rune) bool { return unicode.IsPunct(r) }},
	}
	for _, t := range tables {
		var parts []string
		for r := rune(0); r <= unicode.MaxRune; {
			if !t.in(r) {
				r++
				continue
			}
			lo := r
			for r <= unicode.MaxRune && t.in(r) {
				r++
			}
			parts = append(parts, fmt.Sprintf("0x%x,0x%x", lo, r-1))
		}
		fmt.Printf("export const %s = [%s];\n", t.name, strings.Join(parts, ","))
	}
}
