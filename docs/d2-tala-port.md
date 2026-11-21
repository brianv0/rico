# Porting TALA to JavaScript

TALA is D2's own layout and edge-routing engine (`d2layouts/d2talalayout` in D2 v0.9.0, MPL-2.0, open source and bundled with D2). It has no JS
original, so every line is ported by hand and checked against the Go implementation. This file is the plan, the harness manual and the notes per
package; later agents rely on it, so keep it accurate. The general port rules (line for line, Go names in camelCase, Go semantics pitfalls, the D2
diff harness) are in [d2-port.md](d2-port.md) and apply here too.

**Status (T0, the foundation): done.** Ported and verified against Go: `gorand` (Go's `math/rand`), `layoutgraph` (with `nodeshape`, which it
needs), `graphjson`, `limits`, `invariant`, `typedpool`, `graphbounds`, `labelgeom`, and the D2 -> TALA adapter graph (`translateGraph`). Not
started: everything from `loops` up (plan below).

**Status (T1, `packing`, `labeling`, `quality`): done**, see "Packing, labeling and quality (T1)" at the end: ported line for line and identical to Go on
every stage and function input of the harness (below), including work units. Plan rows 7, 8 and 9 are done.

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
| `internal/packing` (`binpack.go`, `guard.go`, `routed_container.go`, `combine*.go`, `snapshot.go`) | `tala/packing.js` | 3059 (1552) | `talapack`: BinPack stages 18 and 32 of the corpus and fixtures with deep state 5880/5880 identical (graph and work units), fuzz programs 9684/9684, direct cases (work limits used-1..0, containers as root, canceled context, mutated graphs) 4737/4737; `talacombine` (CombineSubgraphs of split subgraphs with random offsets and obstacles) 6726/6726 |
| `internal/labeling` | `tala/labeling.js` | 2080 (681) | `talaplace`: PlaceLabels stage 33 2940/2940 identical (positions, percentages, work units), fuzz programs 4842/4842, direct: Place, PlaceNewEdges, Initialize, PositionArrowheadLabel, limits and cancellation 8825/8825; the Go tests that need no fixtures are ported (`test/tala-pkg.test.js`) |
| `internal/quality` | `tala/quality.js` | 1271 (389) | `talaquality`: EvaluateWithArea and Inspect on graphs after stages 17, 24, 32, 33, 36 14126/14126 (+574 Go panics skipped), fuzz programs 17004/17004 (+7206 Go panics skipped), direct 2455/2455 (+231 skipped) (penalty, area, every metric, work units, limits); `pkgscores.mjs`: the per-seed `scores` dump of the whole corpus 2859/2859 and the seed selection 953/953; `talascore` (Score.Compare incl. NaN, Inf, negative areas) |

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
| 7 | `packing` | 3062 | `graphbounds`, `SplitSubgraphs`, `Transaction`, `fixedBounds` | graphbounds | `stages` index 18 and 32 (`BinPack`; the second one "doesn't try to avoid edges") | uses work budget 1e9; recursion over subgraphs. **Done (T1).** |
| 8 | `labeling` (node/icon/edge/arrowhead labels) | 2080 | `labelTopLeft`, `Label`/`Icon`, `nodeshape.labelPositionPreferences`, `labelgeom`, edge geometry | labelgeom, nodeshape | `stages` index 33 (`PlaceLabels`) | overlaps `quality`; 50M budget. **Done (T1).** |
| 9 | `quality` | 1271 | `Graph.area`, `validatePositionedGraphSelection`, `countSegmentCrossings`, labeling | labeling | `scores` per seed (`penalty`, `area`): exact float equality needed for seed selection | the score decides which seed is printed: port early after labeling and diff on `scores`. **Done (T1).** |
| 10 | `placement` (prescale, prepare, stress init, sized/sizeless optimizers, swap, transpose, align, gap normalization, equidistance, symmetry, dejitter, node placement, pad, normalize) | 9437 | everything: transactions, costs, `abductEdges`, nears, hubs, trees, clusters, loops | grouping, labeling, loops, packing, placementcost, proximity, trees, rand (`Float64` temperature noise, own `rand.New(rand.NewSource(seed))`) | `stages` 0 (`Prescale`) to 17, 19-20 (`CleanupStuff`, `Rescale`), 23 (`Dejitter`), 36 (`Normalize`) | the largest package; split by stage (placement is stages 7-17 of the pipeline: see the list below); the randomized optimizers make any one wrong draw diverge everything after it, so diff after every stage |
| 11 | `routing` (OVG visibility graph, edge router with flavors, postprocessing, nudging, shortcuts, swap ports, slingshot, tunnels, tree routes) | 15715 | `Graph` costs (`turnCost`, `crossingCost`, `nonCenterPortCost`), ports, `PortEdges`, `graphbounds`, hierarchy, loops, quality | graphbounds, hierarchy, labeling, loops, nodeshape, quality | `stages` 21 (`EdgeRouting`) .. 36 (`Normalize`), and `ovg` fixtures of `testdata/ovg` (`exp` OVG JSON per case) | the biggest; flavors run in parallel in Go but are independent (see Determinism); priority queue tie-breaks and `sort.Slice` calls must use `gosort.js`; budget `routeWorkGuard` |
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
- Float formatting is not an issue for the port itself (JSON shape is the D2 `Diagram`); IDs are.

