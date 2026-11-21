# Porting D2 to JavaScript

Goal: render `d2` blocks in Rico with plain JavaScript in the browser, instead of D2's Go-compiled-to-WASM
build (`@terrastruct/d2`: 8.2 MB, 6.0 MB gzipped, about 0.8 s before the first diagram). Target: the default
(dagre) path around 100–150 KB gzipped, with ELK, sketch mode and LaTeX loaded only when a diagram uses them.

Source: D2 **v0.9.0** (`github.com/d2lang/d2`, MPL-2.0; Go module path changed from `oss.terrastruct.com/d2`, whose
last release is v0.7.2). Every ported file keeps the MPL header that `public/d2/parser.js` has. Rico itself stays
MIT; MPL is per file, so that is fine.

## Target version: v0.9.0 (changed from v0.7.2)

The port was started against v0.7.2 by mistake (the old module path's last release). Everything verified up to
commit `0cbfdae` was measured against v0.7.2; the Status table below shows those numbers until a row is re-verified.
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
- Initial v0.9.0 diff of the v0.7.2-era JS: parse 1077/1077; ir 1052/1077; graph 1060/1077; layout 942/1073.
- Layout stage result (below): dagre **3.1.1 from npm, vendored with dagro's three compat corrections** matches dagro bit for bit, so no
  Go port of dagro was needed; layout is 1073/1073 on the v0.9.0 corpus.

## Status

| Stage | Go packages | JS | Matches Go |
|---|---|---|---|
| parse | `d2ast`, `d2parser` | `public/d2/ast.js`, `parser.js` | 972/972 corpus cases, UTF-8 and UTF-16 |
| ir | `d2ir` (+ `d2format.Format`, `d2ast` helpers, the constants of `d2target`/`d2themes`, `textmeasure.ReplaceSubstitutionsMarkdown`) | `public/d2/d2ir.js`, `format.js`, `target.js`, `themes.js`, `textmeasure.js` (+ helpers in `ast.js`) | 1025/1025 corpus cases, UTF-8 and UTF-16; 190/190 extra cases (`extra.jsonl`); about 40k fuzzed cases. Residue below |
| graph | `d2compiler`, `d2graph` (not serde.go, not `SetDimensions`), `net/url`, `html.UnescapeString`, `encoding/xml` (the Markdown check), `sort.Slice`, `strconv`, `fmt.Sprintf` | `d2compiler.js`, `d2graph.js`, `url.js`, `gohtml.js` + `htmlentity.js`, `xml.js`, `gosort.js`, `strconv.js`, `gofmt.js` (+ `d2target` `Class`/`SQLTable`, `d2ast` label/near tables) | 1025/1025 corpus, UTF-8 and UTF-16; 347/347 `extra.jsonl`; about 30k fuzzed cases clean except the residue below. Support stages: `url` 4122, `htmlunescape` 6017, `xml` 9038, `sortslice` 3000, `strconv` 6093, `sprintf` 6501 (all identical); `graphmethods` (read-only d2graph methods) 1025 |
| layout | `lib/textmeasure` (glyph metrics, Markdown validation and legacy box model), `d2graph.SetDimensions`, `d2layouts` (+ `d2near`, `d2grid`, `d2sequence`), `d2dagrelayout` (Go glue; the engine is dagre 3.1.1 from npm with dagro's corrections, `vendor/dagre.js`), `d2exporter`, `d2lib` (Compile, applyConfigs/Defaults, boards), `lib/geo`, `lib/shape`, `lib/label` | `textmeasure.js` (+ `fonts.js`, `fonts/metrics.json`, `uniseg.js`, `htmlparse.js`), `geo.js`, `shape.js`, `label.js`, `gomath.js`, `d2graph.js` (`setDimensions`), `d2exporter.js`, `d2layouts.js`, `d2near.js`, `d2grid.js`, `d2sequence.js`, `d2dagrelayout.js`, `vendor/dagre.js` (107 KB, 24 KB gzipped), `d2lib.js` (`compile(text, opts)` -> `{diagram, graph, err}`) | v0.9.0: `layout` corpus 1073/1073 (+4 deferred: latex), UTF-8 and UTF-16; `extra.jsonl` 345/345 (+2 deferred); `extralayout.jsonl` (v0.9.0 cases written for this stage) 50/50, both modes; D2's e2e dagre goldens (`e2e` stage) 312/312 boards (+2 expected errors, 9 latex deferred, 5 without a dagre golden); `dims` 1073/1073; about 36k generated layout cases (`fuzzlayout.mjs`, 9 seeds) and 9k mutated corpus cases identical to Go (Go-unstable ones excepted, below). Engine level: `dagrocmp.mjs` 1030/1030 dagre layouts of the corpus and 20000+ generated ones identical to dagro. Support stages: `measure` 129354/129354 (incl. `--big`), `shape` 297/360 exact (rest within 1e-9, libm), `label` 381/381 |
| render | `d2renderers/d2svg`, `lib/svg`, `lib/color` | done: `svg.js`, `color.js` (renderer itself not started) | `color`: 2436/2438 (the two are `oklch()` last-bit libm) |
| later | `d2elklayout`, `d2sketch`, `d2latex`, `d2animate` | | |

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
5. **Don't type literal U+2028/U+2029 or other invisible characters into source**; write ` ` and check
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
- With no WASM and no ELK-by-default, `'wasm-unsafe-eval'` can leave the CSP in `src/security.js`.
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

- **Text measuring**: freetype's no-hinting path replayed over a dump of the glyph records (advance, bearings, point bounding
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
- Layout stage: `SetDimensions`, `GetLabelSize`, `GetDefaultSize` are ported but untested (`GetLabelSize` throws for latex: `d2latex` is not ported); `ApplyTextTransform` capitalize is an approximation of x/text `cases.Title`; `serde.go` is not ported. `layout.go` (ShiftStart, TraceToShape, ...) is ported and untested because it needs boxes.

### Graph residue

- Pointer addresses in `import key %q` errors (same as ir; `diff.mjs` blanks them in `err` too).
- Markdown validation depends on markdown-it matching goldmark's HTML: a few pathological inputs differ (`<!iv>x</div>`, control-character entities inside link destinations); same residue as `mdhtml`.
- `strconv.Atoi` results beyond 2^53 and hex-float subnormals are doubles/rounded; unobservable in the compared output.
- `html.UnescapeString` and `net/url` are complete (full entity table, 11 KB gzipped: `htmlentity.js`, only needed by `validateBoardLinks` and d2ir imports).


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
- **Deferred (not counted as matches)**: exactly the cases where a board has a `latex` label (needs `d2latex`/mathjax-go): the JS port throws
  `LatexNotPorted` from `setDimensions`, `compile` returns it as `err.name`, and `diff.mjs` counts the case as deferred (4 of the corpus, 2 of `extra.jsonl`, 9 e2e).
  ELK and TALA are not ported (`layout: 'elk'` -> `ElkNotPorted`, `'tala'` -> `TalaNotPorted`); the Go harness
  and the e2e tests always pass `Layout: dagre`, which overrides `d2-config`'s layout-engine, so no corpus case needs them; `sketch`
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

### Notes for the ELK and TALA stages

- ELK: v0.9.0 is `elk-go` ("a native Go port of the ELK behavior used by D2", target ELK.js 0.12.0 exactly; its own tests compare ordered JSON against the official bundle).
  The dagre result suggests the same plan: vendor npm `elkjs@0.12.0` (`elk.bundled.js` is large; check whether `elk-api.js` plus a worker-less layout is smaller and whether
  `layered`'s D2 profile is all that is needed), port `d2elklayout/layout.go` (new in v0.9.0: `descendant_shifter.go`, `spatial_index.go`, route-around-containers fixes,
  self-loop label fixes) and compare. Build the engine-level harness first (`dagrocmp.mjs` is the template: wrap the engine call, record its input graph, send it to
  `elk-go` through a new d2ref mode, compare exactly). `e2e` goldens for ELK are `testdata/<name>/elk/board.exp.json` (cases with measured texts and `justDagre`
  have none); generalise `diff.mjs e2e` by passing the engine name and `layout: 'elk'`. `d2-config.layout-engine` is ignored by the harness (`Layout` is always set), so ELK
  corpus runs need a `layout` field per case (`input.Layout` exists in `main.go`).
- TALA is `d2layouts/d2talalayout`: about 6k lines at the top and `internal/` below (about 64k in all), Go only, no JS original, deterministic per seed
  (`Seeds`, the e2e tests use one seed and `MaxConcurrency 1`). Nothing to vendor: it has to be ported, diffed with the same harness (engine-level first), and loaded lazily.
- All engines go through `d2layouts.LayoutNested` (done): grids, sequences and constant nears are laid out by D2 itself, the engine only sees plain graphs and a
  `RouteEdges` hook for the edges that cross nested diagrams (`routerResolver`, TALA brings its own).
