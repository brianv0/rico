# Porting D2 to JavaScript

Goal: render `d2` blocks in Rico with plain JavaScript in the browser, instead of D2's Go-compiled-to-WASM
build (`@terrastruct/d2`: 8.2 MB, 6.0 MB gzipped, about 0.8 s before the first diagram). Target: the default
(dagre) path around 100–150 KB gzipped, with ELK, sketch mode and LaTeX loaded only when a diagram uses them.

Source: D2 **v0.7.2** (`oss.terrastruct.com/d2`, MPL-2.0). Every ported file keeps the MPL header that
`public/d2/parser.js` has. Rico itself stays MIT; MPL is per file, so that is fine.

## Status

| Stage | Go packages | JS | Matches Go |
|---|---|---|---|
| parse | `d2ast`, `d2parser` | `public/d2/ast.js`, `parser.js` | 972/972 corpus cases, UTF-8 and UTF-16 |
| ir | `d2ir` (+ `d2format.Format`, `d2ast` helpers, the constants of `d2target`/`d2themes`, `textmeasure.ReplaceSubstitutionsMarkdown`) | `public/d2/d2ir.js`, `format.js`, `target.js`, `themes.js`, `textmeasure.js` (+ helpers in `ast.js`) | 1025/1025 corpus cases, UTF-8 and UTF-16; 190/190 extra cases (`extra.jsonl`); about 40k fuzzed cases. Residue below |
| graph | `d2compiler`, `d2graph` (no dimensions), `d2target` types, `d2themes` | | |
| layout | `lib/textmeasure`, `d2graph.SetDimensions`, `d2layouts` (+ `d2near`, `d2grid`, `d2sequence`), `d2dagrelayout`, `d2exporter`, `lib/geo`, `lib/shape`, `lib/label` | | |
| render | `d2renderers/d2svg`, `lib/svg`, `lib/color` | | |
| later | `d2elklayout`, `d2sketch`, `d2latex`, `d2animate` | | |

Not needed: `d2oracle`, `d2lsp`, `d2format` (except what `d2ir` calls), `d2plugin`, `d2renderers/d2ascii`, `d2js`.

## The harness: always diff against Go

`tools/d2ref` runs the real Go D2. `tools/d2ref/diff.mjs` runs the JS port on the same input and reports
the first JSON path that differs.

```bash
curl -sSLo d2.zip https://proxy.golang.org/oss.terrastruct.com/d2/@v/v0.7.2.zip && unzip -q d2.zip   # D2 source
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
