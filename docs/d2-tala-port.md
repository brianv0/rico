# Porting TALA to JavaScript

TALA is D2's own layout and edge-routing engine (`d2layouts/d2talalayout` in D2 v0.9.0, MPL-2.0, open source and bundled with D2). It has no JS
original, so every line is ported by hand and checked against the Go implementation. This file is the plan, the harness manual and the notes per
package; later agents rely on it, so keep it accurate. The general port rules (line for line, Go names in camelCase, Go semantics pitfalls, the D2
diff harness) are in [d2-port.md](d2-port.md) and apply here too.

**Status (T0, the foundation): done.** Ported and verified against Go: `gorand` (Go's `math/rand`), `layoutgraph` (with `nodeshape`, which it
needs), `graphjson`, `limits`, `invariant`, `typedpool`, `graphbounds`, `labelgeom`, and the D2 -> TALA adapter graph (`translateGraph`).
**T1 (`loops`, `grouping`, `proximity`, `trees`): done** (section "T1" at the end). Not started: everything from `hierarchy` up (plan below).

**Status (T1, `routing`):** the **core** of `internal/routing` is ported and verified (OVG, edge router, slingshot, guards; section "Routing core" below): `public/d2/tala/routing/`,
`routing/core.js` is the API boundary to the stage half, which is not ported yet.

| Go package | JS | Lines of Go (tests) | Verified by (cases identical to Go) |
|---|---|---|---|
| `math/rand` (rngSource) | `public/d2/gorand.js` | n/a | `talarand`: 600 sequences, about 18k draws (Int63, Uint32, Uint64, Int31, Int, Float64, Float32, Int63n, Int31n, Intn, Perm, Shuffle, `limits.Shuffle` with its work count), seeds incl. 0, -1, 2^31-1, 2^63-1, -2^63 |
| `internal/limits` | `tala/limits.js` | 363 (327) | `talarand` (GuardShuffle), `talaops` (guards' `used()` through graphbounds); unit tests in `test/tala.test.js` |
| `internal/invariant`, `typedpool` | `tala/invariant.js`, `typedpool.js` | 20, 29 | unit tests |
| `internal/nodeshape` | `tala/nodeshape.js` | 2348 (211) | `talanodeshape`: 427/427 (all 23 kinds + `""` + unknown, 7 sizes, table with 0..5 columns: snap points, port indices, mirrored/center ports, label tiers, table ports, inner box, placement) |
| `internal/layoutgraph` | `tala/layoutgraph.js` | 11227 (4208) | `talaops` 115/115 fixtures and 4560/4560 mid-pipeline graphs (see below), `talagraphjson` 4560 + 115 |
| `internal/graphjson` | `tala/graphjson.js`, `bigjson.js` | 2016 (1179) | `talagraphjson`: 115/115 testdata fixtures and 4560/4560 pipeline-stage graphs (Unmarshal + Serialize round trip, identical JSON) |
| `internal/graphbounds` | `tala/graphbounds.js` | 231 (260) | `talaops` op `graphbounds` (bounds, fixed bounds, per node with and without siblings, empty set, guard use) |
| `internal/labelgeom` | `tala/labelgeom.js` | 35 (110) | through `Edge.boundingBoxValues` in `talaops` (arrowhead labels) |
| adapter (`adapter.go`, `adapter_validate.go`, `seedgraph.go`, `limits.go`, seed plan of `layout.go`) | `tala/d2talalayout.js` | about 1100 | `talaadapter`: corpus 1073/1073 (UTF-8 and UTF-16; with the 4 LaTeX cases 1077/1077 after merging the LaTeX port), e2e inputs 300/300, `extra.jsonl` 400/400, `extralayout` 50/50, `fuzzlayout` 2500/2500, `fuzzgrid` 600/600, `fuzzseq` 600/600 |
| `internal/loops` | `tala/loops.js` | 329 (61) | `talat1ops` op `loops` (routes, label positions and `LoopOffsets` of every node, with and without positions): see T1 |
| `internal/grouping` | `tala/grouping.js` | 1985 (about 2570) | `t1diff stages` 1 (`PreprocessSequences`), 5 (`PreprocessClusters`), 19 (`CleanupStuff`); `talat1ops` ops `resetClusters`, `seqEdges`, `cluster`, `join`, `rebuild`: see T1 |
| `internal/proximity` | `tala/proximity.js` | 668 (1270) | `t1diff stages` 6 (`PreprocessHubs`); `talat1ops` ops `hubs`, `commonUncle`, `nearsHerds` (nears, herds): see T1 |
| `internal/trees` | `tala/trees.js` | 2707 (2340) | `t1diff stages` 3 (`PreprocessTrees`); `talat1ops` op `trees` (Preprocess + Place as placement calls them): see T1 |
| `slices.SortFunc`, `SortStableFunc`, `cmp.Compare` | `tala/goslices.js` | n/a | `talat1ops` op `slices`: 2,300 arrays |
| `internal/routing` **core** (OVG, router, slingshot, guards: about 9.9k of the 15.7k lines) | `tala/routing/*.js` (`core.js`) | about 9900 | `tools/d2ref/tala/routingcheck.mjs`: 6328 recorded `RouteGraph` calls identical (corpus x 3 seeds, e2e, fixtures, 2 fuzz families, `considerNodeLabels` variants), 11/11 golden OVGs, stage 30 on 1865 graphs (section "Routing core") |

## Running it

```bash
# once (needs Go 1.27; GOTOOLCHAIN=auto downloads it): copy the D2 module, install the overlay, build xdump.bin
export TALA_REF=/tmp/tala-ref                 # default; the copy of the module lives here (about 114 MB)
tools/d2ref/tala/setup.sh                     # re-run after editing anything under tools/d2ref/tala/ (it recopies and rebuilds)
cd tools/d2ref
go run . corpus <D2 v0.9.0 source dir> > corpus.jsonl      # as for the D2 port; e2e.jsonl from e2eenum/run.sh
node tala/corpus.mjs $TALA_REF                # -> tala-corpus.jsonl (1077), tala-e2e.jsonl (309), tala-fixtures.jsonl (115)
node tala/stagegraphs.mjs tala-corpus.jsonl 250 > tala-stagegraphs.jsonl     # 4560 graphs from Go's pipeline stages
node randcorpus.mjs 600 > tala-rand.jsonl; node nodeshapecorpus.mjs > tala-nodeshape.jsonl

node diff.mjs talagraphjson tala-fixtures.jsonl            # also tala-stagegraphs.jsonl
node diff.mjs talaadapter   tala-corpus.jsonl [--utf16]    # also tala-e2e.jsonl
node diff.mjs talaops       tala-fixtures.jsonl            # also tala-stagegraphs.jsonl
node diff.mjs talarand      tala-rand.jsonl
node diff.mjs talanodeshape tala-nodeshape.jsonl
node tala/lint.mjs                                         # naming rule of the port (below) + no literal U+2028/9
node talatry.mjs adapter tala-corpus.jsonl 793 --go        # one case, JS and Go side by side
node --test test/tala.test.js                              # unit tests, no Go needed (part of npm test)
node --test test/tala-routing.test.js                      # routing core: unit tests + replay of recorded Go calls, no Go needed

# routing core (own module copy: TALA_REF=/tmp/tala-ref-routing tala/setup.sh); every check prints its counts
node tala/routingcheck.mjs routing tala-corpus.jsonl --seeds 1,2,3     # every RouteGraph call of Go's pipeline: OVG, routes, distances, work
node tala/routingcheck.mjs routing tala-e2e.jsonl                      # also: routinglabels (considerNodeLabels on), frouting/froutinglabels tala-fixtures.jsonl
node tala/routingfuzz.mjs 400 1 > tala-routingfuzz.jsonl               # tables, trees, hierarchies, clusters, containers, labels; then routing ... --seeds 1,2
node tala/routingcheck.mjs ovggolden                                   # the 11 golden OVGs of internal/testdata/ovg
node tala/routingcheck.mjs trace tala-e2e.jsonl                        # traceToShapeBorder against stage 30
```

`tools/d2ref/main.go`'s `layout` mode accepts `layout: "tala"` (and `seeds: [..]`, default TALA's `{1,2,3}`), with `RouterResolver` set to
`d2talalayout.RouteEdges`. It builds against the public module, so no overlay is needed for it.

## The Go harness (`tools/d2ref/tala/`)

