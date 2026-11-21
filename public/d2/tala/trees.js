// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/trees (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022 Terrastruct
// Inc.): TALA's tree discovery, preprocessing, orientation and placement. The graph records themselves (Tree) live in layoutgraph.js.
// Files of the Go package: types.go, traversal.go, preprocess_helpers.go, layout.go, geometry.go (in this order).
//
// Go semantics kept on purpose: `for range` over a slice uses the length it had at loop start (arrays are copied where the body appends
// to the same list), slices.Backward walks from the last element, Go's map iteration order is random where the Go code ranges over a
// map: the only such place that is observable is documented at buildPlacementTrees.

import * as geo from '../geo.js';
import { goRound as goRoundTrees } from '../gomath.js';
import * as label from '../label.js';
import { errorf, GoError } from './goerrors.js';
import * as invariant from './invariant.js';
import * as lg from './layoutgraph.js';
import * as limits from './limits.js';
import { sortFunc, compare } from './goslices.js';

const { Orientation } = geo;

// ============================== types.go ==============================

export const Outwards = 'Outwards';
export const Inwards = 'Inwards';
export const Bidirectional = 'Bidirectional';
export const Undirected = 'Undirected';

const newWorkGuard = (ctx, location) => limits.newWorkGuard(ctx, location, limits.MaxEngineWorkUnits);

/** treeEdgeDirection determines whether edge points from node toward its sentinel, toward node, in both directions, or in neither direction. */
function treeEdgeDirection(node, edge) {
  if (edge.isBidirectional()) return Bidirectional;
  if (edge.isUndirected()) return Undirected;
  if (edge.to === node) return Inwards;
  return Outwards;
}

// ============================== traversal.go ==============================

/** Descendants returns tree descendants in the breadth-first order used when restored tree nodes and edges are copied back into an owning graph. */
export function descendants(root) {
  if (root === null) return [];
  const out = [];
  const queue = [root];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const child of current.children) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

// ============================== preprocess_helpers.go ==============================

const treePreprocessLocation = 'PreprocessTrees';

const treePreprocessBadState = (message) => invariant.errorf(message);

/**
 * treeContainerRDFSOrder is the bounded, iterative equivalent of containerRDFSOrder. The stack is populated in forward slice order so
 * its LIFO traversal preserves the existing reverse-DFS output order exactly.
 */
function treeContainerRDFSOrder(g, root, guard) {
  if (root !== null && !root.isContainer()) return [];

  const stack = [];
  for (const child of g.containers.get(root) ?? []) {
    guard.step();
    stack.push({ node: child, emit: false });
  }

  const order = [];
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current.node === null) throw treePreprocessBadState('tree preprocessing encountered a nil container child');
    if (current.emit) {
      order.push(current.node);
      continue;
    }

    if (current.node.isContainer()) {
      stack.push({ node: current.node, emit: true });
      for (const child of g.containers.get(current.node) ?? []) {
        guard.step();
        stack.push({ node: child, emit: false });
      }
      continue;
    }

    if (current.node.isClusterVessel()) {
      const cluster = g.clusters.get(current.node) ?? null;
      if (cluster === null) throw treePreprocessBadState(`cluster vessel ${current.node.id} has no cluster record`);
      for (const clusterNode of cluster.nodes) {
        guard.step();
        if (clusterNode === null) throw treePreprocessBadState(`cluster vessel ${current.node.id} contains a nil node`);
        if (clusterNode.isContainer()) stack.push({ node: clusterNode, emit: false });
      }
    }
  }
  return order;
}

function buildTreeAdjacencyMatrix(g, guard) {
  const fromNodeToToNodeToEdge = new Map();
  for (const edge of g.edges) {
    guard.step();
    if (edge === null || edge.from === null || edge.to === null) {
      throw treePreprocessBadState('tree preprocessing encountered an edge with missing endpoints');
    }
    if (!fromNodeToToNodeToEdge.has(edge.from)) fromNodeToToNodeToEdge.set(edge.from, new Map());
    fromNodeToToNodeToEdge.get(edge.from).set(edge.to, edge);
  }
  return (a, b) => {
    let edge = fromNodeToToNodeToEdge.get(a)?.get(b);
    if (edge === undefined) edge = fromNodeToToNodeToEdge.get(b)?.get(a);
    return edge === undefined ? null : edge;
  };
}

function treeFringeNodes(nodes, guard) {
  const inSet = new Set();
  for (const node of nodes) {
    guard.step();
    if (node === null) throw treePreprocessBadState('tree preprocessing encountered a nil node');
    inSet.add(node);
  }

  const fringeNodes = [];
  for (const node of nodes) {
    guard.step();
    if (node.edges.length !== 1) continue;
    const edge = node.edges[0];
    if (edge === null || (edge.from !== node && edge.to !== node)) {
      throw treePreprocessBadState(`node ${node.id} contains a non-incident fringe edge`);
    }
    const adjacent = node.adjacent(edge);
    if (inSet.has(adjacent)) fringeNodes.push(node);
  }
  return fringeNodes;
}

function filterTerminalTrees(trees, terminals, guard) {
  const filtered = [];
  for (const tree of trees) {
    guard.step();
    if (tree === null || tree.node === null) throw treePreprocessBadState('tree preprocessing encountered a tree without a node');
    if (!terminals.has(tree.node)) filtered.push(tree);
  }
  return filtered;
}

/**
 * dominantTreeEdgeDirection preserves the recursive helper's preorder search: the first non-undirected sentinel direction wins,
 * otherwise the root's undirected direction is returned.
 */
function dominantTreeEdgeDirection(root, includeRoot, guard) {
  if (root === null || root.node === null) throw treePreprocessBadState('tree preprocessing encountered an incomplete tree');
  if (root.sentinelEdge === null) throw treePreprocessBadState(`tree node ${root.node.id} has no sentinel edge`);

  const stack = [];
  if (includeRoot) {
    stack.push(root);
  } else {
    for (let i = root.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(root.children[i]);
    }
  }
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null || current.sentinelEdge === null) {
      throw treePreprocessBadState('tree preprocessing encountered an incomplete tree');
    }
    if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a repeated tree node');
    seen.add(current);
    const direction = treeEdgeDirection(current.node, current.sentinelEdge);
    if (direction !== Undirected) return direction;
    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
  return treeEdgeDirection(root.node, root.sentinelEdge);
}

/** Map<direction, count> in first-seen order */
function countTreeDirections(trees, guard) {
  const directionCounts = new Map();
  for (const tree of trees) {
    guard.step();
    const direction = dominantTreeEdgeDirection(tree, true, guard);
    directionCounts.set(direction, (directionCounts.get(direction) ?? 0) + 1);
  }
  return directionCounts;
}

function candidateTreeRoots(roots, guard) {
  const rootsByDirection = new Map();
  for (const root of roots) {
    guard.step();
    const direction = dominantTreeEdgeDirection(root, false, guard);
    if (!rootsByDirection.has(direction)) rootsByDirection.set(direction, []);
    rootsByDirection.get(direction).push(root);
  }
  const of = (d) => rootsByDirection.get(d) ?? [];

  const nOutwards = of(Outwards).length;
  const nInwards = of(Inwards).length;
  const nBidirectional = of(Bidirectional).length;
  const nUndirected = of(Undirected).length;
  const candidates = [];
  const appendRoots = (values) => {
    for (const value of values) {
      guard.step();
      candidates.push(value);
    }
  };
  if (nOutwards === 1 && 1 + nInwards + nUndirected === roots.length) appendRoots(of(Outwards));
  if (nInwards === 1 && 1 + nOutwards + nUndirected === roots.length) appendRoots(of(Inwards));
  if (nUndirected > 0 && nOutwards > 1 && nUndirected + nOutwards === roots.length) appendRoots(of(Undirected));
  if (nUndirected > 0 && nInwards > 1 && nUndirected + nInwards === roots.length) appendRoots(of(Undirected));
  if (nBidirectional + nUndirected === roots.length) {
    appendRoots(of(Bidirectional));
    appendRoots(of(Undirected));
  }
  guard.check();
  return candidates;
}

