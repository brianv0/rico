package main

// fontmetrics: dumps the tables Go's measuring path (lib/textmeasure + freetype/truetype, no hinting) reads,
// as compact JSON for public/d2/textmeasure.js.
//
//	go run . fontmetrics > ../../public/d2/fonts/metrics.json

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/golang/freetype/truetype"
	"golang.org/x/image/math/fixed"

	"github.com/d2lang/d2/d2renderers/d2fonts"
	"github.com/d2lang/d2/lib/textmeasure"
)

type sfnt struct {
	tables map[string][]byte
}

func parseSfnt(b []byte) *sfnt {
	n := int(binary.BigEndian.Uint16(b[4:]))
	s := &sfnt{tables: map[string][]byte{}}
	for i := 0; i < n; i++ {
		e := b[12+16*i:]
		off := binary.BigEndian.Uint32(e[8:])
		l := binary.BigEndian.Uint32(e[12:])
		s.tables[string(e[:4])] = b[off : off+l]
	}
	return s
}

func u16(b []byte, i int) int { return int(binary.BigEndian.Uint16(b[i:])) }
func i16(b []byte, i int) int { return int(int16(binary.BigEndian.Uint16(b[i:]))) }
func u32(b []byte, i int) int { return int(binary.BigEndian.Uint32(b[i:])) }

type comp struct {
	Glyph int   `json:"g"`
	DX    int   `json:"dx"`
	DY    int   `json:"dy"`
	Round bool  `json:"r,omitempty"`
	UMM   bool  `json:"u,omitempty"`
	T     []int `json:"t,omitempty"`
}

type glyphRec struct {
	Adv   int    `json:"a"`
	LSB   int    `json:"l"`
	XMin  int    `json:"x"`
	Empty bool   `json:"e,omitempty"`
	BBox  []int  `json:"b,omitempty"` // simple: minX,maxX,minY,maxY of all points
	Comps []comp `json:"c,omitempty"`
}

type fontOut struct {
	UPEM    int                 `json:"upem"`
	Ascent  int                 `json:"ascent"`
	Descent int                 `json:"descent"`
	Cmap    map[string]int      `json:"cmap"`
	Glyphs  map[string]glyphRec `json:"glyphs"`
	Kern    [][3]int            `json:"kern"`
}

func fontmetrics() {
	out := map[string]interface{}{}
	faces := map[string]string{}
	fonts := map[string]*fontOut{}
	byBytes := map[string]string{}

	var runes []rune
	runes = append(runes, 0xFFFD)
	runes = append(runes, textmeasure.Runes...)

	for _, fam := range d2fonts.FontFamilies {
		for _, st := range d2fonts.FontStyles {
			f := d2fonts.Font{Family: fam, Style: st}
			data, ok := d2fonts.FontFaces.Lookup(f)
			if !ok {
				continue
			}
			key := string(fam) + "-" + string(st)
			if prev, ok := byBytes[string(data)]; ok {
				faces[key] = prev
				continue
			}
			byBytes[string(data)] = key
			faces[key] = key
			fonts[key] = dumpFont(data, runes)
		}
	}
	out["faces"] = faces
	out["fonts"] = fonts
	enc := json.NewEncoder(os.Stdout)
	enc.Encode(out)
}