## Packing, labeling and quality (T1)

`public/d2/tala/packing.js` (80 KB, 18.2 KB gzipped), `labeling.js` (56 KB, 11.6 KB), `quality.js` (33 KB, 8.4 KB). Ported line for line from
`binpack.go`, `guard.go`, `routed_container.go`, `combine.go`, `combine_snapshot.go`, `snapshot.go` (packing), `model.go`, `arrowhead.go`, `placement.go`,
`guard.go` (labeling), `score.go`, `scoring.go`, `evaluation_guard.go`, `crossings.go`, `inspection*.go`, `labels.go` (quality). The score functions of `quality`
are exact: every float operation is the Go one in the same order, so the penalty and area that pick the seed are equal bit for bit.

### API for the packages that use them

- `packing.pack(ctx, g, root)` (Go `Pack`; the pipeline calls it with `root = null`), `packing.packWithLimit(ctx, g, root, limit)` (returns the work units
  used; a thrown GoError carries them in `err.used`), `packing.combineSubgraphs(ctx, masterGraph, graphs, ancestorObstacles)` (array of `geo.Box`; returns the combined graph).
- `labeling.initialize(graph)`, `labeling.place(ctx, graph)`, `labeling.placeNewEdges(ctx, graph, edges)` (+ `placeWithLimit`, `placeNewEdgesWithLimit`),
  `labeling.positionArrowheadLabel(edge, isTarget, route)` -> `PositionedArrowheadLabel` or `null`: Go embeds `geo.Box`, so `pal.box` is the `geo.Box` and
  `pal.topLeft`, `pal.width`, `pal.height` read it (like `node.box`); `pal.edge`, `pal.isTarget`, `pal.text`; `labeling.SharedSegmentClearance`.
- `quality.evaluateWithArea(ctx, graph)` -> `[penalty, area]`, `quality.evaluate(ctx, graph)` -> `Score` (`{penalty, area}`, `score.compare(other)` is `Score.Compare`: lower
  penalty wins, then lower area, non-finite and negative values lose), `quality.inspect(ctx, graph)` -> `{nodeOverlaps, routeObstructions, textOcclusions, crossings, detour, routeLength}`,
  and the limit variants `evaluateWithAreaLimit` -> `[penalty, area, used]`, `inspectWithLimit` -> `[metrics, used]` (the unexported Go functions the harness calls).
- Seed selection (engine): the later seed wins an exact tie: `s.compare(best) < 0 || (s.compare(best) === 0 && index > bestIndex)`; `pkgscores.mjs` checks it against Go.

### How it is checked (and what the stage checks needed)

`graphjson` is the dump of the pipeline stages, but it does not carry enough for packing, labeling and the evaluators: **per node, the margin, the padding, the loop offsets,
the label and icon `positionFixed` flags and the node's own edge list in its own order**, and `Unmarshal` adds every near symmetrically. The order of `node.Edges` mattered: a live graph
keeps its own order, `Unmarshal` rebuilds the lists in `graph.Edges` order, and `binPackHasExternalConnection` stops at the first external edge, so the same layout cost a different
number of work units (found by comparing the work counters phase by phase). The Go mode `pkgcases` therefore records, per seed and stage, the graph before the stage **plus the
deep state** (`args.deep`: `m` margin, `p` padding, `loop`, `n` nears, `e` edge order, `lf`/`if` fixed flags per node ID) and Go's own result and work units on the live graph (`args.expect`),
and the stage cases are compared without running Go again (the modes return `args.expect`). The twin applies `args.deep` to the unmarshalled graph (`pkgcheck.mjs` `loadGraph`).

