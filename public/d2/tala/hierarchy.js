// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/hierarchy (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): discovery of DAG-like subgraphs (discovery.go, eligibility.go, orientation.go), layered placement
// (placement.go, crossing.go, sifting.go, brandes_kopf.go) and the compound placement of rigid containers (compound.go).
// The ranker (rank*.go) is in hierarchyrank.js.
//
// Port notes (docs/d2-tala-port.md has the conventions): errors are thrown; Go maps keyed by pointers are Map/Set (insertion
// order; Go's iteration is random, and every place below ranges over a map only where the result does not depend on the order,
// see the notes at findCycleEdges, firstNeighbor, the markConflicts/leafNodes loops); `slices.SortStableFunc` is the stable
// Array.prototype.sort; `sort.Slice` is gosort.sortSlice; the exported Go name keeps the plain name, an unexported twin gets
// a trailing underscore (Assign/assign_, Place/place_); a nil `*rand.Rand` is null.

import * as geo from '../geo.js';
import { goRound } from '../gomath.js';
import { sortSlice } from '../gosort.js';
import { errorf } from './goerrors.js';
import * as lg from './layoutgraph.js';
import * as limits from './limits.js';
import * as nodeshape from './nodeshape.js';
import * as shape from '../shape.js';
import { rankDAG } from './hierarchyrank.js';

const crossingComparisonPrecision = 0.0001;
const minHierarchyLevels = 3;

// Limit automatic workflow recognition to modest graphs. Long rank axes and dense edge sets can exhaust geometry or placement
// budgets.
const maxAutomaticWorkflowNodes = 128;
const maxAutomaticWorkflowEdges = 256;

const crossingSpacing = 50.0;
const parentSpacing = 300.0;
const siblingDummySpacing = 50.0;
const siblingSpacing = 60.0;

// A compound candidate reuses already laid-out interiors as rigid blocks. The first implementation is deliberately bounded to one
// connected outer graph; separate outer components must not be expanded into one another before routing.
const maxCompoundBlocks = 64;
const maxCompoundInterfaces = 256;

const MaxInt = 9223372036854775807;
const MinInt = -9223372036854775808;

/** g.Containers[node]: the nil slice of a missing key is []. */
const containersOf = (g, node) => g.containers.get(node) ?? [];

/** n.HierarchyLevel(): n.Hierarchy.level[n] (a missing key reads 0). */
const hierarchyLevel = (n) => n.hierarchy.levels().get(n) ?? 0;

/** slices.SortFunc(s, cmp): the same pdqsort as sort.Slice with less(i, j) = cmp(s[i], s[j]) < 0. */
const slicesSortFunc = (s, cmp) => sortSlice(s, (i, j) => cmp(s[i], s[j]) < 0);

const cmpCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- orientation.go ----

/**
 * IsHorizontal reports the orientation shared by hierarchy placement and hierarchy-aware routing. Entity-relationship diagrams
 * use horizontal hierarchy placement regardless of the container direction.
 */
export function isHorizontal(nodes) {
  if (nodes.length === 0) return false;
  if (geo.isHorizontal(nodes[0].containerDirection())) return true;
  for (const node of nodes) {
    if (node !== null && node.isTable()) return true;
  }
  return false;
}

// ---- eligibility.go ----

/**
 * Candidates identifies the graph nodes that may participate in hierarchy discovery. Existing hierarchy membership is derived
 * state and deliberately does not disqualify a node, so repeated layouts can reconsider topology and edge-direction changes.
 * Returns a Set (insertion order = graph.nodes order).
 */
export function candidates(graph) {
  const candidates = new Set();
  for (const node of graph.nodes) {
    if (graph.nodeToTree !== null && graph.nodeToTree.has(node)) continue;
    if (graph.isTreeSentinel(node) || node.sequence !== null || node.fixedTopLeft !== null) continue;
    if (isSimpleCandidate(graph, node)) {
      candidates.add(node);
      continue;
    }
    if (node.isContainer() && shapeCanBeContainer(node.shape) && !node.aspectRatio1() && isEligibleContainer(graph, node)) {
      candidates.add(node);
    }
  }
  return candidates;
}

function isSimpleCandidate(graph, node) {
  return !(node.isContainer() || graph.isTreeSentinel(node) || node.isClusterVessel() ||
    graph.isSequenceVessel(node) || node.cluster !== null);
}

// Hierarchy containers grow only horizontally. These shapes can grow in one direction without distorting their visual meaning.
function shapeCanBeContainer(candidate) {
  switch (candidate.getType()) {
    case '': case shape.SQUARE_TYPE: case shape.PACKAGE_TYPE: case shape.STORED_DATA_TYPE: case shape.QUEUE_TYPE: case shape.STEP_TYPE:
      return true;
    default:
      return false;
  }
}

// A container can participate only when it has no internal edges and none of its descendants belongs to another specialized layout
// structure.
function isEligibleContainer(graph, root) {
  for (const child of containersOf(graph, root)) {
    if (child.fixedTopLeft !== null) return false;
    if (graph.nodeToTree !== null && graph.nodeToTree.has(child)) return false;
    if (graph.isTreeSentinel(child) || child.sequence !== null) return false;
    if (!child.isContainer() && !isSimpleCandidate(graph, child)) return false;
    for (const edge of child.edges) {
      if (!isHierarchyStructuralEdge(edge)) continue;
      if (child.adjacent(edge).isDescendantOf(root)) return false;
    }
    if (child.isContainer() && !isEligibleContainer(graph, child)) return false;
  }
  return true;
}

// ---- discovery.go ----

// Self-loops are routed, but they do not describe a relationship between hierarchy levels. Keep hierarchy detection and ordering
// consistent with the DAG ranker, which removes them before assigning levels.
function isHierarchyStructuralEdge(edge) {
  return !edge.isLoop();
}

function countHierarchyStructuralEdges(node) {
  let count = 0;
  for (const edge of node.edges) {
    if (isHierarchyStructuralEdge(edge)) count++;
  }
  return count;
}

/** Assign identifies hierarchical structures within the subgraphs of this graph. */
export function assign(ctx, g, root, hierarchicalNodes) {
  lg.validate(ctx, 'AssignNodeHierarchy', g);
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'AssignNodeHierarchyTransactions');
  const state = lg.newGraphStateSnapshot({ captureTopology: true, captureEdgeRoutes: true });
  state.updateWithWorkGuard(g, guard);
  const rollback = new lg.Transaction();
  rollback.graph = g;
  rollback.priorGraphState = state;
  let complete = false;
  try {
    const ownedNodes = state.ownedNodes(g, guard);
    const seenHierarchies = new Set();
    for (const node of ownedNodes) {
      guard.step();
      if (node.hierarchy !== null) seenHierarchies.add(node.hierarchy);
    }
    for (const hierarchy of seenHierarchies) {
      for (const node of Array.from(hierarchy.levels().keys())) {
        guard.step();
        if (ownedNodes.has(node)) hierarchy.levels().delete(node);
      }
    }
    for (const node of ownedNodes) {
      guard.step();
      node.hierarchy = null;
    }
    assign_(ctx, g, root, hierarchicalNodes);
    guard.finish();
    complete = true;
  } finally {
    if (!complete) rollback.rollback();
  }
}

/**
 * RemoveIsolatedMemberships removes leaf nodes that inherited a container's hierarchy but have no edges of their own. They remain
 * ordinary routing obstacles after hierarchy placement.
 */
export function removeIsolatedMemberships(g) {
  for (const node of g.nodes) {
    if (node.hierarchy !== null && node.edges.length === 0 && !node.isContainer()) {
      node.hierarchy.levels().delete(node);
      node.hierarchy = null;
    }
  }
}

function assign_(ctx, g, root, hierarchicalNodes) {
  let force;
  if (root === null) force = g.isRootHierarchy;
  else force = root.forceHierarchy;

  const hierarchyGraph = lg.newGraph();
  hierarchyGraph.copyEntitiesFrom(g);

  for (const node of containersOf(g, root)) hierarchyGraph.addNodeUnchecked(node);
  const edgeAbductions = g.abductEdges(root, hierarchyGraph);
  let edgesRestored = false;
  let splitOwnership = null;
  try {
    for (const child of containersOf(g, root)) {
      // if this container can't be in a hierarchy, it may have one inside it
      if (!hierarchicalNodes.has(child) && child.isContainer()) assign_(ctx, g, child, hierarchicalNodes);
    }

    // does not consider Nears when splitting the subgraph
    let subgraphs;
    [subgraphs, splitOwnership] = hierarchyGraph.splitSubgraphsTracked(ctx, {}, null);
    for (const subgraph of subgraphs) {
      const hierarchy = build(ctx, subgraph, force, hierarchicalNodes, edgeAbductions);
      if (hierarchy === null) continue;
      for (const node of subgraph.nodes) {
        node.hierarchy = hierarchy;
        for (const descendant of g.allDescendantNodes(node, false)) {
          hierarchy.levels().set(descendant, hierarchy.levels().get(node) ?? 0);
          descendant.hierarchy = hierarchy;
        }
      }
    }
    g.restoreEdgeAbductions(edgeAbductions);
    edgesRestored = true;

    // remove Nears of nodes in hierarchies
    if (root === null) {
      for (const node of g.nodes) {
        const nears = node.nears;
        node.nears = new Set();
        if (node.hierarchy === null) {
          for (const near of nears) {
            if (near.hierarchy === null) node.addNear(near);
          }
        }
      }
    }
  } finally {
    if (!edgesRestored) g.restoreEdgeAbductions(edgeAbductions);
    // Edge reachability can include nodes outside hierarchyGraph.Nodes. Restore those exact owners before retaining the assignment
    // stage's existing owner state for nodes in g.
    if (splitOwnership !== null) splitOwnership.restore();
    lg.Nodes.setGraphReference(g.nodes, g);
  }
}

/**
 * buildHierarchy assigns a hierarchy level to each node in this graph given that all nodes can be in a hierarchy.
 * Find sources (nodes with no incoming edges) and sinks (nodes without outgoing edges); if there is at least one of each, rank the
 * simplified DAG. SQL-table-only subgraphs use the orthogonal table placement path rather than hierarchy placement, even when
 * their edges form a directed hierarchy.
 */
