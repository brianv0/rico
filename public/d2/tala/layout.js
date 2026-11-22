// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of layout.go (and RouteEdges / recoverAsError of adapter.go) of the Go package d2layouts/d2talalayout (D2 v0.9.0, Copyright
// 2022 Terrastruct Inc.): the entry points of the TALA layout engine. This is the module that d2lib.js loads on demand (`layout: 'tala'`).
//
//   layout(ctx, graph, opts)      Go's Layout: runs every configured seed, selects the best complete result deterministically, tries the
//                                  compound candidate and applies the result to the D2 graph through a validated patch
//   defaultLayout(g)              Go's DefaultLayout with a fresh background context (the signature d2layouts.layoutNested wants)
//   routeEdges(ctx, g, edges)     Go's RouteEdges (the TALA edge router the plugin offers); routeEdgesDefault(g, edges) without a context
//   hydrateOpts(raw)              the options of the plugin's HydrateOpts: {"tala-seeds": [..]} (null: the defaults)
//
// Go runs the seeds in goroutines; the selection depends only on the scores (lowest penalty, then lowest area, a later seed wins an exact tie),
// so the port runs them one after another in seed order (see "Determinism" in docs/d2-tala-port.md). Options are {seeds: [BigInt|number],
// maxConcurrency}, graph data `tala-seeds` takes precedence. A NotPorted error (a pipeline stage whose package is not merged) is never turned
// into Go's "internal invariant" error: it reaches the caller.

import { background, withCancel, Canceled, DeadlineExceeded } from './context.js';
import { errorf, errorsIs, errorsJoin, isPanic } from './goerrors.js';
import { quote } from '../url.js';
import { layoutPlan, newSeedInput, translateGraph, validateRequestedD2Edges } from './d2talalayout.js';
import * as lg from './layoutgraph.js';
import * as engine from './engine.js';
import { NotPorted, stageFn } from './stagepkgs.js';
import { evaluateSeedResult } from './result.js';
import { applySeedResult, buildRoutePatch, commitRoutePatch, preferContextError } from './patch.js';

export { defaultOptions, normalizeSeeds, seedsFromData, layoutPlan } from './d2talalayout.js';
export { NotPorted };

/** DefaultLayout lays out graph with fresh default options. Like all D2 layout functions, it mutates graph. */
export function defaultLayoutCtx(ctx, graph) {
  layout(ctx, graph, null);
}

/** The layout function of d2lib (g -> void): DefaultLayout with a background context. */
export function defaultLayout(g) {
  layout(background(), g, null);
}

/** The layout function with options (the plugin's Layout): `opts` as returned by hydrateOpts. */
export function layoutWithOptions(g, opts) {
  layout(background(), g, opts);
}

/**
 * hydrateOpts decodes the plugin options (d2plugin's decodeTALAOptions): `raw` is the parsed JSON {"tala-seeds": [int, ...]} or null.
 * Returns an Options {seeds} (null for no options). A value that is not an int64 list is the usage error of the Go plugin.
 */
export function hydrateOpts(raw) {
  if (raw === null || raw === undefined) return null;
  const bad = () => errorf('non-TALA layout options given for TALA');
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const opts = { seeds: null, maxConcurrency: 0 };
  const seeds = raw['tala-seeds'];
  if (seeds !== undefined && seeds !== null) {
    if (!Array.isArray(seeds)) throw bad();
    opts.seeds = seeds.map((s) => {
      if (typeof s === 'bigint') return s;
      if (typeof s !== 'number' || !Number.isInteger(s)) throw bad();
      return BigInt(s);
    });
  }
  return opts;
}

/** recoverAsError runs f and turns a panic (a non-GoError exception) into Go's internal-invariant error of the operation. */
function recoverAsError(operation, f) {
  try {
    return f();
  } catch (e) {
    if (!isPanic(e) || e instanceof NotPorted) throw e;
    throw errorf(`TALA ${operation} failed due to an internal invariant`);
  }
}

/** runLocalSeed: one seed attempt {index, seed, result, err}. */
function runLocalSeed(ctx, input, index, seed) {
  const attempt = { index, seed, result: null, err: null };
  try {
    const laidOut = runSeed(ctx, input, seed);
    attempt.result = evaluateSeedResult(ctx, input, laidOut);
  } catch (e) {
    if (e instanceof NotPorted) throw e;
    attempt.result = null;
    if (isPanic(e)) {
      attempt.err = errorf('TALA seed layout failed due to an internal invariant');
    } else {
      attempt.err = e;
    }
  }
  return attempt;
}

/** runSeed runs one TALA variation in a new workspace. Input remains unchanged and may be reused by other attempts. */
export function runSeed(ctx, input, seed) {
  if (input.graph == null) throw errorf('TALA seed graph is empty');
  const err = ctx.err();
  if (err) throw err;
  return engine.layout(ctx, input.graph, { seed });
}

/**
 * coordinateLocalSeeds runs the seeds (`run(index, seed)` -> attempt) in index order and selects the best attempt: lowest score, a later seed
 * wins an exact tie. Errors of single seeds are collected per index.
 */
