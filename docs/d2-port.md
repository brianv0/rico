# Porting D2 to JavaScript

Goal: render `d2` blocks in Rico with plain JavaScript in the browser, instead of D2's Go-compiled-to-WASM
build (`@terrastruct/d2`: 8.2 MB, 6.0 MB gzipped, about 0.8 s before the first diagram). Target: the default
(dagre) path around 100–150 KB gzipped, with ELK, sketch mode and LaTeX loaded only when a diagram uses them.

Source: D2 **v0.9.0** (`github.com/d2lang/d2`, MPL-2.0; Go module path changed from `oss.terrastruct.com/d2`, whose
last release is v0.7.2). Every ported file keeps the MPL header that `public/d2/parser.js` has. Rico itself stays
MIT; MPL is per file, so that is fine.

## Target version: v0.9.0 (changed from v0.7.2)

The port was started against v0.7.2 by mistake (the old module path's last release). Everything verified up to
commit `0cbfdae` was measured against v0.7.2; the `parse`, `ir`, `graph` and `leaf` rows below are re-verified at v0.9.0 (the
`layout`/`render` rows say what they were measured against).
The reference runner (`tools/d2ref`) now builds against v0.9.0 (needs Go 1.27, which `GOTOOLCHAIN=auto` downloads),
and `corpus.jsonl` must be regenerated from the v0.9.0 source:

```bash
curl -sSLo d2.zip https://proxy.golang.org/github.com/d2lang/d2/@v/v0.9.0.zip && unzip -q d2.zip   # github.com/d2lang/d2@v0.9.0/
cd tools/d2ref && go run . corpus <path to github.com/d2lang/d2@v0.9.0> > corpus.jsonl            # 1077 snippets
```

What changed upstream after v0.7.2 (v0.8.x, v0.9.0 changelogs):
- The embedded JS runtimes are gone. dagre is now native Go (`github.com/d2lang/dagro`, "Dagre 3.1.1 behavior": node
  order, coordinates, routes and compound sizes changed on purpose), ELK is native Go (`elk-go`, "ELK.js 0.12.0
  behavior"), LaTeX is `mathjax-go`, sketch is `rough-go` ("Rough.js 4.6.6 behavior"). npm has the JS originals
  (`@dagrejs/dagre` 3.1.x, `elkjs` 0.12.x, `roughjs` 4.6.6, `mathjax-full` 3.2.2): prefer vendoring those and porting
  only D2's glue code, and let the harness decide whether the output matches the Go ports.
- **TALA** (`d2layouts/d2talalayout`, about 64k lines of Go, no JS original) is open source and bundled. Load lazily.
- SVG: markdown labels are native SVG text (not `foreignObject`); SVGs are about 24% smaller; font/CSS assembly changed.
- Faster compile/layout internals (glob, imports, grid), new scene/raster pipeline (`d2scene`, `d2scenebuild`) that
  the SVG path does not use, so it is out of scope.
- Initial v0.9.0 diff of the v0.7.2-era JS: parse 1077/1077; ir 1052/1077; graph 1060/1077; layout 942/1073. After the front-end port
  (next section): parse, ir, graph 1077/1077.
- Layout stage result (below): dagre **3.1.1 from npm, vendored with dagro's three compat corrections** matches dagro bit for bit, so no
  Go port of dagro was needed; layout is 1073/1073 on the v0.9.0 corpus.

## Status

| Stage | Go packages | JS | Matches Go |
|---|---|---|---|
| parse | `d2ast`, `d2parser` | `public/d2/ast.js`, `parser.js` | **v0.9.0**: corpus 1077/1077 and `extra.jsonl` 390/390, UTF-8 and UTF-16 |
| ir | `d2ir` (+ `d2format.Format`/`FormatKeyPath`, `d2ast` helpers, the constants of `d2target`/`d2themes`, `textmeasure.ReplaceSubstitutionsMarkdown`) | `public/d2/d2ir.js`, `format.js`, `target.js`, `themes.js`, `textmeasure.js` (+ helpers in `ast.js`) | **v0.9.0**: corpus 1077/1077 (UTF-8 and UTF-16); `extra.jsonl` 390/390 (both); mutation fuzz 3 x 3000 (both, 1 case dropped: Go does not finish) and glob/board/class/import grammar fuzz (`globfuzz.mjs`) 3 seeds about 1100-1400 each, all identical. Residue below |
| graph | `d2compiler`, `d2graph` (not serde.go, not `SetDimensions`), `net/url`, `html.UnescapeString`, `encoding/xml` (the Markdown check), `sort.Slice`, `strconv`, `fmt.Sprintf` | `d2compiler.js`, `d2graph.js`, `url.js`, `gohtml.js` + `htmlentity.js`, `xml.js`, `gosort.js`, `strconv.js`, `gofmt.js` (+ `d2target` `Class`/`SQLTable`, `d2ast` label/near tables) | **v0.9.0**: corpus 1077/1077 (UTF-8 and UTF-16); `extra.jsonl` 390/390 (both); the same fuzz sets as `ir` identical; `graphmd` (Markdown-heavy) 2000/2000. Support stages: `url` 4122 (3 seeds), `htmlunescape` 6017, `xml` 9038, `sortslice` 3000, `strconv` 6093, `sprintf` 6501 (all identical); `graphmethods` 1077 |
| leaf | `lib/textmeasure` (ruler, legacy Markdown measure), `lib/shape`, `lib/label`, `lib/geo`, `lib/color` (+ csscolorparser, go-colorful parts), `lib/svg` (FormatFloat, path commands), `d2themes` (`ThemableElement`), `d2target`, `d2fonts` | `textmeasure.js` (+ `fonts.js`, `fonts/metrics.json`, `uniseg.js`, `uniprops.js`, `htmlparse.js`), `shape.js`, `label.js`, `geo.js`, `color.js`, `svg.js`, `themes.js`, `target.js` | **v0.9.0**: `measure` 129354/129354 (+ `extra-measure.jsonl` 113/113; fuzz 3974-3990 of 4000, Markdown HTML residue below), `mdhtml` 118/118 on the corpus's Markdown, `shape` 297/360 exact + 63 within 1e-9 (libm; same on 3 x 3000 fuzz), `label` 381/381 (+ 3 x 3000), `color` 2467/2470 exact + 3 within 1e-9, `element` 1500/1500, `target` 886/886, `targetstatics`, `dims` 1073/1073 (+ 390 extra, 2 x 3000 fuzz) |
| layout | `lib/textmeasure` (glyph metrics, Markdown validation and legacy box model), `d2graph.SetDimensions`, `d2layouts` (+ `d2near`, `d2grid`, `d2sequence`), `d2dagrelayout` (Go glue; the engine is dagre 3.1.1 from npm with dagro's corrections, `vendor/dagre.js`), `d2exporter`, `d2lib` (Compile, applyConfigs/Defaults, boards), `lib/geo`, `lib/shape`, `lib/label` | `textmeasure.js` (+ `fonts.js`, `fonts/metrics.json`, `uniseg.js`, `htmlparse.js`), `geo.js`, `shape.js`, `label.js`, `gomath.js`, `d2graph.js` (`setDimensions`), `d2exporter.js`, `d2layouts.js`, `d2near.js`, `d2grid.js`, `d2sequence.js`, `d2dagrelayout.js`, `vendor/dagre.js` (107 KB, 24 KB gzipped), `d2lib.js` (`compile(text, opts)` -> `{diagram, graph, err}`) | v0.9.0: `layout` corpus 1077/1077 (latex included), UTF-8 and UTF-16; `extra.jsonl` 390/390; `extra-latex.jsonl` (34 hand-written LaTeX programs) 34/34; `extralayout.jsonl` (v0.9.0 cases written for this stage) 50/50, both modes; D2's e2e dagre goldens (`e2e` stage) 321/321 boards (+2 expected errors, 5 without a dagre golden); `dims` 1077/1077; about 27k generated layout cases (`fuzzlayout.mjs` 9 seeds, `fuzzgrid.mjs`, `fuzzseq.mjs`) and 12k mutated corpus cases identical to Go (Go-unstable ones excepted, below). Engine level: `dagrocmp.mjs` 1030/1030 dagre layouts of the corpus and 6500+ generated ones identical to dagro. Support stages: `measure` 129354/129354 (incl. `--big`), `shape` 297/360 exact (rest within 1e-9, libm), `label` 381/381 |
| render | `d2renderers/d2svg` (d2svg, class, table, markdown, theme, font_corpus), `lib/svg`, `lib/color`, `lib/font` (subsetter, Sfnt2Woff), `compress/flate`+`zlib` (Go 1.27's encoder), `d2renderers/internal/patternassets`, `lib/textmeasure` markdown layout (`markdown.go`, `markdown_svg.go`), `rivo/uniseg` line breaking, `alecthomas/chroma` (lexer engine, 48 lexers, 2 styles) | `d2svg.js` (+ `d2sketch.js`, `vendor/rough.js`, `d2latex.js` and the lazy `vendor/mathjax.js`, `d2svgcorpus.js`, `d2svgassets.js`, `d2svgfonts.js`, `d2svgpatterns.js`, `fontsubset.js`, `flate.js`, `mdlayout.js`, `linebreak.js`, `highlight.js`, the `xml.js` tokenizer, `fonts/*.ttf`, `patterns/*`, `lexers/*`) | `svg` stage (Go's own diagram JSON in, Go's SVG bytes out): corpus 881/881, e2e boards 929/929 (all of D2's `board.exp.json` incl. elk/tala layouts and multiboard), extra 277/277, `extra-latex.jsonl` 29/29, about 8700 fuzzed cases with random render options, 3150 Markdown-heavy cases; non-Latin Markdown and the unported code languages are deferred by rule (see below). LaTeX labels are rendered by MathJax 3.2.2 instead of mathjax-go (section "LaTeX" below: identical on every formula of D2's tests, not on all input). **Sketch mode** (`--sketch`, `svgfull`, see "Sketch mode" below): corpus 877/877 (renderer) and 1068/1068 (whole pipeline), e2e boards 911/911, extra 397/397 (whole pipeline) and 287/287 (renderer), D2's own sketch goldens 37/37 byte for byte, about 20,000 fuzzed cases identical (residue below). Support stages: `flate` 3160/3160 streams identical to Go, `linebreak` 6000/6000, `highlight` 7169/7169 |
| latex | `d2renderers/d2latex` (glue); engine: MathJax 3.2.2 instead of `mathjax-go` | `d2latex.js`, `vendor/mathjax.js` (1.7 MB, 599 KB gzipped, lazy) | `latex` stage 19/19 formulas of D2's tests identical (svg, size, errors); **not** identical on all input, see "LaTeX" |
| elk | `d2layouts/d2elklayout` (Go glue: `layout.go`, `descendant_shifter.go`, `spatial_index.go`; the engine is ELK.js 0.12.0 from npm `elkjs` with elk-go compatibility edits) | `d2elklayout.js`, `vendor/elk.js` (1.6 MB, 464 KB gzipped, lazy `import()`), `d2lib.js` (`loadLayout`, `layout: 'elk'`, `elkOpts`) | v0.9.0: `layout --layout elk` corpus 1077/1077 (UTF-8 and UTF-16), `extra.jsonl` 390/390 (both), `extralayout.jsonl` 50/50 (both); D2's e2e elk goldens (`e2e --layout elk`) 309/309 boards (+2 expected errors, 17 without an elk golden); about 26k generated layouts (`fuzzlayout.mjs` 6 seeds x 3000 plus its `elk` profile with ELK options 2 x 1500, `fuzzgrid.mjs`, `fuzzseq.mjs`, 3000 mutated corpus cases; UTF-8 and UTF-16) identical to Go, Go panics excepted (a padding option without `right=`; non-layered algorithms with an edge across a container boundary), one residue: the LaTeX width of a mutated `grid_with_latex.d2` (MathJax against mathjax-go, the same under dagre). Engine level: `elkcmp.mjs` ELK.js against elk-go on the graphs the glue builds, 1030/1030 corpus layouts and about 22k generated ones identical; the graphs the Go glue really marshals are byte for byte the JS ones (`elkinputcmp.mjs`, 1030/1030) |
| later | `d2animate`, `d2talalayout` | | TALA is not ported yet (`d2lib` throws `TalaNotPorted`) |

Not needed: `d2oracle`, `d2lsp`, `d2format` (except what `d2ir` calls), `d2plugin`, `d2renderers/d2ascii`, `d2js`.

## The harness: always diff against Go

`tools/d2ref` runs the real Go D2. `tools/d2ref/diff.mjs` runs the JS port on the same input and reports
the first JSON path that differs.

```bash
curl -sSLo d2.zip https://proxy.golang.org/github.com/d2lang/d2/@v/v0.9.0.zip && unzip -q d2.zip   # D2 source
cd tools/d2ref
go run . corpus ../../oss.terrastruct.com/d2@v0.7.2 > corpus.jsonl   # ~1000 snippets from D2's own tests (53 with imported files)
node diff.mjs parse corpus.jsonl            # and again with --utf16
node diff.mjs parse corpus.jsonl --only 17  # one case
node diff.mjs ir extra.jsonl                # hand-written cases for what the corpus lacks (array spreads, imports, links, markdown vars)
node fuzz.mjs corpus.jsonl 4000 7 > fuzz.jsonl && node diff.mjs ir fuzz.jsonl   # mutation fuzzing, seeded
```

Go modes: `parse`, `ir`, `graph`, `layout` (diagram JSON after dimensions and layout), `render` (SVG). To add
a stage, port the packages, then add one line to `STAGES` in `diff.mjs` that returns the same JSON shape
as the Go mode. A stage is done when **every** corpus case matches Go in both UTF-8 and UTF-16 mode (cases
where Go itself panics are skipped automatically). Also add random/fuzzed inputs once a stage passes.

Cases may carry `"fs": {"x.d2": "..."}`; the main file is then `index.d2` (the `ir` and later modes pass the files to Go through
`memfs`, and the JS port takes `{ fs }`). Without `fs`, Go's `d2ir` reads the real disk, so an import in a case with no `fs`
fails with `open x.d2: no such file or directory`; the JS port never reads the disk and prints the same message.

Layout-stage tools (all in `tools/d2ref`; build the Go side once with `go build -o /tmp/d2ref .` and pass the binary where a tool takes `bin`):

```bash
node diff.mjs layout corpus.jsonl [--utf16]      # {diagram, err} of d2lib.Compile (dagre), reruns Go 100 times on a mismatch to detect Go-unstable output
node diff.mjs e2e e2e.jsonl                      # D2's own board.exp.json goldens; e2eenum/run.sh <writable copy of the D2 tree> regenerates e2e.jsonl
node diff.mjs dims corpus.jsonl                  # state right after SetDimensions; diff.mjs measure measure.jsonl (measurecorpus.mjs [--big] makes it)
node extralayout.mjs > extralayout.jsonl         # hand-written v0.9.0 cases (self-loops, parallel edges, nested diagrams, markdown, glyph rounding)
node fuzzlayout.mjs 3000 7 > f.jsonl             # generated programs for layout (nesting, edges, labels, grids, sequences, near, shapes); fuzzgrid.mjs, fuzzseq.mjs
node fuzz.mjs corpus.jsonl 3000 7 > f.jsonl      # mutated corpus (mostly exercises the front end)
node dagrocmp.mjs f.jsonl /tmp/d2ref             # engine level: dagre.js against dagro on the graphs the glue builds
node cmp.mjs case.d2 /tmp/d2ref 100              # one case: JS vs Go tables, and how many different Go outputs there are
node shrink.mjs f.jsonl 123 /tmp/d2ref           # greedy reducer of a failing case
node errstats.mjs f.jsonl                        # how many generated cases compile (a generator that mostly errors tests nothing)
```

`node --test` covers Rico; the D2 diff needs Go, so it is a separate command and not part of `npm test`.

## Rules

1. **Port line for line.** Same function names (camelCase), same control flow, same error messages. No
   refactoring, no "improvements" while porting: the point is that upstream diffs can be re-applied later.
2. **Keep Go's JSON shape.** Property names are the Go JSON tags (`map_key`, `unquoted_string`, ...); boxes
   stay boxes; `Range` serialises to `"path,l:c:b-l:c:b"` (see `ast.js`). Rico's `d2LineMaps` reads the
   compile result, so the `graph` and `diagram` JSON must match what the WASM build returns.
3. **Plain ESM JavaScript**, no build step, no dependencies beyond what Rico already vendors (markdown-it,
   highlight.js, DOMPurify) plus D2's own JS (dagre, ELK, rough.js, MathJax), loaded with dynamic `import()`.
4. **Go semantics to watch:**
   - Strings: Go indexes bytes, JS indexes UTF-16 units. Wherever Go uses `len(s)` or slices by byte
     offsets that reach the output, use `utf8Len` (in `ast.js`) or iterate code points.
   - `unicode.IsSpace` is not JS `\s`: use `isSpace` from `ast.js`.
   - Float output: Go's `strconv.FormatFloat(f, 'f', -1, 64)`, `%v` and `%f` differ from JS `String(n)`
     (exponents, `-0`, rounding). Write one `goFloat` helper and use it everywhere numbers reach SVG or JSON.
   - `math.*` results can differ from V8 in the last bit. If layout coordinates differ by about 1e-12,
     compare with a tolerance in `diff.mjs` rather than chasing it.
   - Go map iteration is random. D2 usually sorts; where it does not, Go's own output is unstable, so compare
     that part as a set.
   - `int` division truncates, `%` keeps the sign of the dividend, integer overflow does not happen in
     practice here: use `Math.trunc` where Go divides ints.
   - Typed nil, zero values: a Go struct field that is a struct (not a pointer) always exists, e.g. `primary: {}`.
5. **Don't type literal U+2028/U+2029 or other invisible characters into source**; write `\u2028` and check
   with `grep -nP '[\x{2028}\x{2029}]' public/d2/*.js` (an editor tool once turned the escapes into the
   characters and broke a regex).

## Known residue (ir stage)

These are the places where the JS output is not (or cannot be) the same as Go's; each is deliberate.

- **Pointer addresses in one error message.** `import key %q doesn't exist inside import` formats a `[]d2ast.String` with `%q`,
  which makes Go print the struct fields and `*string` addresses (`0xc000420510`). The JS port prints the same text with
  `0xc000000000` and `diff.mjs` blanks `0xc[0-9a-f]{9}` in `errmsg` strings (nowhere else).
- **Go fatal errors.** A self-referential `vars` (`Cherry: { cc: ${Cherry} }`) overflows Go's stack, which kills the whole
  `go run` process. `diff.mjs` bisects the batch and reports that case as a Go panic. JS throws `RangeError` there.
- **Markdown inside block strings.** `d2ir` substitutes `${var}` in block strings only outside code, which Go finds with goldmark.
  `textmeasure.js` uses a line scanner plus regexes (fences, indented code, HTML blocks, lists, code spans, autolinks, link
  destinations). It matches Go on every case in the corpus and on about 99.7% of fuzzed markdown; blockquotes, reference
  definitions and lazy-continuation corner cases are not modelled. The real markdown port belongs to the layout stage.
- **`html.UnescapeString` and `url.Parse`** (used for `link:` and `icon:` of imported files) are reduced to the entities and
  URL forms that plausibly occur; invalid URLs are rejected for the common reasons only.
- **Go slice aliasing is modelled in one place.** Spreading an array variable into an array (`[...${a}; x]`) in Go overwrites
  elements when the slice has spare capacity (`append(append(vals[:i], spread...), vals[i+1:]...)`), and the `range` loop above
  sees them. `d2ir.js` reproduces this with Go's allocator size classes (`growCap`, `goAppend`). It matches Go on all corpus, extra and
  fuzzed cases so far.

## The hard parts

- **`d2ir`** (about 4k lines: globs, imports, vars, spreads, filters, boards) is the largest and most
  intricate piece. Imports read from an `fs` map: take it as an option `{ fs: { 'x.d2': '...' } }`.
- **Text measurement** (`lib/textmeasure`) decides every node size. Go measures with freetype on D2's
  bundled TTFs. Do not use canvas `measureText`: precompute per-font tables (advance widths, kerning, line
  metrics) with a small Go program in `tools/d2ref`, ship them as JSON, and port the measuring code to use
  them. Markdown labels are measured from goldmark's HTML; use markdown-it with the same options and expect
  to adjust until the measured sizes match on the corpus.
- **dagre**: v0.9.0 calls dagro (native Go, "Dagre 3.1.1 behavior") instead of running `dagre.js` in a JS runtime. The npm package
  `@dagrejs/dagre@3.1.1` plus the three corrections dagro applies to it gives identical output (see "Layout stage" below), so the port
  vendors that and ports only the Go glue around it.
- **Fonts in the SVG**: Go embeds base64 font subsets in every SVG. For the byte-for-byte diff, port that.
  For Rico, add an option to reference the fonts as cached same-origin files instead (much smaller).
- **Code shapes** use chroma; use highlight.js and accept that only colours differ (exclude them from the
  render diff for code blocks).

## After the port

- Swap `public/diagrams.js` from `/vendor/d2.js` to the JS port and keep the WASM build as a fallback for a
  release or two.
- With no WASM and no ELK-by-default, `'wasm-unsafe-eval'` can leave the CSP in `src/security.js`. The vendored ELK (`vendor/elk.js`) needs neither `'unsafe-eval'` nor a
  worker nor `blob:` (see "ELK stage"), so `'unsafe-eval'` can leave it too once the page uses the port.
- Optional DOM output: build the SVG with `createElementNS` and `textContent` from the same renderer, and put
  source ranges on elements as `data-*` attributes for click-to-comment. Rico currently draws diagrams in a
  sandboxed, script-less iframe because diagram source is untrusted; drawing into the page loses that, so
  markdown labels (`foreignObject`) must go through DOMPurify and link/icon URLs must be checked.


## Leaf packages (`lib/*`, `d2fonts`, `d2themes`, `d2target`): what was learned

Files: `gomath.js` (Go number semantics: `goFloat`/`goV`/`goFixed` for `%v`/`%.Nf`, `goRound`, `goInt`, `goPow`, `exactDiv`,
sha1, `strings.Fields`), `geo.js`, `shape.js`, `label.js`, `svg.js`, `color.js`, `fonts.js`, `textmeasure.js`, `uniseg.js`,
`htmlparse.js`, `themes.js`, `target.js`, `fonts/metrics.json`. Diff stages (all in `tools/d2ref/diff.mjs`): `measure`
(`measurecorpus.mjs [--big]`, `fuzzleaf.mjs measure`), `mdhtml`, `shape` (`shapecorpus.mjs`, use `--tol 1e-9`), `label`
(`labelcheck.mjs`), `color` (`colorcheck.mjs`), `element` (`elementcheck.mjs`), `target` (`targetcorpus.mjs`, needs Go layout
output), `targetstatics`. `go run . fontmetrics` regenerates the font tables, `go run . themes` the theme data (`themes.js` is
generated from it; keep the template in sync).

- **Text measuring** (v0.7.2: freetype's no-hinting path; v0.9.0: sfnt's, see the v0.9.0 section) replayed over a dump of the glyph records (advance, bearings, point bounding
  box or component list, kern pairs, hhea metrics). 197 KB JSON, 31 KB gzipped, for all ten distinct TTFs and the 353 runes the
  atlas holds. The atlas packing (`makeSquareMapping`) is ported too: it decides rounding of the glyph rects. Any rune outside
  the atlas measures as U+FFFD, as in Go; non-ASCII strings go through `uniseg` (grapheme width).
- **Markdown**: markdown-it with `html`, `xhtmlOut`, any link scheme, `<del>` for strikethrough reproduces goldmark's HTML except
  on pathological input (`</pre>` alone on a line, tables inside list items/quotes, `\r`, trailing space after an HTML comment):
  `mdhtml` 124596/127247, `measure` fuzz (`fuzzleaf.mjs measure`) 3965/4000. The tree builder in `htmlparse.js` stands in for
  `x/net/html` (quirks mode, formatting elements with the adoption agency algorithm, foster parenting, implied end tags). Register
  markdown-it with `setMarkdownIt(markdownit)`; load the metrics with `await loadMetrics()` (or `setMetrics(json)`).
  `replaceSubstitutionsMarkdown` stays the line scanner d2ir needs: markdown-it tokens have no source offsets.
- **Go semantics that bit**: constant expressions are exact in Go (`40 * 14 / 18.925`, `20.2 / 68.3`, `math.Sqrt2` quotients): use
  `exactDiv`; `float -> int` of NaN/Inf is `math.MinInt64` on amd64 (`goInt`); `math.Round` is half away from zero; `%f`
  rounds exact ties to even; `go2.Min` is not `Math.min`; a shadowed named result in `label.GetPointOnRoute` makes Outside*
  positions return index 0 (kept); `bounds` in textmeasure starts at the replacement glyph kern, even for the first rune.
- **Libm residue**: Go's `Exp`/`Log` have amd64 assembly and `Sin`/`Cos`/`Acos`/`Pow` (fractional) are Cephes, V8's are fdlibm.
  Affected: bezier/ellipse intersections in `geo.js` (cubic roots: last-bit differences, up to 1e-12 absolute at 500 px),
  `oklab()`/`oklch()` colors. They only reach layout through `TraceToShapeBorder`, which rounds to integers.
- **`target`**: one corpus diagram is not reproduced because Go's `json.Unmarshal` rejects it (a float where an int is expected);
  `Icon` is a plain `url.URL`-shaped object: a `net/url` port (`Parse`, `ParseRequestURI`, `String`) is still needed by the
  compiler/exporter. `Diagram.bytes()` and `hashID()` match Go byte for byte (field order, omitempty, HTML escaping).
- **Tooling trap**: an editor tool turned `\u2028` escapes in files I wrote into the literal characters again; check with
  `grep -lP '(*UTF8)[\x{2028}\x{2029}]' public/d2/*.js tools/d2ref/*`.


## Graph stage: what was learned

`node diff.mjs graph corpus.jsonl` compares `{graph, config, err}` (err is Go's `err.Error()`). The caller must register markdown-it first
(`setMarkdownIt`): the compiler renders Markdown to validate it. Support stages in `diff.mjs`: `url`, `htmlunescape`, `xml`, `sortslice`,
`strconv`, `sprintf`, `graphmethods` (inputs: `node urlcheck.mjs`, `htmlcheck.mjs`, `xmlcheck.mjs corpus.jsonl`, `sortcheck.mjs`,
`strconvcheck.mjs`, `sprintfcheck.mjs`; `graphmd.mjs corpus.jsonl N seed` makes Markdown-heavy graph cases).

- **Go strings are bytes.** `url.js` works on binary strings (one char per UTF-8 byte) and keeps invalid bytes as lone surrogates U+DC80..DCFF;
  `jsonStr` prints them as U+FFFD like `encoding/json`. `quote` is `strconv.Quote` (exported from `url.js`).
- **Errors are formats.** d2compiler passes messages that already contain user text back through `Sprintf` (a font named `%d`), so `gofmt.js`
  ports `doPrintf` including `%!d(MISSING)`, `%!(NOVERB)`, `%[1]d` (prints the `Range` struct via `GoRange`). Other verbs on a `Range` are not modelled.
- **`sort.Slice` is pdqsort** and D2's comparators are not strict orders (`return i < j`): `gosort.js` is the exact algorithm.
- **Constant division**: `THREE_DEE_OFFSET / 2` is the integer 7 in Go (untyped integer constants). The render stage has the same in `d2svg` (`Y_OFFSET := ... / 2`).
- **Nil receivers**: `IsGridDiagram`, `IsSequenceDiagram`, `ClosestGridDiagram` ... are nil-safe in Go; JS needs `parent !== null &&` guards (a Go panic is skipped by the harness, a JS TypeError is not).
- **nil vs empty slices** show in the JSON (`"edges": null`): `append([]T(nil), x...)` of an empty x is nil.
- `Object.Box` is `box` (null until layout), `Attributes` is `attributes`; `GraphObject` is Go's `Object`. `d2ast.LabelPositionsMapping` is lazy (import cycle ast -> label -> geo -> gomath -> ast).
- markdown-it now keeps numeric references to control characters like goldmark (`&#6;`); the XML check rejects them.
- Layout stage: `SetDimensions`, `GetLabelSize`, `GetDefaultSize` are ported (latex labels go through `d2latex.js`, see "LaTeX"); `ApplyTextTransform` capitalize is an approximation of x/text `cases.Title`; `serde.go` is not ported. `layout.go` (ShiftStart, TraceToShape, ...) is ported and untested because it needs boxes.

### Graph residue

- Pointer addresses in `import key %q` errors (same as ir; `diff.mjs` blanks them in `err` too).
- Markdown validation depends on markdown-it matching goldmark's HTML: a few pathological inputs differ (`<!iv>x</div>`, control-character entities inside link destinations); same residue as `mdhtml`.
- `strconv.Atoi` results beyond 2^53 and hex-float subnormals are doubles/rounded; unobservable in the compared output.
- `html.UnescapeString` and `net/url` are complete (full entity table, 11 KB gzipped: `htmlentity.js`, only needed by `validateBoardLinks` and d2ir imports).


## v0.9.0 front end (parse, ir, graph, leaf): what changed and what was learned

Method: regenerate every input against v0.9.0, run the stages in order, read the upstream `diff -ru` of the package for the cause, port the
behavior (not the performance machinery), add a hand-written case to `extra*.jsonl`, fuzz. `globfuzz.mjs` (grammar fuzzer for globs, boards, classes,
vars and imports) and `nohang.mjs` (drops fuzz cases on which Go does not finish: D2's glob evaluation can loop on adversarial input; build the reference with
`go build -o /tmp/d2refbin .` and set `D2REF`) were added because the corpus and mutation fuzz barely reach the new lazy-glob code.

- **d2ir: the lazy glob worklist is observable, so it is ported; the indexes and the import-template cache are not.** v0.9.0 stops rescanning the
  whole IR after each key: `Map.structureVersion` (bumped by `appendField/insertField/removeField/appendEdge/removeEdge`, and by
  `markStructureCountDelta` when a composite is replaced), `ensureField`'s `created` list, `lazyGlobTarget` + `multiGlobMatchesToward`/`directChildToward`
  (only the branch toward the new field is replayed), `applyLazyGlobs`, `lazyPostTargets`, `lazySettledVersions`. This changes reference lists
  (`Field.appendReference`/`Edge.appendReference` dedupe lazy-glob replays with `sameReferenceContext`) and the order in which rules apply, so it is ported
  line for line (`d2ir.js` `Compiler.compileKey/applyLazyGlobs`, `IRMap.ensureField*`). `fieldIndex`/`edgeIndex` are lookup accelerators with the same
  results as the linear scans, `getFieldIndexed`/`ensureFieldIndexed`/`getEdgesIndexed` are the same functions, and the per-compilation `importTemplates`
  cache (selective field imports reuse a compiled IR) gave identical IR on all corpus/extra/fuzz cases without being ported: imports recompile every time.
- **AST clones change the JSON.** `loadImportAST` returns a deep copy (`cloneASTMap` ...), and `Field`/`Scalar.Copy` now clone the scalar's AST node
  (`cloneASTScalar`). Go's copies turn nil slices into empty ones, so `"value": null` becomes `"value": []` (interpolation lists, map/array nodes) in
  imported files' references and in every copied scalar. The JS clone helpers in `d2ir.js` reproduce that (`cloneASTScalarBox` ...).
- **Other d2ir changes**: `EdgeID.Match` also matches the reversed edge (`a -> b` / `b <- a`: the arrows travel with the endpoints), `EdgeID.Copy` copies
  the index, `Edge.Copy` copies the ID, `CopyBase` no longer deletes and re-adds the board fields (`deleteEdgesForFieldReferences` + a base copy; same
  order), recursive globs (`**`) skip `classes` and `vars` (`skipDoubleGlobSubtree`), `matchPattern` for `*b`/`a*b*c` requires the suffix/end to match
  (`*b` no longer matches `abc`).
- **d2compiler/d2graph**: `Edge.initIndex`/`findEdges` use `IsEquivalent`/flipped matching (same reversed-edge rule); class reference cycles are an error
  (`class "a" forms a reference cycle`, `beginClass/endClass`); an edge with `link:` and no label gets the link as label; `compileBoard` copies the IR only for
  nested boards or boards with children and tests `len(layers...) > 0` before `CopyBase`; opacity rejects NaN/Inf. `d2format.FormatKeyPath(a)` is
  `Format(MakeKeyPathString(a))` (no code change).
- **`lib/textmeasure` moved from freetype/truetype to x/image/font/opentype (sfnt).** `metricPreservingFace` keeps hhea ascent/descent and the legacy `kern` table,
  but `GlyphBounds`/`GlyphAdvance` are now sfnt's: the advance is the hmtx advance scaled once (`scale(adv*ppem, upem)`, no phantom points), the bounds are the box of
  the outline points (compound glyphs: transformed + offset component points) scaled point by point with Y flipped, with no left-side-bearing shift. `metrics.json`
  needed no change (`go run . fontmetrics` regenerates it byte-identically with the sfnt-based dump); only `loadGlyph` was rewritten (`unitBounds`).
  `MeasureMarkdown` is now `LayoutMarkdown(...)` and fails with `native Markdown SVG does not support HTML element <x>` (a thrown `Error` in JS; `getMarkdownDimensions`
  turns it into the `[null, message]` pair, `target.js` falls back like Go) for anything but the supported element list (`validateMarkdownSVGNodes`); the legacy measure
  path itself changed only in `scaleUnicodeLegacy` (default-ignorable controls are removed before the fallback scaling; tables in `uniprops.js`, generated from Go's
  `unicode` package, Unicode 17) and an empty code text node. The CSS/native-painting half of `markdown_svg.go` (`LayoutMarkdown`'s primitives, `measureFontAdvance`,
  `cssFontBoxMetrics`, `scaleUnicodeCSS`) is the render stage's.
- **Markdown HTML moved with goldmark 1.7.4 -> 1.8.5 and x/net 0.35 -> 0.57** (`mdhtml` is only a stand-in comparison; what matters is the structure the measurer and the XML
  check see). Done in `setMarkdownIt`/`htmlparse.js`: table cell alignment is the `align` attribute; `<blockquote>` always has `\n` after it; a tight list item's text is followed
  by `\n` before a fence/code/HTML block; an unterminated fence at the end of the input gets its final newline; a lone `</pre>` is not an HTML block; leading whitespace of
  a paragraph's continuation lines is stripped (visible in code spans); and the HTML parser (x/net) drops whitespace, comments and ignorable end tags before the first body
  content and puts `title/style/script/meta/link/base/noframes` that start the document into `<head>` (outside the measured body), and `<li>/<dd>/<dt>` close an open `<p>`.
- **net/url (Go 1.24 -> 1.27)**: `parseHost(scheme, host)` is strict about colons for http/https (`a::1` and `h1:80,h2:81` are errors there, not for other
  schemes), validates bracketed hosts with `netip.ParseAddr` (zone rules, IPv4 not allowed in brackets; the error texts are ported) and unescapes the port part.
  `Diagram.Bytes()` keeps `icon` URLs in the field order of Go <= 1.25 (`marshalHashJSON`) so hashes do not change with the toolchain: `goMarshal(v, true)`.
- **csscolorparser 0.1.5 -> 0.1.8** (via lib/color): any `name(...)` with other than 3 or 4 parameters is `Invalid format` (so `linear-gradient(red, blue)` no
  longer reports `Invalid color format`), parameters split on `,` `/` and space only, `lab()`/`lch()` exist (`Invalid lab()`), the alpha is parsed first.
  `gradientStopOffset` gives `0.00%` for a single stop. `d2themes.ThemableElement` prints coordinates with `svg.FormatFloat` (`%f` without trailing zeros, `-0` kept,
  integers without `.`): `svg.js` `formatFloat`. `svg.SvgPathContext` records typed `PathCommand`s (`pathCommands()`, kinds `PathCommandMove/Line/Cubic/Close`) and every shape
  that has custom path data has `getPathCommands()` (`shape.getPathCommands(s)` is `shape.GetPathCommands`); `shape.boxPath` is gone upstream. `lib/svg/doctype.go` (SVG import) is not ported.
- **Dependency drift that does not show**: Go 1.27 has Unicode 17 tables, Node 22.23 has ICU Unicode 17, and the cased-letter probes added in Unicode 16/17 (Garay, Latin
  additions) fold identically, so `goLower`/`equalFold` need no table. The d2themes catalog is unchanged (`genthemes.py` output is byte-identical).

### v0.9.0 residue (front end)

- Pointer addresses in `import key %q` errors: Go 1.27 prints 12 hex digits (`0x2ec8f9e61230`); `diff.mjs` blanks `0x[0-9a-f]{9,12}` in `errmsg`/`err`.
- Go fatal errors and hangs: the self-referential `vars` stack overflow (as before); glob programs that make Go (and the port) loop or explode, for example
  `* -> *` followed by hundreds of fields or `**.a: { Ab -> a*.y.y }`. Both sides do not finish; `nohang.mjs` filters them out of fuzz files.
- Markdown HTML versus goldmark 1.8.5 on pathological fuzz input (about 3% of generated Markdown snippets, about 0.7% of all `measure` fuzz cases): `\r` is kept by goldmark
  inside code and raw HTML (markdown-it normalizes it), tables that start in a lazy continuation line inside a list item or blockquote, `>` + tab + a block tag, an inline raw tag at the
  start of a line followed by a table. None occurs in D2's corpus (`mdhtml` 118/118, all `measure` corpus cases identical).
- `lib/shape` and `lib/color` libm residue as before (`shape` 63 of 360 within 1e-9; `oklab()/oklch()/lab()/lch()` last bit).

## Layout stage: what was learned

Run: `node diff.mjs layout corpus.jsonl [--utf16]` (`{diagram, err}` of `d2lib.Compile` with the dagre layout, as the e2e tests run it),
`node diff.mjs dims corpus.jsonl` (the state right after `SetDimensions`: sizes, label dims/positions, no layout), and
`node diff.mjs e2e e2e.jsonl` (D2's own goldens). `e2e.jsonl` comes from `e2eenum/run.sh`: it runs `go test` on D2's `e2etests`
with an overlay that swaps `run()` for a recorder (name, script, measured texts, themeID, expected errors), so the inputs are exactly what
Go compiles, whatever Go code builds them; the goldens are `testdata/<name>/dagre/board.exp.json` in the module cache. Fuzz with
`fuzz.mjs corpus.jsonl N seed > f.jsonl && node diff.mjs layout f.jsonl`.

- **The engine is dagre 3.1.1, not a port of dagro.** dagro (4.6k lines of Go, "D2-used layout surface") is itself a port of dagre 3.1.1 /
  graphlib 4.0.5 that was checked bit for bit against the npm package, plus three source corrections for inputs where the official package
  throws or returns NaN (same-direction parallel edges, several reversed partners, zero-size rectangle intersections; the patch is
  `testdata/differential/dagre-3.1.1-d2-compat.patch` inside dagro). `tools/d2ref/dagrebuild/build.py` turns the package's own `dist/dagre.js`
  (unminified, graphlib included) into `public/d2/vendor/dagre.js`: an ES module (no `eval`, no module state, so no fresh-engine-per-layout
  trick and no CSP exception) with those corrections applied. Unpatched 3.1.1 differs from dagro on one corpus
  graph (NaN coordinates) and throws on two more (that is what the corrections are for); 3.1.3 changes ordering, border-dummy and cluster-edge code,
  its fix for the same problem is different (the patch does not apply) and it already differs from dagro on `stable/us_map`: use 3.1.1 + patch. Result: 107 KB, 24 KB gzipped, against 284 KB / 65 KB for the v0.7.2 engine (dagre 0.8.5 with lodash). Only
  `Math.abs/ceil/floor/max/min`-class arithmetic is involved, so V8 and Go agree exactly: `--tol` is not used by any layout stage.
- **Engine-level harness.** `go run . dagro` (`dagrocheck.go`) runs dagro on a graph description; `dagrocmp.mjs cases.jsonl [bin]` wraps
  `dagre.layout` while the JS port compiles the cases, sends every recorded graph (nodes with parents, named multi-edges, attributes) to dagro and
  compares node x/y/width/height and edge points exactly. Use it first when a layout differs: if it is clean, the difference is in the glue or after
  it. `dagroinput.mjs` prints the recorded graphs; a patched copy of `d2dagrelayout/layout.go` (env var dump) shows what the Go glue really sends.
  To find where two layouts diverge inside the glue, print object boxes and edge routes after `dagre`, `adjustRankSpacing`,
  `adjustCrossRankSpacing` and `fitContainerPadding` on both sides (that is how the `seen` bug below was found).
- **Go map iteration that mutates the map.** `shiftReachableDown` ranges over the map `seen` and calls `processQueue()` inside the loop, which adds
  to `seen`. Go says such entries "may be produced during the iteration or may be skipped"; in practice a swiss map that grows while it is iterated keeps
  walking its old table and skips them. JS `Set` iteration visits everything added, which produced layouts Go never prints (found by the layout fuzzer,
  1 in ~1000 cases). The port iterates a snapshot (`[...seen]`). Other `range`-over-map loops in the glue only collect into slices or are
  order-insensitive.
- **Go-unstable output.** The glue still ranges over Go maps (`shiftReachableDown`'s `seen`/`shifted`, `adjustRankSpacing`'s ancestor maps), so Go itself prints
  different layouts on different runs for a few inputs (about 1 in 3000 generated cases). The JS port uses insertion order (and the snapshot above).
  The `layout` stage re-runs Go 100 times on a mismatching case and counts it as identical ("Go-unstable") if Go ever prints the JS answer;
  `cmp.mjs file.d2 bin 100` lists the distinct Go outputs of one case.
- **Text measurement changed under the hood.** v0.9.0 measures with `golang.org/x/image/font/sfnt` (a `metricPreservingFace` over `opentype`) instead of
  freetype. Differences that reach layout: glyph bounds of compound glyphs (`i`, `j`, accented letters) are computed in font units (component offsets and
  2.14 transforms applied to the unscaled points) and scaled once at the end, so a `.5` pixel rounds differently than freetype's per-component scaling (a
  column or label width off by one); the advance is the plain `hmtx` advance (no USE_MY_METRICS); `Face` size is `int32(0.5 + size*64)`.
  `textmeasure.js` `loadGlyph` ports that; `fonts/metrics.json` did not need regenerating (it already holds the point bounding boxes and
  component lists). The fonts have no `kern` table (v0.9.0's own `kern` code scales by `fixed.I(value)`, a 64x bug that never fires).
- **Markdown is measured by `LayoutMarkdown`.** `MeasureMarkdown` now builds the whole native-SVG layout and returns its width and height, but those are
  the *legacy* box model (`measureNode` with `cssLineBoxes=false`, run on an unnormalised parse tree) so graph sizes only changed in two ways: (1) HTML
  elements outside a fixed list (`div`, `span`, `details`, ...) are an error, `native Markdown SVG does not support HTML element <div>` (`MarkdownError` in
  `measureMarkdown`, returned through `getMarkdownDimensions`); (2) the Unicode fallback for Markdown text is `scaleUnicodeLegacy`, which first drops
  default-ignorable runes and clusters (ZWJ, variation selectors, format controls; the Go tables are Unicode 17, hard-coded where JS regexps lack the property) and
  floors each line at its measured width. Everything the painter needs (CSS line boxes, `measureCSSNode`, `scaleUnicodeCSS`, tables) is renderer work.
- **`LayoutNested` extracts all nested diagrams at once.** With more than one nested grid/sequence/constant-near at the same level it partitions the graph in one
  pass (`collectNestedExtractions`, `extractSubgraphs`: an edge between two nested diagrams belongs to the first; `rollbackAfter` restores the later ones if a
  nested layout fails). It also copies `g.Data` into the nested graphs and rejects objects whose position is infinite after layout
  (`object "x" has invalid position with infinity value: x=480.500000, y=+Inf`, e.g. a sequence group in a sequence group in v0.9.0's todo test).
- **Dagre 3.1 self-loops** come back as seven points with repeats: the glue removes consecutive duplicates and, for `a -> a`, wraps the route in two centre
  points so `TraceToShape` can chop both ends.
- **Not ported on purpose:** `d2lib.LayoutReuse` (opt-in; D2's own e2e tests turn it on, and the goldens still match without it, so replaying a base board's geometry
  for scenarios/steps gives what re-running the deterministic layout gives), `d2layoutfeatures`, the `d2plugin` feature checks.
- **Go values that bit**: `geo.TruncateDecimals` is `float64(int(v*1000))/1000`, so NaN/Inf become MinInt64/1000 (`goInt`); `d2sequence`
  `float64(label.Height/2.)` is an integer division (untyped constant `2.` becomes int) and `heightAdd` is an int; `cases.Title` (x/text)
  is a state machine (digits do not start a word: `1st` -> `1St`, `layers.x` stays one word) - ported with Unicode property escapes for
  its tables (`titleCase` in `d2graph.js`; exotic scripts/special casing other than final sigma, digraphs, ligatures are approximated);
  `encoding/json` refuses NaN, so d2ref prints `{"panic": ...}` for such a case (e.g. `style.opacity: nan`) and the harness skips it.
- **Not ported**: TALA (`'tala'` -> `TalaNotPorted`); ELK has its own section below. The Go harness
  and the e2e tests pass `Layout` explicitly, which overrides `d2-config`'s layout-engine, so no corpus case needs the engines; `sketch`
  only switches the font family to HandDrawn and is covered. `d2plugin.FeatureSupportCheck` (the "dagre does not support ..." errors
  the e2e tests expect on 5 cases) is not ported and not part of `d2lib.Compile`.
- **API shape**: `compile(text, opts, renderOpts)` async / `compileSync`: `opts` = `{utf16, fs, inputPath, layout, layoutResolver, routerResolver, measuredTexts, ruler (null = none), fontFamily, monoFontFamily}`;
  `renderOpts` = `{themeID, darkThemeID, sketch, pad, center, themeOverrides, darkThemeOverrides}` is filled in from `d2-config` and the defaults
  (read it back for the render stage: `pad` default 100, `center`, theme overrides). `diagram.config` carries themeID/darkThemeID/sketch. Errors are
  `Error` objects (`err.message` is Go's text). Register markdown-it first (`init({markdownit})`).
- **Conventions in the layout code**: Go's `obj.TopLeft.X` is `obj.box.TopLeft.x` (Box fields stay capitalised, Point fields are `x`/`y`), `obj.Width` is
  `obj.box.Width`, `obj.Label` is `obj.attributes.label`, `obj.Children` a Map (`size`), `LabelPosition` the string `obj.labelPosition`. `ExtractSubgraph`'s
  `nestedGraph.Root.Attributes = container.Attributes` is a struct copy in Go: `copyAttributes` in `d2layouts.js` copies the value fields and shares pointers.
  `slices.SortFunc`/`sort.Slice` use the pdqsort of `gosort.js`; `sort.SliceStable` uses JS's stable sort.

### ELK stage: what was learned

Run (Go side: `go build -o /tmp/d2ref .`, then `export D2REF_BIN=/tmp/d2ref` so `diff.mjs` does not `go run` for every batch):

```bash
node diff.mjs layout corpus.jsonl --layout elk [--utf16]    # also extra.jsonl, extralayout.mjs output, fuzz sets: --layout sets the engine of every case
node diff.mjs e2e e2e.jsonl --layout elk                    # testdata/<name>/elk/board.exp.json (e2eenum/run.sh records elkFeatureError too)
node fuzzlayout.mjs 3000 7 elk > f.jsonl                    # ELK profile: container <-> descendant edges, SQL/class column edges, self loops, ELK options
node elkcmp.mjs f.jsonl /tmp/d2ref                          # engine level: ELK.js (vendor/elk.js) against elk-go on the graphs the JS glue builds
node elkinputcmp.mjs f.jsonl dump.jsonl                     # the graphs the Go glue really marshals (sh elkdump/build.sh /tmp/d2ref_dump; D2REF_ELKDUMP=dump.jsonl /tmp/d2ref_dump layout) against the JS ones
node elkone.mjs prog.d2 /tmp/d2ref [--show]                 # one program (or several, separated by `---` lines), ELK.js against elk-go; ELK_ALT=build.js tries another build of the engine
node elkshrink.mjs f.jsonl 123 /tmp/d2ref                   # greedy reducer of an engine-level mismatch
node elkcsp.mjs                                             # headless Chromium: compile with layout elk under `script-src 'self'`
```

- **The engine is ELK.js 0.12.0 (npm `elkjs`), not a port of elk-go.** elk-go (49k lines) says it follows official ELK.js 0.12.0 and checks itself against that bundle; for the graphs
  D2's glue builds the two agree except in three places, which are small and are patched into the vendored build (`tools/d2ref/elkbuild/build.py` turns `lib/elk-worker.min.js`, which
  `elk.bundled.js` embeds byte for byte, into `public/d2/vendor/elk.js`; `ELK_COMPAT=none|origin|all` builds the plain or partly patched engine to see a difference):
  1. *Edges between a container and its own descendants* (`a -> a.b`, `a.b -> a`): elk-go translates `findCoordinateSystemOrigin` of ELK 0.8.1, ELK 0.12 returns `null` for an edge
     whose target is a descendant of its source. elk-go then walks up to the root when it offsets the route (`if current.ParentNode == nil { break }`), ELK.js would throw. The patch drops the
     check and adds the break (this alone fixed 5 of 1030 corpus graphs).
  2. *Several edges through the same compound node*: ELK splits cross-hierarchy edges node by node and sets the compound node's port constraints to `FIXED_SIDE` after the last external-port dummy;
     elk-go splits them edge by edge (import order) and sets it after the first, so every later dummy of that node takes its side from the boundary port instead of from the net flow; the ports
     it creates on the compound node and the order of its dummies (`reorderCompoundPortDummies`) follow the edges too. The patch tags the imported edges with their order and reproduces that
     (`elkgoPrepare`, `elkgoConstraints`, `elkgoPorts`, `elkgoReorder`); the Go version is `internal/layered/compound.go`.
  3. *Two-sided opposing self loops* (e.g. a SQL table with a self loop under `direction: right`, where D2 gives the table a SOUTH and a NORTH port): ELK.js takes the two sides out of a
     hash map keyed by identity-hashed enum constants (order = which constant was hashed first), elk-go takes north, east, south, west. The patch sorts them.
  Result: engine level `elkcmp.mjs` 1030/1030 corpus layouts and about 22k generated ones (6 seeds of `fuzzlayout.mjs`, 2 of the ELK profile with options) identical, ordered arrays and all
  numbers; the graphs the Go glue marshals are byte for byte the JS ones (`elkinputcmp.mjs`, 1030/1030, found with a patched copy of `layout.go` built through
  `-modfile`, `elkdump/build.sh`). Unpatched ELK.js differs on about 0.5% of corpus graphs and 0.3% of generated ones; every difference found was in these three places. A graph shape nobody has
  generated yet may show a fourth: that is what `elkshrink.mjs` and the Go debug-copy approach (copy elk-go, add `println`s, `-modfile` replace) are for.
- **Identity hash codes.** GWT gives objects `$H` hash codes from one global counter, which orders Java `HashMap`s of identity-hashed keys. elk-go replaces those with insertion order, so a result
  that depended on the counter would depend on the layouts run before it in the same engine. It does not (except the self-loop sides above): layouts run in one engine in different orders (corpus, six
  fuzz sets) all equal elk-go's fresh-engine answers; the engine keeps no module state beyond that, so one dispatcher is reused.
- **No `eval`, no worker, no `setTimeout`.** The GWT output is plain script (`grep` finds neither `eval(` nor `new Function` nor `importScripts` in `elk-worker.min.js`); elkjs runs it in a Web
  Worker or in a "FakeWorker" that defers with `setTimeout`. The vendored module exports the worker's `Dispatcher`, and `d2elklayout.js` calls it synchronously, which is what keeps `compileSync`/
  `layoutNested` synchronous. `node elkcsp.mjs` (Playwright's Chromium, page served with `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'`): `eval` and
  `new Function` are blocked in that page, the ELK layout still works, no violation is reported. So the ELK engine needs neither `'unsafe-eval'` nor `'wasm-unsafe-eval'` nor `worker-src`/`blob:`.
  (The `'unsafe-eval'` in `src/security.js` was for the embedded elk.js of D2's WASM build, which ran inside a blob: worker.) Size: `vendor/elk.js` 1.6 MB, 464 KB gzipped; the page downloads it with
  `import('./d2elklayout.js')` only when a diagram asks for ELK (`layout: 'elk'` in the options or `d2-config.layout-engine`), `compile()` does that by itself, `compileSync()` needs `await loadLayout('elk')`
  (else `LayoutNotLoaded`). Cost on a loaded dev machine: about 0.2 s to load and initialise the module, 0.3 s for the first layout (JIT warm-up), then 10 to 25 ms per layout (the D2 corpus's 1077 diagrams take about 10 s in all).
- **Options.** D2 v0.9.0's `d2elklayout.Layout(g, opts)` takes `ConfigurableOpts`; the CLI flags `--elk-algorithm`, `--elk-nodeNodeBetweenLayers`, `--elk-padding`, `--elk-edgeNodeBetweenLayers`,
  `--elk-nodeSelfLoop` reach it through the plugin's `HydrateOpts` (JSON with the Go tags, missing keys are Go zero values, not defaults). The port takes the same JSON as `compileOpts.elkOpts`
  (`hydrateOpts`), nothing in `d2-config` is read (only TALA reads `d2-config.data`). `diff.mjs layout` passes a case's `elkopts` to Go through the same plugin path. A padding option without `right=`
  makes Go panic (`parsePadding` indexes the submatch before checking it); the port throws the same.
- **Where elk-go and ELK.js still differ, and why it does not matter.** Non-layered algorithms (`--elk-algorithm radial|stress|mrtree|force|box`) on a diagram with an edge that crosses a container
  boundary: ELK.js refuses (`UnsupportedGraphException ... could not be found`: the container's own layout is layered and cannot reach the other end), elk-go lays the graph out and leaves the
  edge without a section, which makes D2's Go glue panic (`index out of range`), so no diagram comes out of Go either; the harness counts those as Go panics (`elkcmp.mjs` lists them).
  Algorithms other than layered are otherwise identical to elk-go (`stress`, `radial`, `mrtree`, `force`, `box` on flat and nested graphs are in the ELK fuzz profile).
- **Not ported**: `wasm.go` (`ConvertGraph`, the legacy raw-WASM export), `d2lib.LayoutReuse` (as for dagre, D2's e2e tests turn it on and the elk goldens still match without it).

### Notes for the render stage

- Inputs are `{diagram}` as printed by Go (`diagram.toJSON()`); `compile(...)` gives `diagram.shapes/connections/root/layers/...`. `Diagram.bytes()` and
  `hashID()` are in `target.js` (needed for multiboard IDs, `renderOpts.masterID`).
- `shape.icon` / `connection.icon` are `url.URL` objects (`url.js`), `diagram.fontFamily` etc. are plain strings.
- Layout output coordinates are integers for shapes and Go `float32`-rounded 3-decimal values for routes (`truncateDecimals` + `truncateFloat32` in the exporter).
- v0.9.0 paints Markdown labels as native SVG (`textmeasure.LayoutMarkdown`, `markdown_svg.go`, 2000 lines, plus `SafeMarkdownLink`, `links.go`). The layout stage ported
  only what decides box sizes (the legacy `measureNode`, `scaleUnicodeLegacy`, the unsupported-element error). The painter additionally needs `measureCSSNode`
  (CSS line boxes, fractional heading scales, `normalizeMarkdownWhitespaceTree`), `scaleUnicodeCSS`/`scaleUnicodeFallback` (emoji and fallback-font advances), and
  Ruler methods `measureFontAdvance`, `measureFontWidth`, `cssFontBoxMetrics`, `cssNormalLineHeight` that read the *original* font through `x/image/font/sfnt`
  (`font.MeasureString`, `font.BoundString`, `Metrics` at `int32(round(size*64))`). `fonts/metrics.json` only holds the 353 atlas runes; those methods need the full cmap and
  every glyph's advance (and the point bounds of the first/last glyph for `BoundString`), so `go run . fontmetrics` has to be extended for the render stage.
- `go run . layout` prints `d2target.Diagram` JSON; v0.9.0 goldens (`board.exp.json`) write `url.URL` fields in another order than the JS diagram does: compare with sorted keys
  (`diff.mjs e2e` does). `Diagram.Bytes()` (hash IDs) keeps the Go 1.25 field order for icons on purpose (`marshalHashJSON`), independent of the toolchain.
- The e2e inputs now include `real_world` (10 large diagrams from `testdata/files/*.d2`, also in the corpus) and every case runs with `LayoutReuse: true`;
  `e2eenum/run.sh <writable copy of the D2 tree>` regenerates `e2e.jsonl` (the module cache is read-only).

### Notes for the TALA stage

- TALA is `d2layouts/d2talalayout`: about 6k lines at the top and `internal/` below (about 64k in all), Go only, no JS original, deterministic per seed
  (`Seeds`, the e2e tests use one seed and `MaxConcurrency 1`). Nothing to vendor: it has to be ported, diffed with the same harness (engine-level first), and loaded lazily.
- All engines go through `d2layouts.LayoutNested` (done): grids, sequences and constant nears are laid out by D2 itself, the engine only sees plain graphs and a
  `RouteEdges` hook for the edges that cross nested diagrams (`routerResolver`, TALA brings its own).


## Render stage (SVG): what was learned

Run: `node diff.mjs svg corpus.jsonl` (also `svg e2esvg.jsonl`, `svg extra.jsonl`, fuzz files). Go mode `svgfromdiagram` prints `{diagram, ro, svg, err}`: it
runs `d2lib.Compile` with dagre (or takes a `diagram` JSON such as D2's `board.exp.json` directly), applies the optional `ropts` of the case and calls
`d2svg.Render` (`ropts.multiboard` calls `RenderMultiboard`); the JS stage (`svgcheck.mjs`) feeds **Go's own diagram and render options** to `d2svg.render` and compares the
SVG byte for byte, so the stage does not depend on the layout port. `svgnofonts` blanks the base64 font data on both sides. Inputs: `e2esvg.mjs <D2 src> > e2esvg.jsonl` (all 952 `board.exp.json`,
dagre/elk/tala, plus a multiboard case for boards with layers), `svgfuzz.mjs <jsonl> N seed > f.jsonl` (random pad incl. invalid ones, scale, center, theme/dark theme ids, salt, noXMLTag, omitVersion,
masterID, theme overrides), `graphmd.mjs` (Markdown-heavy texts, reused from the graph stage), `fuzz.mjs`. Support stages: `node flatecheck.mjs [N] [seed]` (JS zlib against Go's `compress/zlib`),
`node linebreakcheck.mjs`, `node highlightcheck.mjs [N] [seed]` (`BYLANG=1` lists per language what was identical or deferred).
Sketch mode: `--sketch` on any `svg` run, the `svgfull` stage (whole pipeline), `node roughcmp.mjs <cases> [bin] [--fuzz N seed]` (roughjs against rough-go) and `node sketche2e.mjs <D2 source>` (D2's sketch goldens); see "Sketch mode" at the end.

API (`public/d2/d2svg.js`): `render(diagram, opts) -> string` (Go's `Render`) and `renderMultiboard`; `renderAsync` / `renderMultiboardAsync` do the same but load what is needed on demand (fonts, Markdown layout, highlighter, patterns, the sketch module) and retry (the sync
functions throw `NeedAsset` when something lazy is missing). `opts` is `RenderOpts` in camelCase (`pad, sketch, center, themeID, darkThemeID, themeOverrides, darkThemeOverrides, scale, masterID, noXMLTag, salt,
omitVersion`; `d2lib.compile(text, opts, renderOpts)` fills the ones from `d2-config`) plus `fonts` and `fontBaseURL`. The diagram is what `compile` returns (or `diagramFromJSON` of Go's JSON). Usage:
`const ro = {}; const {diagram} = await compile(src, {}, ro); const svg = await renderAsync(diagram, {...ro, fonts: 'external'})`.

- **`fonts: 'embed'`** (default, Go-identical): every SVG carries WOFF subsets of the faces it uses, cut to the characters of its text (`d2svgfonts.js` + `fontsubset.js` + `flate.js`; the faces are
  `public/d2/fonts/*.ttf`, fetched on first use, only the styles the diagram uses). **`fonts: 'external'`** (what Rico should use): the `@font-face` rules keep Go's shape but `src: url(...)`
  points at the whole stripped TTF under `fonts/` (resolved against `opts.fontBaseURL`, default the `fonts/` directory next to the module), so the browser caches each face once per origin and the SVG
  is smaller by the subsets; nothing but `d2svg.js` is loaded. The page's CSP must allow `font-src` for that origin (a sandboxed iframe with a `blob:`/`data:` document needs absolute URLs). The
  stripped TTFs keep only the tables the subsetter reads (head hhea maxp cmap loca glyf hmtx name cvt fpgm prep gasp post OS/2), so they have no kerning/GPOS either, like D2's embedded subsets.
  Not handled: custom font families (`AddFontFamily`); the `d2fonts` fallback/emoji fonts are not used by the SVG path in v0.9.0 (the subsetter never falls back).
- **Go 1.27's flate is not the old one.** D2 v0.9.0 builds with Go 1.27, whose `compress/flate` is klauspost's: level 6 is `fastEncL6` (two hash tables, repeat offsets, `deflatefast.go`) with the new
  Huffman block writer. `flate.js` is a faithful port of exactly the path `lib/font` runs (a fresh writer per table, `Write; Flush; Close`, level 6); only the bit writer is simplified (it keeps a small
  accumulator, the stream is identical) and 64-bit hashes use 32-bit halves (`mulhi`). It matches Go on 3160 streams (random, text, sparse, repeated, whole fonts, 0 B to 250 KB).
- **`lib/font` details that bit**: `readInt16` is the signed value (its code is inverted but the cast cancels out); `getMetrics` appends to a slice of the font itself, which overwrites the lsb of the
  last long metric in place (kept: it only matters for composite glyphs added late); `GetEncodedSubset` falls back to the full encoding if `Sfnt2Woff` fails (it cannot for the bundled faces).
- **Which faces and characters are embedded** is decided by `font_corpus.go`: it re-reads the body fragment with Go's `encoding/xml` decoder and follows SVG text inheritance. `xml.js` (the decoder port of the graph
  stage) now also returns attributes, character data and namespace-translated names (`Decoder.token`); `d2svgcorpus.js` is the scan plus `pruneThemeCSS` (which rules of the palette stylesheet are dropped).
- **Hash and icons**: the diagram hash is `Diagram.Bytes()` over the JSON with `url.URL` fields in `legacyURLFieldOrder`; a diagram read back from JSON (`diagramFromJSON`) keeps icons as plain objects, so
  `svgcheck.mjs` rebuilds them as `url.URL`. A `url.Userinfo` marshals as `{}`, so icons with credentials cannot be round-tripped through Go's JSON: those cases are deferred (`icon-userinfo`).
- **Markdown labels** are native SVG in v0.9.0: `LayoutMarkdown` (markdown_svg.go) measures with the old box model (`measureMarkdownNode`, which gained a `cssLineBoxes` flavour and `fontScale`) and paints text/rect
  primitives; `mdlayout.js` ports it with the Ruler methods it needs (`measureFontAdvance` = x/image's `GlyphAdvance` + legacy kerning over the dumped glyph records, `cssFontBoxMetrics`, `cssNormalLineHeight`) and
  `linebreak.js` (uniseg's UAX 14 state machine, generated for U+0000..U+00FF from the Go tables by `genlinebreak.mjs`). `x/net/html` puts leading `<script>`/`<style>`/`<meta>`... in `<head>`, which the
  painter never sees: `stripLeadingHead`. **Deferred**: any Markdown text with a character outside U+0020..U+007E, U+00A1..U+00FF (the browser fallback emulation, emoji, CJK, combining marks are not ported).
- **Code labels** use chroma. `highlight.js` ports the RegexLexer engine; the lexers are chroma's own definitions exported by `go run . chromadump <names>` (XML via `chroma.Marshal`, the Go lexer with its closure
  replaced) and converted by `genlexers.mjs` to `lexers/*.json` (48 lexers, 344 KB, loaded one by one; `lexers/index.json` has the name/alias/extension table of all ~280 lexers, the token type hierarchy and the SVG
  attributes of the `github` and `catppuccin-mocha` styles as `StyleEntryToSVG` prints them). Language names resolve through `index.names` (unknown names use the fallback lexer exactly as Go does). chroma matches with
  **regexp2 (.NET syntax)**: patterns are translated to sticky JS regexps (`.`, `$`, `\A`, `[]...]`, `\p{L}`/`\p{N}`, leading `(?i)(?s)`), which is exact for ASCII text, so text with another character is deferred.
  regexp2 also mishandles character classes with several shorthand escapes of which one is negated (`[^\W\d]` matches digits, `[\D\w]` is just `\D`): the generator asks regexp2 (Go mode `regexp2`) for the ASCII set
  such a class matches and stores it per lexer (`cls`); a pattern the translator does not know (named groups, other `\p{..}`) makes that code label deferred (Haskell, PowerShell, Scala, Kotlin, Terraform hit this).
  **Deferred**: every language without a lexer file (about 230 of chroma's 280), non-ASCII code, and the rules above.
- **Patterns**: `paper` (435 KB) and `grain` are built-in texture definitions, shipped as `patterns/*.svg.txt` (generated by `genpatterns.mjs` from the Go assets; brotli decoded at build time) and loaded on first use.
- **Deferred classes** (counted, never as matches): `markdown-unicode`, code languages without a lexer / non-ASCII code
  (`code-language`, `code-non-ascii`), `icon-userinfo`, `compile-error` (Go printed no diagram). Counts now: corpus 196 of 1077 (191 compile errors, 5 markdown-unicode), e2e boards
  32 of 961 (21 markdown-unicode, 9 sketch, 2 compile errors). (`latex` and `sketch` were classes until their stages; `latex` had 4 corpus and 27 e2e boards, `sketch` 9 e2e boards.)
- **Residue** (differences that are not the renderer's): markdown-it versus goldmark on a few inputs (`~del~~` and `<!br>` render differently: the `mdhtml` residue of the leaf stage; 6 of 3160 Markdown-heavy fuzz cases);
  a Go panic is skipped by the harness.
- **Sizes** (gzip -9): `d2svg.js` 25.1 KB, `d2svgcorpus.js` 4.5, `d2svgassets.js` 1.4, `xml.js` 7.3 (shared with the graph stage), `mdlayout.js` 20.3 + `linebreak.js` 4.0 (only for Markdown labels), `highlight.js` 5.0 +
  `lexers/index.json` 8.2 + one lexer 1-3 (only for code labels), `d2svgfonts.js` 1.1 + `fontsubset.js` 6.8 + `flate.js` 11.5 (only for `fonts: 'embed'`), `d2svgpatterns.js` 0.8 + `patterns/paper.svg.txt` 160 /
  `grain.svg.txt` 21 (only for those fill patterns), faces `fonts/*.ttf` 48-75 KB each (SourceSansPro regular 75, bold 75, semibold 75, italic 48; SourceCodePro 50-67; FuzzyBubbles 59-61 for sketch mode;
  1.4 MB raw in total). Typical diagram (shape labels bold, connection labels italic): `external` loads about 38 KB gzipped on top of what compile needs (d2svg + corpus + assets + xml); `embed` adds the
  subsetter (19 KB) and two or three faces (about 200 KB).
- Sketch mode is documented in its own section below; the sketch row of the deferred classes is gone.
- Nothing in this stage touches Rico's app, the CSP or `package.json`; `public/d2/fonts/*.ttf`, `patterns/*`, `lexers/*` are plain static files next to the modules (check that the build copies them).


## LaTeX (d2latex): what was done, and where it does not match Go

Run: `node diff.mjs latex <file.jsonl>` (lines `{"text": <TeX>}`; Go mode `latex` = `d2latex.Render` and `d2latex.Measure`, compared as `{svg, err, width, height, merr}`);
`node latexformulas.mjs corpus.jsonl extra.jsonl e2e.jsonl e2esvg.jsonl > f.jsonl` lists every LaTeX label of D2's inputs (19 distinct formulas: corpus, extra,
every e2e script and every e2e diagram); `node latexfuzz.mjs N seed [--invalid P] [--depth D] > f.jsonl` is the grammar fuzzer (fractions, scripts, big operators,
delimiters, accents, fonts, matrices/cases/aligned/array, CD, spacing, colours, physics/braket/mhchem/cancel/gensymb/mathtools constructs, special characters,
and mutations that truncate/drop/insert stray characters); `node latexcases.mjs > extra-latex.jsonl` (34 D2 programs: shape and edge labels, `shape: text`, themes,
positions, links, tooltips/icons, shapes, 3D/multiple, sequence, grid, near, layers/scenarios/steps, classes, invalid TeX, empty, unicode, mhchem, physics, text
transform, arrowhead labels, vars) and `--gap` (3 programs where the engines differ). `layout`, `dims`, `svg`, `e2e` run with the engine loaded (diff.mjs does
`await loadLatex()`); the latex deferrals of the layout/svg stages are gone.

Files: `d2latex.js` (ports `latex_common.go`: `render(s) -> [svg, err]`, `measure(s) -> [w, h, err]` with `latex failed to parse: ` as the xdefer prefix and mathjax-go's
`Measure` rules: the `<svg ... width="Nex" height="Mex">` regexp, `ceil(N * 8)`; a `\tag` makes the width `100%`, so Go fails with
`latex failed to parse: mathjax-go: SVG dimensions not found`, kept), `vendor/mathjax.js` (the engine), `tools/d2ref/mathjaxbuild/{entry.js,build.sh}` (rebuild:
`sh tools/d2ref/mathjaxbuild/build.sh`, byte-reproducible), `d2graph.js` (`getLabelSize` and the edge label measure call `d2latex.measure`), `d2svg.js` (`renderLatex`:
the `<g transform=translate(..)>` + inner SVG, colour = stroke/connection colour, shape labels placed with the *recomputed* label position of `d2svg.go`), `d2lib.js`
(`compile` loads the engine on `NeedLatex` and compiles again; `compileSync` throws `NeedLatex` until `loadLatex()` resolved), `d2svg.js` `renderAsync` (kind `latex`).
Loading is a dynamic `import()` of `vendor/mathjax.js`: nothing downloads unless a diagram has a LaTeX label.

### The engine

- **D2 v0.9.0 does not run MathJax; it runs `mathjax-go` v0.1.0**, a 26k-line Go reimplementation (tex input 12.4k lines, svg output 6.3k, mhchem 2.6k, generated font
  data 3k lines / 1.3 MB) of the MathJax 3.2.2 pipeline that D2 <= v0.7.2 ran as a custom bundle (`mathjax.js`, 1.8 MB: lite DOM adaptor, TeX input with the packages base
  mathtools ams amscd braket cancel cases color gensymb mhchem physics, SVG output, `fontCache: 'none'`, `em: 16, ex: 8`, serialised with `adaptor.innerHTML`) inside goja.
  mathjax-go's own tests pin 28 D2 formulas by SHA-256 against that bundle.
- **npm `mathjax-full@3.2.2` + `mhchemparser@4.1.1`, configured as above (`entry.js`), is the same engine as D2's v0.7.2 bundle**: 654 formulas (the 28 above, MathJax's handler
  oracle cases, every TeX string in mathjax-go's tests, D2's docs) are byte-identical to the frozen bundle run in a fresh vm context per formula, which is how D2 ran it. One
  thing matters: D2 starts a new JS engine per `Render` because TeX state would leak between formulas; the bundle's entry creates the TeX jax, the SVG jax and the document
  per call (handler registration is the only module state; `\def`, `\label`, `\mathtoolsset` do not leak, checked). A shared document leaks (`\mathtoolsset{centercolon}` changed `:\approx`).
- **No port was written**; the build is `esbuild` over mathjax-full's CommonJS sources with `--bundle --format=esm --minify --target=es2020`, 1.7 MB, **599 KB gzipped
  (452 KB brotli)** (D2's own bundle: 598 KB gzipped). 611 KB of the raw size is `svg/fonts/tex/normal.js` (glyph paths), the other font variants about 400 KB; all needed (the
  MathML-to-SVG output asks for any variant), so there is no smaller component set. Plus `d2latex.js` 4 KB (1.8 KB gzipped).
- **CSP**: no `eval`, no `new Function` (the only `eval` in the bundle is the physics macro named `eval`); verified in Chrome under
  `default-src 'none'; script-src 'self'; connect-src 'self'` (`eval()` is blocked there and the formulas render): first load 170-200 ms from localhost (599 KB gzipped
  over the wire), 80 ms for four formulas including mhchem and CD, identical SVG to Node. `script-src` must allow the origin of `vendor/mathjax.js`; no
  `'unsafe-eval'` is needed, and no DOM is needed either (liteAdaptor; the harness runs it in Node). A sandboxed `blob:` iframe needs an absolute URL (`setEngineURL`).

### Where MathJax and mathjax-go differ (the reason latex is not "identical on all input")

Result: **every formula that occurs in D2's corpus, extra cases and e2e tests (19 distinct) is identical in SVG, size and error to Go (`latex` 19/19; all layout/dims/svg/e2e
latex cases N/N)**, but D2 v0.9.0 is not identical to MathJax 3.2.2 on input outside what mathjax-go's authors tested: of 115 ordinary formulas (physics, calculus, linear
algebra, chemistry, probability) 85 are byte-identical, of grammar-generated formulas (`latexfuzz.mjs`, 1500 each) 32-41% (the formulas are long, one difference fails one). The
differences are mathjax-go's, not the JS engine's (the JS engine equals the frozen bundle): it is a reimplementation with its own bugs, and D2's "without changing rendered
formulas" holds for the tested set only. Causes, with a probe of 2265 control sequence / environment names (5 templates each: `\x`, `\x{a}`, `\x{a}{b}`, `x \x y`, `\begin{x}..`):

1. **Macros Go does not define (135)**, they render as `Undefined control sequence \x` there: `\dots` (!), `\pmatrix`, `\matrix`, `\cases`, `\pmod`'s `\pod`, `\hline` in arrays, `\cr`,
   `\hfil`, `\hfill`, `\mathstrut`, `\strut`, `\newline`, `\overleftrightarrow`, `\underleftrightarrow`, `\overparen`, `\pmb`, `\mmlToken`, `\TeX`, `\LaTeX`, `\frak`, `\Bbb`, `\buildrel`,
   `\overwithdelims`, `\skew`, `\xLeftrightharpoons`, `\longrightleftharpoons` (so mhchem `<=>` fails in Go), `\symbf`.., all the physics trig names (`\sine`, `\acosine`..), `\flatfrac`,
   `\Rule`, `\Space`, `\leftroot`/`\uproot`... Conversely MathJax lacks 8 that Go has (`\boldsymbol`, `\enclose`, `\enskip`, `\noalign`, `\raisebox`, `\relax`, `\textsl`, `\vspace`, `\vcentcolon`).
2. **Physics overrides are missing in Go**: with the physics package `\div` is divergence (`\nabla\cdot`) and `\Re`/`\Im` are operator names; Go keeps `\div` = division sign and `\Re` = fraktur R.
3. **Inter-atom spacing**: Go does not treat `\frac` (and some other constructs) as an inner atom, so `\frac{a}{b} + c` has no space before `+` (width 4.932 ex vs 5.938 ex);
   `\sum..=\frac..`, `\lim ... = 1`, `\bar{x} = ..`, `h(x)=\max(0,x)`, `\{1,2,3\}`, `x_1, \ldots, x_n` all differ in width, so layout boxes differ too.
4. **Wrapper nodes**: MathJax wraps accents (`\bar`, `\hat`, `\vec`, ..), `\binom`, `$`, `/` and other `Other` characters in `TeXAtom` groups and writes transforms as separate
   `translate()`s; Go does not (same picture for most, a different SVG always; `\binom{a}{b}` is also displayed in another style, 5.428 ex vs 4.178 ex high); `\overline` uses another glyph (U+2013 stretchy vs U+00AF).
5. **Parser decisions**: Go reports `Double exponent` / `Double subscripts` for formulas MathJax accepts (`\underbrace{a+b}_{n}` is an error in Go: 4% of realistic formulas), `Missing \end{x}` /
   `Extra \end{x}` for environments MathJax reads differently, and treats `` ` `` as U+2018 where MathJax uses U+2035.
6. **Error text** (what an invalid formula shows inside the diagram, and its size): `Missing close brace` vs MathJax's `Extra open brace or missing close brace`, `Misplaced alignment tab character &amp;`
   vs `Misplaced &`, `You can't use macro parameter character # in math mode` vs the quoted one, `Extra \right` vs `Missing or unrecognized delimiter for \right`, ...
7. **mhchem**: `\pu{1.2 kg}` and `\ce{..}` with `\mkern`/`\smash` units differ by sub-pixel float rounding (`3054.8` vs `3054.5`) or spacing; `\longrightleftharpoons` and friends are missing.

What it would take to be identical everywhere: a line-for-line port of mathjax-go (`internal/tex` 12.4k lines, `internal/svg` 6.3k, `internal/mhchem` 2.6k, `internal/mml`+`layout`
+`jscompat`+`font` 1.3k, and the generated glyph tables 3k lines / 1.3 MB of data that must be loaded lazily too: about 22k hand-written lines before the tests) with
the harness already in place (`latex` stage + `latexfuzz.mjs`); the MathJax engine would be dropped. The alternative (decision for the owner): keep MathJax, which is what Rico's current
WASM D2 builds before v0.9.0 render (the MathJax 3.2.2 bundle in an embedded JS VM; Rico depends on `@terrastruct/d2` 0.1.33, which should be one of them), so Rico users would see no change,
and which is the more correct renderer in every difference above.
`extra-latex-gap.jsonl` holds three programs that show this on `layout`/`svg` (error text, the backtick, `\pu`).

## Sketch mode: what was learned

`sketch: true` (render option or `vars: {d2-config: {sketch: true}}`) switches the font family to HandDrawn (FuzzyBubbles, already part of the
layout stage), draws every shape and connection with Rough.js and adds the streak overlay patterns. `d2svg.js` loads `d2sketch.js` on demand
(`hooks.sketch`, `NeedAsset('sketch')`, so `renderAsync` does it by itself); `d2sketch.js` is the port of `d2renderers/d2sketch/sketch.go` and imports
`vendor/rough.js`. The scene files of that package (`scene.go`, `scene_connection.go`) belong to the raster pipeline and are not ported.

- **Library decision: npm `roughjs@4.6.6`, vendored unmodified, not a port of rough-go.** v0.9.0 draws with `github.com/d2lang/rough-go` v0.2.0 (2.9k
  lines, "Rough.js 4.6.6 behavior", whose own differential tests use the same npm tarball, sha256 `373873b2...`). The package's `bundled/rough.esm.js`
  is one minified ES module with its four dependencies (hachure-fill, path-data-parser, points-on-curve, points-on-path) inside: 27.7 KB, 8.9 KB gzipped, loaded only
  by `d2sketch.js` (`vendor/README.txt`, `vendor/rough.LICENSE.txt`). The engine-level diff decides it: `go run . rough` (`roughcheck.go`) runs one rough-go
  generator call (shape kind, arguments, options) and prints `ToPaths`; `roughcmp.mjs` renders the corpus (JS compile), D2's e2e boards and `extra.jsonl` in sketch mode with the
  generator wrapped to record every call (35,000 calls, 12,000 distinct, among them every rectangle, line, ellipse, path, polygon, linear path and circle d2sketch makes),
  adds random calls in D2's option profiles (`--fuzz N seed`: 120,000 generated calls over rectangles, ellipses, lines, polygons, arrowheads, SVG paths of M L H V C Q l and unreadable path data, shapes
  with every stroke width) and compares what both engines return, path by path. Result: **identical text for everything except the last bit** of numbers of ellipses,
  circles and zigzag-filled polygons (V8's `sin`/`cos` against Go's: `3.5241262247620253` and `3.524126224762025`); `truncatePathData` cuts every number to six decimals, after which the calls
  are identical: none of the corpus's 4,054 or the e2e boards' 7,981 distinct calls differs, and 120,000 generated calls gave one difference, an ellipse of width 572.51 (a size D2 never has: ellipse
  sizes are integers) where a last-bit difference lies across a six-decimal cut. A number can only differ visibly if its exact value lies within 1e-15 of such a cut. If it ever shows in real diagrams,
  Go's Cephes `Sin`/`Cos` (about 60 lines, arguments below 2^29 need no Payne-Hanek reduction) are what to port, as a prelude to the vendored file. No vendored patch was needed, so no build script.
- **Two real differences, both outside what a correct D2 produces.** (1) rough-go's path parser is lenient: path data it cannot read (`M NaN NaN L NaN NaN`, which D2's own
  layout can produce for a grid in a grid: `fuzzgrid:3:805`; a cut-off command) gives empty paths where roughjs throws (`Cannot read properties of undefined (reading 'type')`,
  `Path data ended short`). `d2sketch.newGenerator` wraps `path` and rebuilds the empty result (the same for every unreadable input: one empty `d`, with an empty fill path first when the
  shape has a fill). (2) SVG arcs (`A`) differ between the two libraries by up to 2e-5 when the radii have to be scaled up; D2 never emits arcs (shape paths are `M L C Z`, connections `M L C`),
  so `roughcmp.mjs --arcs` only documents it.
- **The e2etests' `sketch.exp.svg` are not sketch renders.** The name is historical: those tests render with `RenderOpts{Pad: 0}`, so `diff.mjs svg e2esvg.jsonl` (no `--sketch`) is
  what covers them. The real sketch goldens are `d2renderers/d2sketch/testdata/*/sketch.exp.svg` (37 of the 38 cases of `sketch_test.go`; the 38th uses ELK): `sketche2e.mjs <D2 source>`
  compiles each script in the JS port exactly as that test does (`Sketch: true`, theme, `FontFamily: HandDrawn`, dagre) and compares the SVG with the golden byte for byte: **37/37**, so
  layout with the HandDrawn font, the whole renderer and the rough drawing are tested against D2's own files, dark themes, Terminal, markdown, dots, paper and crow's feet included.
- **Harness**: `node diff.mjs svg <file> --sketch` renders every case in sketch mode (the flag adds `ropts.sketch` before Go runs, so Go renders sketch too); the new stage
  `svgfull` is the whole JS pipeline against Go's (JS compiles the text with the case's render options, so `--sketch` changes fonts, sizes and layout, then renders; diagram, render
  options, SVG and error are compared, and a mismatch is rerun 100 times in Go to detect Go-unstable layouts as the `layout` stage does); `svgfuzz.mjs` now sets `sketch` in 30% of its cases.
  Results (all identical to Go unless stated): `svg corpus --sketch` 877/877 (+200 deferred: 191 compile errors, 5 markdown-unicode, 4 latex), `svg e2esvg --sketch` 911/911 (+50: 27 latex, 21 markdown-unicode, 2 compile errors),
  `svgfull corpus --sketch` 1068/1068 (+9), `svgfull extra --sketch` and without it 397/397 (extra.jsonl has 10 new sketch cases: all shapes, effects, arrowheads, animated, containers with border labels,
  tables, markdown and code, grids, sequences, dark themes, boards), `svgfull extralayout --sketch` 49/49. Fuzz (`svg` stage with `svgfuzz.mjs` random options and sketch forced: corpus 3 x 1500 cases = 3666 rendered, e2e boards 1422;
  with the random 30% sketch: 2055 + 2384): all identical. Whole pipeline (`svgfull --sketch`): mutated corpus (`fuzz.mjs`) 2983/2983, grids (`fuzzgrid.mjs`) 1000/1000, sequences (`fuzzseq.mjs`) 1000/1000,
  generated programs (`fuzzlayout.mjs`, 2 seeds) 3496/3498 (the two are Go-unstable layouts) and Markdown-heavy cases (`graphmd.mjs`) 1392/1393 (the Markdown residue), see below.
  `npm test` has a sketch case (`test/d2svg.test.js`).
- **Details that bit**: `DefineFillPatterns` reads the buffer it appends to (fonts and stylesheet, where the pruned theme rules mention `url(#streaks-<luminance>-<hash>)`), not the body, so a streak
  pattern is defined exactly when a rule that uses it survived the pruning; the streak path data (9 KB, `patternassets.StreakPathData`) is a string in `d2sketch.js`; sketch elements are built with
  `NewThemableElement(tag, nil)`, so the inline-theme option does not reach them (as in Go); `shape.Width/2` is an integer division (ellipse centre, `Math.trunc`); `%f` and `%v` for the arrowhead
  transform and the font sizes (`goFixed`, `goV`); `Class` in sketch mode uses a header of exactly `2*rowHeight` (the plain renderer also takes the label height into account) and `Class`/`Table` draw no icon and no underline;
  a roughjs options object is not shared between calls (it keeps the PRNG), D2 creates fresh options for each call as roughjs's `_o` copies them; `roughness: 0.5` and the arrow seeds (1 to 8) are D2's.
- **Residue**: last-bit trig differences, removed by the truncation except in the astronomically rare cut-boundary case above; Go-unstable layouts in generated programs (two of 2000 `fuzzlayout` programs, Go itself prints two layouts, the port equals one: the `layout` stage's
  rule, now also in `svgfull`); the Markdown residue of the leaf stage (`graphmd` case 267: markdown-it against goldmark on a pathological input, a `labelWidth` of 56 against 35 in the diagram, no sketch involvement);
  deferred as before: LaTeX, non-Latin Markdown, unported code languages, ELK/TALA layout selection (the ELK sketch golden `elk_corners` is skipped; the renderer is layout independent and is covered by `svg e2esvg --sketch` on ELK and TALA diagrams).
- **Sizes** (gzip -9, loaded only for sketch diagrams): `d2sketch.js` 35.7 KB raw, 9.5 KB gzipped (9.2 KB raw of it is the streak path), `vendor/rough.js` 27.7 KB raw, 8.9 KB gzipped, plus the two handwriting faces
  `fonts/FuzzyBubbles-Regular.ttf` (59 KB gzipped) and `FuzzyBubbles-Bold.ttf` (57 KB) that `fonts: 'external'` references and `fonts: 'embed'` subsets. The default path loads none of it.