export function build(ctx, g, force, hierarchicalNodes, edgeAbductions) {
  if (g.nodes.length <= 1) return null;
  let sourceCount = 0;
  let sinkCount = 0;
  let allNodesAreTable = true;
  for (const node of g.nodes) {
    if (!hierarchicalNodes.has(node)) return null;
    allNodesAreTable = allNodesAreTable && node.isTable();

    // `if/else if` to ensure source and sink are different nodes
    if (isSource(node)) sourceCount++;
    else if (isSink(node)) sinkCount++;
  }

  if (!force && (allNodesAreTable || sourceCount === 0 || sinkCount === 0)) return null;

  const hierarchy = lg.newHierarchy();
  const dag = makeSimpleDAG(ctx, g);
  const ranks = rankDAG(ctx, dag);
  hierarchy.replaceLevels(mapDAGToGraphLevels(g, ranks.nodeToLevel));
  hierarchy.levelCount = ranks.levelCount;
  if (force || isValid(hierarchy, g, edgeAbductions, sourceCount, sinkCount)) return hierarchy;

  return null;
}

/**
 * isValid prefers compact hierarchies with a dominant edge direction. Fully directed branched workflows retain their reading order
 * even when they are too tall for the usual compactness heuristic.
 */
function isValid(h, g, edgeAbductions, sourceCount, sinkCount) {
  if (h.levelCount < minHierarchyLevels) return false;
  // a perfect square hierarchy would have nLevels and nLevels nodes on each level (a matrix nLevels x nLevels)
  // so, taking the ratio to nLevels * nLevels tries to approximate this estimate this hierarchy "squaredness"
  const unique = new Set();
  for (const node of h.levels().keys()) {
    unique.add(node);
    for (const descendant of g.allDescendantNodes(node, false)) unique.add(descendant);
  }
  const aspectRatio = unique.size / (h.levelCount * h.levelCount);
  const tooTall = aspectRatio < 0.5;
  const tooWide = aspectRatio > 2.0;

  // At least 60% of the structural edges must point forward. The workflow exception requires every structural edge to point forward.
  const [forwardEdges, backOrNeutralEdges] = countEdgeDirection(h, g);
  const edgesFlowInOneDirection = forwardEdges >= 1.5 * backOrNeutralEdges;
  const allEdgesForward = backOrNeutralEdges === 0;
  // More nodes than ranks requires a parallel rank: ordinary chains retain their existing placement path. Count only top-level
  // blocks here, since descendants do not add parallel branches to the outer workflow.
  let branchedWorkflow = g.nodes.length > h.levelCount && sourceCount === 1 && sinkCount === 1 && allEdgesForward &&
    unique.size <= maxAutomaticWorkflowNodes && forwardEdges + backOrNeutralEdges <= maxAutomaticWorkflowEdges;
  if (tooTall && branchedWorkflow && !minimumWorkflowExtentFits(h, g)) branchedWorkflow = false;

  // we want to avoid nodes with many edges, as they would create a lot of noisy routes
  const nEdgesAbductions = new Map();
  for (const ea of edgeAbductions ?? []) {
    if (!isHierarchyStructuralEdge(ea.edge)) continue;
    if (ea.originallyFrom !== null) nEdgesAbductions.set(ea.currentFrom, (nEdgesAbductions.get(ea.currentFrom) ?? 0) + 1);
    if (ea.originallyTo !== null) nEdgesAbductions.set(ea.currentTo, (nEdgesAbductions.get(ea.currentTo) ?? 0) + 1);
  }
  const maxEdges = Math.trunc(2 * Math.ceil(Math.sqrt(unique.size)));
  let hasDenselyConnectedNode = false;
  for (const node of unique) {
    const edgeCount = countHierarchyStructuralEdges(node) - (nEdgesAbductions.get(node) ?? 0);
    if (edgeCount > maxEdges) {
      hasDenselyConnectedNode = true;
      break;
    }
  }

  return !tooWide && (!tooTall || branchedWorkflow) && edgesFlowInOneDirection && !hasDenselyConnectedNode && !is1N1(h, edgeAbductions);
}

/**
 * minimumWorkflowExtentFits screens current rank dimensions with the minimum placement gaps. Container resizing can change these
 * dimensions, and later padding can add space, so this does not guarantee that a layout will fit. It is called only for the bounded
 * workflow exception, never for authored or ordinary hierarchies.
 */
function minimumWorkflowExtentFits(h, g) {
  const horizontal = isHorizontal(g.nodes);
  const levelSize = new Array(h.levelCount).fill(0);
  for (const [node, level] of h.levels()) {
    let size = node.height;
    if (horizontal) size = node.width;
    levelSize[level] = Math.max(levelSize[level], size);
  }
  let extent = (h.levelCount - 1) * (crossingSpacing + 2 * lg.MinPortClearance);
  for (const size of levelSize) extent += Math.ceil(size);
  return extent <= limits.MaxGraphSize;
}

/**
 * countHierarchyEdgesDirections counts the direction of the edges in the given graph considering the node levels. Forward edges
 * are the targeted ones coming (source) from top (lower level value) to (target) bottom (higher level value). Undirected edges and
 * bidirectional edges are counted as backwardOrNeutral. Targeted edges coming from bottom to top are as backwardOrNeutral.
 */
function countEdgeDirection(h, g) {
  let forward = 0;
  let structural = 0;
  for (const e of g.edges) {
    if (!isHierarchyStructuralEdge(e)) continue;
    structural++;
    if (!e.isDirected()) continue;
    const [from, to] = e.directedEndpoints();
    if ((h.levels().get(to) ?? 0) > (h.levels().get(from) ?? 0)) forward += 1;
  }
  return [forward, structural - forward];
}

/** is1N1Hierarchy identifies the 1 source, N middle nodes, 1 sink diamond shape (see the Go source for the drawing). */
function is1N1(h, edgeAbductions) {
  if (h.levelCount !== 3) return false;

  const nodesByLevel = new Map();
  for (const [node, level] of h.levels()) {
    if (!nodesByLevel.has(level)) nodesByLevel.set(level, []);
    nodesByLevel.get(level).push(node);
  }
  const at = (level) => nodesByLevel.get(level) ?? [];
  if (at(0).length !== 1 || at(2).length !== 1) return false;

  // This doesn't qualify: a diagram where the edges of the source or sink come from different original endpoints.
  let sourceEdgeAbduction = null;
  let sinkEdgeAbduction = null;
  for (const ea of edgeAbductions ?? []) {
    if (!isHierarchyStructuralEdge(ea.edge)) continue;
    if (ea.currentFrom === at(0)[0]) {
      if (sourceEdgeAbduction !== null) {
        if (ea.originallyFrom !== sourceEdgeAbduction.originallyFrom) return false;
      } else {
        sourceEdgeAbduction = ea;
      }
    }
    if (ea.currentTo === at(0)[0]) {
      if (sourceEdgeAbduction !== null) {
        if (ea.originallyTo !== sourceEdgeAbduction.originallyTo) return false;
      } else {
        sourceEdgeAbduction = ea;
      }
    }

    if (ea.currentFrom === at(2)[0]) {
      if (sinkEdgeAbduction !== null) {
        if (ea.originallyFrom !== sinkEdgeAbduction.originallyFrom) return false;
      } else {
        sinkEdgeAbduction = ea;
      }
    }
    if (ea.currentTo === at(2)[0]) {
      if (sinkEdgeAbduction !== null) {
        if (ea.originallyTo !== sinkEdgeAbduction.originallyTo) return false;
      } else {
        sinkEdgeAbduction = ea;
      }
    }
  }

  // all nodes on level 2 must be connected at least once above and once below
  for (const node of at(1)) {
    let hasEdgeAbove = false;
    let hasEdgeBelow = false;
    for (const e of node.edges) {
      if (!isHierarchyStructuralEdge(e)) continue;
      const adj = node.adjacent(e);
      if ((h.levels().get(adj) ?? 0) === 0) hasEdgeAbove = true;
      else if ((h.levels().get(adj) ?? 0) === 2) hasEdgeBelow = true;
      else return false;
      if (hasEdgeAbove && hasEdgeBelow) break;
    }
    if (!hasEdgeAbove || !hasEdgeBelow) return false;
  }

  // the source (level=0) can't be connected to the sink (level=2)
  const source = at(0)[0];
  for (const e of source.edges) {
    if (!isHierarchyStructuralEdge(e)) continue;
    const adj = source.adjacent(e);
    if ((h.levels().get(adj) ?? 0) !== 1) return false;
  }

  return true;
}

/**
 * makeSimpleDAG transforms the input into a DAG and removes duplicate edges
 * - undirected (a -- b) and bidirectional (a <-> b) edges are split in 2: a -> b and b -> a
 * - cycles are broken by reversing some edges
 * - duplicate edges are combined, preserving one rank-weight unit per authored edge
 * - loops (self-edges) are removed
 */
export function makeSimpleDAG(ctx, g) {
  const guard = limits.newWorkGuard(ctx, 'MakeSimpleDAG', limits.MaxEngineWorkUnits);
  const dag = lg.newGraph();
  const connect = (from, to, rankWeight) => {
    const e = dag.connect(from, to);
    e.sourceArrowhead = lg.NoArrowhead;
    e.targetArrowhead = lg.TriangleArrowhead;
    e.id = BigInt(dag.edges.length);
    e.setHierarchyRankWeight(rankWeight);
  };

  const idToNode = new Map();
  for (const n of g.nodes) {
    guard.step();
    const newN = dag.addNode(lg.newNode(n.id, n.width, n.height));
    newN.d2ID = n.d2ID;
    idToNode.set(n.id, newN);
  }

  for (const e of g.edges) {
    guard.step();
    if (!isHierarchyStructuralEdge(e)) continue;
    if (e.isDirected()) {
      const [from, to] = e.directedEndpoints();
      connect(idToNode.get(from.id), idToNode.get(to.id), 1);
    } else {
      // An undirected or bidirectional edge expands to opposing arcs so the cycle breaker can choose a feasible orientation. The two
      // arcs still represent one authored edge, not two independent rank objectives. They necessarily converge after cycle removal,
      // so carry its unit weight on one half and zero on the other before simplification.
      connect(idToNode.get(e.from.id), idToNode.get(e.to.id), 1);
      connect(idToNode.get(e.to.id), idToNode.get(e.from.id), 0);
    }
  }

  const cycleEdges = findCycleEdges(ctx, dag);
  reverseEdges(ctx, cycleEdges);
  removeDuplicateEdges(ctx, dag);
  // Preserve preparation's work charge and cancellation checkpoints after simplifying the graph.
  for (let i = 0; i < dag.nodes.length; i++) guard.step();

  guard.finish();
  return dag;
}