/** the leaf at the end of a chain, or null when the tree branches */
function treeEndOfLine(root, guard) {
  const seen = new Set();
  let current = root;
  for (;;) {
    guard.step();
    if (current === null) throw treePreprocessBadState('tree preprocessing encountered a nil tree');
    if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a tree cycle');
    seen.add(current);
    switch (current.children.length) {
      case 0: return current;
      case 1: current = current.children[0]; break;
      default: return null;
    }
  }
}

function removeTreeChild(parent, child, guard) {
  const filtered = [];
  for (const current of parent.children) {
    guard.step();
    if (current !== child) filtered.push(current);
  }
  parent.children = filtered;
}

function addTreeChild(parent, child, guard) {
  if (parent === null || child === null) throw treePreprocessBadState('tree preprocessing cannot connect a nil tree');
  if (child.parent !== null) removeTreeChild(child.parent, child, guard);
  guard.step();
  child.parent = parent;
  parent.children.push(child);
}

function reverseTreeChain(root, guard) {
  if (root === null) throw treePreprocessBadState('tree preprocessing cannot reverse a nil tree');
  const chain = [root];
  const seen = new Set();
  let current = root;
  while (current.children.length > 0) {
    guard.step();
    if (current.children.length !== 1) throw treePreprocessBadState('tree preprocessing attempted to reverse a branching tree');
    if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a tree cycle');
    seen.add(current);
    const next = current.children[0];
    if (next === null) throw treePreprocessBadState('tree preprocessing encountered a nil tree child');
    current.sentinelEdge = next.sentinelEdge;
    next.sentinelEdge = null;
    removeTreeChild(current, next, guard);
    chain.push(next);
    current = next;
  }
  for (let i = chain.length - 1; i > 0; i--) addTreeChild(chain[i], chain[i - 1], guard);
}

function treeBranches(root, guard) {
  const seen = new Set();
  let current = root;
  for (;;) {
    guard.step();
    if (current === null) throw treePreprocessBadState('tree preprocessing encountered a nil tree');
    if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a tree cycle');
    seen.add(current);
    switch (current.children.length) {
      case 0: return false;
      case 1: current = current.children[0]; break;
      default: return true;
    }
  }
}

function treeSize(root, guard) {
  if (root === null) throw treePreprocessBadState('tree preprocessing cannot size a nil tree');
  const stack = [root];
  const seen = new Set();
  let size = 0;
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null) throw treePreprocessBadState('tree preprocessing encountered an incomplete tree');
    if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a repeated tree node');
    seen.add(current);
    size++;
    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
  return size;
}