TALA's packages are Go `internal`, so nothing outside `d2layouts/d2talalayout` can import them, and the module cache is read-only. `setup.sh` copies the
v0.9.0 tree to `$TALA_REF` and adds, **inside that copy**:

| overlay file | installed as | what it does |
|---|---|---|
| `engine_xdump.go` | `internal/engine/xdump_hook.go` | `XLayoutObserved`: a copy of `engine.Layout` + `runAllStages` that calls an observer with the graph after every stage (index -1, name `input` is the cloned input). It reimplements pipeline.go by copy: keep it equal if pipeline.go changes |
| `root_xdump.go` | `xdump_export.go` | `XDumpTranslate` (adapter only), `XDumpLayout` (Layout with the seeds run one after another, per-seed records, the real selection and compound candidate, then the real patch) |
| `routing_xdump.go` + `routing_hooks.mjs` | `internal/routing/xdump_hook.go` (+ a few inserted `xHook*` calls) | the call recorder of the routing core check (section "Routing core"); the hooks do nothing unless an xdump routing mode switches them on |
| `xdump/*.go` | `internal/xdump/` | `package main`, may import the internal packages; the modes below; `sanitize.go` prints non-finite floats as strings `"+Inf"`, `"-Inf"`, `"NaN"` |

`xdump.bin <mode> < cases.jsonl > out.jsonl`, one JSON object per line. The case format is d2ref's (`path`, `text`, `utf16`, `fs`) plus `seeds`,
`maxConcurrency`, `themeID`. Graph dumps are `graphjson.Serialize` output (the representation of `internal/graphjson`; **int64 IDs print as JSON numbers
and can exceed 2^53**: read them with `public/d2/tala/bigjson.js`, which is what `diff.mjs` does for the `tala*` stages).