/**
 * findCycleEdges implements "A fast and effective heuristic for the feedback arc set problem" by P. Eades.
 * 1. sources and sinks can't be in cycles, so remove them and flag their edges as non cycle
 * 2. for the remaining nodes, take the node max(outgoing - incoming)
 * 3. remove the node and flag the outgoing as non cycle
 * 4. repeat from 1 until all nodes were processed
 * return set(all edges) - set(non cycle edges)
 *
 * Go ranges over maps here (`for n := range nodes`, the edge sets). The result does not depend on the order: removing sinks, then
 * sources, is confluent; the max-diff node is a total order (diff, edge count, in-degree, ID); the final set difference is a set.
 */
function findCycleEdges(ctx, g) {
  const guard = limits.newWorkGuard(ctx, 'FindCycleEdges', limits.MaxEngineWorkUnits);
  const incomingEdges = new Map();
  const outgoingEdges = new Map();
  const addEdgeToSet = (e, n, set) => {
    const nodeEdges = set.get(n);
    if (nodeEdges !== undefined) nodeEdges.add(e);
    else set.set(n, new Set([e]));
  };
  const len = (set) => (set === undefined ? 0 : set.size);

  const nodes = new Set();
  // set of edges to take the difference with set of non cycle edges
  const edges = new Set();
  for (const e of g.edges) {
    guard.step();
    edges.add(e);
    nodes.add(e.from);
    nodes.add(e.to);
    if (e.isTargetedTo(e.from)) {
      addEdgeToSet(e, e.from, incomingEdges);
      addEdgeToSet(e, e.to, outgoingEdges);
    } else {
      addEdgeToSet(e, e.from, outgoingEdges);
      addEdgeToSet(e, e.to, incomingEdges);
    }
  }

  const nonCycleEdges = new Set();
  const pruneNode = (n) => {
    const inc = incomingEdges.get(n);
    if (inc !== undefined) {
      for (const e of inc) {
        guard.step();
        nonCycleEdges.add(e);
        // update the adjacent node
        const adj = n.adjacent(e);
        const adjEdges = outgoingEdges.get(adj);
        if (adjEdges !== undefined) adjEdges.delete(e);
        // removes the isolated adjacent node
        if (len(adjEdges) === 0 && len(incomingEdges.get(adj)) === 0) {
          nodes.delete(adj);
          outgoingEdges.delete(adj);
          incomingEdges.delete(adj);
        }
      }
    }
    const out = outgoingEdges.get(n);
    if (out !== undefined) {
      for (const e of out) {
        guard.step();
        nonCycleEdges.add(e);
        // update the adjacent node
        const adj = n.adjacent(e);
        const adjEdges = incomingEdges.get(adj);
        if (adjEdges !== undefined) adjEdges.delete(e);
        // removes the isolated adjacent node
        if (len(adjEdges) === 0 && len(outgoingEdges.get(adj)) === 0) {
          nodes.delete(adj);
          outgoingEdges.delete(adj);
          incomingEdges.delete(adj);
        }
      }
    }
    nodes.delete(n);
    incomingEdges.delete(n);
    outgoingEdges.delete(n);
  };
  while (nodes.size > 0) {
    guard.step();
    for (;;) {
      // as we delete sinks we might be creating new sinks so this part runs until all sinks were removed
      let foundSink = false;
      for (const n of nodes) {
        guard.step();
        // only incoming edges = sink
        if (len(outgoingEdges.get(n)) === 0) {
          foundSink = true;
          pruneNode(n);
        }
      }
      if (!foundSink) break;
    }

    // isolated nodes are handled in `pruneNode` when we remove the edge of the adjacent node

    // sources
    for (;;) {
      let foundSource = false;
      for (const n of nodes) {
        guard.step();
        // only outgoing edges = source
        if (len(incomingEdges.get(n)) === 0) {
          foundSource = true;
          pruneNode(n);
        }
      }
      if (!foundSource) break;
    }

    if (nodes.size > 0) {
      let maxNode = null;
      let maxDiff = -Infinity;
      for (const node of nodes) {
        guard.step();
        const diff = len(outgoingEdges.get(node)) - len(incomingEdges.get(node));
        if (diff > maxDiff) {
          maxDiff = diff;
          maxNode = node;
        } else if (diff === maxDiff) {
          // prefer the node with more edges
          const nEdges = len(outgoingEdges.get(node)) + len(incomingEdges.get(node));
          const nMaxEdges = len(outgoingEdges.get(maxNode)) + len(incomingEdges.get(maxNode));
          if (nEdges > nMaxEdges) {
            maxDiff = diff;
            maxNode = node;
          } else if (len(incomingEdges.get(node)) === len(incomingEdges.get(maxNode)) && node.id < maxNode.id) {
            // if edge count is the same, prefer the smaller ID
            maxDiff = diff;
            maxNode = node;
          }
        }
      }
      const maxIncoming = incomingEdges.get(maxNode);
      if (maxIncoming !== undefined) {
        for (const e of Array.from(maxIncoming)) {
          guard.step();
          maxIncoming.delete(e);
          const adjOut = outgoingEdges.get(maxNode.adjacent(e));
          if (adjOut !== undefined) adjOut.delete(e);
        }
      }
      pruneNode(maxNode);
    }
  }

  for (const e of nonCycleEdges) {
    guard.step();
    edges.delete(e);
  }

  guard.finish();
  return edges;
}

/** ReverseEdges exchanges from, to = to, from. Arrowheads don't change because we want `a -> b` to become `b -> a` and not `b <- a`. */
function reverseEdges(ctx, edges) {
  const guard = limits.newWorkGuard(ctx, 'ReverseEdges', limits.MaxEngineWorkUnits);
  for (let i = 0; i < edges.size; i++) guard.step();
  guard.finish();
  for (const e of edges) {
    const t = e.from;
    e.from = e.to;
    e.to = t;
  }
}

/** removeDuplicateEdges combines multiple instances of the same edge (from -> to), summing their hierarchy rank weights. Assumes all edges are directed. */
function removeDuplicateEdges(ctx, g) {
  const guard = limits.newWorkGuard(ctx, 'RemoveDuplicateEdges', limits.MaxEngineWorkUnits);
  const edges = new Map();
  const uniqueEdges = [];
  const rankWeights = new Map();
  for (const e of g.edges) {
    guard.step();
    const fromEdges = edges.get(e.from);
    if (fromEdges !== undefined) {
      const retained = fromEdges.get(e.to);
      if (retained !== undefined) {
        rankWeights.set(retained, rankWeights.get(retained) + e.hierarchyRankWeight());
      } else {
        fromEdges.set(e.to, e);
        uniqueEdges.push(e);
        rankWeights.set(e, e.hierarchyRankWeight());
      }
    } else {
      edges.set(e.from, new Map());
      edges.get(e.from).set(e.to, e);
      uniqueEdges.push(e);
      rankWeights.set(e, e.hierarchyRankWeight());
    }
  }

  guard.finish();
  for (const e of uniqueEdges) e.setHierarchyRankWeight(rankWeights.get(e));
  g.replaceEdgesUnchecked(uniqueEdges);
}

function mapDAGToGraphLevels(g, dagNodeToLevel) {
  const idToNode = new Map();
  for (const n of g.nodes) idToNode.set(n.id, n);

  const nodeToLevel = new Map();
  for (const [dagN, level] of dagNodeToLevel) nodeToLevel.set(idToNode.get(dagN.id), level);
  return nodeToLevel;
}

// ---- placement.go ----

class PlacementNode {
  constructor(level, node) {
    this.graphNode = node;
    this.level = level;
    // this is the level index considering the order left to right as if it was a flatten array, no container depth considered
    this.rank = 0;
    this.aboves = new Set();
    this.belows = new Set();
    this.container = null;
    this.children = []; // Go: nil
    // flags whether or not we should recurse to optimize the children's position currently only for SQL Tables as we need to
    // consider their columns as `children` but we don't want to change their position also, tables are simple nodes and we create
    // children as dummy nodes so that we can optimize the tables position based on the columns (as routing from column to column
    // can change crossings)
    this.optimizeChildrenCrossings = true;

    // a flag for intermediate nodes used to break long connections
    // a connection from level 1 to 3 is broken with a dummy node at level 2
    // (so that all `aboves`/`belows` are 1 level apart)
    // this flags marks the node at level 2 as being part of the chain
    this.isChainningConnection = false;

    // isContainer quickly checks if a node is a container or not. Table nodes have children, but aren't containers
    this.isContainer = false;

    this.isDummy = false;
  }

  degree() {
    if (this.isDummy) {
      // dummy nodes have only 2 edges
      return 2;
    }
    return countHierarchyStructuralEdges(this.graphNode);
  }

  /** Go ranges over the map and returns the first (random) neighbor: dummy chain nodes have exactly one above and one below. */
  findNonDummyNode(above) {
    const firstNeighbor = (n, isAbove) => {
      const nodes = isAbove ? n.aboves : n.belows;
      for (const connected of nodes) return connected;
      return null;
    };
    let n = this;
    while (n.isDummy && n.isChainningConnection) n = firstNeighbor(n, above);
    return n;
  }

  /** (below *placementNode) connect(above *placementNode) */
  connect(above) {
    let below = this;
    if (above.level === below.level) return;
    if (above.level > below.level) {
      const t = below;
      below = above;
      above = t;
    }
    below.aboves.add(above);
    above.belows.add(below);
  }

  containerPadding() {
    if (this === null || this.isDummy) return lg.uniformSpacing(lg.ContainerPadding);
    let container = null;
    if (this.container !== null) container = this.container.graphNode;
    return this.graphNode.graph.containerPadding(container, true);
  }

  debugID() {
    return `${this.graphNode.debugID()}[${this.level}, ${this.rank}]`;
  }
}

const newPlacementNode = (level, node) => new PlacementNode(level, node);

/** Place lays out every hierarchy of the graph (root null = the top level) in layers. `randGenerator` is a gorand Rand or null. */
export function place(ctx, g, root, randGenerator) {
  lg.validate(ctx, 'PlaceHierarchies', g);
  if (containersOf(g, root).length === 0) return;
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'PlaceHierarchiesTransactions');
  const state = lg.newGraphStateSnapshot({ captureTopology: true, captureEdgeRoutes: true });
  state.updateWithWorkGuard(g, guard);
  const rollback = new lg.Transaction();
  rollback.graph = g;
  rollback.priorGraphState = state;
  let complete = false;
  try {
    place_(ctx, g, root, randGenerator);
    const err = ctx.err();
    if (err) throw errorf(`PlaceHierarchies: ${err.message}`, err);
    complete = true;
  } finally {
    if (!complete) rollback.rollback();
  }
}