function treeDescendants(root, guard) {
  if (root === null) throw treePreprocessBadState('tree preprocessing cannot traverse a nil tree');
  const out = [];
  const queue = [root];
  const seen = new Set();
  for (let index = 0; index < queue.length; index++) {
    guard.step();
    const current = queue[index];
    if (current === null || current.node === null) throw treePreprocessBadState('tree preprocessing encountered an incomplete tree');
    if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a repeated tree node');
    seen.add(current);
    for (const child of current.children) {
      guard.step();
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Map<direction, Tree[]> */
function rootsByTreeDirection(treeRoots, guard) {
  const rootsByDirection = new Map();
  for (const root of treeRoots) {
    guard.step();
    const direction = dominantTreeEdgeDirection(root, false, guard);
    if (!rootsByDirection.has(direction)) rootsByDirection.set(direction, []);
    rootsByDirection.get(direction).push(root);
  }
  return rootsByDirection;
}

function removeNodeFromGraph(node, graph, guard) {
  if (graph.nodes.length === 0) throw treePreprocessBadState(`node ${node.id} is missing from the graph`);
  const newNodes = [];
  let found = false;
  for (const current of graph.nodes) {
    guard.step();
    if (current === node) {
      found = true;
      continue;
    }
    newNodes.push(current);
  }
  if (!found) throw treePreprocessBadState(`node ${node.id} is missing from the graph`);
  graph.nodes = newNodes;
}

function removeEdgeFromNode(node, edge, guard) {
  for (let i = 0; i < node.edges.length; i++) {
    guard.step();
    if (node.edges[i] === edge) {
      node.edges.splice(i, 1);
      return;
    }
  }
  throw treePreprocessBadState(`edge ${edge.id} is missing from node ${node.id}`);
}

function disconnectTreeEdge(graph, edge, guard) {
  if (edge === null || edge.from === null || edge.to === null) throw treePreprocessBadState('tree preprocessing cannot disconnect an incomplete edge');
  removeEdgeFromNode(edge.from, edge, guard);
  if (edge.to !== edge.from) {
    removeEdgeFromNode(edge.to, edge, guard);
  } else {
    // Disconnect historically calls removeEdge for each endpoint even on a
    // self-loop. Preserve the second removal only when a duplicate exists.
    for (const current of edge.to.edges.slice()) {
      guard.step();
      if (current === edge) {
        removeEdgeFromNode(edge.to, edge, guard);
        break;
      }
    }
  }

  const newEdges = [];
  let found = false;
  for (const current of graph.edges) {
    guard.step();
    if (current === edge) {
      found = true;
      continue;
    }
    newEdges.push(current);
  }
  if (!found) throw treePreprocessBadState(`edge ${edge.id} is missing from the graph`);
  graph.edges = newEdges;
}

function removeNodeFromContainer(graph, container, node, guard) {
  const filtered = [];
  let found = false;
  for (const current of graph.containers.get(container) ?? []) {
    guard.step();
    if (current === node) {
      found = true;
      continue;
    }
    filtered.push(current);
  }
  if (!found) throw treePreprocessBadState(`node ${node.id} is missing from its tree container`);
  graph.containers.set(container, filtered);
}

function reconnectTreeGuarded(g, tree, container, guard) {
  if (tree === null) throw treePreprocessBadState('tree preprocessing cannot reconnect a nil tree');
  const stack = [tree];
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null) throw treePreprocessBadState('tree preprocessing encountered an incomplete tree');
    if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a repeated tree node');
    seen.add(current);

    if (current.parent !== null) {
      const edge = current.sentinelEdge;
      if (edge === null || edge.from === null || edge.to === null) {
        throw treePreprocessBadState(`tree node ${current.node.id} has no complete sentinel edge`);
      }
      g.addNodeUnchecked(current.node);
      g.addNodeToContainer(container, current.node);
      edge.from.addIncidentEdgeUnchecked(edge);
      edge.to.addIncidentEdgeUnchecked(edge);
      g.edges.push(edge);
      guard.step();
    }

    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
}

function isIsolatedTreeGuarded(g, node, guard) {
  if (node === null) throw treePreprocessBadState('tree preprocessing encountered a nil tree sentinel');
  if (node.isContainer()) return false;
  for (const edge of node.edges) {
    guard.step();
    let isToTree = false;
    for (const root of g.trees.get(node) ?? []) {
      guard.step();
      if (root !== null && edge === root.sentinelEdge) {
        isToTree = true;
        break;
      }
    }
    if (!isToTree) return false;
  }
  return true;
}

function buildNodeToTreeGuarded(g, guard) {
  const nodeToTree = new Map();
  const order = [];
  for (const rootSentinel of g.trees.keys()) {
    guard.step();
    order.push(rootSentinel);
  }
  lg.sortNodesByID(order);
  guard.check();
  for (const rootSentinel of order) {
    guard.step();
    for (const root of g.trees.get(rootSentinel)) {
      if (root === null || root.node === null) throw treePreprocessBadState('tree sentinel contains an incomplete root');
      const queue = [root];
      const seen = new Set();
      for (let index = 0; index < queue.length; index++) {
        guard.step();
        const current = queue[index];
        if (current === null || current.node === null) throw treePreprocessBadState('tree preprocessing encountered an incomplete tree');
        if (seen.has(current)) throw treePreprocessBadState('tree preprocessing encountered a repeated tree node');
        seen.add(current);
        nodeToTree.set(current.node, current);
        for (const child of current.children) {
          guard.step();
          queue.push(child);
        }
      }
    }
  }
  g.nodeToTree = nodeToTree;
  guard.check();
}

// ============================== layout.go ==============================

/** Map<Node, Tree[]> of the terminal (sentinel) nodes of the trees found in one container, or null when the container has a table */
function extractTreesInContainer(g, container, guard) {
  const containerNodes = g.containers.get(container) ?? [];
  const nodeToTree = new Map();
  for (const node of containerNodes) {
    guard.step();
    if (node === null) throw treePreprocessBadState('tree container contains a nil node');
    if (node.isTable()) return null;
    nodeToTree.set(node, lg.newTree(node));
  }
  // TODO: Compare this adjacency matrix with repeated ConnectionTo lookups.
  const edgeBetween = buildTreeAdjacencyMatrix(g, guard);

  // Terminal node: tree never reaches here, but roots can connect to graph here
  // Sentinel node: the node that a tree root is connected to
  const isTerminal = new Map();
  const sentinelToTreeRoots = new Map();
  const sentinelToArrowheads = new Map();

  // mark all containers as terminal so they aren't in trees
  for (const c of g.containers.keys()) {
    guard.step();
    isTerminal.set(c, true);
  }
  for (const vessel of g.sequences.keys()) {
    guard.step();
    isTerminal.set(vessel, true);
  }
  // if node has Nears, don't put it in a tree since placement doesn't work with both Nears and Trees
  // TODO: place trees early enough that they are restored before Near placement.
  for (const n of g.nodes) {
    guard.step();
    if (n.nears.size > 0 || n.fixedTopLeft !== null) isTerminal.set(n, true);
  }

  for (;;) {
    const fringeNodes = [];
    const candidates = treeFringeNodes(containerNodes, guard);
    for (const fn of candidates) {
      guard.step();
      if (!isTerminal.has(fn)) fringeNodes.push(fn);
    }
    if (fringeNodes.length === 0) break;

    for (const fn of fringeNodes) {
      guard.step();
      // Note: fn can be marked terminal if it is the sentinel of another fringe node
      // in this set which has its incoming edge directions not matching the sentinel edge
      if (isTerminal.has(fn)) continue;

      if (fn.edges.length !== 1 || fn.edges[0] === null) throw treePreprocessBadState(`fringe node ${fn.id} has invalid degree`);
      const sentinelNode = fn.adjacent(fn.edges[0]);
      if (sentinelNode === null) throw treePreprocessBadState(`fringe node ${fn.id} has no sentinel`);
      // if there are a pair of fringe nodes remaining, mark the first one as terminal and continue
      // otherwise both will have their tree nodes as children of each other
      if (sentinelNode.edges.length === 1 && sentinelNode.adjacent(sentinelNode.edges[0]) === fn) {
        if (!isTerminal.has(sentinelNode)) {
          isTerminal.set(fn, true);
          continue;
        }
      }
      const tree = nodeToTree.get(fn) ?? null;
      if (tree === null) throw treePreprocessBadState(`fringe node ${fn.id} has no tree record`);
      tree.sentinelEdge = edgeBetween(fn, sentinelNode);
      if (tree.sentinelEdge === null) throw treePreprocessBadState(`fringe node ${fn.id} has no graph sentinel edge`);

      if (!sentinelToTreeRoots.has(sentinelNode)) {
        sentinelToTreeRoots.set(sentinelNode, []);
        sentinelToArrowheads.set(sentinelNode, new Set());
      }

      const ah = tree.sentinelEdge.arrowheadTo(sentinelNode);

      sentinelToTreeRoots.get(sentinelNode).push(tree);
      sentinelToArrowheads.get(sentinelNode).add(ah);

      if (sentinelToTreeRoots.has(fn)) {
        // Note: treeRoots may contain a terminal node if a root was marked from another direction leading to it
        const treeRoots = filterTerminalTrees(sentinelToTreeRoots.get(fn), isTerminal, guard);
        if (treeRoots.length === 0) continue;
        const directionCounts = countTreeDirections(treeRoots, guard);
        // the fringe node is terminal if it has incoming edges with more than one direction
        // or multiple different arrowheads
        const fnArrowheads = sentinelToArrowheads.get(fn); // (nil map in Go has length 0: it is set whenever sentinelToTreeRoots has fn)
        if (directionCounts.size > 1 || (fnArrowheads === undefined ? 0 : fnArrowheads.size) > 1) {
          isTerminal.set(fn, true);
        } else {
          // merge the roots with the fringe node tree
          for (const t of treeRoots) addTreeChild(tree, t, guard);

          const hasUndirected = directionCounts.has(Undirected);
          const sentinelEdgeDirection = treeEdgeDirection(fn, tree.sentinelEdge);
          const hasSentinelDirection = directionCounts.has(sentinelEdgeDirection);
          // sentinel node is terminal if the fringe node's incoming edges don't match the edge to the sentinel node
          // a directed edge can merge with Undirected edges and an Undirected edge can merge with matching directed edges
          const sentinelIsTerminal = !(hasUndirected || sentinelEdgeDirection === Undirected) && !hasSentinelDirection;

          if (sentinelIsTerminal) isTerminal.set(sentinelNode, true);
        }
      }
    }

    for (const fn of fringeNodes) {
      guard.step();
      if (!isTerminal.has(fn)) {
        removeNodeFromGraph(fn, g, guard);
        disconnectTreeEdge(g, nodeToTree.get(fn).sentinelEdge, guard);
        // remove node from container to children map
        removeNodeFromContainer(g, container, fn, guard);
      }
    }
  }

  const terminalNodeToTreeRoots = new Map();
  // Note: sentinelToTreeRoots will only have nodes in this container, but can contain nodes in the tree.
  // by iterating over g.Nodes, we only consider the nodes remaining in the graph, and by checking
  // sentinelToTreeRoots, we get the tree roots connected to the nodes remaining in the graph
  for (const node of g.nodes) {
    guard.step();
    if (sentinelToTreeRoots.has(node)) {
      const filteredRoots = filterTerminalTrees(sentinelToTreeRoots.get(node), isTerminal, guard);
      if (filteredRoots.length === 0) continue;
      // if the sentinel is a sequence, we must keep it as is since it can't be inside the tree
      if (g.sequences.has(node)) {
        terminalNodeToTreeRoots.set(node, filteredRoots);
      } else {
        const [rootSentinel, roots] = handleTreeSubgraph(g, node, container, filteredRoots, guard);
        terminalNodeToTreeRoots.set(rootSentinel, roots);
      }
    }
  }

  guard.check();
  return terminalNodeToTreeRoots;
}

function extractTrees(g, guard) {
  // extract trees in the base graph (nil container) and in all containers
  const terminalNodeToTreeRoots = new Map();
  // TODO: investigate why this has to be in RDFSOrder
  const containerOrder = treeContainerRDFSOrder(g, null, guard);
  containerOrder.push(null);
  for (const container of containerOrder) {
    guard.step();
    const containerTrees = extractTreesInContainer(g, container, guard);
    if (containerTrees !== null) {
      for (const [rootSentinel, roots] of containerTrees) {
        guard.step();
        terminalNodeToTreeRoots.set(rootSentinel, roots);
      }
    }
  }
  return terminalNodeToTreeRoots;
}

/**
 * handleTreeSubgraph merges tree parts that share an internal root sentinel. Entire tree subgraphs can produce multiple parts because
 * extraction assumes every tree is attached to a non-tree core. Returns [rootSentinel, roots].
 */
function handleTreeSubgraph(g, rootSentinel, container, roots, guard) {
  // if rootSentinel has connections after extract trees it isn't a subgraph,
  //  and if there isn't more than 1 tree root there aren't any parts to merge
  if (!(rootSentinel.edges.length === 0 && roots.length > 1)) return [rootSentinel, roots];
  if (rootSentinel.isContainer()) return [rootSentinel, roots];

  let newRootSentinel = null;
  let newTreeRoot = null;
  // Of the roots connecting to rootSentinel, each can only possibly lead to the root of a merged tree if
  //   the directions are valid for a tree.
  // e.g. with 1 root via an outward edge and 2 roots via inward edges,
  //   only the outward edge root could possibly lead to the root of a single merged tree.
  const candidateRoots = candidateTreeRoots(roots, guard);
  for (const candidateRoot of candidateRoots) {
    guard.step();
    // if the root tree is a line, then it can be the merged tree root
    const newRoot = treeEndOfLine(candidateRoot, guard);
    if (newRoot !== null) {
      // We just need to join the other roots as children of a new Tree for rootSentinel,
      const jointNode = lg.newTree(rootSentinel);
      for (const otherRoot of roots) {
        guard.step();
        if (otherRoot !== newRoot) addTreeChild(jointNode, otherRoot, guard);
      }

      // Note: the root's Sentinel Edge is overwritten by reversing the chain, so we have to record it beforehand
      const edgeToRootSentinel = candidateRoot.sentinelEdge;
      //   flip the tree nodes along the root,
      reverseTreeChain(candidateRoot, guard);
      //   and connect the node and the flipped chain together.
      addTreeChild(candidateRoot, jointNode, guard);
      jointNode.sentinelEdge = edgeToRootSentinel;

      newRootSentinel = newRoot.node;
      newTreeRoot = newRoot.children[0];
      newTreeRoot.parent = null;
      break;
    }
  }

  if (newRootSentinel !== null && newTreeRoot !== null) {
    removeNodeFromGraph(rootSentinel, g, guard);
    g.addNodeUnchecked(newRootSentinel);
    guard.step();

    const filtered = [];
    for (const n of g.containers.get(container) ?? []) {
      guard.step();
      if (n === rootSentinel) continue;
      filtered.push(n);
    }
    filtered.push(newRootSentinel);
    g.containers.set(container, filtered);

    return [newRootSentinel, [newTreeRoot]];
  }
  return [rootSentinel, roots];
}

/**
 * prepare tree for operation defined to Bottom, when we want it to work for the provided orientation
 * Note: must also call after the operation to cancel out the effects of this function
 */
function invertOrientationToBottom(t, orientation, guard) {
  switch (orientation) {
    case Orientation.Top:
      flip(t, guard);
      return;
    case Orientation.Right:
      swapDimensions(t, guard);
      return;
    case Orientation.Left:
      swapDimensions(t, guard);
      flip(t, guard);
      return;
  }
  guard.check();
}

function constructToOrientation(placementTree, orientation, guard) {
  setOrientation(placementTree, orientation, guard);
  invertOrientationToBottom(placementTree, orientation, guard);
  layoutTree(placementTree, guard);
  centerAlignChildren(placementTree, guard);
  invertOrientationToBottom(placementTree, orientation, guard);
}

function treePlacementFixedOrigin(g, container, guard) {
  for (const node of g.nodes) {
    guard.step();
    if (node === null) throw treePreprocessBadState('tree placement encountered a nil graph node');
    if (lg.effectiveContainer(node) !== container) continue;
    const point = node.fixedOrigin();
    if (point !== null) return point;
  }
  return null;
}

function placeAtOrientationGuarded(ctx, g, placementTree, orientation, guard) {
  ctx = lg.contextWithTransactionWorkGuard(ctx, guard);
  if (placementTree === null || placementTree.node === null || placementTree.node.topLeft === null) {
    throw treePreprocessBadState('tree placement encountered an incomplete placement tree');
  }
  guard.finish();
  const positionOf = (n) => {
    switch (orientation) {
      case Orientation.Left: return n.topLeft.x;
      case Orientation.Right: return n.topLeft.x + n.width;
      case Orientation.Top: return n.topLeft.y;
      default: return n.topLeft.y + n.height;
    }
  };
  const moveTree = (from, to) => {
    let dx = 0.0;
    let dy = 0.0;
    if (orientation === Orientation.Left || orientation === Orientation.Right) dx = Math.round(to - from);
    else if (orientation === Orientation.Top || orientation === Orientation.Bottom) dy = Math.round(to - from);
    for (const child of placementTree.children) {
      guard.step();
      offsetSubtree(child, dx, dy, guard);
    }
    guard.finish();
  };
  const isFurtherOut = (a, b) => {
    if (orientation === Orientation.Left || orientation === Orientation.Top) return a < b;
    return a > b;
  };

  // 0. Find the root position and border position
  const rootPosition = positionOf(placementTree.node);
  let borderPosition = rootPosition;
  const descendants_ = treeDescendants(placementTree, guard);
  const isNodeOfTree = new Set();
  isNodeOfTree.add(placementTree.node);
  for (const descendant of descendants_) {
    guard.step();
    isNodeOfTree.add(descendant.node);
  }
  for (const n of g.nodes) {
    guard.step();
    if (n === null || n.topLeft === null) throw treePreprocessBadState('tree placement encountered an incomplete graph node');
    if (!isNodeOfTree.has(n)) {
      const position = positionOf(n);
      if (isFurtherOut(position, borderPosition)) borderPosition = position;
    }
  }

  // 1. Move the tree to the starting border position
  //   we could include the obstacle(s) at the border to find this state, but we also want to
  //   start the transaction attempts from here since there will not be any existing overlaps
  let currentBestPosition = borderPosition;
  let currentBestDistance = Math.abs(currentBestPosition - rootPosition);

  moveTree(0, borderPosition);
  // if there are fixed nodes in the container, there shouldn't be any negative coordinates in the initial placement
  const fixedOrigin = treePlacementFixedOrigin(g, lg.effectiveContainer(placementTree.node), guard);
  if (fixedOrigin !== null) {
    let hasNegative = false;
    const placementNodes = [placementTree, ...descendants_];
    for (const tree of placementNodes) {
      guard.step();
      if (tree.node.topLeft.x < fixedOrigin.x || tree.node.topLeft.y < fixedOrigin.y) {
        hasNegative = true;
        break;
      }
    }
    if (hasNegative) currentBestDistance = Infinity;
  }

  // 2a. find nodes between the root and the border to find placement options closer to the root node
  //     we will try to place the tree next to each of these to find the best option
  const obstaclePositions = [];
  for (const n of g.nodes) {
    guard.step();
    if (!isNodeOfTree.has(n)) {
      const position = positionOf(n);
      if (isFurtherOut(borderPosition, position) && isFurtherOut(position, rootPosition)) obstaclePositions.push(position);
    }
  }
  // 2b. We add the root position as an option and we start at the border for the edge cases, other obstacles are in-between
  obstaclePositions.push(rootPosition);

  const txn = g.newRequestTransaction(ctx, {});
  for (const obstaclePosition of obstaclePositions) {
    guard.step();
    // 2c. Try moving the tree next to each obstacle
    txn.addOp(() => moveTree(currentBestPosition, obstaclePosition));
    // 2d. Undo if overlapping or too close to other nodes
    try {
      txn.commit(ctx);
    } catch (err) {
      if (!(err instanceof GoError)) throw err;
      txn.clear();
      if (lg.isCandidateRejection(err)) continue;
      throw err;
    }
    try {
      guard.finish();
    } catch (err) {
      if (err instanceof GoError) txn.clear();
      throw err;
    }

    // 2e. Keep this position if it is closer to the root, otherwise undo the movement
    const obstacleDistance = Math.abs(obstaclePosition - rootPosition);
    if (obstacleDistance < currentBestDistance) {
      currentBestPosition = obstaclePosition;
      currentBestDistance = obstacleDistance;
      try {
        txn.updateState();
      } catch (err) {
        if (err instanceof GoError) txn.clear();
        throw err;
      }
    } else {
      txn.rollback();
    }
    txn.clear();
  }

  guard.finish();
  return currentBestDistance;
}

/**
 * trees look nicer due to their internal relative placement and consistent edges, but they
 * have the drawback of fixed placement options on the sides of the rootSentinel its connected to
 * when the tree doesn't branch at all, we'd prefer to have node placement since there's little benefit to tree placement
 */
function putBackNonBranchingTrees(g, guard) {
  const containerOrder = treeContainerRDFSOrder(g, null, guard);
  containerOrder.push(null);
  for (const container of containerOrder) {
    guard.step();
    // Go ranges over the slice header read here: reconnecting a tree appends to g.Containers[container]
    const containerNodes = (g.containers.get(container) ?? []).slice();
    for (const node of containerNodes) {
      guard.step();
      const roots = g.trees.get(node);
      if (roots === undefined) continue;
      if (roots.length === 0) throw treePreprocessBadState(`tree sentinel ${node.id} has no roots`);
      const isolated = isIsolatedTreeGuarded(g, node, guard);
      let firstBranches = false;
      if (isolated && roots.length === 1) firstBranches = treeBranches(roots[0], guard);
      if (isolated && (roots.length > 1 || firstBranches)) {
        // if it is a branching isolated tree, don't put back its roots
        const isVessel = g.sequences.has(node);
        // for a sequence vessel sentinel: put non-branching roots back since tree placement
        // isn't tailored for sequences so it's only worth keeping branching roots
        if (!isVessel) continue;
      }
      const branchingRoots = [];
      for (const root of roots) {
        guard.step();
        const branches = treeBranches(root, guard);
        if (!branches) {
          const reconnectionTree = lg.newTree(node);
          addTreeChild(reconnectionTree, root, guard);
          reconnectTreeGuarded(g, reconnectionTree, container, guard);
        } else {
          branchingRoots.push(root);
        }
      }
      if (branchingRoots.length > 0) g.trees.set(node, branchingRoots);
      else g.trees.delete(node);
    }
  }
  guard.check();
}

function preprocessTreesWithWorkLimit(ctx, g, workLimit) {
  lg.validate(ctx, treePreprocessLocation, g);
  const guard = newWorkGuard(ctx, treePreprocessLocation);
  guard.setLimit(workLimit);

  const state = lg.newGraphStateSnapshot({ captureTopology: true, captureEdgeRoutes: true });
  state.updateWithWorkGuard(g, guard);
  const rollback = new lg.Transaction();
  rollback.graph = g;
  rollback.priorGraphState = state;
  let complete = false;
  try {
    const trees = extractTrees(g, guard);
    g.trees = trees;
    guard.step();
    guard.check();
    putBackNonBranchingTrees(g, guard);
    buildNodeToTreeGuarded(g, guard);
    guard.finish();
    complete = true;
  } finally {
    if (!complete) rollback.rollback();
  }
}

export function preprocess(ctx, g) {
  preprocessTreesWithWorkLimit(ctx, g, limits.MaxEngineWorkUnits);
}

/**
 * if width >= height this is the aspect ratio, otherwise it is 1/the aspect ratio
 * this way the value is always >= 1, and 1:10 has the same value as 10:1
 */
function normalizedAspectRatio(g, guard) {
  // BoundingBox has no guard parameter and may inspect every peer node while
  // resolving outside labels. Charge its node-pair and route-point traversal
  // here so cancellation and the aggregate work limit cover the calculation.
  for (const node of g.nodes) {
    guard.step();
    if (node === null || node.topLeft === null) throw treePreprocessBadState('tree placement encountered an incomplete graph node');
    for (let i = 0; i < g.nodes.length; i++) guard.step();
  }
  for (const edge of g.edges) {
    guard.step();
    if (edge === null) throw treePreprocessBadState('tree placement encountered a nil graph edge');
    for (const point of edge.points) {
      guard.step();
      if (point === null) throw treePreprocessBadState('tree placement encountered a nil route point');
    }
  }
  const [tl, br] = g.boundingBox();
  if (tl === null || br === null) throw treePreprocessBadState('tree placement could not compute a graph bounding box');
  guard.finish();
  const width = br.x - tl.x;
  const height = br.y - tl.y;
  if (width >= height) return width / height;
  return height / width;
}

/** reconnect tree to the graph with the best placement we can find. existingPlacements: Map<orientation, bool> */
function placeTree(ctx, g, placementTree, container, existingPlacements, guard) {
  // 0. initialize TopLeft to non-nil for placement
  const descendants_ = treeDescendants(placementTree, guard);
  for (const t of descendants_) {
    guard.step();
    t.node.topLeft = new geo.Point(0, 0);
    guard.finish();
  }

  // 1. restore the tree to the graph
  reconnectTreeGuarded(g, placementTree, container, guard);

  // 2. find the best orientation to place the tree close to the root node
  let bestOrientation = 0; // the zero value of geo.Orientation (TopLeft)
  let bestDistance = Infinity;
  let bestRatio = Infinity;

  const defaultOrder = [Orientation.Bottom, Orientation.Top, Orientation.Left, Orientation.Right];
  let order = [];

  const isIsolatedTree = isIsolatedTreeGuarded(g, placementTree.node, guard);
  if (existingPlacements.size === 1) {
    for (const o of defaultOrder) {
      if (existingPlacements.has(o)) {
        bestOrientation = geo.getOpposite(o);
        break;
      }
    }
  } else {
    // for isolated trees, don't place on the same side as an already placed tree
    if (isIsolatedTree) {
      for (const o of defaultOrder) {
        if (existingPlacements.has(o)) continue;
        order.push(o);
      }
      if (order.length === 0) {
        // we ran out of unused sides
        order = defaultOrder;
      }
    } else {
      order = defaultOrder;
    }

    const direction = g.direction(container);
    for (const orientation of order) {
      guard.step();
      constructToOrientation(placementTree, orientation, guard);
      let distance = placeAtOrientationGuarded(ctx, g, placementTree, orientation, guard);
      const ratio = normalizedAspectRatio(g, guard);

      // slightly favor the container direction
      if (orientation !== direction) distance += directionPenalty;

      if (distance < bestDistance) {
        bestOrientation = orientation;
        bestDistance = distance;
        bestRatio = ratio;
      } else if (distance === bestDistance && ratio < bestRatio) {
        // break ties with width & height ratio closest to 1 (most square)
        bestOrientation = orientation;
        bestRatio = ratio;
      }
    }
  }

  // 3. place using the best orientation
  guard.step();
  constructToOrientation(placementTree, bestOrientation, guard);
  placeAtOrientationGuarded(ctx, g, placementTree, bestOrientation, guard);

  positionTreeEdgeLabels(placementTree, isIsolatedTree, guard);
  return bestOrientation;
}

function positionTreeEdgeLabels(placementTree, isIsolatedTree, guard) {
  const orientation = placementTree.orientation;
  invertOrientationToBottom(placementTree, orientation, guard);
  let err = null;
  try {
    const labelTrees = [];
    for (const root of placementTree.children) {
      guard.step();
      // if it is an isolated tree, we also position the root's sentinel edge label (because we route it in an s-shape)
      if (isIsolatedTree) {
        labelTrees.push(root);
      } else {
        for (const child of root.children) {
          guard.step();
          labelTrees.push(child);
        }
      }
    }
    for (const tree of labelTrees) {
      guard.step();
      validateBottomOrientation(tree, guard);
    }
    for (const tree of labelTrees) {
      guard.step();
      positionEdgeLabels(tree, guard);
    }
    guard.finish();
  } catch (e) {
    if (!(e instanceof GoError)) throw e;
    err = e;
  }
  // deferred: restore the orientation; the first error wins
  let restoreErr = null;
  try {
    invertOrientationToBottom(placementTree, orientation, guard);
  } catch (e) {
    if (!(e instanceof GoError)) throw e;
    restoreErr = e;
  }
  if (err !== null) throw err;
  if (restoreErr !== null) throw restoreErr;
}

function placeTrees(ctx, g, container, guard) {
  const placementTrees = buildPlacementTrees(g, guard);
  const treeSizes = new Map();
  for (const placementTree of placementTrees) {
    treeSizes.set(placementTree, treeSize(placementTree, guard));
  }
  // Sorting cannot return an error from its comparator. Charge a stable
  // n*ceil(log2(n)) upper bound first, one step at a time, so sorting remains
  // covered by the same overflow-safe aggregate budget.
  for (let width = 1; width < placementTrees.length;) {
    for (let i = 0; i < placementTrees.length; i++) guard.step();
    if (width > Math.trunc(placementTrees.length / 2)) break;
    width *= 2;
  }
  // Note: we sort placementTrees so larger trees are placed first and to have a deterministic order
  sortFunc(placementTrees, (a, b) => {
    const order = compare(treeSizes.get(b), treeSizes.get(a));
    if (order !== 0) return order;
    // We compare each placement tree's first child's ID, since placement tree roots can be the same rootSentinel (if a rootSentinel has multiple roots).
    return compare(a.children[0].node.id, b.children[0].node.id);
  });
  // record placement sides to prevent repeats in isolated trees
  const rootSentinelPlacements = new Map();
  for (const placementTree of placementTrees) {
    guard.step();
    if (!rootSentinelPlacements.has(placementTree.node)) rootSentinelPlacements.set(placementTree.node, new Map());
    const placedOrientation = placeTree(ctx, g, placementTree, container, rootSentinelPlacements.get(placementTree.node), guard);
    rootSentinelPlacements.get(placementTree.node).set(placedOrientation, true);
    guard.finish();
  }
  // disconnect from placement tree
  for (const rootSentinel of g.nodes) {
    guard.step();
    for (const root of g.trees.get(rootSentinel) ?? []) {
      guard.step();
      root.parent = null;
      guard.finish();
    }
  }
  guard.check();
}

function placeTreesWithWorkLimit(ctx, g, container, workLimit) {
  lg.validate(ctx, 'PlaceTrees', g);
  const guard = newWorkGuard(ctx, 'PlaceTrees');
  guard.setLimit(workLimit);

  const state = lg.newGraphStateSnapshot({ captureTopology: true, captureEdgeRoutes: true });
  state.updateWithWorkGuard(g, guard);
  if (container !== null) {
    if (!state.tracksNode(container)) throw treePreprocessBadState('cannot place trees into an unknown container');
  }
  const rollback = new lg.Transaction();
  rollback.graph = g;
  rollback.priorGraphState = state;
  let complete = false;
  try {
    placeTrees(ctx, g, container, guard);
    guard.finish();
    complete = true;
  } finally {
    if (!complete) rollback.rollback();
  }
}

export function place(ctx, g, container) {
  placeTreesWithWorkLimit(ctx, g, container, limits.MaxPlaceTreesWorkUnits);
}

/**
 * buildPlacementTrees: the Go code ranges over `byDirection`, a map with up to three keys, whose iteration order is random in Go. The
 * result only depends on it through (1) the order of placementTrees, which placeTrees sorts totally (size, first child's ID), and
 * (2) `mergeWith` below, which takes the first tree with the most children: two trees of the same size from different directions
 * make Go's own output vary. JS keeps first-seen order.
 */
function buildPlacementTrees(g, guard) {
  const placementTrees = [];
  for (const rootSentinel of g.nodes) {
    guard.step();
    const firstPlacementTree = placementTrees.length;
    const roots = g.trees.get(rootSentinel);
    if (roots === undefined) {
      // not actually a rootSentinel
      continue;
    }

    const isIsolated = isIsolatedTreeGuarded(g, rootSentinel, guard);
    if (isIsolated) {
      // for an isolated tree and we should try to place all the matching roots together
      const byDirection = rootsByTreeDirection(roots, guard);
      const undirected = byDirection.get(Undirected) ?? [];
      byDirection.delete(Undirected);
      for (const matchingRoots of byDirection.values()) {
        const arrowheadSentinels = new Map();

        for (const root of matchingRoots) {
          guard.step();
          if (root === null || root.sentinelEdge === null) throw treePreprocessBadState('tree placement encountered an incomplete root');
          const arrowhead = root.sentinelEdge.arrowheadTo(rootSentinel);
          if (!arrowheadSentinels.has(arrowhead)) {
            arrowheadSentinels.set(arrowhead, lg.newTree(rootSentinel));
            placementTrees.push(arrowheadSentinels.get(arrowhead));
          }
          addTreeChild(arrowheadSentinels.get(arrowhead), root, guard);
        }
      }
      if (undirected.length > 0) {
        // merges undirected trees to the largest one that has no arrowhead in the sentinel edge
        let mergeWith = null;
        for (const tree of placementTrees.slice(firstPlacementTree)) {
          guard.step();
          if (mergeWith !== null && tree.children.length <= mergeWith.children.length) continue;
          // all children should have compatible edges, so we just need to check the first one
          if (tree.children.length > 0 && !tree.children[0].sentinelEdge.hasArrowTo(rootSentinel)) mergeWith = tree;
        }
        if (mergeWith === null) {
          // if it could not fit with any of the existing trees, we need to create a new for undirected trees
          mergeWith = lg.newTree(rootSentinel);
          placementTrees.push(mergeWith);
        }
        for (const root of undirected) addTreeChild(mergeWith, root, guard);
      }
    } else {
      for (const root of roots) {
        guard.step();
        // For placement, create a tree node with the rootSentinel connected to the tree root
        const placementTree = lg.newTree(rootSentinel);
        addTreeChild(placementTree, root, guard);
        placementTrees.push(placementTree);
      }
    }
  }
  guard.check();
  return placementTrees;
}

// ============================== geometry.go ==============================

const siblingSpacing = 50.0;
const directionPenalty = 2 * lg.TreeParentSpacing;

/**
 * get a map from depth level 0-n to tree nodes at that depth (a Map<int, Tree[]>)
 * .                     ┌───┐
 * . L 0                 │   │
 * .                     └───┘
 * .        ┌───┐        ┌───┐        ┌───┐
 * . L 1    │   │        │   │        │   │
 * .        └───┘        └───┘        └───┘
 */
function levelsByDepth(t, guard) {
  if (t === null) throw treePreprocessBadState('tree placement cannot traverse a nil tree');
  const queue = [{ tree: t, level: 0 }];
  const seen = new Set();
  const treeLevels = new Map();
  for (let index = 0; index < queue.length; index++) {
    guard.step();
    const current = queue[index];
    if (current.tree === null || current.tree.node === null) throw treePreprocessBadState('tree placement encountered an incomplete tree');
    if (seen.has(current.tree)) throw treePreprocessBadState('tree placement encountered a repeated tree node');
    seen.add(current.tree);
    if (!treeLevels.has(current.level)) treeLevels.set(current.level, []);
    treeLevels.get(current.level).push(current.tree);
    for (const child of current.tree.children) {
      guard.step();
      queue.push({ tree: child, level: current.level + 1 });
    }
  }
  return treeLevels;
}

function shiftSubtreeHorizontally(t, delta, guard) {
  offsetSubtree(t, delta, 0, guard);
}

function spacingToChildren(t, guard) {
  let maxLabelSize = 0.0;
  for (const c of t.children) {
    guard.step();
    if (c === null || c.sentinelEdge === null) throw treePreprocessBadState('tree placement encountered an incomplete child edge');
    let labelSize = c.sentinelEdge.minHeight;
    if (t.orientation === Orientation.Left || t.orientation === Orientation.Right) labelSize = c.sentinelEdge.minWidth;
    maxLabelSize = Math.max(maxLabelSize, labelSize);
  }
  if (maxLabelSize === 0) return lg.TreeParentSpacing;
  const labelSpacingWithArrowheads = maxLabelSize + 2 * lg.MinArrowheadClearance;
  if (t.children.length === 1) {
    //  ┌───┐
    //  │   │ We want enough space to place the label at the X
    //  └─┬─┘  ┬ MinArrowheadClearance
    //    │    ┼
    //   X│    │ maxLabelSize
    //    │    ┼
    //  ┌─▼─┐  ┴ MinArrowheadClearance
    //  │   │
    //  └───┘
    return Math.max(lg.TreeParentSpacing, labelSpacingWithArrowheads);
  }
  //         ┌───┐
  //         │   │       We want enough space to place the labels at the X positions
  //         └─┬─┘        ┬
  //           │          │ TreeParentSpacing/2
  //    ┌──────┴──────┐   ┼
  //    │             │   │
  //   X│             │X  │ labelSpacingWithArrowheads
  //    │             │   │
  //  ┌─▼─┐         ┌─▼─┐ ┴
  //  │   │         │   │
  //  └───┘         └───┘
  return lg.TreeParentSpacing / 2 + Math.max(lg.TreeParentSpacing / 2, labelSpacingWithArrowheads);
}

function layoutTree(t, guard) {
  const treeLevels = levelsByDepth(t, guard);

  // 1. The level height is the tallest node's at each level
  const levelHeights = new Map();
  for (let level = 0; level < treeLevels.size; level++) {
    let levelHeight = 0.0;
    for (const levelNode of treeLevels.get(level) ?? []) {
      guard.step();
      levelHeight = Math.max(levelHeight, levelNode.node.height);
    }
    levelHeights.set(level, levelHeight);
  }
  // 1.1. Edge labels may require additional spacing, so spacing for the level is based on the largest label
  const levelSpacings = new Map();
  for (let level = 0; level < treeLevels.size - 1; level++) {
    for (const levelNode of treeLevels.get(level) ?? []) {
      guard.step();
      const spacing = spacingToChildren(levelNode, guard);
      levelSpacings.set(level + 1, Math.max(levelSpacings.get(level + 1) ?? 0, spacing));
    }
  }

  //   ┌───┐        ┌─────┐              ┌──┐ ┌───┐
  //   │   │ ┌───┐  │     │ ┌─────────┐  │  │ │   │
  // ------------------------------------------------
  //   │   │ └───┘  │     │ └─────────┘  │  │ │   │
  //   └───┘        └─────┘              └──┘ └───┘
  // 2. On each level, center all nodes to the center y value for that level
  let levelBottom = 0.0;
  for (let level = 1; level < treeLevels.size; level++) {
    const levelTop = levelBottom + (levelSpacings.get(level) ?? 0);
    for (const levelNode of treeLevels.get(level) ?? []) {
      guard.step();
      const centerOffset = goRoundTrees((levelHeights.get(level) - levelNode.node.height) / 2);
      moveTreeNodeAbsWithChildren(levelNode.node, levelNode.node.topLeft.x, levelTop + centerOffset, guard);
    }
    levelBottom = levelTop + levelHeights.get(level);
  }

  // 3. Position all level nodes x values on each level, going bottom up by level
  for (let level = treeLevels.size - 1; level > 0; level--) {
    // nextPosition moves along the x axis as we position each level node on this level
    let nextPosition = 0.0;
    for (const levelNode of treeLevels.get(level) ?? []) {
      guard.step();
      if (levelNode.children.length === 0) {
        // 3a. Simply set position according to nextPosition value
        moveTreeNodeAbsWithChildren(levelNode.node, nextPosition, levelNode.node.topLeft.y, guard);
      } else {
        const below = treeLevels.get(level + 1) ?? [];
        let lastChildPosition = below.length;
        for (let i = lastChildPosition - 1; i >= 0; i--) {
          guard.step();
          if (below[i].parent === levelNode) {
            lastChildPosition = i;
            break;
          }
        }
        const shiftSubsequentLevelNodes = (dx) => {
          for (let i = lastChildPosition + 1; i < below.length; i++) {
            guard.step();
            shiftSubtreeHorizontally(below[i], dx, guard);
          }
        };

        // 3b 1. Space children evenly on the level below
        const spacingBefore_ = totalChildrenSpacing(levelNode, guard);
        spaceChildrenEvenly(levelNode, guard);
        const spacingAfter = totalChildrenSpacing(levelNode, guard);
        const totalShift = spacingAfter - spacingBefore_;
        // 3b 1a. if this shifts the children we also need to shift their subsequent level nodes
        if (totalShift > 0) shiftSubsequentLevelNodes(totalShift);
        // 3b 2. Center over children
        const siblingCenter = childrenCenterX(levelNode, guard);
        moveTreeNodeAbsWithChildren(levelNode.node, goRoundTrees(siblingCenter - levelNode.node.width / 2), levelNode.node.topLeft.y, guard);

        // 3b 3. if after centering, this node's position is less than the desired spacing,
        // shift its whole subtree to reach the desired spacing (keeping the centering intact)
        const positionDiff = nextPosition - levelNode.node.topLeft.x;
        if (positionDiff > 0) {
          shiftSubtreeHorizontally(levelNode, positionDiff, guard);
          shiftSubsequentLevelNodes(positionDiff);
        }
      }

      // 3c. the next position on this level is siblingSpacing past the end of this level node
      nextPosition = levelNode.node.topLeft.x + levelNode.node.width + siblingSpacing;
    }
  }
  guard.finish();
}

function validateBottomOrientation(t, guard) {
  const stack = [t];
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null || current.node.topLeft === null) {
      throw treePreprocessBadState('tree placement encountered an incomplete tree');
    }
    if (seen.has(current)) throw treePreprocessBadState('tree placement encountered a repeated tree node');
    seen.add(current);
    if (current.parent !== null) {
      if (current.parent.node === null || current.parent.node.topLeft === null) {
        throw treePreprocessBadState('tree placement encountered an incomplete parent');
      }
      if (current.node.topLeft.y < current.parent.node.topLeft.y + current.parent.node.height) {
        throw invariant.errorf(`tree node ${current.node.id} is not in Bottom orientation`);
      }
    }
    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
  guard.check();
}

function positionEdgeLabels(t, guard) {
  if (t === null) throw treePreprocessBadState('tree placement cannot label a nil tree');
  const stack = [{ tree: t, emit: false }];
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const task = stack.pop();
    const current = task.tree;
    if (current === null || current.node === null) throw treePreprocessBadState('tree placement encountered an incomplete label tree');
    if (!task.emit) {
      if (seen.has(current)) throw treePreprocessBadState('tree placement encountered a repeated tree node');
      seen.add(current);
      stack.push({ tree: current, emit: true });
      for (let i = current.children.length - 1; i >= 0; i--) {
        guard.step();
        stack.push({ tree: current.children[i], emit: false });
      }
      continue;
    }

    const edge = current.sentinelEdge;
    if (edge === null) throw treePreprocessBadState(`tree node ${current.node.id} has no sentinel edge for label placement`);
    if (edge.label === null) continue;
    let labelSize = edge.minHeight;
    if (geo.isHorizontal(current.orientation)) labelSize = edge.minWidth;
    if (labelSize !== 0) {
      if (current.parent === null || current.parent.node === null) {
        throw treePreprocessBadState(`tree node ${current.node.id} has no parent for label placement`);
      }
      if (current.parent.children.length === 1) {
        edge.label.position = label.UnlockedMiddle;
        edge.labelPercentage = 0.5;
      } else {
        //         ┌───┐
        //  parent │   │       We want to place the labels at the X positions
        //         └─┬─┘        ┬    ┬
        //           │          │    │ TreeParentSpacing/2
        //    ┌──────┴──────┐   │    ┼
        //    │      .      │   │dy  │
        //   X│      .      │X  │    │ childSegmentLength
        //    │      .      │   │    │
        //  ┌─▼─┐    .    ┌─▼─┐ ┴    ┴
        //  │   │ child   │   │ child
        //  └───┘    .    └───┘
        //           ├──────┤
        //              dx
        const childNode = current.node;
        const parentNode = current.parent.node;
        const dx = childNode.center().x - parentNode.center().x;
        const dy = childNode.topLeft.y - (parentNode.topLeft.y + parentNode.height);
        const totalLength = Math.abs(dx) + dy;
        const childSegmentLength = dy - lg.TreeParentSpacing / 2;

        // LabelPercentage = distance from edge.From along edge / total edge distance
        let distanceAlongEdge = childSegmentLength / 2;
        const isChildToParent = edge.from === childNode;
        if (!isChildToParent) distanceAlongEdge = totalLength - childSegmentLength / 2;
        edge.labelPercentage = distanceAlongEdge / totalLength;
        // if the child is to the left, to be on the outside we want the label on the relative bottom position
        if (dx < 0) edge.label.position = label.UnlockedBottom;
        else edge.label.position = label.UnlockedTop;
        // if the edge is in the other direction we need to mirror to get the same position
        if (isChildToParent) edge.label.position = label.mirrored(edge.label.position);
        if (geo.isHorizontal(current.orientation)) {
          // mirroring is needed due to the effects of invertOrientationToBottom on a horizontal orientation
          edge.label.position = label.mirrored(edge.label.position);
        }
      }
    }
    guard.finish();
  }
}