```bash
export TALA_REF=/tmp/tala-ref-mine      # use your own copy: the default /tmp/tala-ref is shared, and the last setup.sh of anybody rebuilds xdump.bin from THEIR xdump files
                                        # (a mode they do not have then prints {"err":"EOF"} and every stage of yours looks broken)
tools/d2ref/tala/setup.sh               # now also copies tala/overlay/<pkg>.<tag>.go into internal/<pkg>/xdump_<tag>.go and runs tala/pkghooks.sh (two small patches: the work units of Pack and Place into XLastUsed)
cd tools/d2ref
node tala/pkgcorpus.mjs [--cases f.jsonl --tag .fz1 --max N --no-fixtures]   # stage cases: tala-pkg-{pack,place,quality}[.tag].jsonl from the corpus (seeds 1,2,3) and the graph fixtures (seed 123)
node tala/pkgdirect.mjs [--mutants N --seed S --stage-sample K]               # direct cases: tala-pkgd-{pack,place,quality,combine,score}.jsonl (Go runs the function itself on the same input)
node diff.mjs talapack tala-pkg-pack.jsonl      # also tala-pkgd-pack.jsonl; talaplace, talaquality (same names), talacombine tala-pkgd-combine.jsonl, talascore tala-pkgd-score.jsonl
node tala/pkgscores.mjs                         # per-seed penalty and area of the whole corpus (xdump scores) against quality.js, and the selection
node --test test/tala-pkg.test.js               # 24 unit tests, 16 of them ports of Go tests (scoring, inspection, label placement, shared segments, arrowheads), no Go needed
```

Modes (Go, `tala/xdump/{pkg,packing,labeling,quality}_xdump.go`): `pkgcases` (the generator), `pkgpack`, `pkgplace` (`op`: "", "new", "init", "arrowheads"), `pkgquality`, `pkgcombine`, `pkgscore`.
Direct cases run Go on the unmarshalled graph with every slice clipped to its length (`slices.Clip`; the JS port has no spare slice capacity, see the residue) and, with `args.limits`, again with
work limits `used-1`, `used/2`, 1 and 0 (the exhaustion error `TALA BinPack work exceeds limit N`, the work units at the failure and the rolled-back graph are compared), with `args.cancel` with an
already canceled context, and `args.root` packs inside a container. The mutants of `pkgdirect.mjs` move and resize nodes, strip or partially strip routes, add L-shaped routes (also on graphs
with active clusters, which is the only place cluster edge labels exist), set random label, icon and arrowhead label positions and edge border radii (which the routed-container proof reads), fix nodes.

### Residue and notes

- **Work units differ by the spare capacity of Go slices.** Go's preflights and transaction snapshots charge `cap` of edge routes, node edge lists and the graph's slices
  (`accountSpareCapacity`, `edge.Points[:cap]`), JS arrays have none. On stage cases the Go pre-state's spare capacity is recorded (`args.spare`): with spare 0 the counts are required equal (5823 of the 5880 corpus stage cases, 8489 of 9684 on the fuzz programs);
  otherwise a JS count below Go's is accepted (57 and 1195, at most 20 units per spare slot, printed by `pkgcheck.mjs` at exit; Go charges the same slot at every snapshot and transaction). Direct cases clip the slices and are exact. It matters only within a few thousand units of the limits.
- **`quality.Evaluate` panics on some mid-pipeline graphs** (after stages 24 and 32 of some seeds Go dereferences a nil position in `nodeOverlapArea`; the real engine never evaluates there). The generator records
  `{"panic"}` for those graphs, which `diff.mjs` skips (574 of the stage cases, 231 direct cases). The observer must recover: an uncaught panic in an observer ends the seed silently (`TALA seed layout failed due to an internal invariant`).
- **Go's map order**: `findSharedSegmentsChecked` and `quality.findSharedSegments` range over a map keyed by the segment's coordinate; the order only orders a set (counted or turned into boxes), the JS `Map` iterates in insertion
  order. A NaN coordinate would be one key in JS and many in Go (never reachable: positions are validated finite). `slices.Sort` of the four overlap coordinates is `sort` with a NaN-first comparator.
- **Go-unstable**: `graphjson.Unmarshal` names an arbitrary one of several inconsistent repeated records in its error (`edge ID 4225416157 has inconsistent repeated records`, a different ID on different runs of the same binary); the mutants
  of `pkgdirect.mjs` avoid graphs with repeated records, but a `--seed` may meet one. A graph with a non-finite coordinate is `{serializeError: "json: unsupported value: NaN"}` on both sides (Go's `encoding/json` refuses NaN).
- `edge.IsCurve` is not part of graphjson and the engine only resets it (`pipeline.go`), so it is never true inside the stages checked here; the routed-container proof reads it and is checked only with `false`.
- Uncovered by the data (V8 line coverage over all runs): the `invariant` errors for malformed inventories (nil edge, edge of another graph, ...), `binPackPositionContainerChildren` (cluster members that are containers, after a failed pack), the hierarchy
  boxes branch of the unrouted candidate loop, `clusterNodeBoundingBoxPlacement` with outside labels and icons on cluster members. These are ported by reading only.
- **Plan corrections**: `validatePositionedGraphSelection` and `countSegmentCrossings` live in `layoutgraph` (T0 had them); `quality` only calls them. `labeling.Initialize` is called by placement's `Prepare` (stage 2), not by the label stage, so the
  `positionFixed` flags of stage 33 depend on the deep state above. `CombineSubgraphs` is used by node placement (stage 7), not by BinPack: it is checked directly (with `SplitSubgraphs` of T0), and the placement agent will exercise it again.