func dumpFont(data []byte, runes []rune) *fontOut {
	ttf, err := truetype.Parse(data)
	if err != nil {
		panic(err)
	}
	s := parseSfnt(data)
	head, hhea, hmtx, loca, glyf, maxp := s.tables["head"], s.tables["hhea"], s.tables["hmtx"], s.tables["loca"], s.tables["glyf"], s.tables["maxp"]
	upem := u16(head, 18)
	locFmt := i16(head, 50)
	nGlyph := u16(maxp, 4)
	nHM := u16(hhea, 34)
	fo := &fontOut{UPEM: upem, Ascent: i16(hhea, 4), Descent: i16(hhea, 6), Cmap: map[string]int{}, Glyphs: map[string]glyphRec{}}

	hmetric := func(j int) (adv, lsb int) {
		if j < 0 || nGlyph <= j {
			return 0, 0
		}
		if j >= nHM {
			p := 4 * (nHM - 1)
			return u16(hmtx, p), i16(hmtx, p+2*(j-nHM)+4)
		}
		return u16(hmtx, 4*j), i16(hmtx, 4*j+2)
	}
	var addGlyph func(i int)
	addGlyph = func(i int) {
		if _, ok := fo.Glyphs[fmt.Sprint(i)]; ok {
			return
		}
		var g0, g1 int
		if locFmt == 0 {
			g0, g1 = 2*u16(loca, 2*i), 2*u16(loca, 2*i+2)
		} else {
			g0, g1 = u32(loca, 4*i), u32(loca, 4*i+4)
		}
		adv, lsb := hmetric(i)
		rec := glyphRec{Adv: adv, LSB: lsb}
		if g0+10 > g1 {
			rec.Empty = true
			fo.Glyphs[fmt.Sprint(i)] = rec
			return
		}
		gl := glyf[g0:g1]
		ne := i16(gl, 0)
		rec.XMin = i16(gl, 2)
		if ne < 0 {
			off := 10
			for {
				flags := u16(gl, off)
				c := comp{Glyph: u16(gl, off+2)}
				if flags&1 != 0 {
					c.DX, c.DY = i16(gl, off+4), i16(gl, off+6)
					off += 8
				} else {
					c.DX, c.DY = int(int8(gl[off+4])), int(int8(gl[off+5]))
					off += 6
				}
				if flags&2 == 0 {
					panic("compound glyph transform vector")
				}
				c.Round = flags&4 != 0
				c.UMM = flags&(1<<9) != 0
				switch {
				case flags&8 != 0:
					c.T = []int{i16(gl, off), 0, 0, i16(gl, off)}
					off += 2
				case flags&(1<<6) != 0:
					c.T = []int{i16(gl, off), 0, 0, i16(gl, off+2)}
					off += 4
				case flags&(1<<7) != 0:
					c.T = []int{i16(gl, off), i16(gl, off+2), i16(gl, off+4), i16(gl, off+6)}
					off += 8
				}
				if c.T != nil {
					fmt.Fprintln(os.Stderr, "note: glyph", i, "has component transform", c.T)
				}
				rec.Comps = append(rec.Comps, c)
				if flags&(1<<5) == 0 {
					break
				}
			}
			fo.Glyphs[fmt.Sprint(i)] = rec
			for _, c := range rec.Comps {
				addGlyph(c.Glyph)
			}
			return
		}
		offset := 10
		last := 0
		for k := 0; k < ne; k++ {
			last = 1 + u16(gl, offset)
			offset += 2
		}
		instr := u16(gl, offset)
		offset += 2 + instr
		if ne > 0 {
			flags := make([]uint32, 0, last)
			for len(flags) < last {
				c := uint32(gl[offset])
				offset++
				flags = append(flags, c)
				if c&8 != 0 {
					cnt := int(gl[offset])
					offset++
					for ; cnt > 0; cnt-- {
						flags = append(flags, c)
					}
				}
			}
			xs := make([]int16, last)
			ys := make([]int16, last)
			var x int16
			for k := 0; k < last; k++ {
				f := flags[k]
				if f&2 != 0 {
					dx := int16(gl[offset])
					offset++
					if f&16 == 0 {
						x -= dx
					} else {
						x += dx
					}
				} else if f&16 == 0 {
					x += int16(u16(gl, offset))
					offset += 2
				}
				xs[k] = x
			}
			var y int16
			for k := 0; k < last; k++ {
				f := flags[k]
				if f&4 != 0 {
					dy := int16(gl[offset])
					offset++
					if f&32 == 0 {
						y -= dy
					} else {
						y += dy
					}
				} else if f&32 == 0 {
					y += int16(u16(gl, offset))
					offset += 2
				}
				ys[k] = y
			}
			b := []int{int(xs[0]), int(xs[0]), int(ys[0]), int(ys[0])}
			for k := 1; k < last; k++ {
				b[0] = min(b[0], int(xs[k]))
				b[1] = max(b[1], int(xs[k]))
				b[2] = min(b[2], int(ys[k]))
				b[3] = max(b[3], int(ys[k]))
			}
			rec.BBox = b
		}
		fo.Glyphs[fmt.Sprint(i)] = rec
	}

	face := truetype.NewFace(ttf, &truetype.Options{Size: 16})
	var idxs []int
	seen := map[int]bool{}
	for _, r := range runes {
		i := int(ttf.Index(r))
		if !seen[i] {
			seen[i] = true
			idxs = append(idxs, i)
		}
		if _, _, ok := face.GlyphBounds(r); !ok {
			continue
		}
		fo.Cmap[fmt.Sprint(int(r))] = i
		addGlyph(i)
	}
	sort.Ints(idxs)
	upemScale := fixed.Int26_6(upem)
	for _, a := range idxs {
		for _, b := range idxs {
			k := ttf.Kern(upemScale, truetype.Index(a), truetype.Index(b))
			if k != 0 {
				fo.Kern = append(fo.Kern, [3]int{a, b, int(k)})
			}
		}
	}
	if fo.Kern == nil {
		fo.Kern = [][3]int{}
	}
	return fo
}