/** We compute the children's center by averaging the their centers */
function childrenCenterX(t, guard) {
  if (t.children.length === 0) throw treePreprocessBadState('tree placement cannot center a leaf');
  let centerX = 0.0;
  for (const child of t.children) {
    guard.step();
    if (child === null || child.node === null || child.node.topLeft === null) throw treePreprocessBadState('tree placement encountered an incomplete child');
    centerX += child.node.topLeft.x + child.node.width / 2;
  }
  // note: assumes this is only called on nodes with children
  centerX /= t.children.length;
  return centerX;
}

function spaceChildrenEvenly(t, guard) {
  let maxSpacing = siblingSpacing;

  const childrenSpacing = [0];
  // 1. Determine the maximum spacing between siblings
  for (let i = 1; i < t.children.length; i++) {
    guard.step();
    const s = t.children[i].node.topLeft.x - (t.children[i - 1].node.topLeft.x + t.children[i - 1].node.width);
    maxSpacing = Math.max(maxSpacing, s);
    childrenSpacing.push(s);
  }

  // 1a. Check that spacing evenly doesn't require too much space
  for (let i = 1; i < t.children.length; i++) {
    guard.step();
    const shiftAmount = maxSpacing - childrenSpacing[i];
    if (shiftAmount === 0) continue;
    const spacingBefore_ = spacingBefore(t, i, guard);
    if (spacingBefore_ + shiftAmount > 10 * siblingSpacing) {
      // spacing evenly would introduce too much excess space, so just keep the current spacing as-is
      return;
    }
    // the next child will have less space after shifting
    if (i + 1 < t.children.length) childrenSpacing[i + 1] -= shiftAmount;
  }

  // 2. Space all siblings with the maximum spacing
  for (let i = 1; i < t.children.length; i++) {
    guard.step();
    const shiftAmount = maxSpacing - childrenSpacing[i];
    if (shiftAmount > 0) shiftSubtreeHorizontally(t.children[i], shiftAmount, guard);
  }
}