| mode | input | output |
|---|---|---|
| `adapter` | D2 text | `{invocations: [{adapter: <graphjson>, err?}], err}`: the TALA graph for every call of the layout function (one per board and nested layout). No layout runs; objects and edges get a placeholder placement and routing is a no-op so compile goes on |
| `scores` | D2 text | invocations with `adapter`, `seeds: [{seed, err?, penalty, area}]`, `selected` (index of the best seed before the compound candidate), `compound` (`none`/`unchanged`/`kept`/`rejected`), `final` (the selected graph) |
| `stages` | D2 text | `scores` + per seed `stages: [{index, name, graph}]`: the graph after every one of the 37 stages of `pipeline.go` (index -1 `input` first). Heavy: one graph per stage per seed |
| `layout` | D2 text | `{diagram, err}`: the real `d2talalayout.Layout` (concurrent) through `d2lib.Compile`, the diagram the D2 tests see |
| `times` | D2 text | `{ms, err}` wall time of one full compile with `Layout` |
| `svg` | D2 text | `{svg, err}` |
| `graphjson` | `{graph}` | Unmarshal + Serialize round trip |
| `fstages` | `{graph, seeds:[123]}` | the engine pipeline on a graphjson fixture: `{err, penalty, area, stages, final}` (the engine's own golden tests use seed 123) |
| `fscore` | `{graph}` | `quality.EvaluateWithArea` of the fixture |
| `lgops` | `{graph, args: [ops]}` | what the layoutgraph API computes (ops: `orders`, `validate`, `clone`, `geometry`, `pairs`, `edges`, `split`, `abduct`, `transactions`, `nodes`, `graphbounds`); the JS twin is `opsStage` in `talacheck.mjs`, keep both in step |
| `rand` | `{seed, ops}` | replays calls on `rand.New(rand.NewSource(seed))` |
| `nodeshape` | `{shape, x, y, width, height, numColumns}` | ports and label policy of a TALA shape |
| `routing`, `routinglabels` | D2 text (`seeds`) | `{invocations: [{seeds: [{seed, err, calls: [{stage, name, call}]}], compound}], err}`: every `RouteGraph` call with the router level record (see "Routing core"); `routinglabels` runs the routers with `considerNodeLabels` |
| `frouting`, `froutinglabels` | `{graph, seeds:[123]}` | the same on a graphjson fixture through the engine pipeline: `{err, calls}` |

`go test` of the TALA packages can be run in the copy: `cd $TALA_REF && go test ./d2layouts/d2talalayout/...`.
`tala/e2egolden.mjs` checks the harness itself: `xdump layout` with seeds `[1]` reproduces **309/309** of D2's own `e2etests/testdata/*/*/tala/board.exp.json`
goldens (shapes, routes, label positions).

### Corpus files (all generated and gitignored; `*.jsonl` except `extra*.jsonl`)

| file | what | made by |
|---|---|---|
| `tala-corpus.jsonl` | D2's 1077 test snippets, `layout: tala` | `tala/corpus.mjs` |
| `tala-e2e.jsonl` | the 309 e2e cases that have a TALA golden (`seeds: [1]`, as the e2e tests run) | same |
| `tala-fixtures.jsonl` | 115 graphjson fixtures of `internal/testdata`: `layout/*` inputs and their `graph.exp.json` (`/exp`), `regression/*`, `benchmark/*`, `ovg/*` inputs | same |
| `tala-stagegraphs.jsonl` | graphs from the pipeline stages of Go (clusters, sequences, hubs, hierarchies, abductions, routes) | `tala/stagegraphs.mjs` |
| `tala-rand.jsonl`, `tala-nodeshape.jsonl` | cases of the `talarand` and `talanodeshape` stages | `randcorpus.mjs`, `nodeshapecorpus.mjs` |

### TALA in Go on the D2 corpus (default seeds {1,2,3})

`xdump times`, one process, 4 cores: of the 1077 corpus cases **884 lay out successfully**, 188 stop in the D2 compiler (invalid snippets of D2's own
compiler tests, same as for dagre), **5 fail in TALA** itself:
`all TALA seed attempts failed: ... TALA LocalOptimize requires a finite positive cell size` (a node with no size: `d2oracle/edit_test.go` case 521),
`D2 object "x" must set top and left together for a locked position` (659), `no actors declared in sequence diagram` (835),
`could not find center of b. Is it declared as an actor?` (866), `object "awkward small talk.icebreaker attempt" has invalid position with infinity value`
(1063, a D2 `LayoutNested` error). All 309 e2e cases with goldens lay out (and match the goldens with seeds `[1]`).

Wall time per laid-out case (all seeds, goroutines on 4 cores): median 5 ms, p90 29 ms, p99 445 ms, max 5.1 s (corpus case 914, a real-world diagram);
whole corpus 33 s. Seeds are 3 independent full pipelines, so a JS port (single threaded) should expect roughly 3x the CPU time of the Go figure, and
the routing and placement stages dominate (the corpus `times` figures per case: `node tala/stats.mjs times.jsonl tala-corpus.jsonl`).

## Determinism: what a deterministic JS port must reproduce

Measured: `tala/determinism.mjs` runs the real `Layout` (goroutines and all) N times and compares the whole output. **The 1077 corpus cases x 20 runs
gave 0 differing outputs; the 91 cases that take 25-400 ms x 5 runs with every core also kept busy by spinning processes gave 0** (`tala/determinism.mjs cases.jsonl N --load`; a loaded run of those 91 cases takes about 50 s).
Reading the source agrees: results do not depend on timing or scheduling.

- **Seeds.** `Layout` runs every seed (`{1,2,3}`, or `tala-seeds` of the diagram data, at most 16 unique, deduplicated in first-seen order) in goroutines,
  but each seed is an independent pipeline on its own `layoutgraph.Clone` of the input, with its own `rand.New(rand.NewSource(seed))` (two generators per
  pipeline: `random` and `hierarchyPlacementRandom`, both seeded with the seed; `grouping.AddClusters` and `placement.Place` create more from the seed).
  Selection is **by exact score only**: lowest `penalty` (`cmp.Compare`, non-finite penalties lose), then lowest `area`, and on an exact tie **the later
  configured seed wins** (`attempt.index > bestIndex`). The completion order of the goroutines does not enter. Errors of single seeds are collected per
  index; if all fail the error is `all TALA seed attempts failed: seed 1: ...` joined in seed order. After the selection `engine.CompoundCandidate` runs at
  most one more trial on the selected graph (`hierarchy.PlaceCompound` with `rand.NewSource(0)`, then `reroutePlaced`) and keeps it only if its score is
  strictly better (`candidate.score.compare(incumbent.score) < 0`). A JS port runs seeds sequentially in index order with the same rule.
- **Time.** `time.Now` is used only for per-stage timing diagnostics (`stageDurations`, off in production). No `WithTimeout`/deadline: only the caller's
  context can cancel. Work budgets are counters, not clocks (below).
- **Routing goroutines** (`routing/coordinator.go:101`): one worker per route "flavor"; responses are sorted back to the declared router order
  (`slices.SortStableFunc` by index) before any result is looked at, and failures are examined in that order. `successfulRouteFlavorResponses` returns a
  work-limit error as soon as any flavor hit it ("accepting a flavor that happened to finish first would make the resource bound depend on goroutine
  scheduling"), so the deterministic answer is: all flavors are computed to completion, ordered by flavor index. The only shared mutable state is the route
  work guard (`routeWorkGuard`, atomic CAS in parallel mode): when the aggregate budget is *not* exhausted (every corpus case) the result is independent of
  which worker charges first; only *which* worker sees the error first could vary if the budget runs out, and that case is an error either way. A port should
  charge the same units (it is a counter) and treat exhaustion as the same error.
- **placementcost goroutines** (`placementcost/graph.go:126`): `EdgeLength` splits nodes over `min(nodes, GOMAXPROCS)` workers (1 worker up to 10 nodes),
  each writes `costs[i]`; the sum is then taken **in node index order** (`for _, c := range costs { totalSum += c }`), which is the same float sequence as the
  sequential branch. So the worker count cannot change the result: a JS port sums sequentially in node order.
- **Maps.** Wherever Go ranges over a map and the order matters, the code sorts (`ClusterOrder`, `TreeOrder`, `SequenceOrder`, `HubOrder` by node ID,
  `sortNodesByID` uses `sort.Slice`, i.e. pdqsort: `gosort.js`). Places that still range over a map without sorting but whose result is used as a set
  (so the order is unobservable): `Node.connectedNodes` (callers that need an order use the `ConnectedNodes` list, see the note in its JS source),
  `abductEdges` collecting the existing abductions of all clusters/sequences (first unused match wins; ties between identical pairs are not expected),
  `collectRuntimeObjectsContext`, `clustersWithWorkGuard` (sorted by cluster ID afterwards), `Commit`'s container and overlap loops (any bad one rejects).
  The JS `Map`/`Set` iterate in insertion order, which is one of Go's possible orders. If a later stage finds a map-order dependence it must be recorded here.
  **Found in T1:** `trees.buildPlacementTrees` ranges over a map of up to three tree directions and `mergeWith` (the first largest placement tree that can take
  undirected roots) depends on that order, so an isolated tree with roots in several directions plus undirected roots is placed differently from run to run in Go
  (2 outputs in 40 runs of one generated case; no corpus, e2e or fixture input has the shape). `layoutgraph.Validate` names an arbitrary cluster vessel in the
  `cluster vessel N has no cluster record` error. See "T1" at the end.
- **Work budgets** are deterministic counters (`limits.WorkGuard`, `OptimizationWorkGuard`, `routeWorkGuard`): 61.4M engine units (`MaxEngineWorkUnits`),
  1e9 per layout for transactions (`MaxTransactionWorkUnits`, one guard per seed pipeline: `EnsureTransactionWorkGuard` in `runAllStages`), 250M per
  optimization, 68M for tree placement, 50M for labels, 1e9 for bin packing. They matter only when a graph is big enough to exhaust one (an error, no
  partial result), but a port that wants identical *errors* on huge inputs must charge the same units in the same places: the ported guards do, call for call.
  One known difference: Go also charges the spare slice *capacity* in the preflights (`accountSpareCapacity`); JS arrays have none, so those charges are 0
  (only visible within ~1e6 references of the limit).
- **Floating point.** `math.Min/Max/Round/Floor/Ceil/Abs/Sqrt` agree between Go and V8 bit for bit (Round is half away from zero: `goRound`). Everything TALA
  computes in `layoutgraph`, `graphbounds`, `nodeshape` matched exactly (no tolerance used by any stage). Libm functions (`Pow`, `Sin`, `Exp`, `Log`)
  differ in the last bit between Go and V8; look for them (and for uint64 hash arithmetic, e.g. the edge-length cache state in `placementcost`) in the stages
  that follow before assuming exactness.

## Port conventions (all of `public/d2/tala/`)

- **Errors are exceptions.** A Go `(T, error)` returns `T` and throws a `GoError` (`goerrors.js`: `errorf(message, cause)`, `errorsIs`, `errorsNew`, `errorsJoin`;
  `%w` is the `cause`, messages are formatted by the caller: use `goV` for `%v` of floats). A Go `panic` throws `GoPanic`; a JS `TypeError` stands for a Go
  runtime panic. A `recover()` site catches only non-`GoError` exceptions (`isPanic`), a site that inspects a returned error catches only `GoError`.
- **Contexts** are `context.js` (`background`, `withCancel`, `withTimeout`, `withValue`, `ctx.err()`, `ctx.hasDone()`); guards are `limits.WorkGuard` (`step()`, `add(n)`,
  `check()`, `finish()`, `used()`); a "workStepper" is any object with `step()` and `finish()` (`layoutgraph`'s unbounded one is `{step(){}, finish(){}}`).
- **EntityIDs are BigInt** (random vessel/sequence IDs use 63 bits); IDs of D2 objects are FNV-1a values (< 2^32) or spill IDs >= 2^32. Never mix with Number.
  JSON of IDs goes through `bigjson.js`; map keys in graphjson are decimal strings.
- **Names.** Go names in camelCase (`Node.TopLeft` -> `node.topLeft`, `D2ID` -> `d2ID`, `ID` -> `id`). When a Go type has an exported and an unexported member
  whose names differ only in the case of the first letter (the exported wrappers of the `*_access.go` files; fields vs methods), **the exported one keeps the plain
  name and the unexported twin gets a trailing underscore**: `node.container` is the field `Container`, `node.container_()` the method `container()`;
  `node.isContainer()` is the exported method, `node.isContainer_` the field. `tala/lint.mjs` checks the field/method pairs (a method used as a property is
  silently truthy). The pairs of `layoutgraph` (plain name = exported, add `_` for the unexported twin):
  - Graph: abductEdges, allDescendantNodes, applyEdgeAbductions, area, boundingBox, containerFixedOrigin, containerPadding, containerRDFSOrder, crossingCost (field `crossingCost_`), fixedNodes, hasFixedNode, isTreeSentinel, newRequestTransaction, nonCenterPortCost (field `_`), resetTurnCost, restoreEdgeAbductions, turnCost (field `_`)
  - Edge: arrowheadTo, boundingBoxValues, directedEndpoints, euclideanDistance, hasArrowTo, hasDuplicateIn, hasOverlappingEnd, hasTableColumn, hierarchyRankWeight (field `_`), isAxisAligned, isBetweenTableColumns, isBidirectional, isClusterEdge, isDirected, isDuplicateOf, isLoop, isStraight, isTargetedTo, isTreeEdge, isUndirected, ownArrowheadsMatch, reconnect
  - Node: adjacent, area, center, centerPorts, connectedNodes, connectionTo, container (field is the plain one; the method is `container_()`), containerLevel, containsPoint, deltaTo, distanceTo, doesOverlap, doesOverlapAt, fitToBoundingBox, fixedOrigin, isAdjacentTo, isClusterVessel (field `_`), isContainer (field `_`), isDescendantOf, isMajorityTarget, isPointNear, isWithinBounds, mirror, mirroredPorts, modifierElementAdjustments, nearestSharedAncestor, orderedNears, orientation, orthogonalDistanceTo, overlappingPorts, overlapsAlongDimension, overlapsLine, passesThrough, ports, portsByOrientation, positionContainerChildren, shapeType (field `_`), spillsOutOf, translate, transpose, wrapChildren
  - Nodes (namespace): boundingBox, center, centerWithWorkGuard, fixedNodes, hasFixedNode, intersectsNode, setGraphReference; module functions: covers, sortNodesByID, ensureTransactionWorkGuard, existingTransactionWorkGuard, contextWithTransactionWorkGuard
  - Tree: sentinelNode; Sequence: first, last, isActive; Cluster: isActive; Label/Icon: positionFixed (field `positionFixed_`)
  Slice types with methods are namespaces taking the array first: `Nodes.fixedBounds(nodes)`, `Edges.portEdges(edges, node)`. Nil receivers: use the free functions `isDescendantOf(a, b)`,
  `clusterIsActive(c)`, `sequenceIsActive(s)`, `ancestryParent(n)`, `effectiveContainer(n)`, `nodeLevel` (inside the file) where Go calls a method on a possibly nil pointer.
- **`Node` embeds `geo.Box` and `nodeshape.Shape`.** `node.box` is a `geo.Box` (fields `TopLeft`, `Width`, `Height` as in `geo.js`) shared with the node's shape;
  `node.topLeft`, `node.width`, `node.height` are accessors for it. The shape's methods are forwarded (`node.portIndices(o)`, `node.snapPointPercentages()`, `node.getInnerBox()` ...).
  Go value copies of `geo.Point` (`tl := *node.TopLeft`) are `.copy()`; pointer sharing is object sharing.
- **Maps and sets.** `map[*Node]T` is `Map`, `map[*Node]struct{}` is `Set` (insertion order), `map[geo.Point]T` is `layoutgraph.PointMap` (keys are x,y values),
  nil container is the key `null`. `nil` slices are `[]` unless the Go code tests for nil.
- **Snapshots.** Go's transaction snapshots copy struct values and slice backing arrays; the JS ones copy own properties and restore arrays *in place*
  (`splice`), maps by clear-and-refill, so identity of arrays/maps/boxes survives a rollback as in Go. Spacing and EdgeStyle (value members) are copied explicitly.
- `generated`: `nodeshape.js` was translated from the Go files by `gennodeshape.py` (kept in the session scratch, not committed: the file is now hand-maintained);
  `ShapeTable` has two hand fixes (nil -> empty for `centerPortIndices`, `mirroredPortIndices`).

## What `layoutgraph` is (read this before porting anything above it)

One mutable `Graph` (`nodes`, `edges`, `cellSize`, `containers` Map<Node|null, Node[]>, `clusters`, `sequences`, `trees`/`nodeToTree`, `hubs`, `directions`,
`commonUncleSiblings`, the cached costs `crossingCost_`, `turnCost_`, `nonCenterPortCost_` computed lazily from `maxEdgeLength`, and `edgeLengthCache`),
`Node` (id, `box`, `edges`, `nears`, `container`/`cluster`/`sequence`/`herdAssignment`/`hierarchy`, `label`, `icon`, `fixedTopLeft`, desired size, `loopOffsets`,
`margin`/`padding`, flags), `Edge` (`from`, `to`, `points`, arrowheads and their labels, `minWidth/minHeight`, `label`, `labelPercentage`, table column indices,
`style`), and the grouping records `Cluster`, `Sequence`, `Tree`, `Hierarchy`, `HerdAssignment`, `EdgeAbduction`. Contents:

- geometry on nodes/pairs (`deltaTo`, `doesOverlap*`, `orientation`, `distanceTo`, bounds with outside labels and icons, `ports`/`centerPorts`/`mirroredPorts`, `containerPadding`,
  `insidePlacement`, `wrapChildren`, `positionContainerChildren`), reachability (`allReachableNodesGuarded`, `connectedNodes`, `Nodes.clusters` = `DistanceClusters`);
- topology: `connect`, `abductEdges`/`restoreEdgeAbductions` (edges of descendants are temporarily moved to the container's children), `splitSubgraphs` (+ ownership journal), `clone`;
- `Transaction`: speculative moves with `addOp`/`commit` (`ErrInvalidCandidate` rejects and rolls back; any exception rolls back), `updateState`, `rollback`,
  `GraphState` snapshots (geometry-only or topology), placement-cost snapshots, one shared work guard per request (`ensureTransactionWorkGuard(ctx)`);
- `validateEngineGraph` (the bounded topology preflight every entry point runs), `validatePositionedGraphSelection`, `countSegmentCrossings`;
- **`clone` is the per-seed reset**: it copies stable state and *drops* margins/paddings, loop offsets, herd assignments, long-distance neighbor requirements, the edge-length
  cache, `commonUncleSiblings`, and `Label`/`Icon` `positionFixed`; node adjacency lists are rebuilt in `graph.edges` order. Clones resolve nodes by ID (duplicate IDs are an error).
- `graphjson.serialize` is the canonical dump of this state (nodes in `graph.nodes` order then cluster/sequence members, vessels, containers by reverse-DFS order,
  hierarchies, directions, costs). It does **not** contain margins, paddings, loop offsets, herd assignments, `nears` of non-listed nodes or the edge-length cache: a stage
  that depends on those needs its own dump (add it to `xdump` and `opsStage`; the deep state can also be read with a reflection dumper, not written yet).

## Routing core (`public/d2/tala/routing/`)

The `routing` package (15.7k Go lines) is split in two. **This directory is the core**: the orthogonal visibility graph (OVG), the OVG edge router
(Dijkstra with the slingshot pre-pass) and everything they need to run, about 9.9k Go lines (9.3k whole files plus the parts of `coordinator.go` and `route_stage_guard.go` they call), one JS file per Go file. **`routing/core.js` is the API
boundary** (it re-exports everything below and its header lists what the stage half may rely on). The second half (stage logic) is not ported yet and
goes into the same directory, importing `./core.js`.

| Go file(s) | JS (`routing/`) | notes |
|---|---|---|
| `ovg.go`, `ovg_node.go`, `ovg_edge.go`, `ovg_edge_set.go`, `ovg_hierarchy.go`, `ovg_resource.go` | `ovg.js`, `ovg_node.js`, `ovg_edge.js`, `ovg_edge_set.js`, `ovg_hierarchy.js`, `ovg_resource.js` | OVG construction with its build guard; `OVG.marshalJSON()` is Go's `MarshalJSON` |
| `ovg_edge_router.go`, `slingshot.go`, `priority_queue.go`, `route.go`, `loop_router.go` | `ovg_edge_router.js`, `slingshot.js`, `priority_queue.js`, `route.js`, `loop_router.js` | the router; the methods of `slingshot.go` are installed on `OvgEdgeRouter.prototype` |
| `tunnel.go`, `tree_routes.go` | `tunnel.js`, `tree_routes.js` | needed by the OVG build (they were in the "stage half" list of the task) |
| `coordinator.go` (the part the router calls) | `route_line.js` | `GenerateRouteResponse`, the flavor names, `routeLine`/`routeLineGuarded`/`routeLineChecked`, `edgeCanOverlapEdges`, `findOverlappingEdges`, `sourceAndTargetClusterNodes`, `maxSideLength`, `hasSharpAngleToBorder` |
| `route_search_guard.go`, `route_stage_guard.go` (guards), `work.go`, `tuning.go` | `route_search_guard.js`, `route_stage_guard.js`, `route_limits.js`, `work.js`, `tuning.js` | `RouteSearchWorkGuard`, `RouteWorkGuard`, the aggregate-work context, `stableSortRouteValues`; the limit constants are gathered in `route_limits.js` (a leaf module: breaks import cycles) |
| `standalone_route_guard.go`, `cluster_route_guard.go`, `cost.go`, `geometry.go`, `turns.go`, `filter.go`, `trace.go`, `snapshot.go` | `standalone_route_guard.js`, `cluster_route_guard.js`, `cost.js`, `geometry.js`, `turns.js`, `filter.js`, `trace.js`, `snapshot.js` | guarded helpers, `traceToShapeBorder` |
| **not ported (the stage half)** | | `coordinator.go` (flavor workers, `finalizeSelectedRoutes`, `reorderSelectedRoutes`, `routeEdgesWithResourceGuards`, `routeAdditionalEdgesWithResourceLimits`, `routeSentinelEdge`, `routeInSShape`, `StraightEdgesFallback`, `ReorderDuplicates`, `Crosshatch`), `graph_stage.go`, `standalone_router.go` (`RouteEdges`), `postprocess.go`, `nudge_channels.go`, `shortcut_routes.go`, `swap_ports.go`, `edge_simplify.go`, `balance_crossings.go`, `port_interior_balance.go`, `balance_route_guard.go`, `trace.go`'s two stage entry points, and from `route_stage_guard.go` the atomic-stage machinery (`captureRouteMutations`, `validateRouteStageGeometry`, `routeStageGraphBoundingBox`, `runAtomicRouteStage*`; `snapshot.js` has the snapshot types they use) |

**API for the stage half.** `buildOVGFromGraphWithGuard(g, nearbyNodes, ovgGuard)` (or `...WithLimits(ctx, g, nearby, limits)`), `defaultOVGBuildLimits()`,
`newOVGBuildGuard(ctx, limits)`; `newOVGEdgeRouterWithWorkLimit(ctx, flavor, ovg, g, existingRoutes, edges, workLimit)` -> router; `router.generateRoutes(workerCtx,
straightLineFallback)` -> `GenerateRouteResponse {routes, distance, err, flavor, work}` (the error is in `err`, like Go; everything else throws);
`router.considerNodeLabels`; `new Route({gEdge, ovgNodes, fromPort, toPort})`; `route.createSegmentEndpoints()`; `makeLoopRoute(edge, ovg)`;
`newRouteWorkGuard(ctx, location, limit)` + `contextWithRouteAggregateWork(ctx, guard)` (the stage-wide aggregate budget: build the routing context with
it before creating the OVG guard and the routers, as `RouteGraphWithWorkLimit` does); `routeLineGuarded`, `tryStraightEdgeFallbackGuarded`,
`reorderDuplicatesInEdgesGuarded`, `traceToShapeBorderGuarded`, `edgeCanOverlapEdgesGuarded`, `estimateRouteCostGuarded`, `routeIntersectsNodeGuarded`.
Go `(T, error)` returns T and throws a `GoError`, exactly as in the rest of the port.

**What the core needs from other packages (`routing/deps.js`).** `hierarchy.IsHorizontal(nodes)` (12 lines: implemented there),
`labeling.PositionArrowheadLabel(edge, isTarget, route)` and the type `labeling.PositionedArrowheadLabel` (35 lines: implemented there; the box is
`label.box`, a `geo.Box`; `label.copy()` is Go's value copy). The core does **not** use `loops`, `quality`, or `labeling.PlaceNewEdges` (those are the stage half:
`loops.Route`, `quality` in `nudge_channels`/`shortcut_routes`/`port_interior_balance`, `PlaceNewEdges` in `RouteEdges` and the coordinator). When the real
`hierarchy` and `labeling` modules are merged, make `deps.js` re-export them (same names and semantics).

**Naming.** `OVGNode` embeds `*geo.Point`: `node.point` is the shared point, `node.x`/`node.y` read and write it. `OVG.Ports/Centers` are `Map<Node, ...>`,
`OccupiedPoints` is a `PointMap`, `VerticalEdges/HorizontalEdges` are `Map<float, OVGEdge[]>`. Go's `portDirectionSet` is a number (bitmask over `geo.Orientation`,
TopLeft=bit 0 .. NONE=bit 8) with the free functions `directionsHas/directionsAny/directionsTransformed`; port metadata per owner is `{directions, isCenterPort}`.
The methods of `ovgEdgeRouter` and `OVG` that are defined in other files (`slingshot.go`, `ovg_hierarchy.go`) are plain functions with `this` = the receiver, installed on
the prototype by `ovg_edge_router.js` / `ovg.js`, so the modules do not import each other's classes. `RouteWorkGuard`'s atomic path is the sequential one (flavors
run one after another). The unguarded `positionedArrowheadLabelCost` lives in `slingshot.js` (as in Go).

### How the core is verified (`tools/d2ref/tala/routingcheck.mjs`)

TALA's whole `EdgeRouting` result also depends on the stage half, so the core is checked **at the level of the router calls**. `setup.sh` also installs
`routing_xdump.go` into the Go copy (`internal/routing/xdump_hook.go`) and `routing_hooks.mjs` inserts a few `xHook*` calls (about 10 lines in `graph_stage.go`,
`coordinator.go`, `ovg_hierarchy.go`; idempotent, fails loudly on a missing anchor) that record, for every call of `RouteGraph` (the EdgeRouting stages 21 and 24
and the compound candidate), the graph before routing and per routed subgraph: the node IDs, the nearby obstacle nodes, the OVG that was built (nodes sorted by point
with their adjacency in `node.Edges` order, port owners with direction masks and center flags, near-port flags, containers, ports per owner, centers), the build guard
counters, the routes that existed before the flavors ran (tree and loop routes: built by the stage half in Go, replayed from the record), the edges to route, the
response of every flavor (routes as OVG node coordinates, distance, error text, work units used) and the final edge points. xdump modes: `routing` (D2 text; the
record per seed and stage index) and `frouting` (a graphjson fixture through the engine pipeline); `routinglabels`/`froutinglabels` run the routers with
`considerNodeLabels` on (the standalone `RouteEdges` setting, which no pipeline run uses).

The JS twin (`routingreplay.mjs`) rebuilds the graph from its graphjson, restores the adjacency order, splits it into the same subgraphs, builds the OVG with the
JS core, recreates the routers with the recorded existing routes and runs every flavor (`generateRoutes`), then compares OVG, work counters, and every flavor's routes,
distance, error and work units. Also: `node tala/routingcheck.mjs ovggolden` (the 11 golden OVGs of `internal/testdata/ovg`, from the graph Go hands to EdgeRouting),
`node tala/routingcheck.mjs trace <cases>` (`traceToShapeBorder` against stage 30 on `stages` dumps), and `node --test test/tala-routing.test.js` (unit tests + replay of
recorded calls from `test/fixtures/tala-routing-calls.json`, no Go needed).

**Results (all identical to Go: OVG, every flavor's routes and distance, error text, route-search work units).** Counts are RouteGraph calls / subgraphs / edges routed / flavor runs:

| input | calls | subgraphs | edges | flavor runs |
|---|---|---|---|---|
| D2 corpus, 1077 cases, seeds {1,2,3} (`routing`) | 1370 | 1793 | 5452 | 5295 (16768 routes) |
| e2e cases with goldens, 309, seed 1 | 206 | 321 | 1372 | 929 |
| the same corpus with `considerNodeLabels` (`routinglabels`, seed 1) | 465 | 606 | 1890 | 1776 |
| graph fixtures of `internal/testdata`, 115 (`frouting`, seed 123; also `froutinglabels`) | 122 (+122) | 199 (+199) | 2350 | 559 (+559) |
| `routingfuzz.mjs` (tables, trees, hierarchies, clusters, containers, labels), 400, seeds {1,2,3} | 1333 | 1605 | 12908 | 4537 (44028 routes) |
| `fuzzlayout.mjs` 700 (seed 11), seeds {1,2,3}; and with `considerNodeLabels`, seed 1 | 1929 (+641) | 6658 (+2206) | 16081 (+5332) | 19562 (+6480) |
| `fuzzgrid.mjs` 250, seeds {1,2} (`fuzzseq.mjs` 250: sequence diagrams do not reach TALA's router, 0 calls) | 140 | 140 | 140 | 420 |

6328 recorded calls in all, about 40k flavor runs. Also: the 11 golden OVGs of `internal/testdata/ovg` (11/11), `traceToShapeBorder` against stage 30 (369 stage graphs of the e2e set and 1496 of
`fuzzlayout`, identical; 320 of them changed by the stage), and the unit tests (7). Sizes: 29 files, 7390 lines, 290 KB, 78 KB gzipped (summing the files; 64 KB as one stream).
The corpus check (1370 calls, Go run and JS replay) takes about 150 s on a shared 4-core machine.


**Findings (read before changing anything in the core).**
- **State that graphjson does not carry matters here: the order of `node.Edges`.** The live Go graph's adjacency lists are not in graph-edge order after the placement stages, and the subgraph split, the
  tunnels and the router depend on it; `Clone`/`Unmarshal` rebuild them in `graph.edges` order. The call record therefore carries `nodeEdges` and the replay restores it. A port that runs
  the whole pipeline in JS has the live order anyway.
- **Go itself is not deterministic in two places, both harmless to the final routes but fatal for an exact comparison.** (1) `addHierarchyLevelNodes` sorts the nodes of a level with
  `sort.Slice` by `TopLeft.X` starting from a *map iteration order*, so nodes with equal X (tables in a column of a horizontal hierarchy, common in ER diagrams) get a random order and the
  OVG differs from run to run (one 12-edge case: 1449, 1567 and 1571 OVG nodes in three runs with identical routes). The harness breaks the tie by node ID in Go (`XDeterministicLevels`, set only
  by the routing modes) and in JS (`setDeterministicHierarchyLevels`, set only by the replay); production JS keeps the order of `hierarchy.levels()` (one of Go's orders). (2) The *work counters*
  of the OVG build guard (`work`, and `nodes`/`edges` on hierarchies) vary between runs of the same input because early exits in `hasUnobstructedLineToPorts` depend on the map order
  of `newOVGPortIndex`'s owners; the replay compares `candidates` exactly and reports the deviation of `work` (at most a few percent). The per-flavor `used` counters of the route search
  are deterministic and match exactly, so the budget accounting of the search is identical.
- Map iteration order was assumed irrelevant (insertion order in JS) at: `ovg.Ports` ranges (`addPortConnectionNodesAtBoundaries`, `flagNodesNearPorts`, `newOVGPortIndex`), `mergePorts`
  (`other.Ports`), `addRoute` (`VerticalEdges`/`HorizontalEdges`), the table-port sets of `findLShapedRoute`/`findSShapedRoute`. All 1370 corpus calls agree.
- `sort.Slice` is `gosort.sortSlice` (pdqsort); `slices.SortStableFunc` is `Array.prototype.sort` (the comparators are strict weak orders except for exact ties of overlapping nodes);
  `slices.Sort` of floats is a numeric sort; `slices.SortFunc` by node ID has unique keys. `math.Pow` is `goPow` (integer exponents), `math.Round` is `goRound`; `math.Atan2` in
  `hasSharpAngleToBorder` is V8's (fdlibm): only the comparison `angle < 30` uses it.
- Go's `fixedOverlapsFor*` caches and `routeSearchTelemetry` mutexes are not needed (single thread); `typedpool` map pooling is replaced by fresh `PointMap`s.
- Not verified by the call replay (ported line for line, exercised by later stages): `considerNodeLabels` outside the `routinglabels` mode, `tryStraightEdgeFallbackGuarded`,
  `reorderDuplicatesInEdgesGuarded`, `traceToShapeBorderGuarded` (the stage-30 check covers `traceToShapeBorder`), the unguarded branches of `routeLineChecked`, `snapshot.js`,
  `makeLoopRoute`, `treeEdgePath`, `OVG.unmarshalJSON`.

## Plan for the remaining packages

Order = dependency order (a package may use everything above it). Sizes are non-test Go lines; "JS estimate" is about the same number of lines, written at
roughly 400-600 lines per agent-hour including the diff stage (a rough figure from T0: layoutgraph, 11k Go lines, was the bulk of this task). Dump format =
what to compare against Go; every stage below is checked with the same pattern: add a Go mode to `tools/d2ref/tala/xdump/`, a JS twin in `talacheck.mjs`, a stage in `diff.mjs`.

| # | package | Go lines | reads from layoutgraph | uses | dump to check against | notes |
|---|---|---|---|---|---|---|
| 1 | `loops` | 329 | `Node.loopOffsets`, edges (self-edges), `ConnectedNodeGap` | layoutgraph | `fstages`/`stages` graphs after `PreprocessSequences`/`NodePlacement` (loop offsets are not in graphjson: add them to a deep dump), plus direct calls in `lgops` | tiny; do first, needed by placement and routing |
| 2 | `grouping` (sequences, clusters) | 1985 | `Graph.clusters/sequences`, `Cluster`/`Sequence`, `abductEdges`, `Nodes.clusters`, `edges`, node shapes | rand (`random.Int63`, `Float64`: vessel IDs and arrangements), limits, layoutgraph | `stages` index 1 (`PreprocessSequences`), 5 (`PreprocessClusters`), 19 (`CleanupStuff`) and `ResetClusters` at stage 0 | consumes the placement `random` stream in a fixed order; IDs are 63-bit BigInt with collision-skipping (`nextVesselID`) |
| 3 | `proximity` (nears, hubs, herds, common uncles) | 668 | `nears`, `hubs`, `herdAssignment`, `commonUncleSiblings`, containers | layoutgraph (+ tests use placement) | `stages` index 6 (`PreprocessHubs`); herd assignments need a deep dump | small |
| 4 | `trees` | 2707 | `Graph.trees/nodeToTree`, `Tree`, `edges`, ports, `Transaction` | layoutgraph | `stages` index 3 (`PreprocessTrees`), and the tree placement inside `NodePlacement` (index 7) | the corpus has few trees: use `benchmark/trees_26nodes` and `layout/larger_tree` fixtures through `fstages` |
| 5 | `hierarchy` (DAG detection, network-simplex ranking, layered placement, compound placement) | 4006 | `Hierarchy`, `edges` (`hierarchyRankWeight`), `Transaction`, `rdfs` orders | rand (`hierarchyPlacementRandom`, `limits.Shuffle`), nodeshape | `stages` index 4 (`PreprocessHierarchies`) and `CompoundCandidate`; the ranker (`rank_simplex.go`) is a pure function with a testable contract | exact integer arithmetic (checked add/mul, Bland's rule): no float risk; also used by routing |
| 6 | `placementcost` | 3005 | graph costs and `edgeLengthCache` (uint64 state hash: BigInt or a 2x32 hash), geometry, ports, `Transaction` | layoutgraph | `EdgeLength` of fixtures/stage graphs through `lgops` | goroutines in `EdgeLength` collapse to a sequential sum in node order (see Determinism); check the hash of the cache key |
| 7 | `packing` | 3062 | `graphbounds`, `SplitSubgraphs`, `Transaction`, `fixedBounds` | graphbounds | `stages` index 18 and 32 (`BinPack`; the second one "doesn't try to avoid edges") | uses work budget 1e9; recursion over subgraphs |
| 8 | `labeling` (node/icon/edge/arrowhead labels) | 2080 | `labelTopLeft`, `Label`/`Icon`, `nodeshape.labelPositionPreferences`, `labelgeom`, edge geometry | labelgeom, nodeshape | `stages` index 33 (`PlaceLabels`) | overlaps `quality`; 50M budget |
| 9 | `quality` | 1271 | `Graph.area`, `validatePositionedGraphSelection`, `countSegmentCrossings`, labeling | labeling | `scores` per seed (`penalty`, `area`): exact float equality needed for seed selection | the score decides which seed is printed: port early after labeling and diff on `scores` |
| 10 | `placement` (prescale, prepare, stress init, sized/sizeless optimizers, swap, transpose, align, gap normalization, equidistance, symmetry, dejitter, node placement, pad, normalize) | 9437 | everything: transactions, costs, `abductEdges`, nears, hubs, trees, clusters, loops | grouping, labeling, loops, packing, placementcost, proximity, trees, rand (`Float64` temperature noise, own `rand.New(rand.NewSource(seed))`) | `stages` 0 (`Prescale`) to 17, 19-20 (`CleanupStuff`, `Rescale`), 23 (`Dejitter`), 36 (`Normalize`) | the largest package; split by stage (placement is stages 7-17 of the pipeline: see the list below); the randomized optimizers make any one wrong draw diverge everything after it, so diff after every stage |
| 11 | `routing` (OVG visibility graph, edge router with flavors, postprocessing, nudging, shortcuts, swap ports, slingshot, tunnels, tree routes) | 15715 | `Graph` costs (`turnCost`, `crossingCost`, `nonCenterPortCost`), ports, `PortEdges`, `graphbounds`, hierarchy, loops, quality | graphbounds, hierarchy, labeling, loops, nodeshape, quality | `stages` 21 (`EdgeRouting`) .. 36 (`Normalize`), and `ovg` fixtures of `testdata/ovg` (`exp` OVG JSON per case) | the biggest; flavors run in parallel in Go but are independent (see Determinism); priority queue tie-breaks and `sort.Slice` calls must use `gosort.js`; budget `routeWorkGuard`. **Core done (T1)**, see "Routing core"; the stage half remains |
| 12 | `engine` (pipeline, `CompoundCandidate`) | 737 | all | all above | `fstages` against `graph.exp.json` (seed 123), `scores` | `pipeline.go` is a flat list of 37 stages: port early as the skeleton with each stage a no-op and fill in |
| 13 | root: `Layout`, result validation, patch (`layout.go`, `result.go`, `result_validate.go`, `patch.go`, `RouteEdges`) | about 1500 | adapter bindings | engine | `layout` stage against `tala/e2egolden.mjs` goldens (309) and `diff.mjs layout` with `layout: 'tala'` | the adapter half is done (`d2talalayout.js`): `translateGraph`, the seed plan, the validations shared with the result |

Pipeline stage indexes (`defaultPipelineStages`, the `index` of `xdump stages`): 0 Prescale, 1 PreprocessSequences, 2 Preprocess, 3 PreprocessTrees, 4 PreprocessHierarchies,
5 PreprocessClusters, 6 PreprocessHubs, 7 NodePlacement, 8 SwapStuff, 9 Transpose, 10 AlignAxes, 11 GapNormalization, 12 AlignAxes, 13 OptimizeClusters, 14 AlignAxes,
15 BalanceSymmetry, 16 Equidistance, 17 AlignAxes, 18 BinPack, 19 CleanupStuff, 20 Rescale, 21 EdgeRouting, 22 Crosshatch, 23 Dejitter, 24 EdgeRouting, 25 SimplifyEdgeRoutes,
26 SwapEdgePorts, 27 StraightEdgesFallback, 28 BalanceEdgeSegments, 29 FixClusterEdgeBranching, 30 TraceEdgesToShapeBorder, 31 ReorderDuplicates, 32 BinPack, 33 PlaceLabels,
34 NudgeEdgeChannels, 35 ShortcutEdgeRoutes,, 36 Normalize. The plan repeats stages (`AlignAxes` x5, `BinPack` x2, `EdgeRouting` x2): always go by the index.

Total remaining non-test Go: about 46k lines (placement 9.4k, routing 15.7k, hierarchy 4k, grouping 2k, trees 2.7k, packing 3k, placementcost 3k, labeling 2k, quality 1.3k,
proximity 0.7k, loops 0.3k, engine 0.7k, root 2.6k incl. what T0 did). Parallelizable after T0: {loops, grouping, proximity, trees, hierarchy, placementcost, packing, labeling} are independent of each
other once `layoutgraph` is there (grouping -> proximity only through tests; placement needs all of them; routing needs hierarchy, labeling, loops, quality, graphbounds). Each can be diffed in
isolation against `fstages`/`stages` dumps: feed the Go graph of stage k-1 to the JS stage k and compare with Go's stage k (the dumps are the input *and* the expected output), without running
earlier stages in JS. That is how to split the work; the full-pipeline diff comes last.

### Corrections to the plan given in the task

- `nodeshape` (2.3k lines) is a dependency of `layoutgraph` (a `Node` embeds its `Shape`), so it was ported in T0 (it was in the "remaining" list).
- `graphjson` serializes only part of the state; see above. Stage-by-stage diffs of mid-pipeline state that is not in graphjson (margins, paddings, loop offsets, herd
  assignments, cost caches) need a deep dump; none exists yet.
- The adapter output graph and the e2e goldens are reproducible in Go in one process; **seed selection needs exact scores**, so `quality` should be ported before the pipeline stages are
  considered done.
- `layoutgraph` has no work to do for D2's `RouteEdges` hook beyond the adapter (`loadExistingLayout`); the router entry (`routing.RouteEdges`) belongs to the routing agent.
- `routing` (task T1): the "core" is larger than the OVG files + `ovg_edge_router.go`: the router calls `slingshot.go` (1.2k lines), `routeLineChecked` and friends from `coordinator.go`, and the OVG build needs `tunnel.go` and `tree_routes.go`; all of those are in the core. `hierarchy`, `labeling`, `loops`, `quality` are needed by the core only for `hierarchy.IsHorizontal` and `labeling.PositionArrowheadLabel` (both tiny, in `routing/deps.js`).
- Float formatting is not an issue for the port itself (JSON shape is the D2 `Diagram`); IDs are.

## T1: `loops`, `grouping`, `proximity`, `trees` (done)

Files (gzip -9): `tala/loops.js` 3.4 KB, `grouping.js` 10.6 KB, `proximity.js` 4.9 KB, `trees.js` 15.4 KB, `goslices.js` 1.5 KB (Go's `slices.SortFunc`,
`slices.SortStableFunc`, `cmp.Compare`; the unit tests are `test/tala-t1.test.js`, 20 tests, ports of the cheap Go tests). 5.7k Go lines became about 4k JS
lines, line for line (Go names in camelCase; unexported twins of exported names get the trailing underscore: `loops.computeOffsets` is `ComputeOffsets`,
`computeOffsets_` the unexported `computeOffsets`).

### What is checked against Go, and how to run it

The Go side is `tools/d2ref/tala/xdump/t1_*.go` (modes `t1stages`, `t1ops`), the JS side `tools/d2ref/tala/t1check.mjs`; build with `tala/setup.sh` as before.

```bash
cd tools/d2ref
node tala/t1diff.mjs stages tala-corpus.jsonl --seeds 1,2,3 --stages 1,3,5,6,19     # also tala-e2e.jsonl, tala-fixtures.jsonl, t1fuzz files
node tala/t1fuzz.mjs 400 11 > ff11.jsonl && node tala/t1diff.mjs stages ff11.jsonl --seeds 1,2,3 --stages 1,3,5,6
node tala/t1opscases.mjs tala-fixtures.jsonl --fixtures > o.jsonl && node diff.mjs talat1ops o.jsonl     # direct calls (graphs from fixtures or stages)
node tala/t1opscases.mjs tala-corpus.jsonl --max 400 --stages -1,2,5,7,8,10,18,20 > o.jsonl            # (or a t1fuzz file instead of the corpus)
node tala/t1slicescases.mjs 800 1 > s.jsonl && node diff.mjs talat1ops s.jsonl                          # goslices.js against slices.SortFunc/SortStableFunc
node --test test/tala-t1.test.js
```

- **`t1diff.mjs stages`** (`talat1stages` is not a `diff.mjs` stage: it needs the exact 63-bit IDs of the Go side, which `diff.mjs` flattens): Go runs the
  pipeline of one seed up to stage 20 and dumps, after the stages asked for, **graphjson plus the deep state** (`t1Deep`: margins, paddings, loop offsets,
  herd assignments with their paired sets, nears, long-distance requirements, `node.edges` order, `node.container`, cluster/sequence/tree records with
  edge abductions, `nodeToTree`, hubs, directions, containers, `commonUncleSiblings`, edge routes). Each target stage k is then recomputed in JS from Go's
  state after stage k-1 (`reconstruct` = `graphjson.unmarshal` + `applyDeep`; the check first rebuilds that state and compares it with Go's, so a
  difference is attributed to the stage and not to the input) and compared with Go's state after stage k, graph and deep state. Targets and inputs: 1 from 0
  (`AddSequences`, generator = a fresh `rand.NewSource(seed)`), 3 from 2 (`trees.Preprocess`), 5 from 4 (`AddClusters`; the generator is first advanced by one
  `Int63` per sequence, which is all stage 1 consumed: nothing else draws from `p.random`), 6 from 5 (`AddHubs`), 19 from 18 (`Cleanup`).
- **`talat1ops`** (registered in `diff.mjs`, which retries a mismatch 100 times in Go: see Go-unstable below): `loops` (every node's `Route`, `ComputeOffsets`,
  `UpdateOffsets` on unpositioned nodes), `resetClusters`, `seqEdges` (`SequenceDefiningEdges`), `cluster` (`PaddingBetween`, `AssignArrangement` for seeds 1-3),
  `join` (`JoinDistancedClusters` as placement calls it: per container, innermost first, children graph + `AbductEdges`; a Go panic is part of the result),
  `rebuild` (`Cleanup` then `AddSequences` with remembered vessel IDs, `AddClusters` from positions, `ResetClusters`, again), `commonUncle`, `hubs`, `nearsHerds`
  (the calls of `placeNodes`: children graph, `AbductEdges`, recursion into child containers, `AssignNears`, `AssignHerds` with the parent's abductions,
  `SyncHerdFences`), `trees` (`Preprocess`, then `Place` for every container as `placeNodes` does: children graph, abducted edges, `SplitSubgraphsTracked` with
  nears and trees, `Place` per subgraph, tree nodes and edges copied back), `slices`.
- Inputs: D2's corpus (`tala-corpus.jsonl`, seeds 1,2,3), the 309 e2e inputs (seed 1), the 115 graph fixtures (seed 123: `benchmark/trees_26nodes` and
  `layout/larger_tree` among them), and **`tala/t1fuzz.mjs`**, a generator of D2 programs for exactly these packages (fans of identical leaves, step chains, cycles with
  branching trees, isolated trees, self loops with labels and arrowheads, hubs, containers whose children share outside uncles, sql tables with edges to columns,
  locked `top`/`left`, trees hanging off steps). `t1opscases.mjs` turns Go's stage graphs (positioned or not, with clusters, sequences, trees) into `t1ops` cases.

Results: every comparison below is identical to Go (graph and deep state), nothing is tolerated.

| check | inputs | identical |
|---|---|---|
| stages 1, 3, 5, 6, 19 (`t1diff stages`) | D2 corpus, seeds 1,2,3 | 847/847 programs, 15,627 stage comparisons (230 of the 1077 snippets make no TALA run: 188 compile errors, the rest only grid or sequence diagrams that D2 lays out itself or errors of TALA; groups are rare: 15 comparisons with sequences, 60 with trees, 54 with clusters, 153 with hubs) |
| same | e2e inputs (309 with goldens), seed 1 | 273/273 (36 have no layout run), 1,845 |
| same | 115 graph fixtures (`benchmark/*`, `layout/*`, `regression/*`, `ovg/*`), seed 123 | 115/115, 575 (`trees_26nodes`, `larger_tree` included) |
| stages 1, 3, 5, 6 | `t1fuzz`: 2,155 programs (6 seeds), seeds 1,2,3 | 2,155/2,155, 25,833 (with sequences in 1,776 comparisons, trees in 2,118, clusters in 4,437, hubs in 5,787) |
| stages 1, 5, 19 | `t1fuzz`: 247 programs, seeds 1,2 | 247/247, 1,482 |
| `talat1ops`: `loops`, `resetClusters`, `seqEdges`, `cluster`, `join`, `commonUncle`, `hubs`, `nearsHerds`, `trees` | graphs of Go's stages -1, 2, 5, 7, 8, 10, 18, 20 of corpus and fuzz programs, and the fixtures: about 4,000 graphs | about 36,000 calls identical (loop offsets non-empty in 563 of the first 2,187 graphs; `trees` placed trees in about 400 graphs, `nearsHerds` assigned herds in about 300 graphs, 165 of them with paired sets) |
| `rebuild` | fixtures, corpus stage graphs, fuzz | 1,383/1,383 |
| `slices` (`goslices.js`) | random arrays up to 500 elements, 3 comparators, `SortFunc` and `SortStableFunc` | 2,300/2,300 |
| unit tests `test/tala-t1.test.js` | | 20/20 |

Also: `diff.mjs graph` and `layout` 1077/1077, `npm test` passes.

### What the port had to get right (found by the diff, or by reading)

- **Go ranges over a slice header fixed at the start.** `AddClusters` appends the new vessel to `g.Containers[container]` while it ranges over the children of that
  container; the JS `for...of` over the same array visits the vessel and failed (18 corpus cases). The port copies the array (`.slice()`) where the loop body
  appends to it (`addClusters`, `putBackNonBranchingTrees`). Look for it in every port of a `for _, x := range s` whose body can `append` to `s`'s variable.
- **The sorts are not stable-valid comparators.** `loops.edgesInOrder` sorts with a comparator that is not a strict weak ordering (a source-only and a
  target-only arrow are equal, but each orders by label area against the others), so the result depends on `slices.SortStableFunc`'s algorithm (insertion sort of
  blocks of 20, then SymMerge): `goslices.js` ports it, `sortFunc` is `sort.Slice`'s pdqsort (`gosort.js`) with `cmp(x[i], x[j]) < 0` (the generated sources are the same).
  Other packages that call `slices.SortFunc` / `SortStableFunc` should use it.
- **State that graphjson does not carry** and a stage in the middle of the pipeline depends on: `node.edges` order (stage 4 `PreprocessHierarchies` reorders it),
  `node.container` of hierarchy members, margins, paddings, loop offsets, herds, nears, long-distance requirements, `commonUncleSiblings`. `applyDeep` puts them back.
  `graphjson.unmarshal` also cannot rebuild a graph in which a sequence's edge abduction names an edge that a tree extraction detached from `g.Edges` (a tree
  hanging off a step, stages 3 to 18; Go's `Unmarshal` has the same check): `t1diff` then runs the JS stages 3 and 5 from the stage 2 graph (valid because Go's stage 4
  left the state as it was up to the order of `node.edges`, which is put onto the JS graph).
- **`JoinDistancedClusters` needs the graph placement gives it** (the children of one container with the edges of the descendants abducted onto them): on a whole
  graph it panics `Clustered nodes: n. Total: m` (a `DistanceClusters` invariant), in Go and in JS.
- **Go panics are `TypeError`s here**: a nil dereference in Go is a `TypeError` in JS (`t1check.mjs` maps both to the same message when it records a recovered panic).
- **Random streams.** `AddSequences` draws one `Int63` per group and container (before it knows which IDs are remembered), `AddClusters` one `Int63` per attempted
  cluster (the draw comes after the cheap descendant test and before the kernel charges) and creates a fresh `rand.New(rand.NewSource(seed))` per container for
  the `Float64` of a square cluster (`AssignArrangement`); vessel IDs skip reserved values (`nextVesselID`, `nextAvailableNodeID`: wrap at MaxInt64 to 0).
- **Work budgets**: every `guard.Step()/Add()/Finish()/Check()` of the Go code is called in the same place, including the loops that only charge (`for range`).
  The budget exhaustion path itself is not exercised (it needs graphs with more than 61 million work units).

### Go-unstable output (a determinism finding to add to the section above)

`trees.buildPlacementTrees` ranges over a Go map of at most three keys (`rootsByTreeDirection`, `Outwards`/`Inwards`/`Bidirectional`) in random order. The trees it
creates are sorted afterwards by size and first child ID (a total order), but the merge of **undirected** roots into "the first largest tree" (`mergeWith`) depends on
the order: an isolated tree whose roots reach the sentinel in several directions and that also has undirected roots can be placed in two different ways, run to run
(measured: 2 distinct outputs in 40 runs of one generated case). The JS port keeps first-seen order; the diff stage counts such cases as identical if JS equals one of
Go's outputs (as `layout` does for dagre). None of the corpus, e2e or fixture inputs has this shape. `Validate` also names an arbitrary cluster vessel in its
`cluster vessel N has no cluster record` error (the `rebuild` op reaches it).

### API for the dependent packages

All functions throw a `GoError` where Go returns an error (`errorsIs(e, context.Canceled)` works); IDs are BigInt; `random` is a `gorand.js` `Rand`.

| Go | JS | called by (Go) |
|---|---|---|
| `loops.ComputeOffsets(g)`, `UpdateOffsets(node)`, `Route(node)` | `computeOffsets(g)`, `updateOffsets(node)`, `route(node)` -> self-edges with `points` and label positions set | `placement.Prepare`, `placeNodes`, `routing/coordinator` |
| `grouping.ResetClusters(g)` | `resetClusters(g)` | pipeline stage 0 (before `Prescale`) |
| `grouping.AddSequences(ctx, g, random)`, `AddClusters(ctx, g, seed, random)`, `Cleanup(g)` | `addSequences`, `addClusters(ctx, g, seedBigIntOrNumber, random)`, `cleanup` | stages 1, 5, 19 |
| `grouping.AssignArrangement`, `PaddingBetween`, `CreateVessel`, `AddCluster`, `SequenceDefiningEdges`, `JoinDistancedClusters(ctx, g)` | same names, camelCase (`sequenceDefiningEdges` returns a `Set` of BigInt IDs) | placement (`optimizeCluster`, `placeNodesOrthogonally`), routing |
| `proximity.AddHubs`, `AssignNears`, `AssignHerds`, `GroupSheep`, `ApplyVirally`, `CanUseBothSides`, `SyncHerdFences`, `CommonUncleSiblings` | same names, camelCase (`commonUncleSiblings(g)` returns `Map<Node, Node[]>`, assign it to `g.commonUncleSiblings`) | stage 6, `placeNodes`, `placement.Place`, the optimizers |
| `trees.Preprocess(ctx, g)`, `Place(ctx, g, container)`, `Descendants(root)` | `preprocess`, `place`, `descendants` | stage 3, `placeNodes` |

### Corrections to the plan

- `join.go` (`JoinDistancedClusters`) is in `grouping`, not in placement; it is ported and checked here.
- Placement's tree placement is verified through the `trees` op (the calls of `placeNodes` replayed on stage graphs and fixtures), not inside stage 7: stage 7 needs
  the placement package. The remaining check of `Place` is the whole stage 7 once placement exists.
- Stage 0's `ResetClusters` is not separable from `Prescale` and the route reset, so it is checked as the `resetClusters` op on graphs with active clusters.