export function coordinateLocalSeeds(ctx, seeds, concurrency, run) {
  if (seeds.length === 0) throw errorf('tala requires at least one seed');
  if (concurrency < 1) throw errorf('tala seed concurrency must be positive');

  let bestIndex = -1;
  let best = null;
  const attemptErrors = new Array(seeds.length).fill(null);
  for (let i = 0; i < seeds.length; i++) {
    const attempt = run(i, seeds[i]);
    if (attempt.err !== null) {
      attemptErrors[attempt.index] = errorf(`seed ${attempt.seed}: ${attempt.err.message}`, attempt.err);
      continue;
    }
    let comparison = 0;
    if (bestIndex >= 0) comparison = attempt.result.score.compare(best.score);
    if (bestIndex < 0 || comparison < 0 || (comparison === 0 && attempt.index > bestIndex)) {
      bestIndex = attempt.index;
      best = attempt.result;
    }
  }

  const err = ctx.err();
  if (err) throw errorf(`tala layout stopped before all seeds completed: ${err.message}`, err);

  if (bestIndex < 0) {
    const joined = errorsJoin(...attemptErrors);
    if (joined === null) throw errorf('no TALA seed produced a layout');
    throw errorf(`all TALA seed attempts failed: ${joined.message}`, joined);
  }
  return best;
}

export function runLocalSeeds(ctx, input, seeds, concurrency) {
  return coordinateLocalSeeds(ctx, seeds, concurrency, (index, seed) => runLocalSeed(ctx, input, index, seed));
}

/**
 * Layout runs every configured seed, selects the best complete result deterministically, and then atomically applies it to graph. It never
 * selects a result from only a timing-dependent subset of the configured seeds. `opts` is null (the defaults) or {seeds, maxConcurrency}.
 */
export function layout(ctx, graph, opts) {
  recoverAsError('layout', () => {
    if (ctx == null) throw errorf('TALA layout requires a context');
    const cerr = ctx.err();
    if (cerr) throw cerr;
    if (graph == null || graph.root == null) throw errorf('tala requires a D2 graph with a root object');
    const [seeds, concurrency] = layoutPlan(graph, opts);
    const input = newSeedInput(ctx, graph);
    // Logging and request metadata commonly wrap Background with values, leaving
    // Done nil. Give the CPU-heavy engine phase a real cancellation channel so
    // its hot work guards can poll that channel without repeatedly traversing
    // every value wrapper. Values and parent cancellation semantics are retained.
    let workCtx = ctx;
    let cancelWork = () => {};
    if (!ctx.hasDone()) [workCtx, cancelWork] = withCancel(ctx);
    try {
      let best = runLocalSeeds(workCtx, input, seeds, concurrency);
      best = considerSeedCandidate(workCtx, best, () => {
        const candidate = engine.compoundCandidate(workCtx, best.graph);
        if (candidate === best.graph) return best;
        return evaluateSeedResult(workCtx, input, candidate);
      });
      applySeedResult(workCtx, graph, best);
    } finally {
      cancelWork();
    }
  });
}

/**
 * Optional strategies may reject a geometry or exhaust their own search. They must not invalidate a complete ordinary result. Caller
 * cancellation remains an error; a timing-dependent subset of candidates is never selected. Returns the selected seedResult.
 */
export function considerSeedCandidate(ctx, incumbent, build) {
  let selected = incumbent;
  let err = null;
  try {
    let candidate = null;
    let candidateErr = null;
    try {
      candidate = build();
    } catch (e) {
      if (isPanic(e)) throw e;
      candidateErr = e;
    }
    if (candidateErr !== null) {
      if (errorsIs(candidateErr, Canceled) || errorsIs(candidateErr, DeadlineExceeded)) {
        selected = incumbent;
        err = candidateErr;
      } else {
        selected = incumbent;
      }
    } else if (candidate.score.compare(incumbent.score) < 0) {
      selected = candidate;
    }
  } catch (e) {
    if (e instanceof NotPorted) throw e;
    selected = incumbent; // recover(): a panic keeps the incumbent
    err = null;
  }
  const contextErr = ctx.err();
  if (contextErr) err = contextErr;
  if (err !== null) throw err;
  return selected;
}

/** RouteEdges reroutes edges in g. It mutates g. */
export function routeEdges(ctx, g, edges) {
  recoverAsError('edge routing', () => {
    if (ctx == null) throw errorf('TALA edge routing requires a context');
    validateRequestedD2Edges(g, edges);

    const talaGraph = lg.newGraph();
    const bindings = translateGraph(ctx, g, talaGraph, true);

    const talaEdgeByID = new Map();
    for (const edge of talaGraph.edges) talaEdgeByID.set(edge.id, edge);
    const talaEdges = [];
    for (const e of edges) {
      if (e == null) throw errorf('cannot route a nil D2 edge');
      const talaEdgeID = bindings.edgeIDs.get(e);
      const talaEdge = talaEdgeByID.get(talaEdgeID);
      if (talaEdgeID === undefined || talaEdge === undefined) throw errorf(`could not find edge ${quote(e.absID())} in graph`);
      talaEdges.push(talaEdge);
    }

    let workCtx = ctx;
    let cancelWork = () => {};
    if (!ctx.hasDone()) [workCtx, cancelWork] = withCancel(ctx);
    try {
      try {
        stageFn('routing', 'routeEdges')(workCtx, talaGraph, talaEdges);
      } catch (e) {
        if (isPanic(e)) throw e;
        throw preferContextError(ctx, 'edge routing', e);
      }

      let patch;
      try {
        patch = buildRoutePatch(workCtx, g, bindings, talaEdges);
      } catch (e) {
        if (isPanic(e)) throw e;
        throw preferContextError(ctx, 'edge routing', e);
      }
      commitRoutePatch(workCtx, patch);
    } finally {
      cancelWork();
    }
  });
}

/** The edge router of d2lib (g, edges -> void): RouteEdges with a background context. */
export function routeEdgesDefault(g, edges) {
  routeEdges(background(), g, edges);
}