function totalChildrenSpacing(t, guard) {
  let spacing = 0.0;
  for (let i = 1; i < t.children.length; i++) {
    guard.step();
    spacing += t.children[i].node.topLeft.x - (t.children[i - 1].node.topLeft.x + t.children[i - 1].node.width);
  }
  return spacing;
}

function spacingBefore(t, childIndex, guard) {
  // returns the minimum space between child at i and i-1 including all descendant levels
  const rights = levelRights(t.children[childIndex - 1], guard);
  const lefts = levelLefts(t.children[childIndex], guard);

  let minSpace = lefts[0] - rights[0];
  for (let level = 1; level < lefts.length && level < rights.length; level++) {
    guard.step();
    minSpace = Math.min(minSpace, lefts[level] - rights[level]);
  }
  return minSpace;
}

/** returns the leftmost positions for each level of descendants from this node */
function levelLefts(t, guard) {
  const levels = levelsByDepth(t, guard);
  const lefts = new Array(levels.size);
  for (let level = 0; level < levels.size; level++) {
    const nodes = levels.get(level) ?? [];
    if (nodes.length === 0 || nodes[0].node.topLeft === null) throw treePreprocessBadState('tree placement encountered an incomplete level');
    guard.step();
    lefts[level] = nodes[0].node.topLeft.x;
  }
  return lefts;
}