function place_(ctx, g, root, randGenerator) {
  const hGraph = lg.newGraph();
  hGraph.copyEntitiesFrom(g);
  for (const child of containersOf(g, root)) hGraph.addNodeUnchecked(child);

  let edgeAbductions = g.abductEdges(root, hGraph);
  let edgesRestored = false;
  let splitOwnership = null;
  try {
    for (const child of containersOf(g, root)) {
      if (child.hierarchy === null && child.isContainer()) place_(ctx, g, child, randGenerator);
    }

    let subgraphs;
    [subgraphs, splitOwnership] = hGraph.splitSubgraphsTracked(ctx, { includeNears: true }, null);
    for (const subgraph of subgraphs) {
      if (subgraph.nodes[0].hierarchy === null) continue;
      subgraph.computeCellSize();
      lg.Nodes.setGraphReference(g.nodes, subgraph);
      edgeAbductions = subgraph.restoreEdgeAbductions(edgeAbductions);
      placeNodesInHierarchy(ctx, subgraph, randGenerator);
    }

    g.restoreEdgeAbductions(edgeAbductions);
    edgesRestored = true;
  } finally {
    if (!edgesRestored) g.restoreEdgeAbductions(edgeAbductions);
    // The split follows Nears outside hGraph.Nodes and temporarily redirects their owners too. Restore every exact pre-split owner
    // before retaining the hierarchy stage's existing successful owner state for nodes in g.
    if (splitOwnership !== null) splitOwnership.restore();
    lg.Nodes.setGraphReference(g.nodes, g);
  }
}

function placeNodesInHierarchy(ctx, g, rand) {
  // A hierarchy may already be attached by an earlier stage. Never let derived state override an absolute constraint on a member,
  // including a nested container member.
  const hierarchy = g.nodes[0].hierarchy;
  if (hierarchy !== null) {
    for (const node of hierarchy.levels().keys()) {
      const err = ctx.err();
      if (err) throw errorf(`PlaceHierarchies: ${err.message}`, err);
      if (node.fixedTopLeft !== null) return;
    }
  }
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'PlaceHierarchiesTransactions');
  const state = lg.newGraphStateSnapshot({ captureEdgeRoutes: true });
  state.updateWithWorkGuard(g, guard);
  const rollback = new lg.Transaction();
  rollback.graph = g;
  rollback.priorGraphState = state;
  let complete = false;
  try {
    const placementNodes = createPlacementNodes(g, g.nodes, rand);
    connectPlacementNodes(g, placementNodes);
    const byLevel = groupPlacementNodesByLevel(placementNodes);
    initializeRanks(byLevel);
    breakLongConnections(placementNodes, byLevel);
    minimizeHierarchyCrossings(byLevel);
    globalSifting(byLevel);
    const horizontal = isHorizontal(g.nodes);
    if (horizontal) transpose(g);
    placeNodesByLevel(g, byLevel, horizontal);
    for (let level = 0; level < byLevel.size; level++) {
      byLevel.set(level, removeTableColumnNodes(byLevel.get(level) ?? []));
      computeLevelRanks(byLevel.get(level));
    }
    alignHierarchy(ctx, g, byLevel);
    if (horizontal) transpose(g);
    switch (g.nodes[0].containerDirection()) {
      case geo.Orientation.Left:
        mirrorX(g);
        break;
      case geo.Orientation.Top:
        mirrorY(g);
        break;
    }
    complete = true;
  } finally {
    if (!complete) rollback.rollback();
  }
}

// create placement nodes recursively and set the container whenever required
function createPlacementNodes(g, nodes, rand) {
  const placementNodes = [];
  for (const node of nodes) {
    const pn = newPlacementNode(hierarchyLevel(node), node);
    placementNodes.push(pn);
    if (node.isTable()) {
      pn.children = new Array(node.numColumns());
      pn.optimizeChildrenCrossings = false;
      pn.isContainer = false;
      for (let i = 0; i < node.numColumns(); i++) {
        pn.children[i] = newPlacementNode(pn.level, null);
        pn.children[i].container = pn;
        pn.children[i].isDummy = true;
      }
    } else {
      pn.optimizeChildrenCrossings = true;
      pn.children = [];
      for (const child of createPlacementNodes(g, containersOf(g, node), rand)) {
        if (child.container === null) {
          child.container = pn;
          pn.children.push(child);
        }
      }
      pn.isContainer = pn.children.length > 0;
    }
  }
  if (rand !== null) {
    rand.shuffle(placementNodes.length, (i, j) => {
      const t = placementNodes[i];
      placementNodes[i] = placementNodes[j];
      placementNodes[j] = t;
    });
  }
  return placementNodes;
}

function connectPlacementNodes(g, nodes) {
  const nodeToPlacementNode = new Map();
  const queue = nodes.slice();
  for (let head = 0; head < queue.length; head++) {
    const pn = queue[head];
    nodeToPlacementNode.set(pn.graphNode, pn);
    for (const c of pn.children) queue.push(c);
  }

  for (const edge of g.edges) {
    let from = nodeToPlacementNode.get(edge.from);
    let to = nodeToPlacementNode.get(edge.to);
    to.connect(from);

    if (edge.isBetweenTableColumns()) {
      // connect the rows
      from = from.children[edge.fromTableColumnIndex];
      to = to.children[edge.toTableColumnIndex];
      to.connect(from);
    }
  }
}

/**
 * breakLongConnections creates chains of dummy nodes when two nodes are connected but their level distance is greater than 1.
 * Returns the dummies created by this call and its recursive calls.
 */
function breakLongConnections(nodes, byLevel) {
  const dummies = [];
  for (const pn of nodes) {
    const belows = [];
    for (const below of pn.belows) {
      if (below.level - pn.level > 1) belows.push(below);
    }
    belows.sort((a, b) => {
      const order = cmpCompare(a.rank, b.rank);
      if (order !== 0) return order;
      return cmpCompare(a.level, b.level);
    });
    for (const below of belows) {
      pn.belows.delete(below);
      below.aboves.delete(pn);

      let above = pn;
      for (let level = pn.level + 1; level < below.level; level++) {
        const dummyID = -BigInt(dummies.length + 1);
        const dummy = newPlacementNode(level, lg.newNode(dummyID, 1, 1));
        dummy.isChainningConnection = true;
        dummy.isDummy = true;
        dummy.rank = (byLevel.get(level) ?? []).length;
        dummy.connect(above);
        dummies.push(dummy);
        if (!byLevel.has(level)) byLevel.set(level, []);
        byLevel.get(level).push(dummy);
        above = dummy;
      }
      below.connect(above);
    }
    for (const d of breakLongConnections(pn.children, byLevel)) dummies.push(d);
  }
  return dummies;
}

function groupPlacementNodesByLevel(nodes) {
  const byLevel = new Map();
  for (const pn of nodes) {
    if (!byLevel.has(pn.level)) byLevel.set(pn.level, []);
    byLevel.get(pn.level).push(pn);
  }
  return byLevel;
}

/** removeTableColumnNodes removes nodes where `graphNode == nil` and restores edge references. */
function removeTableColumnNodes(nodes) {
  const newNodes = [];
  for (const node of nodes) {
    if (node.isDummy) {
      if (node.graphNode === null) {
        // table column
        continue;
      } else if (node.isChainningConnection) {
        const above = node.findNonDummyNode(true);
        const below = node.findNonDummyNode(false);
        if (above.graphNode === null || below.graphNode === null) {
          // dummy node chaining a long connection between two table columns
          continue;
        }
      }
    }
    newNodes.push(node);
    node.children = removeTableColumnNodes(node.children);
  }
  return newNodes;
}

function placeNodesByLevel(g, byLevel, horizontal) {
  let yOffset = 0.0;
  for (let i = 0; i < byLevel.size; i++) {
    const nodes = [];
    let levelHeight = 0.0;
    let xOffset = 0.0;
    for (const pn of byLevel.get(i)) {
      nodes.push(pn.graphNode);
      pn.graphNode.topLeft = geo.newPoint(xOffset, yOffset);
      if (!pn.isDummy) {
        let container = null;
        if (pn.container !== null) container = pn.container.graphNode;
        const padding = g.containerPadding(container, true);
        placeDescendants(g, pn, pn.graphNode.insidePlacement(1, 1, padding));
        levelHeight = Math.max(levelHeight, pn.graphNode.height);
        xOffset += Math.ceil(pn.graphNode.width) + siblingSpacing;
      } else {
        xOffset += siblingSpacing;
      }
    }
    const distanceToNextLevel = minimumDistanceToNextLevel(byLevel.get(i), horizontal);
    yOffset += Math.ceil(levelHeight + distanceToNextLevel + 2 * lg.MinPortClearance);

    // move to center
    const center = lg.Nodes.center(nodes);
    center.y = Math.ceil(center.y);
    for (const node of nodes) {
      const yDiff = Math.ceil(center.y - node.center().y);
      node.translate(0, yDiff);
    }
  }
}

// recursively place all descendants of a given container
function placeDescendants(g, root, tl) {
  if (!root.isContainer) return;
  const padding = g.containerPadding(root.graphNode, true);
  let x = tl.x;
  for (const child of root.children) {
    child.graphNode.topLeft = geo.newPoint(x, tl.y);
    placeDescendants(g, child, child.graphNode.insidePlacement(1, 1, padding));
    x += Math.ceil(child.graphNode.width) + siblingSpacing;
  }
  const [childrenTL, childrenBR] = lg.Nodes.boundingBox(containersOf(g, root.graphNode));
  root.graphNode.fitToBoundingBox(childrenTL, childrenBR, padding);
}

