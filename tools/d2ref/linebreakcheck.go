package main

import "github.com/rivo/uniseg"

// linebreakCheck: {"text": s} -> {"segments": [...]}: uniseg.FirstLineSegmentInString applied until the string is used up, the way
// lib/textmeasure's markdown painter segments text at Unicode line-break opportunities.
func linebreakCheck(in input) interface{} {
	remaining := in.Text
	state := -1
	segments := []string{}
	mustBreaks := []bool{}
	for remaining != "" {
		segment, rest, mustBreak, nextState := uniseg.FirstLineSegmentInString(remaining, state)
		if segment == "" {
			break
		}
		segments = append(segments, segment)
		mustBreaks = append(mustBreaks, mustBreak)
		remaining = rest
		state = nextState
	}
	return map[string]interface{}{"segments": segments, "mustBreak": mustBreaks}
}
