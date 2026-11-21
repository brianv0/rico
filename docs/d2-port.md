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

## Status

| Stage | Go packages | JS | Matches Go |
|---|---|---|---|
| parse | `d2ast`, `d2parser` | `public/d2/ast.js`, `parser.js` | **v0.9.0**: corpus 1077/1077 and `extra.jsonl` 390/390, UTF-8 and UTF-16 |
| ir | `d2ir` (+ `d2format.Format`/`FormatKeyPath`, `d2ast` helpers, the constants of `d2target`/`d2themes`, `textmeasure.ReplaceSubstitutionsMarkdown`) | `public/d2/d2ir.js`, `format.js`, `target.js`, `themes.js`, `textmeasure.js` (+ helpers in `ast.js`) | **v0.9.0**: corpus 1077/1077 (UTF-8 and UTF-16); `extra.jsonl` 390/390 (both); mutation fuzz 3 x 3000 (both, 1 case dropped: Go does not finish) and glob/board/class/import grammar fuzz (`globfuzz.mjs`) 3 seeds about 1100-1400 each, all identical. Residue below |
| graph | `d2compiler`, `d2graph` (not serde.go, not `SetDimensions`), `net/url`, `html.UnescapeString`, `encoding/xml` (the Markdown check), `sort.Slice`, `strconv`, `fmt.Sprintf` | `d2compiler.js`, `d2graph.js`, `url.js`, `gohtml.js` + `htmlentity.js`, `xml.js`, `gosort.js`, `strconv.js`, `gofmt.js` (+ `d2target` `Class`/`SQLTable`, `d2ast` label/near tables) | **v0.9.0**: corpus 1077/1077 (UTF-8 and UTF-16); `extra.jsonl` 390/390 (both); the same fuzz sets as `ir` identical; `graphmd` (Markdown-heavy) 2000/2000. Support stages: `url` 4122 (3 seeds), `htmlunescape` 6017, `xml` 9038, `sortslice` 3000, `strconv` 6093, `sprintf` 6501 (all identical); `graphmethods` 1077 |
| leaf | `lib/textmeasure` (ruler, legacy Markdown measure), `lib/shape`, `lib/label`, `lib/geo`, `lib/color` (+ csscolorparser, go-colorful parts), `lib/svg` (FormatFloat, path commands), `d2themes` (`ThemableElement`), `d2target`, `d2fonts` | `textmeasure.js` (+ `fonts.js`, `fonts/metrics.json`, `uniseg.js`, `uniprops.js`, `htmlparse.js`), `shape.js`, `label.js`, `geo.js`, `color.js`, `svg.js`, `themes.js`, `target.js` | **v0.9.0**: `measure` 129354/129354 (+ `extra-measure.jsonl` 113/113; fuzz 3974-3990 of 4000, Markdown HTML residue below), `mdhtml` 118/118 on the corpus's Markdown, `shape` 297/360 exact + 63 within 1e-9 (libm; same on 3 x 3000 fuzz), `label` 381/381 (+ 3 x 3000), `color` 2467/2470 exact + 3 within 1e-9, `element` 1500/1500, `target` 886/886, `targetstatics`, `dims` 1073/1073 (+ 390 extra, 2 x 3000 fuzz) |
| layout | `lib/textmeasure`, `d2graph.SetDimensions`, `d2layouts` (+ `d2near`, `d2grid`, `d2sequence`), `d2dagrelayout` (Go glue; D2's own `dagre.js`/`setup.js` run unmodified from `vendor/`), `d2exporter`, `d2lib` (Compile, applyConfigs/Defaults, boards), `lib/geo`, `lib/shape`, `lib/label` | `textmeasure.js` (+ `fonts.js`, `fonts/metrics.json`, `uniseg.js`, `htmlparse.js`), `geo.js`, `shape.js`, `label.js`, `gomath.js`, `d2graph.js` (`setDimensions`), `d2exporter.js`, `d2layouts.js`, `d2near.js`, `d2grid.js`, `d2sequence.js`, `d2dagrelayout.js`, `vendor/`, `d2lib.js` (`compile(text, opts)` -> `{diagram, graph, err}`) | `layout` corpus 1021/1021 (+4 deferred: latex), UTF-8 and UTF-16; `extra.jsonl` 343/343 (+2 deferred, 2 Go panics); `dims` 1021/1021; D2's e2e goldens (`e2e` stage) 296/296 dagre boards (+9 latex deferred, 7 stale golden dirs); about 10k fuzzed cases clean except the residue below. Support stages: `measure` 127259/127259, `shape` 297/360 exact (rest within 1e-9, libm), `label` 381/381 |
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
- **dagre**: D2 already runs `d2layouts/d2dagrelayout/dagre.js` (plus `setup.js`) through a JS runtime.
  Import that file directly; port only the Go glue around it.
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
- Layout stage: `SetDimensions`, `GetLabelSize`, `GetDefaultSize` are ported but untested (`GetLabelSize` throws for latex: `d2latex` is not ported); `ApplyTextTransform` capitalize is an approximation of x/text `cases.Title`; `serde.go` is not ported. `layout.go` (ShiftStart, TraceToShape, ...) is ported and untested because it needs boxes.

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

- **Everything matches without tolerance.** dagre.js only calls `Math.abs/ceil/floor/max/min`, which are exact in goja and V8, and its
  sorts have total tie-breakers, so JS (V8) and Go (goja) give identical numbers; `--tol` is not used by any layout stage. goja's
  `for in` order of integer-like keys did not matter either.
- **Fresh dagre per layout, like goja.** `d2dagrelayout.js` builds the same strings Go evals (setup.js, `setGraph`, `setNode/setParent/setEdge` lines,
  `dagre.layout(g)`, the `JSON.stringify(g.node(...))` reads) and runs them with `new Function`; dagre's module state (lodash `uniqueId`) is
  re-created per call (the compiled factory is kept). `new Function` needs `'unsafe-eval'` in a page CSP: the render/wiring stage
  has to either allow it for this one script or provide `setDagreFactory(fn)` with dagre loaded as a classic script instead.
  `await loadDagre()` (or `d2lib.init()`) must run first; `compileSync` needs it done, `compile` awaits it.
- **Go-unstable output.** `d2dagrelayout` ranges over Go maps (`shiftReachableDown`'s `seen`/`shifted`, `adjustRankSpacing`'s ancestor maps),
  so Go itself prints different layouts on different runs for some inputs (seen on a fuzzed `dagre_spacing_right.d2`: 2 variants over
  12 runs). The JS port uses insertion order. The `layout` stage re-runs Go 30 times on a mismatching case and counts it as identical
  ("Go-unstable") if Go ever prints the JS answer. D2's own goldens are all stable.
- **Go values that bit**: `geo.TruncateDecimals` is `float64(int(v*1000))/1000`, so NaN/Inf become MinInt64/1000 (`goInt`); `d2sequence`
  `float64(label.Height/2.)` is an integer division (untyped constant `2.` becomes int) and `heightAdd` is an int; `cases.Title` (x/text)
  is a state machine (digits do not start a word: `1st` -> `1St`, `layers.x` stays one word) - ported with Unicode property escapes for
  its tables (`titleCase` in `d2graph.js`; exotic scripts/special casing other than final sigma, digraphs, ligatures are approximated);
  `encoding/json` refuses NaN, so d2ref prints `{"panic": ...}` for such a case (e.g. `style.opacity: nan`) and the harness skips it.
- **Deferred (not counted as matches)**: any board with a `latex` label (needs `d2latex`/MathJax in goja): the JS port throws
  `LatexNotPorted` from `setDimensions`, `compile` returns it as `err.name`. ELK is not ported (`layout: 'elk'` -> `ElkNotPorted`); the Go harness
  and the e2e tests always pass `Layout: dagre`, which overrides `d2-config`'s layout-engine, so no corpus case needs ELK; `sketch`
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