/** minimumDistanceToNextLevel computes the distance between two levels, accounting for crossings between them and the label sizes. */
function minimumDistanceToNextLevel(levelNodes, horizontal) {
  const scratch = new CrossingScratch();
  const segments = scratch.crossLevelSegments(levelNodes, false, true);
  const crossings = countCrossings(segments);
  const crossingsDistance = crossings * crossingSpacing;

  let maxLabelSize = 0.;
  for (const node of levelNodes) {
    if (node.isDummy) continue;
    for (const e of node.graphNode.edges) {
      const adj = node.graphNode.adjacent(e);
      let from = node.graphNode;
      let to = adj;
      if (hierarchyLevel(to) < hierarchyLevel(from)) {
        const t = from;
        from = to;
        to = t;
      }
      if (hierarchyLevel(to) - hierarchyLevel(from) !== 1) continue;
      if (e.label !== null) {
        if (horizontal) maxLabelSize = Math.max(e.label.width, maxLabelSize);
        else maxLabelSize = Math.max(e.label.height, maxLabelSize);
      }
    }
  }
  let distance = Math.max(crossingsDistance, maxLabelSize + crossingSpacing);
  // ensure there'll be some space if there are no crossings
  distance = Math.max(crossingSpacing, distance);
  // crossings distance is a kind of overshot (as routes might be shared), so clipping here to avoid large gaps between levels
  distance = Math.min(distance, parentSpacing);
  return goRound(distance);
}

function isSource(n) {
  for (const e of n.edges) {
    if (!isHierarchyStructuralEdge(e)) continue;
    if (e.hasSourceArrow() === e.hasTargetArrow() || (e.hasSourceArrow() && e.from === n) || (e.hasTargetArrow() && e.to === n)) return false;
  }
  return true;
}

function isSink(n) {
  for (const e of n.edges) {
    if (!isHierarchyStructuralEdge(e)) continue;
    if (e.hasSourceArrow() === e.hasTargetArrow() || (e.hasTargetArrow() && e.from === n) || (e.hasSourceArrow() && e.to === n)) return false;
  }
  return true;
}

function iterContainersBFS(g, apply) {
  const queue = g.nodes.slice();
  for (let head = 0; head < queue.length; head++) {
    const curr = queue[head];
    if (curr.isContainer()) {
      for (const c of containersOf(g, curr)) queue.push(c);
    }
    apply(curr);
  }
}

function transpose(g) {
  iterContainersBFS(g, (n) => {
    n.transpose();
  });
}

function mirrorX(g) {
  iterContainersBFS(g, (n) => {
    n.mirror(true, false);
  });
}

function mirrorY(g) {
  iterContainersBFS(g, (n) => {
    n.mirror(false, true);
  });
}

// ---- crossing.go ----

class CrossingScratch {
  constructor() {
    this.segments = [];
  }

  // adjacentLevelNodes can be either the nodes above or below, depending on the optimization direction
  crossLevelSegments(nodes, aboves, belows) {
    this.segments = [];
    iterAllDescendants(nodes, (pn) => {
      if (aboves) {
        for (const connected of pn.aboves) {
          this.segments.push(lg.newCrossingSegment(new geo.Point(pn.rank, pn.level), new geo.Point(connected.rank, connected.level)));
        }
      }
      if (belows) {
        for (const connected of pn.belows) {
          this.segments.push(lg.newCrossingSegment(new geo.Point(pn.rank, pn.level), new geo.Point(connected.rank, connected.level)));
        }
      }
    });
    this.segments.sort((a, b) => {
      if (a.start.x === b.start.x) {
        if (a.end.x < b.end.x) return -1;
        if (b.end.x < a.end.x) return 1;
        return 0;
      }
      if (a.start.x < b.start.x) return -1;
      if (b.start.x < a.start.x) return 1;
      return 0;
    });

    return this.segments;
  }
}

// The routines below are part of the implementation of the `ordering` procedure described in section `3. Vertex Ordering Within
// Ranks` of "A Technique for Drawing Directed Graphs" by Gansner et al.

function initializeRanks(byLevel) {
  for (let i = 0; i < byLevel.size; i++) computeLevelRanks(byLevel.get(i));
}

// minimizes crossings iteratively. After minimization, recomputes the nodes ranks
function minimizeHierarchyCrossings(byLevel) {
  let widestLevel = 0;
  for (const nodes of byLevel.values()) widestLevel = Math.max(widestLevel, nodes.length);
  const scratch = new CrossingScratch();
  const iterCount = widestLevel;
  for (let n = 0; n < iterCount; n++) {
    for (let level = 0; level < byLevel.size; level++) minimizeCrossings(byLevel.get(level), byLevel, level > 0, scratch);
  }
}

/**
 * This is the main routine to find the optimal node rank compared to its siblings. Ranks are optimized considering edges above the
 * given level. Except for the first (top level), in which the optimization considers the edges below. Crossings take precedence to
 * be optimized, then if they don't change, it tries to get the best length. To find the best rank it first sorts the nodes so that
 * it is "pulled" towards its connected neighbors in the direction under optimization. Then, it tries to swap each node with its
 * neighbors. Once the nodes were ranked properly, if any of these nodes are containers, apply the same routine recursively to it's
 * descendants.
 */
function minimizeCrossings(nodes, byLevel, isTopDown, scratch) {
  sortLevelNodesByAdacencyPosition(nodes, isTopDown);
  computeLevelRanks(byLevel.get(nodes[0].level));
  const segments = scratch.crossLevelSegments(nodes, true, true);
  let crossings = countCrossings(segments);
  let length = addLengths(segments);
  for (let j = 0; j < nodes.length; j++) {
    const [newCrossings, newLength, swapIndex] = bestIndexBySwappingNeighbors(nodes, j, byLevel, scratch);
    if (newCrossings < crossings) {
      crossings = newCrossings;
      length = newLength;
      const t = nodes[j]; nodes[j] = nodes[swapIndex]; nodes[swapIndex] = t;
    } else if (newCrossings === crossings && geo.precisionCompare(newLength, length, crossingComparisonPrecision) === -1) {
      crossings = newCrossings;
      length = newLength;
      const t = nodes[j]; nodes[j] = nodes[swapIndex]; nodes[swapIndex] = t;
    }
    computeLevelRanks(byLevel.get(nodes[0].level));
  }
  for (const node of nodes) {
    if (node.children.length > 0 && node.optimizeChildrenCrossings) minimizeCrossings(node.children, byLevel, isTopDown, scratch);
  }
}

/**
 * Swap a given node with it's 3 neighbors to the right and returns the best crossing and index of this swap. This function returns
 * the level nodes as they were, it does not change their position. For the last nodes, it tries to swap them with the first ones in
 * a sort of "circular" approach.
 */
function bestIndexBySwappingNeighbors(levelNodes, nodeIndex, byLevel, scratch) {
  let bestCrossing = MaxInt;
  let bestLength = Infinity;
  let bestIndex = 0;
  for (let i = nodeIndex + 1; i < nodeIndex + 4; i++) {
    // swap to count new crossings
    const j = i % levelNodes.length;
    let t = levelNodes[nodeIndex]; levelNodes[nodeIndex] = levelNodes[j]; levelNodes[j] = t;
    computeLevelRanks(byLevel.get(levelNodes[nodeIndex].level));
    const segments = scratch.crossLevelSegments(levelNodes, true, true);
    const newCrossings = countCrossings(segments);
    const newLength = addLengths(segments);
    if (newCrossings < bestCrossing) {
      bestCrossing = newCrossings;
      bestIndex = j;
      bestLength = newLength;
    } else if (newCrossings === bestCrossing && geo.precisionCompare(newLength, bestLength, crossingComparisonPrecision) === -1) {
      bestCrossing = newCrossings;
      bestIndex = j;
      bestLength = newLength;
    }
    // swap back, so that node[j] swaps with the next one
    t = levelNodes[j]; levelNodes[j] = levelNodes[nodeIndex]; levelNodes[nodeIndex] = t;
  }
  return [bestCrossing, bestLength, bestIndex];
}

function iterAllDescendants(nodes, f) {
  for (const pn of nodes) f(pn);
  for (const pn of nodes) iterAllDescendants(pn.children, f);
}

function allDescendants(nodes, forOptimization) {
  const allNodes = nodes.slice();
  for (const pn of nodes) {
    if (!forOptimization || pn.optimizeChildrenCrossings) {
      for (const d of allDescendants(pn.children, forOptimization)) allNodes.push(d);
    }
  }
  return allNodes;
}

function addLengths(segments) {
  let length = 0.0;
  for (const s of segments) length += geo.euclideanDistance(s.start.x, s.start.y, s.end.x, s.end.y);
  return length;
}

function countCrossings(segments) {
  return lg.countSegmentCrossings(segments);
}

function sortLevelNodesByAdacencyPosition(nodes, useConnectionsAbove) {
  const adjacentLevelAverage = (pn) => {
    const nodes = useConnectionsAbove ? pn.aboves : pn.belows;
    if (nodes.size === 0) return 0;

    let sum = 0;
    for (const connected of nodes) sum += connected.rank;
    return sum / nodes.size;
  };

  nodes.sort((a, b) => {
    const aAverage = adjacentLevelAverage(a);
    const bAverage = adjacentLevelAverage(b);
    if (aAverage < bAverage) return -1;
    if (bAverage < aAverage) return 1;
    return 0;
  });
}

/**
 * Computes the nodes rank (index) from left to right as if they were sorted by TopLeft.X. Ranking is performed by Depth First
 * Search (DFS) adding nodes in reverse order. By adding the nodes on the right first, they get stacked first and popped only after
 * the nodes more on the left, yielding the desired effect of processing the nodes on the left before the ones on the right.
 */
function computeLevelRanks(nodes) {
  const stack = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) stack[i] = nodes[nodes.length - i - 1];
  for (let rank = 0; stack.length > 0; rank++) {
    const current = stack.pop();
    current.rank = rank;
    for (let i = current.children.length - 1; i > -1; i--) stack.push(current.children[i]);
  }
}

// ---- sifting.go ----

/**
 * The routines below implement the algorithm described in `Fig. 1`, and section `4 Extending Sifting to k-Layered Directed Graphs`,
 * of "Using Sifting for k-Layer Straightline Crossing Minimization" by Matuszewski et al.
 */
function globalSifting(byLevel) {
  const queue = nodesInDescendingDegreeOrder(byLevel);
  const nodeToSiblings = buildNodeToSiblings(queue, byLevel);
  const scratch = new CrossingScratch();
  let improveIfEqualCrossings = false;
  // 10 is just a killswitch (there's no suggested value in the paper)
  for (let iter = 0; iter < 10; iter++) {
    const iterQueue = queue.slice();
    let improved = false;
    while (iterQueue.length > 0) {
      const node = iterQueue.shift();
      const oldRank = node.rank;
      sifting(node, nodeToSiblings.get(node), byLevel, improveIfEqualCrossings, scratch);
      if (node.rank !== oldRank) improved = true;
    }
    if (!improved) {
      if (improveIfEqualCrossings) {
        // no improvement even considering reordering for the same crossings count
        break;
      }
      improveIfEqualCrossings = true;
    } else {
      improveIfEqualCrossings = false;
    }
  }
}