function levelRights(t, guard) {
  const levels = levelsByDepth(t, guard);
  const rights = new Array(levels.size);
  for (let level = 0; level < levels.size; level++) {
    const nodes = levels.get(level) ?? [];
    if (nodes.length === 0) throw treePreprocessBadState('tree placement encountered an empty level');
    const last = nodes[nodes.length - 1];
    if (last.node.topLeft === null) throw treePreprocessBadState('tree placement encountered an incomplete level');
    guard.step();
    rights[level] = last.node.topLeft.x + last.node.width;
  }
  return rights;
}

function centerAlignChildren(t, guard) {
  // 1. the x axis offset is computed so the root's children are centered with the root.
  // The center x value of the children should be equal to the root center x when aligned,
  // so we check how much to move everything in order to correct that.
  const childrenCenter = childrenCenterX(t, guard);
  const xOffset = goRoundTrees((t.node.topLeft.x + t.node.width / 2) - childrenCenter);

  // 2. shift all children to be in alignment
  for (const child of t.children) {
    guard.step();
    offsetSubtree(child, xOffset, 0, guard);
  }
  guard.finish();
}

/**
 * treePlacementDescendants is the guarded equivalent of Graph.AllDescendantNodes for tree-placement movement. Push order mirrors
 * that helper so both traversals produce the same mutation order.
 */