function nodesInDescendingDegreeOrder(byLevel) {
  const nodes = [];
  for (let level = 0; level < byLevel.size; level++) {
    for (const d of allDescendants(byLevel.get(level), true)) nodes.push(d);
  }
  nodes.sort((a, b) => {
    let order = cmpCompare(b.degree(), a.degree());
    if (order !== 0) return order;
    // If nodes have the same degree, sort by order from top-left.
    order = cmpCompare(a.level, b.level);
    if (order !== 0) return order;
    return cmpCompare(a.rank, b.rank);
  });
  return nodes;
}

function buildNodeToSiblings(nodes, byLevel) {
  const nodeToSiblings = new Map();
  for (const node of nodes) {
    if (node.container !== null) nodeToSiblings.set(node, node.container.children);
    else nodeToSiblings.set(node, byLevel.get(node.level));
  }
  return nodeToSiblings;
}

function sifting(node, siblings, byLevel, improveIfEqualCrossings, scratch) {
  let segments = scratch.crossLevelSegments(siblings, true, true);
  let bestCrossings = countCrossings(segments);
  let bestLength = addLengths(segments);
  let bestI = -1;

  if (bestCrossings === 0 || siblings.length === 1) {
    return;
  } else if (node === siblings[siblings.length - 1]) {
    // handle edge case where the node is already the right most one
    bestI = siblings.length - 1;
  } else {
    // move all the way to the right
    for (let i = 0; i < siblings.length - 1; i++) {
      if (bestI === -1) {
        if (siblings[i] === node) bestI = i;
        else continue;
      }

      let t = siblings[i + 1]; siblings[i + 1] = siblings[i]; siblings[i] = t;
      computeLevelRanks(byLevel.get(node.level));
      segments = scratch.crossLevelSegments(siblings, true, true);
      const crossings = countCrossings(segments);
      const length = addLengths(segments);
      if (improved(crossings, bestCrossings, length, bestLength, improveIfEqualCrossings)) {
        bestCrossings = crossings;
        bestI = i + 1;
        bestLength = length;
      }
    }
    if (siblings[siblings.length - 1] !== node) {
      throw errorf(`sifting: expected node ${node.graphNode.debugID()} to have moved to the right of siblings slice`);
    }
    if (bestI === -1) throw errorf(`sifting: node ${node.graphNode.debugID()} not found`);
  }

  // move all the way to the left
  for (let i = siblings.length - 1; i > 0; i--) {
    const t = siblings[i - 1]; siblings[i - 1] = siblings[i]; siblings[i] = t;
    computeLevelRanks(byLevel.get(node.level));
    segments = scratch.crossLevelSegments(siblings, true, true);
    const crossings = countCrossings(segments);
    const length = addLengths(segments);
    if (improved(crossings, bestCrossings, length, bestLength, improveIfEqualCrossings)) {
      bestCrossings = crossings;
      bestI = i - 1;
      bestLength = length;
    }
  }
  if (siblings[0] !== node) {
    throw errorf(`sifting: expected node ${node.graphNode.debugID()} to have moved to the left of siblings slice`);
  }

  // swap the node to the best rank and update the rank of all siblings
  for (let i = 0; i < siblings.length; i++) {
    if (i === bestI) {
      // at this moment, the node was already swapped to bestLocalRank
      break;
    }
    const t = siblings[i + 1]; siblings[i + 1] = siblings[i]; siblings[i] = t;
  }
  computeLevelRanks(byLevel.get(node.level));
}

function improved(crossings, bestCrossings, length, bestLength, improveIfEqualCrossings) {
  if (!improveIfEqualCrossings) {
    return crossings < bestCrossings || (crossings === bestCrossings && geo.precisionCompare(length, bestLength, geo.PRECISION) === -1);
  }
  return crossings <= bestCrossings || (crossings === bestCrossings && geo.precisionCompare(length, bestLength, geo.PRECISION) < 1);
}

// ---- brandes_kopf.go ----

/**
 * The routines below implement ideas described in "Fast and Simple Horizontal Coordinate Assignment" by Ulrik Brandes and Boris
 * Kopf, the authors' erratum to that paper, and "Node and Label Placement in a Layered Layout Algorithm" by John Julian Carstens.
 * The hierarchy is aligned 4 times changing directions (top left, top right, bottom left, bottom right), then all nodes are aligned
 * to the median of the 4 alignments after balancing them within the narrowest layout's bounding box. Only leaf descendants are
 * aligned; containers are wrapped around them again at the end.
 */
function alignHierarchy(ctx, g, byLevel) {
  const guard = limits.newWorkGuard(ctx, 'AlignHierarchy', limits.MaxEngineWorkUnits);
  const TL = { vertical: geo.Orientation.Top, horizontal: geo.Orientation.Left };
  const TR = { vertical: geo.Orientation.Top, horizontal: geo.Orientation.Right };
  const BR = { vertical: geo.Orientation.Bottom, horizontal: geo.Orientation.Right };
  const BL = { vertical: geo.Orientation.Bottom, horizontal: geo.Orientation.Left };

  const alignments = [TL, TR, BL, BR];

  const conflicts = markConflicts(ctx, byLevel);
  const minX = new Map();
  const maxX = new Map();
  let minWidth = Infinity;
  let minWidthAlignment = null;
  const xs = new Map();
  for (const d of alignments) {
    guard.step();
    minX.set(d, Infinity);
    maxX.set(d, -Infinity);
    const alignmentNodes = createAlignmentNodes(ctx, byLevel, d.vertical, d.horizontal);
    verticalAlignment(ctx, alignmentNodes, conflicts, d.horizontal);
    horizontalCompaction(ctx, alignmentNodes, d.horizontal);
    for (const n of alignmentNodes) {
      guard.step();
      const x = n.x + (n.root.blockSize / 2.0) - (n.graphNode.width / 2.0);
      if (!xs.has(n.placementNode)) xs.set(n.placementNode, []);
      xs.get(n.placementNode).push(x);
      minX.set(d, Math.min(minX.get(d), n.x));
      maxX.set(d, Math.max(maxX.get(d), n.x + n.blockSize));
    }
    const width = maxX.get(d) - minX.get(d);
    if (width < minWidth) {
      minWidth = width;
      minWidthAlignment = d;
    }
  }

  // balance
  const shift = new Map();
  for (const d of alignments) {
    guard.step();
    if (d.horizontal === geo.Orientation.Left) shift.set(d, minX.get(minWidthAlignment) - minX.get(d));
    else shift.set(d, maxX.get(minWidthAlignment) - maxX.get(d));
  }

  // final placement
  const updates = [];
  for (const [pn, x] of xs) {
    guard.step();
    for (let i = 0; i < xs.get(pn).length; i++) {
      guard.step();
      x[i] += shift.get(alignments[i]);
    }
    updates.push({ node: pn.graphNode, x: goRound(median(xs.get(pn))) });
  }
  guard.finish();
  for (const update of updates) update.node.topLeft.x = update.x;
  syncContainers(g, guard);
}

/** Reposition and resize containers based on the position of the aligned children. This routine goes from most to least nested container. */
function syncContainers(g, guard) {
  const containers = [];
  const queue = g.nodes.slice();
  for (let head = 0; head < queue.length; head++) {
    guard.step();
    const node = queue[head];
    if (node.isContainer()) {
      containers.push(node);
      for (const c of containersOf(g, node)) queue.push(c);
    }
  }

  // most nested containers are the last ones added to the list
  for (let i = containers.length - 1; i > -1; i--) {
    guard.step();
    containers[i].wrapChildren();
  }
  guard.finish();
}

function median(numbers) {
  if (numbers.length === 0) return 0;
  else if (numbers.length === 1) return numbers[0];

  const ordered = numbers.slice();
  ordered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (ordered.length % 2 === 1) return ordered[Math.trunc(ordered.length / 2)];

  const middle = Math.trunc(ordered.length / 2);
  return ordered[middle - 1] / 2 + ordered[middle] / 2;
}

/** alignmentNode embeds *placementNode: the promoted members are the getters below. */
class AlignmentNode {
  constructor(pn) {
    this.placementNode = pn;
    this.prevSibling = null;
    this.root = this;
    this.alignedWith = this;
    this.sink = this;
    this.medianNeighbors = null;
    this.shift = 0;
    this.x = 0;
    this.blockSize = pn.graphNode.width;
    this.rightPad = 0;
    this.leftPad = 0;
  }

  get graphNode() { return this.placementNode.graphNode; }
  get level() { return this.placementNode.level; }
  get rank() { return this.placementNode.rank; }
  get aboves() { return this.placementNode.aboves; }
  get belows() { return this.placementNode.belows; }
  get isDummy() { return this.placementNode.isDummy; }
  containerPadding() { return this.placementNode.containerPadding(); }
}

const newAlignmentNode = (pn) => new AlignmentNode(pn);

// Given layered nodes, creates a slice of alignment nodes sorted in the desired direction
function createAlignmentNodes(ctx, byLevel, vertical, horizontal) {
  const guard = limits.newWorkGuard(ctx, 'CreateAlignmentNodes', limits.MaxEngineWorkUnits);
  const placementToAlignment = new Map();
  const nodes = [];
  for (let l = 0; l < byLevel.size; l++) {
    guard.step();
    const leaves = leafNodesContext(byLevel.get(l), guard);
    for (const node of leaves) {
      guard.step();
      nodes.push(node);
      placementToAlignment.set(node.placementNode, node);
    }
  }

  sortAlignmentNodes(nodes, vertical, horizontal);
  guard.finish();

  let x = -Infinity;
  let shift = Infinity;
  if (horizontal === geo.Orientation.Right) {
    x = Infinity;
    shift = -Infinity;
  }
  let previous = null;
  for (const node of nodes) {
    guard.step();
    if (previous !== null && node.level !== previous.level) previous = null;
    const medianNeighbors = medianNeighborsContext(node, vertical, horizontal, placementToAlignment, guard);
    node.medianNeighbors = medianNeighbors;
    node.prevSibling = previous;
    node.x = x;
    node.shift = shift;
    previous = node;
  }
  guard.finish();
  return nodes;
}

const absInt = (a) => (a < 0 ? -a : a);

function leafNodesContext(nodes, guard) {
  let leaves = [];
  for (let i = 0; i < nodes.length; i++) {
    guard.step();
    const node = nodes[i];
    if (!node.isContainer) {
      leaves.push(newAlignmentNode(node));
      continue;
    }
    // Instead of picking a single 'middle' child, distribute container edges among children whose rank is closest to the other
    // endpoint's rank.
    const descendants = leafNodesContext(node.children, guard); // recursively collect leaf descendants

    const pickChildForEdge = (edgeEndpoint, possible) => {
      // simple heuristic: pick child with rank closest to edgeEndpoint's rank
      let best = possible[0];
      let minDiff = absInt(edgeEndpoint.rank - best.placementNode.rank);
      for (const cand of possible) {
        guard.step();
        const diff = absInt(edgeEndpoint.rank - cand.placementNode.rank);
        if (diff < minDiff) {
          minDiff = diff;
          best = cand;
        }
      }
      return best;
    };

    // rewire "aboves" from container to children
    for (const above of Array.from(node.aboves)) {
      guard.step();
      above.belows.delete(node);
      const bestChild = pickChildForEdge(above, descendants);
      above.belows.add(bestChild.placementNode);
      bestChild.aboves.add(above);
    }

    // rewire "belows" from container to children
    for (const below of Array.from(node.belows)) {
      guard.step();
      below.aboves.delete(node);
      const bestChild = pickChildForEdge(below, descendants);
      below.aboves.add(bestChild.placementNode);
      bestChild.belows.add(below);
    }

    // Add the descendants to the final leaves
    for (const d of descendants) leaves.push(d);
  }
  // we need to consider the container padding to properly align the nodes the first container child has the left pad and the last
  // one has the right pad this applied recursively (as this function is recursive) because we can have containers inside containers
  const leftNode = leaves[0];
  const rightNode = leaves[leaves.length - 1];
  leftNode.leftPad += leftNode.containerPadding().left;
  rightNode.rightPad += rightNode.containerPadding().right;
  return leaves;
}

function sortAlignmentNodes(nodes, vertical, horizontal) {
  if (vertical === geo.Orientation.Top && horizontal === geo.Orientation.Left) {
    sortSlice(nodes, (i, j) => {
      if (nodes[i].level === nodes[j].level) return nodes[i].rank < nodes[j].rank;
      return nodes[i].level < nodes[j].level;
    });
  } else if (vertical === geo.Orientation.Top && horizontal === geo.Orientation.Right) {
    sortSlice(nodes, (i, j) => {
      if (nodes[i].level === nodes[j].level) return nodes[j].rank < nodes[i].rank;
      return nodes[i].level < nodes[j].level;
    });
  } else if (vertical === geo.Orientation.Bottom && horizontal === geo.Orientation.Left) {
    sortSlice(nodes, (i, j) => {
      if (nodes[i].level === nodes[j].level) return nodes[i].rank < nodes[j].rank;
      return nodes[j].level < nodes[i].level;
    });
  } else if (vertical === geo.Orientation.Bottom && horizontal === geo.Orientation.Right) {
    sortSlice(nodes, (i, j) => {
      if (nodes[i].level === nodes[j].level) return nodes[j].rank < nodes[i].rank;
      return nodes[j].level < nodes[i].level;
    });
  }
}

function medianNeighborsContext(n, vertical, horizontal, placementToAlignment, guard) {
  const neighbors = [];

  if (vertical === geo.Orientation.Top) {
    for (const above of n.aboves) {
      guard.step();
      if (above.level === n.level - 1) neighbors.push(placementToAlignment.get(above));
    }
  } else {
    for (const below of n.belows) {
      guard.step();
      if (below.level === n.level + 1) neighbors.push(placementToAlignment.get(below));
    }
  }

  if (neighbors.length === 0) return neighbors;

  sortSlice(neighbors, (i, j) => neighbors[i].graphNode.topLeft.x < neighbors[j].graphNode.topLeft.x);

  const mid = (neighbors.length + 1) / 2.0;
  if (neighbors.length % 2 === 1) {
    // exact median
    const medianIndex = Math.trunc(mid) - 1;
    return [neighbors[medianIndex]];
  } else {
    // consider left and right median
    let leftMedian = Math.floor(mid) - 1;
    let rightMedian = Math.ceil(mid) - 1;
    if (horizontal === geo.Orientation.Right) {
      const t = leftMedian;
      leftMedian = rightMedian;
      rightMedian = t;
    }
    return [neighbors[leftMedian], neighbors[rightMedian]];
  }
}

function allAbove(pn) {
  const result = [];
  for (const above of pn.aboves) result.push(above);
  return result;
}

function markConflicts(ctx, byLevel) {
  const guard = limits.newWorkGuard(ctx, 'MarkHierarchyConflicts', limits.MaxEngineWorkUnits);
  const conflicts = new Map();
  const addConflict = (n1, n2) => {
    if (!conflicts.has(n1)) conflicts.set(n1, new Set());
    conflicts.get(n1).add(n2);
  };

  // skip the first and last level because there are no dummy nodes in them
  for (let level = 1; level < byLevel.size - 1; level++) {
    guard.step();
    const nextLevel = level + 1;
    let k0 = 0;
    let l = 0;
    const nextNodes = byLevel.get(nextLevel);
    for (let l1 = 0; l1 < nextNodes.length; l1++) {
      const pn = nextNodes[l1];
      guard.step();
      let k1 = 0;
      if (l1 === nextNodes.length - 1) {
        const last = byLevel.get(level).length - 1;
        k1 = byLevel.get(level)[last].rank;
      } else if (pn.isDummy) {
        for (const above of allAbove(pn)) {
          guard.step();
          // dummy nodes have only one edge above and one below
          if (!above.isDummy) continue;
          k1 = above.rank;
        }
      } else {
        continue;
      }
      for (; l <= l1; l++) {
        guard.step();
        const n = byLevel.get(nextLevel)[l];
        for (const above of n.aboves) {
          guard.step();
          if (above.rank < k0 || above.rank > k1) {
            addConflict(n, above);
            addConflict(above, n);
          }
        }
      }
      k0 = k1;
    }
  }

  guard.finish();
  return conflicts;
}

function verticalAlignment(ctx, nodes, conflicts, horizontal) {
  const guard = limits.newWorkGuard(ctx, 'VerticalAlignment', limits.MaxEngineWorkUnits);
  const hasConflict = (n1, n2) => {
    const c = conflicts.get(n1.placementNode);
    if (c !== undefined) return c.has(n2.placementNode);
    return false;
  };

  let lastAlignedRank = MaxInt;
  for (const n of nodes) {
    guard.step();
    // given a level with nodes a b c: when horizontal = Left a.previousSibling = nil, b.previousSibling = a, c.previousSibling = b;
    // when horizontal = Right a.previousSibling = b, b.previousSibling = c, c.previousSibling = nil.
    // This is how `createAlignmentNodes` creates the slice
    if (n.prevSibling === null) {
      if (horizontal === geo.Orientation.Left) lastAlignedRank = MinInt;
      else lastAlignedRank = MaxInt;
    }

    for (const m of n.medianNeighbors) {
      guard.step();
      if (hasConflict(n, m)) {
        continue;
      } else if (n.alignedWith !== n) {
        // already aligned
        continue;
      } else if (horizontal === geo.Orientation.Left && lastAlignedRank >= m.rank) {
        // this would align crossing edges, skip
        continue;
      } else if (horizontal === geo.Orientation.Right && lastAlignedRank <= m.rank) {
        // this would align crossing edges, skip
        continue;
      }
      m.alignedWith = n;
      n.root = m.root;
      n.alignedWith = n.root;
      m.root.blockSize = Math.max(m.root.blockSize, n.blockSize);
      m.root.leftPad = Math.max(m.root.leftPad, n.leftPad);
      m.root.rightPad = Math.max(m.root.rightPad, n.rightPad);
      lastAlignedRank = m.rank;
    }
  }
  guard.finish();
}

function horizontalCompaction(ctx, nodes, horizontalDirection) {
  const guard = limits.newWorkGuard(ctx, 'HorizontalCompaction', limits.MaxEngineWorkUnits);
  for (const n of nodes) {
    guard.step();
    if (n.root === n) placeBlock(n, horizontalDirection, guard);
  }
  for (const n of nodes) {
    guard.step();
    n.x = n.root.x;
    if (n.root === n && !(n.sink.shift === Infinity || n.sink.shift === -Infinity)) n.x += n.sink.shift;
  }
  guard.finish();
}

function placeBlock(root, horizontal, guard) {
  guard.step();
  if (!(root.x === Infinity || root.x === -Infinity)) return;
  root.x = 0;
  let n = root;
  for (;;) {
    guard.step();
    if (n.prevSibling !== null) {
      const prevRoot = n.prevSibling.root;
      placeBlock(prevRoot, horizontal, guard);
      if (root.sink === root) root.sink = prevRoot.sink;
      const delta = distanceFromPreviousRoot(prevRoot, root, horizontal);
      if (root.sink !== prevRoot.sink) {
        if (horizontal === geo.Orientation.Left) {
          prevRoot.sink.shift = Math.min(prevRoot.sink.shift, root.x - prevRoot.x - prevRoot.blockSize - delta);
        } else {
          prevRoot.sink.shift = Math.max(prevRoot.sink.shift, root.x - prevRoot.x + root.blockSize + delta);
        }
      } else {
        if (horizontal === geo.Orientation.Left) {
          root.x = Math.max(root.x, prevRoot.x + prevRoot.blockSize + delta);
        } else {
          root.x = Math.min(root.x, prevRoot.x - root.blockSize - delta);
        }
      }
    }
    n = n.alignedWith;
    if (n === root) break;
  }
}

/**
 * By default, nodes in hierarchies are siblingSpacing from their siblings. Though, when a node is inside a container, this distance
 * must be increased by the container padding. For the first node of a container, this pad is added to the left. For the last node
 * of a container, the pad is added to the right. The recursiveness of the pad (containers inside containers) is considered when
 * creating the node. This function only combines padding in the given direction.
 */
function distanceFromPreviousRoot(previous, current, horizontal) {
  let pad = siblingSpacing;
  if (current.isDummy || (current.prevSibling !== null && current.prevSibling.isDummy)) pad = siblingDummySpacing;
  if (horizontal === geo.Orientation.Left) pad += previous.rightPad + current.leftPad;
  else pad += previous.leftPad + current.rightPad;
  return pad;
}