function treePlacementDescendants(node, guard) {
  if (node === null || node.graph === null) throw treePreprocessBadState('tree placement cannot move a node without graph ownership');
  const g = node.graph;
  const seen = new Set([node]);
  const stack = [];
  const pushChildren = (parent) => {
    if (parent === null) return;
    const sequence = g.sequences.get(parent) ?? null;
    if (sequence !== null) {
      for (let i = sequence.nodes.length - 1; i >= 0; i--) {
        guard.step();
        stack.push(sequence.nodes[i]);
      }
    }
    if (parent.isClusterVessel()) {
      const cluster = g.clusters.get(parent) ?? null;
      if (cluster !== null) {
        for (let i = cluster.nodes.length - 1; i >= 0; i--) {
          guard.step();
          stack.push(cluster.nodes[i]);
        }
      }
    }
    if (parent.isContainer()) {
      const children = g.containers.get(parent) ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        guard.step();
        stack.push(children[i]);
      }
    }
  };
  pushChildren(node);
  const out = [];
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null) throw treePreprocessBadState('tree placement encountered a nil graph descendant');
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    pushChildren(current);
  }
  return out;
}

function moveTreeNodeWithChildren(node, dx, dy, guard) {
  if (node === null || node.topLeft === null) throw treePreprocessBadState('tree placement cannot move an incomplete node');
  if (dx === 0 && dy === 0) {
    guard.check();
    return;
  }
  const descendants_ = treePlacementDescendants(node, guard);
  guard.step();
  node.translate(dx, dy);
  guard.finish();
  for (const descendant of descendants_) {
    guard.step();
    if (descendant.topLeft === null) throw treePreprocessBadState('tree placement encountered a descendant without a position');
    descendant.translate(dx, dy);
    guard.finish();
  }
}