// ---- compound.go ----

/**
 * PlaceCompound lays out the outer flow of detailed containers after their interiors have been placed and rescaled, but before edge
 * routing. It preserves every interior coordinate relative to its container, including local directions and specialized inner
 * layouts. The caller compares this complete candidate against ordinary placement; this stage is not an unconditional improvement.
 * Returns `changed`.
 */
export function placeCompound(ctx, g, random) {
  lg.validate(ctx, 'PlaceCompound', g);
  if (containersOf(g, null).length < 3 || containersOf(g, null).length > maxCompoundBlocks) return false;
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'PlaceCompoundTransactions');
  const proxy = lg.newGraph();
  proxy.directions.set(null, g.direction(null));
  const blocks = [];
  const byRoot = new Map();
  for (const root of containersOf(g, null)) {
    guard.step();
    const n = lg.newNode(root.id, root.width, root.height);
    n.topLeft = root.topLeft.copy();
    proxy.addNewNodeToContainer(null, n);
    const block = { original: root, proxy: n, members: [] };
    blocks.push(block);
    byRoot.set(root, block);
  }
  const owner = new Map();
  for (const node of g.nodes) {
    guard.step();
    // Absolute coordinates and active grouping vessels are not rigid-block input.
    if (node.fixedTopLeft !== null || g.isSequenceVessel(node) || node.isClusterVessel()) return false;
    let root = node;
    while (root.container !== null) {
      guard.step();
      root = root.container;
    }
    const block = byRoot.get(root) ?? null;
    if (block === null) return false;
    block.members.push(node);
    owner.set(node, block);
  }
  // Trees must already be restored into the ordinary node collection. A tree sentinel can be an authored node; it is safe to move
  // once all members exist.
  if (g.nodeToTree !== null) {
    for (const node of g.nodeToTree.keys()) {
      guard.step();
      if (!owner.has(node)) return false;
    }
  }
  const interfaces = [];
  let detailed = false;
  for (const edge of g.edges) {
    guard.step();
    const from = owner.get(edge.from) ?? null;
    const to = owner.get(edge.to) ?? null;
    if (from === null || to === null) return false;
    if (from === to) {
      detailed = detailed || (from.original.isContainer() && edge.from !== edge.to);
      continue;
    }
    if (interfaces.length === maxCompoundInterfaces) return false;
    const e = proxy.connect(from.proxy, to.proxy);
    e.id = edge.id;
    e.sourceArrowhead = edge.sourceArrowhead;
    e.targetArrowhead = edge.targetArrowhead;
    if (edge.label !== null) {
      const copied = Object.assign(Object.create(Object.getPrototypeOf(edge.label)), edge.label);
      e.label = copied;
    }
    interfaces.push({
      from, to,
      fromOffset: compoundEndpointOffset(edge.from, from.original, edge.fromTableColumnIndex),
      toOffset: compoundEndpointOffset(edge.to, to.original, edge.toTableColumnIndex),
    });
  }
  if (!detailed || !compoundConnected(blocks, interfaces)) return false;
  // The compactness heuristics for ordinary nodes do not decide whether rearranging these opaque blocks helps the completed
  // drawing. Rank only this isolated proxy, then retain the compound proposal's original directed backbone requirement. The caller
  // compares its finished route geometry.
  const outerHierarchy = build(ctx, proxy, true, candidates(proxy), null);
  if (outerHierarchy === null) return false;
  const [forward, other] = countEdgeDirection(outerHierarchy, proxy);
  if (outerHierarchy.levelCount < 2 || forward === 0 || forward < 1.5 * other) return false;
  for (const node of proxy.nodes) {
    guard.step();
    node.hierarchy = outerHierarchy;
  }
  place(ctx, proxy, null, random);
  orderCompoundInterfaces(blocks, interfaces, geo.isHorizontal(proxy.direction(null)), guard);
  const [tl, br] = lg.Nodes.boundingBox(proxy.nodes);
  if (br.x - tl.x > limits.MaxGraphSize || br.y - tl.y > limits.MaxGraphSize) return false;
  // All planning is isolated. Snapshot only when there is an applicable plan, and keep mutations atomic even if cancellation arrives
  // during rigid translation.
  const state = lg.newGraphStateSnapshot({ captureTopology: true, captureEdgeRoutes: true });
  state.updateWithWorkGuard(g, guard);
  const rollback = new lg.Transaction();
  rollback.graph = g;
  rollback.priorGraphState = state;
  let complete = false;
  try {
    const [originalTL] = lg.Nodes.boundingBox(containersOf(g, null));
    const h = lg.newHierarchy();
    h.levelCount = proxy.nodes[0].hierarchy.levelCount;
    for (const block of blocks) {
      guard.step();
      const dx = block.proxy.topLeft.x - tl.x + originalTL.x - block.original.topLeft.x;
      const dy = block.proxy.topLeft.y - tl.y + originalTL.y - block.original.topLeft.y;
      for (const member of block.members) {
        guard.step();
        member.translate(dx, dy);
      }
      // Only the opaque block belongs to the outer hierarchy. Its descendants retain their own hierarchy and rank, rather than
      // being flattened into one row.
      const previous = block.original.hierarchy;
      if (previous !== null) previous.levels().delete(block.original);
      block.original.hierarchy = h;
      h.levels().set(block.original, hierarchyLevel(block.proxy));
    }
    guard.finish();
    complete = true;
  } finally {
    if (!complete) rollback.rollback();
  }
  return true;
}

function compoundEndpointOffset(endpoint, block, column) {
  let center = endpoint.center();
  if (column !== null) {
    const [port, ok] = nodeshape.tableColumnPortValue(endpoint.shape, geo.Orientation.Right, column);
    if (ok) center = port;
  }
  return new geo.Point(Math.max(0, Math.min(block.width, center.x - block.topLeft.x)), Math.max(0, Math.min(block.height, center.y - block.topLeft.y)));
}

function compoundConnected(blocks, interfaces) {
  const adjacent = new Map();
  for (const edge of interfaces) {
    if (!adjacent.has(edge.from)) adjacent.set(edge.from, []);
    adjacent.get(edge.from).push(edge.to);
    if (!adjacent.has(edge.to)) adjacent.set(edge.to, []);
    adjacent.get(edge.to).push(edge.from);
  }
  const seen = new Map([[blocks[0], true]]);
  const queue = [blocks[0]];
  while (queue.length > 0) {
    const block = queue.shift();
    for (const next of adjacent.get(block) ?? []) {
      if (!seen.get(next)) {
        seen.set(next, true);
        queue.push(next);
      }
    }
  }
  return seen.size === blocks.length;
}

/**
 * orderCompoundInterfaces refines the center-based layered ordering using actual boundary offsets. At most two adjacent-swap sweeps
 * are attempted. Blocks keep their rank and size, so accepted swaps cannot introduce node overlap.
 */
function orderCompoundInterfaces(blocks, interfaces, horizontal, guard) {
  const levels = new Map();
  for (const block of blocks) {
    const level = hierarchyLevel(block.proxy);
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(block);
  }
  // returns [object holding the coordinate, key of the coordinate, size]: Go returns a *float64 into the proxy's TopLeft
  const coordinates = (b) => {
    if (horizontal) return [b.proxy.topLeft, 'y', b.proxy.height];
    return [b.proxy.topLeft, 'x', b.proxy.width];
  };
  for (let level = 0; level < blocks[0].proxy.hierarchy.levelCount; level++) {
    const row = levels.get(level) ?? [];
    slicesSortFunc(row, (a, b) => {
      const [ao, ak] = coordinates(a);
      const [bo, bk] = coordinates(b);
      const ax = ao[ak];
      const bx = bo[bk];
      if (ax < bx) return -1;
      if (ax > bx) return 1;
      return 0;
    });
    levels.set(level, row);
  }
  let score = compoundInterfaceScore(interfaces, horizontal, guard);
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let level = 0; level < blocks[0].proxy.hierarchy.levelCount; level++) {
      const row = levels.get(level) ?? [];
      for (let i = 0; i + 1 < row.length; i++) {
        guard.step();
        const a = row[i];
        const b = row[i + 1];
        const [ao, ak, aw] = coordinates(a);
        const [bo, bk, bw] = coordinates(b);
        const oldA = ao[ak];
        const oldB = bo[bk];
        ao[ak] = oldB + bw - aw;
        bo[bk] = oldA;
        const candidate = compoundInterfaceScore(interfaces, horizontal, guard);
        if (candidate.crossings < score.crossings || (candidate.crossings === score.crossings && candidate.span < score.span)) {
          score = candidate;
          row[i] = b;
          row[i + 1] = a;
          improved = true;
        } else {
          ao[ak] = oldA;
          bo[bk] = oldB;
        }
      }
    }
    if (!improved) break;
  }
  guard.finish();
}

function compoundInterfaceScore(interfaces, horizontal, guard) {
  const score = { crossings: 0, span: 0 };
  const segments = new Array(interfaces.length);
  for (let i = 0; i < interfaces.length; i++) {
    const edge = interfaces[i];
    guard.step();
    const from = edge.from.proxy;
    const to = edge.to.proxy;
    const a = new geo.Point(from.topLeft.x + edge.fromOffset.x, from.topLeft.y + edge.fromOffset.y);
    const b = new geo.Point(to.topLeft.x + edge.toOffset.x, to.topLeft.y + edge.toOffset.y);
    if (horizontal) {
      if (from.center().x < to.center().x) {
        a.x = from.topLeft.x + from.width;
        b.x = to.topLeft.x;
      } else {
        a.x = from.topLeft.x;
        b.x = to.topLeft.x + to.width;
      }
      score.span += Math.abs(a.y - b.y);
    } else {
      if (from.center().y < to.center().y) {
        a.y = from.topLeft.y + from.height;
        b.y = to.topLeft.y;
      } else {
        a.y = from.topLeft.y;
        b.y = to.topLeft.y + to.height;
      }
      score.span += Math.abs(a.x - b.x);
    }
    segments[i] = { a, b };
  }
  const orientation = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    for (const b of segments.slice(i + 1)) {
      guard.step();
      if (orientation(a.a, a.b, b.a) * orientation(a.a, a.b, b.b) < 0 && orientation(b.a, b.b, a.a) * orientation(b.a, b.b, a.b) < 0) score.crossings++;
    }
  }
  return score;
}