function moveTreeNodeAbsWithChildren(node, x, y, guard) {
  if (node === null || node.topLeft === null) throw treePreprocessBadState('tree placement cannot move an incomplete node');
  if (node.topLeft.x === x && node.topLeft.y === y) {
    guard.check();
    return;
  }
  moveTreeNodeWithChildren(node, x - node.topLeft.x, y - node.topLeft.y, guard);
}

function offsetSubtree(t, xOffset, yOffset, guard) {
  const stack = [t];
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null) throw treePreprocessBadState('tree placement encountered an incomplete tree');
    if (seen.has(current)) throw treePreprocessBadState('tree placement encountered a repeated tree node');
    seen.add(current);
    moveTreeNodeWithChildren(current.node, xOffset, yOffset, guard);
    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
  guard.finish();
}

/**
 * this swaps the x and y coordinates as well as the width and height of all nodes in the tree
 * this is so that we can layout a tree to the right with the same code to lay it out to the bottom
 * by swapping dimensions before and after
 */
function swapDimensions(t, guard) {
  const stack = [t];
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null || current.node.topLeft === null) {
      throw treePreprocessBadState('tree placement encountered an incomplete tree');
    }
    if (seen.has(current)) throw treePreprocessBadState('tree placement encountered a repeated tree node');
    seen.add(current);
    moveTreeNodeAbsWithChildren(current.node, current.node.topLeft.y, current.node.topLeft.x, guard);
    const w = current.node.width;
    current.node.width = current.node.height;
    current.node.height = w;
    guard.finish();
    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
}

/** this flips all nodes in the tree such that the top left is the mirror topleft accounting for the width and height */
function flip(t, guard) {
  const stack = [t];
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null || current.node.topLeft === null) {
      throw treePreprocessBadState('tree placement encountered an incomplete tree');
    }
    if (seen.has(current)) throw treePreprocessBadState('tree placement encountered a repeated tree node');
    seen.add(current);
    moveTreeNodeAbsWithChildren(
      current.node,
      -(current.node.topLeft.x + current.node.width),
      -(current.node.topLeft.y + current.node.height),
      guard,
    );
    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
  guard.finish();
}

function setOrientation(t, o, guard) {
  const stack = [t];
  const seen = new Set();
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null || current.node === null) throw treePreprocessBadState('tree placement encountered an incomplete tree');
    if (seen.has(current)) throw treePreprocessBadState('tree placement encountered a repeated tree node');
    seen.add(current);
    current.orientation = o;
    guard.finish();
    for (let i = current.children.length - 1; i >= 0; i--) {
      guard.step();
      stack.push(current.children[i]);
    }
  }
}

