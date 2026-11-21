// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/grouping (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): discovers and manages layout groups (sequences of step nodes, clusters of interchangeable siblings) that
// temporarily move as a single vessel node. Files of the Go package: sequences.go, clusters.go, cluster_discovery.go, join.go,
// lifecycle.go (all in this file, in that order). The random stream is a gorand.js Rand: vessel IDs are `random.int63()` (BigInt).

import * as geo from '../geo.js';
import * as label from '../label.js';
import * as shape from '../shape.js';
import { goRound } from '../gomath.js';
import { errorf } from './goerrors.js';
import * as invariant from './invariant.js';
import * as lg from './layoutgraph.js';
import * as limits from './limits.js';
import { newRand } from '../gorand.js';
import { sortFunc, sortStableFunc, compare } from './goslices.js';
import { sortSlice } from '../gosort.js';

const { Orientation } = geo;
const { Row, Column } = lg;

const MAX_INT64 = 9223372036854775807n;

// ============================== sequences.go ==============================

function identifySequences(graph, nodes, guard) {
  const activeNodes = new Set();
  for (const node of graph.nodes) {
    guard.step();
    activeNodes.add(node);
  }
  const stepNodes = [];
  for (const node of nodes) {
    guard.step();
    if (!activeNodes.has(node) || node.isContainer()) continue;
    if (node.sequence !== null && !node.sequence.isActive()) continue;
    if (node.fixedTopLeft !== null || !node.isSequenceStep()) continue;
    stepNodes.push(node);
  }
  if (stepNodes.length <= 1) return null;

  const sequences = [];
  let steps = [stepNodes[0]];
  for (let i = 1; i < stepNodes.length; i++) {
    guard.step();
    const previous = stepNodes[i - 1];
    const current = stepNodes[i];
    let connected = false;
    for (const edge of previous.edges) {
      guard.step();
      if (previous.adjacent(edge) === current) {
        connected = true;
        break;
      }
    }
    if (connected) {
      steps.push(current);
    } else {
      if (steps.length > 1) sequences.push(steps);
      steps = [current];
    }
  }
  if (steps.length > 1) sequences.push(steps);
  return sequences;
}

/** SequenceDefiningEdges returns the IDs (a Set of BigInt) of edges consumed when step nodes are replaced by sequence vessels. */
export function sequenceDefiningEdges(ctx, graph) {
  lg.validate(ctx, 'GetSequenceDefiningEdges', graph);
  const guard = limits.newWorkGuard(ctx, 'GetSequenceDefiningEdges', limits.MaxEngineWorkUnits);
  let containerOrder = graph.containerRDFSOrder(null, guard);
  containerOrder = [...containerOrder, null];
  const sequenceEdges = new Set();
  for (const container of containerOrder) {
    guard.step();
    const sequences = identifySequences(graph, graph.containers.get(container) ?? [], guard) ?? [];
    for (const steps of sequences) {
      for (let i = 1; i < steps.length; i++) {
        let connection = null;
        for (const edge of steps[i - 1].edges) {
          guard.step();
          if ((edge.from === steps[i - 1] && edge.to === steps[i]) || (edge.to === steps[i - 1] && edge.from === steps[i])) {
            connection = edge;
            break;
          }
        }
        if (connection === null) {
          throw errorf(`TALA sequence steps ${steps[i - 1].id} and ${steps[i].id} have no defining edge`);
        }
        sequenceEdges.add(connection.id);
      }
    }
  }
  guard.finish();
  return sequenceEdges;
}

function isValidRememberedSequence(graph, vessel, sequence, activeNodes, guard) {
  if (vessel === null || sequence === null || sequence.isActive() || sequence.vessel !== vessel || sequence.graph !== graph || sequence.nodes.length < 2) {
    return false;
  }
  if (sequence.container !== null) {
    if (!activeNodes.has(sequence.container)) return false;
  }
  if (!graph.containers.has(sequence.container)) return false;
  const children = graph.containers.get(sequence.container);
  const childIndex = new Map();
  const duplicateChild = new Set();
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    guard.step();
    if (childIndex.has(child)) {
      duplicateChild.add(child);
      continue;
    }
    childIndex.set(child, i);
  }
  const seen = new Set();
  let previousIndex = -1;
  for (const node of sequence.nodes) {
    guard.step();
    if (node === null) return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (!activeNodes.has(node) || node.graph !== graph || !node.isSequenceStep() || node.fixedTopLeft !== null) return false;
    if (node.sequence !== sequence || node.container !== sequence.container) return false;
    const inContainer = childIndex.has(node);
    const index = childIndex.get(node) ?? 0;
    if (!inContainer || duplicateChild.has(node)) return false;
    if (previousIndex >= 0 && index !== previousIndex + 1) return false;
    previousIndex = index;
  }
  return true;
}

function clearRememberedSequenceMembership(sequence, guard) {
  if (sequence === null) return;
  for (const node of sequence.nodes) {
    guard.step();
    if (node !== null && node.sequence === sequence) node.sequence = null;
  }
}

/** AddSequences replaces each discovered step run with a temporary vessel. */
export function addSequences(ctx, graph, random) {
  lg.validate(ctx, 'AddSequences', graph);
  const guard = limits.newWorkGuard(ctx, 'AddSequences', limits.MaxEngineWorkUnits);
  const state = lg.newGraphStateSnapshot({ captureTopology: true, captureEdgeRoutes: true });
  state.updateWithWorkGuard(graph, guard);
  let complete = false;
  try {
    const remembered = new Map(); // Map<Node|null, Node[][]>
    const rememberedIDByFirstStep = new Map();
    const reservedNodeIDs = new Set();
    const activeNodes = new Set();
    for (const node of graph.nodes) {
      guard.step();
      activeNodes.add(node);
      reservedNodeIDs.add(node.id);
    }
    for (const [vessel, cluster] of graph.clusters) {
      guard.step();
      if (vessel !== null) reservedNodeIDs.add(vessel.id);
      if (cluster !== null) {
        for (const node of cluster.nodes) {
          guard.step();
          if (node !== null) reservedNodeIDs.add(node.id);
        }
      }
    }
    for (const [vessel, sequence] of graph.sequences) {
      guard.step();
      if (vessel !== null) reservedNodeIDs.add(vessel.id);
      if (sequence !== null) {
        for (const node of sequence.nodes) {
          guard.step();
          if (node !== null) reservedNodeIDs.add(node.id);
        }
      }
    }
    for (const vessel of graph.sequenceOrder()) {
      guard.step();
      const sequence = graph.sequences.get(vessel) ?? null;
      const valid = isValidRememberedSequence(graph, vessel, sequence, activeNodes, guard);
      if (valid) {
        const list = remembered.get(sequence.container);
        if (list === undefined) remembered.set(sequence.container, [sequence.nodes]);
        else list.push(sequence.nodes);
        rememberedIDByFirstStep.set(sequence.nodes[0], vessel.id);
      } else {
        clearRememberedSequenceMembership(sequence, guard);
      }
    }
    graph.sequences = new Map();

    const containerOrder = graph.containerRDFSOrder(null, guard);
    for (const container of [...containerOrder, null]) {
      guard.step();
      let groups = identifySequences(graph, graph.containers.get(container) ?? [], guard) ?? [];
      groups = [...groups, ...(remembered.get(container) ?? [])];
      const containerChildren = graph.containers.get(container) ?? [];
      const containerIndex = new Map();
      for (let i = 0; i < containerChildren.length; i++) {
        guard.step();
        containerIndex.set(containerChildren[i], i);
      }
      sortStableFunc(groups, (a, b) => compare(containerIndex.get(a[0]) ?? 0, containerIndex.get(b[0]) ?? 0));

      const generatedIDs = new Array(groups.length);
      const slotByID = new Map();
      for (let i = 0; i < groups.length; i++) {
        guard.step();
        generatedIDs[i] = random.int63();
        slotByID.set(generatedIDs[i], i);
      }
      const orderedGroups = new Array(groups.length).fill(null);
      const usedGroups = new Array(groups.length).fill(false);
      for (let i = 0; i < groups.length; i++) {
        const steps = groups[i];
        guard.step();
        if (rememberedIDByFirstStep.has(steps[0])) {
          const rememberedID = rememberedIDByFirstStep.get(steps[0]);
          if (slotByID.has(rememberedID) && orderedGroups[slotByID.get(rememberedID)] === null) {
            orderedGroups[slotByID.get(rememberedID)] = steps;
            usedGroups[i] = true;
          }
        }
      }
      let nextGroup = 0;
      for (let i = 0; i < orderedGroups.length; i++) {
        guard.step();
        if (orderedGroups[i] !== null) continue;
        while (nextGroup < groups.length && usedGroups[nextGroup]) {
          guard.step();
          nextGroup++;
        }
        orderedGroups[i] = groups[nextGroup];
        usedGroups[nextGroup] = true;
      }

      for (let i = 0; i < orderedGroups.length; i++) {
        const steps = orderedGroups[i];
        guard.step();
        let id = generatedIDs[i];
        if (rememberedIDByFirstStep.has(steps[0])) {
          id = rememberedIDByFirstStep.get(steps[0]);
        } else {
          id = nextAvailableNodeID(graph, id, reservedNodeIDs);
          reservedNodeIDs.add(id);
        }
        addSequence(graph, buildSequence(steps, graph, container, id));
      }
    }
    guard.finish();
    complete = true;
  } finally {
    if (!complete) lg.restoreGraphState(graph, state);
  }
}

function buildSequence(steps, graph, container, id) {
  let maxHeight = 0.0;
  for (const node of steps) {
    if (node.width <= shape.STEP_WEDGE_WIDTH) {
      node.width = 2 * shape.STEP_WEDGE_WIDTH;
    }
    maxHeight = Math.max(maxHeight, node.height);
  }
  for (const node of steps) {
    node.height = maxHeight;
  }
  for (let i = 1; i < steps.length; i++) {
    const edge = steps[i - 1].connectionTo(steps[i]);
    if (edge !== null) graph.disconnect(edge);
  }
  const sequence = new lg.Sequence();
  sequence.vessel = lg.newNode(id, 0, 0);
  sequence.nodes = steps;
  sequence.graph = graph;
  sequence.container = container;
  sequence.syncGeometry();
  abductSequenceEdges(sequence);
  sequence.placeVessel();
  return sequence;
}

function addSequence(graph, sequence) {
  graph.addNewNodeToContainer(sequence.container, sequence.vessel);
  for (const node of sequence.nodes) {
    node.sequence = sequence;
  }
  const updatedContainerNodes = [];
  for (const child of graph.containers.get(sequence.container) ?? []) {
    if (child.sequence !== sequence) updatedContainerNodes.push(child);
  }
  graph.containers.set(sequence.container, updatedContainerNodes);
  for (const node of sequence.nodes) {
    graph.removeNode(node);
    node.container = null;
  }
  graph.sequences.set(sequence.vessel, sequence);
}

function abductSequenceEdges(sequence) {
  const isStep = new Set();
  for (const node of sequence.nodes) isStep.add(node);
  const abductions = [];
  for (const edge of sequence.graph.edges) {
    const fromIsStep = isStep.has(edge.from);
    const toIsStep = isStep.has(edge.to);
    if (fromIsStep && toIsStep) continue;
    if (fromIsStep) {
      abductions.push(newAbduction({ edge, originallyFrom: edge.from, currentFrom: sequence.vessel, currentTo: edge.to }));
      edge.reconnect(sequence.vessel, false);
    }
    if (toIsStep) {
      abductions.push(newAbduction({ edge, originallyTo: edge.to, currentTo: sequence.vessel, currentFrom: edge.from }));
      edge.reconnect(sequence.vessel, true);
    }
  }
  sequence.edgeAbductions = abductions;
}

/** &layoutgraph.EdgeAbduction{...}: unset fields are nil. */
function newAbduction(fields) {
  const a = new lg.EdgeAbduction();
  a.edge = null;
  a.originallyFrom = null;
  a.originallyTo = null;
  a.currentFrom = null;
  a.currentTo = null;
  return Object.assign(a, fields);
}

function nextAvailableNodeID(graph, candidate, unavailable) {
  for (;;) {
    if (!unavailable.has(candidate) && !hasNodeID(graph, candidate)) return candidate;
    if (candidate === MAX_INT64) candidate = 0n;
    else candidate++;
  }
}

function hasNodeID(graph, id) {
  const hasID = (node) => node !== null && node.id === id;
  if (graph.nodes.some(hasID)) return true;
  for (const [vessel, cluster] of graph.clusters) {
    if (hasID(vessel) || (cluster !== null && cluster.nodes.some(hasID))) return true;
  }
  for (const [vessel, sequence] of graph.sequences) {
    if (hasID(vessel) || (sequence !== null && sequence.nodes.some(hasID))) return true;
  }
  const treeHasID = (tree) => tree !== null && (hasID(tree.node) || tree.children.some(treeHasID));
  for (const [sentinel, roots] of graph.trees) {
    if (hasID(sentinel) || roots.some(treeHasID)) return true;
  }
  return false;
}

// ============================== clusters.go ==============================

/**
 * AssignArrangement selects the cluster axis from node dimensions. Randomness is consumed only for square clusters, preserving
 * the engine's seed contract.
 */
export function assignArrangement(cluster, isConnectedToSequence, random) {
  const [averageWidth, averageHeight] = averageClusterDimensions(cluster);
  if (isConnectedToSequence) return Row;
  if (averageWidth > averageHeight) return Column;
  if (averageWidth < averageHeight) return Row;
  if (random.float64() > 0.5) return Column;
  return Row;
}

function averageClusterDimensions(cluster) {
  let width = 0;
  let height = 0;
  for (const node of cluster.nodes) {
    width += node.width;
    height += node.height;
  }
  const count = cluster.nodes.length;
  return [goRound(width / count), goRound(height / count)];
}


/** PaddingBetween calculates the spacing between adjacent cluster members. */
export function paddingBetween(cluster, considerPositions) {
  const [averageWidth, averageHeight] = averageClusterDimensions(cluster);
  let hasIcon = false;
  let maxLabelWidth = 0;
  let maxLabelHeight = 0;
  for (const node of cluster.nodes) {
    hasIcon = hasIcon || node.icon !== null;
    if (node.label !== null) {
      maxLabelWidth = Math.max(maxLabelWidth, node.label.width);
      maxLabelHeight = Math.max(maxLabelHeight, node.label.height);
    }
  }
  let given;
  if (cluster.arrangement === Row) {
    given = Math.max(lg.NodeGap, Math.ceil(averageWidth) * 0.1);
    if (hasIcon) given = Math.max(given, 2 * label.PADDING + maxLabelWidth);
  } else {
    given = Math.max(lg.NodeGap, Math.ceil(averageHeight) * 0.1);
    if (hasIcon) given = Math.max(given, 2 * label.PADDING + maxLabelHeight);
  }
  if (considerPositions) {
    let total = 0;
    for (let index = 0; index < cluster.nodes.length - 1; index++) {
      total += cluster.nodes[index].distanceTo(cluster.nodes[index + 1], true);
    }
    const positionedPadding = total / (cluster.nodes.length - 1);
    if (positionedPadding > 0) return goRound(Math.min(positionedPadding, given));
  }
  return goRound(given);
}

/** CreateVessel builds the temporary placement node representing a cluster. */
export function createVessel(cluster, vesselID) {
  let minimumX = Infinity;
  let minimumY = Infinity;
  for (const node of cluster.nodes) {
    if (node.topLeft !== null) {
      minimumX = Math.min(minimumX, node.topLeft.x);
      minimumY = Math.min(minimumY, node.topLeft.y);
    }
  }
  const vessel = lg.newNode(vesselID, 0, 0);
  vessel.setClusterVessel(true);
  cluster.resize(vessel);
  if (cluster.arrangement === Row) {
    if (minimumX !== Infinity && minimumY !== Infinity) {
      sortSlice(cluster.nodes, (i, j) => cluster.nodes[i].topLeft.x < cluster.nodes[j].topLeft.x);
      vessel.topLeft = new geo.Point(minimumX, minimumY);
    }
  }
  if (cluster.arrangement === Column) {
    if (minimumX !== Infinity && minimumY !== Infinity) {
      sortSlice(cluster.nodes, (i, j) => cluster.nodes[i].topLeft.y < cluster.nodes[j].topLeft.y);
      vessel.topLeft = new geo.Point(minimumX, minimumY);
    }
  }
  return vessel;
}

/** AddCluster installs a discovered cluster and its temporary vessel into the mutable layout graph. */
export function addCluster(graph, cluster) {
  graph.addNewNodeToContainer(cluster.container, cluster.vessel);
  for (const node of cluster.nodes) {
    node.cluster = cluster;
  }
  const updatedContainerNodes = [];
  for (const child of graph.containers.get(cluster.container) ?? []) {
    if (child.cluster !== cluster) updatedContainerNodes.push(child);
  }
  graph.containers.set(cluster.container, updatedContainerNodes);
  for (const node of cluster.nodes) {
    graph.removeNode(node);
    node.container = null;
  }
  graph.clusters.set(cluster.vessel, cluster);
}

function abductClusterEdges(cluster, edges, guard) {
  const abductions = [];
  for (const edge of edges) {
    guard.step();
    if (edge.from.cluster === cluster) {
      for (let n = edge.from.edges.length + cluster.vessel.edges.length; n > 0; n--) guard.step();
      abductions.push(newAbduction({ edge, originallyFrom: edge.from, currentFrom: cluster.vessel, currentTo: edge.to }));
      edge.reconnect(cluster.vessel, false);
    }
    if (edge.to.cluster === cluster) {
      for (let n = edge.to.edges.length + cluster.vessel.edges.length; n > 0; n--) guard.step();
      abductions.push(newAbduction({ edge, originallyTo: edge.to, currentTo: cluster.vessel, currentFrom: edge.from }));
      edge.reconnect(cluster.vessel, true);
    }
  }
  cluster.edgeAbductions = abductions;
  guard.finish();
}

/** AddClusters discovers interchangeable sibling nodes and replaces accepted groups with temporary vessels for node placement. */
export function addClusters(ctx, graph, randomSeed, random) {
  if (graph == null) throw errorf('TALA AddClusters requires a graph');
  if (random == null) throw errorf('TALA AddClusters requires a random generator');
  lg.validate(ctx, 'AddClusters', graph);
  const [, guard] = lg.ensureTransactionWorkGuard(ctx, 'AddClustersTransactions');
  const containerOrder = graph.containerRDFSOrder(null, guard);

  const stageState = lg.newGraphStateSnapshot({ captureTopology: true, captureEdgeRoutes: true });
  stageState.updateWithWorkGuard(graph, guard);
  let complete = false;
  try {
    graph.clusters.clear();
    const discoveryIndex = buildClusterDiscoveryIndex(graph, containerOrder, guard);
    const infos = discoveryIndex.infos;
    const edgeOrder = discoveryIndex.edgeOrder;
    const reservedIDs = new Set();
    for (const node of graph.nodes) {
      guard.step();
      reservedIDs.add(node.id);
    }
    for (const vessel of graph.sequenceOrder()) {
      guard.step();
      reservedIDs.add(vessel.id);
      for (const node of graph.sequences.get(vessel).nodes) {
        guard.step();
        reservedIDs.add(node.id);
      }
    }
    const seenTrees = new Set();
    for (const sentinel of graph.treeOrder()) {
      guard.step();
      if (sentinel !== null) reservedIDs.add(sentinel.id);
      const stack = (graph.trees.get(sentinel) ?? []).slice();
      while (stack.length > 0) {
        guard.step();
        const tree = stack.pop();
        if (tree === null) continue;
        if (seenTrees.has(tree)) continue;
        seenTrees.add(tree);
        if (tree.node !== null) reservedIDs.add(tree.node.id);
        stack.push(...tree.children);
      }
    }
    const nextVesselID = (candidate) => {
      for (;;) {
        guard.step();
        if (!reservedIDs.has(candidate)) return candidate;
        if (candidate === MAX_INT64) candidate = 0n;
        else candidate++;
      }
    };
    const chargeClusterKernel = (cluster) => {
      for (let i = 0; i < cluster.nodes.length; i++) {
        for (let j = 0; j < cluster.nodes.length; j++) guard.step();
      }
      for (let width = 1; width < cluster.nodes.length; width *= 2) {
        for (let i = 0; i < cluster.nodes.length; i++) guard.step();
        if (width > Math.trunc(cluster.nodes.length / 2)) break;
      }
      guard.finish();
    };

    const maybeCreateCluster = (cluster, arrangement) => {
      for (const node of cluster.nodes) {
        guard.step();
        for (const edge of node.edges) {
          guard.step();
          const isDescendant = clusterIsDescendantOfGuarded(node, node.adjacent(edge), guard);
          if (isDescendant) return false;
        }
      }
      const vesselID = nextVesselID(random.int63());
      const clusterEdges = clusterIncidentEdges(cluster, infos, edgeOrder, guard);
      chargeClusterKernel(cluster);
      cluster.arrangement = arrangement;
      cluster.desiredArrangement = arrangement;
      cluster.padding = paddingBetween(cluster, false);
      const vessel = createVessel(cluster, vesselID);
      cluster.vessel = vessel;
      addCluster(graph, cluster);
      guard.step();
      abductClusterEdges(cluster, clusterEdges, guard);
      discoveryIndex.refreshAfterClusterAbduction(graph, cluster, clusterEdges, guard);
      reservedIDs.add(vesselID);
      for (const node of cluster.nodes) {
        guard.step();
        reservedIDs.add(node.id);
      }
      return true;
    };

    const maxSizeDiff = 4.0;
    const refreshContainerEstimate = (container) => {
      if (container === null || !container.isContainer()) return;
      const info = infos.get(container) ?? null;
      if (info === null) throw errorf('TALA AddClusters cannot find container discovery index');
      const padding = graph.containerPadding(container, true);
      let childrenWidth = 0;
      let childrenHeight = 0;
      for (const child of graph.containers.get(container) ?? []) {
        guard.step();
        let childWidth = child.width;
        let childHeight = child.height;
        const childInfo = infos.get(child) ?? null;
        if (childInfo !== null) {
          childWidth = childInfo.estimatedWidth;
          childHeight = childInfo.estimatedHeight;
        }
        childrenWidth += childWidth;
        childrenHeight += childHeight;
      }
      info.estimatedWidth = Math.max(container.width, childrenWidth + padding.left + padding.right);
      info.estimatedHeight = Math.max(container.height, childrenHeight + padding.top + padding.bottom);
      guard.finish();
    };
    const containers = [...containerOrder, null];
    for (const container of containers) {
      guard.step();
      const rng = newRand(BigInt(randomSeed));
      // Go ranges over a slice header fixed here: AddCluster appends the vessel to the same container list while the loop runs
      const children = (graph.containers.get(container) ?? []).slice();
      for (const node of children) {
        guard.step();
        const info = infos.get(node) ?? null;
        if (info === null) throw errorf('TALA AddClusters cannot find node discovery index');
        if (info.noClustering || node.cluster !== null) continue;
        let connectedToCluster = false;
        for (const edge of node.edges) {
          guard.step();
          const adjacent = node.adjacent(edge);
          if (adjacent !== null && adjacent.isClusterVessel()) {
            connectedToCluster = true;
            break;
          }
        }
        if (connectedToCluster || info.toTableColumn) continue;
        const clusterNodes = [node];
        let isConnectedToSequence = false;
        for (const otherNode of children) {
          guard.step();
          if (otherNode === node || !otherNode.sameShape(node)) continue;
          const otherInfo = infos.get(otherNode) ?? null;
          if (otherInfo === null) throw errorf('TALA AddClusters cannot find comparison-node discovery index');
          if (otherInfo.noClustering || otherNode.cluster !== null || otherInfo.toTableColumn) continue;
          if (maxSizeDiff * otherInfo.estimatedWidth < info.estimatedWidth ||
            maxSizeDiff * info.estimatedWidth < otherInfo.estimatedWidth ||
            maxSizeDiff * otherInfo.estimatedHeight < info.estimatedHeight ||
            maxSizeDiff * info.estimatedHeight < otherInfo.estimatedHeight) {
            continue;
          }
          let sameAdjacentNodes = info.neighbors.length > 0 && info.neighbors.length === otherInfo.neighbors.length;
          if (sameAdjacentNodes) {
            for (const adjacentNode of info.neighbors) {
              guard.step();
              isConnectedToSequence = isConnectedToSequence || (adjacentNode !== null && adjacentNode.sequence !== null);
              if (!otherInfo.neighborSet.has(adjacentNode)) {
                sameAdjacentNodes = false;
                break;
              }
            }
          }
          if (sameAdjacentNodes && info.edgeSignature.matches(otherInfo.edgeSignature)) {
            clusterNodes.push(otherNode);
          }
        }
        if (clusterNodes.length <= 1) continue;
        const cluster = new lg.Cluster();
        cluster.nodes = clusterNodes;
        cluster.container = container;
        cluster.graph = graph;
        for (const clusterNode of clusterNodes) {
          guard.step();
          if (clusterNode.aspectRatio1()) {
            cluster.fixedSize = true;
            break;
          }
        }
        chargeClusterKernel(cluster);
        const initialArrangement = assignArrangement(cluster, isConnectedToSequence, rng);
        const success = maybeCreateCluster(cluster, initialArrangement);
        if (!success) {
          maybeCreateCluster(cluster, lg.flipArrangement(initialArrangement));
        }
      }
      refreshContainerEstimate(container);
    }
    guard.finish();
    complete = true;
  } finally {
    if (!complete) lg.restoreGraphState(graph, stageState);
  }
}

// ============================== cluster_discovery.go ==============================

const maxEngineNodes = limits.MaxEngineNodes;

class ClusterEdgeSignature {
  constructor() {
    this.from = 0;
    this.to = 0;
    this.bidirectional = 0;
    this.undirected = 0;
    this.directed = 0;
    this.fromArrowheads = new Set();
    this.toArrowheads = new Set();
  }

  add(node, edge) {
    if (edge.from === node) this.from++;
    if (edge.to === node) this.to++;
    if (edge.isBidirectional()) this.bidirectional++;
    else if (edge.isUndirected()) this.undirected++;
    else if (edge.isDirected()) this.directed++;
    if (edge.from === node) {
      this.fromArrowheads.add(edge.sourceArrowhead);
      this.toArrowheads.add(edge.targetArrowhead);
    } else {
      this.fromArrowheads.add(edge.targetArrowhead);
      this.toArrowheads.add(edge.sourceArrowhead);
    }
  }

  arrowTypeCount() {
    let types = 0;
    if (this.directed > 0) types++;
    if (this.bidirectional > 0) types++;
    if (this.undirected > 0) types++;
    return types;
  }

  matches(other) {
    return this.from === other.from &&
      this.to === other.to &&
      this.bidirectional === other.bidirectional &&
      this.undirected === other.undirected &&
      this.arrowTypeCount() <= 1 &&
      other.arrowTypeCount() <= 1 &&
      arrowheadSetsEqual(this.fromArrowheads, other.fromArrowheads) &&
      arrowheadSetsEqual(this.toArrowheads, other.toArrowheads);
  }
}

function arrowheadSetsEqual(first, second) {
  if (first.size !== second.size) return false;
  for (const arrowhead of first) {
    if (!second.has(arrowhead)) return false;
  }
  return true;
}

class ClusterDiscoveryInfo {
  constructor() {
    this.neighbors = [];
    this.neighborSet = new Set();
    this.edges = [];
    this.edgeSignature = new ClusterEdgeSignature();
    this.estimatedWidth = 0;
    this.estimatedHeight = 0;
    this.noClustering = false;
    this.toTableColumn = false;
  }
}

class ClusterDiscoveryIndex {
  constructor() {
    this.infos = new Map();
    this.edgeOrder = new Map();
    this.edgeNodes = new Map();
    this.sequenceEdges = new Map();
  }

  sequenceOriginal(sequence, edge, guard) {
    let byEdge = this.sequenceEdges.get(sequence);
    if (byEdge === undefined) {
      byEdge = new Map();
      for (const abduction of sequence.edgeAbductions) {
        guard.step();
        if (abduction === null || abduction.edge === null) continue;
        if (abduction.currentFrom === sequence.vessel) {
          if (!byEdge.has(abduction.edge)) byEdge.set(abduction.edge, abduction.originallyFrom);
        } else if (abduction.currentTo === sequence.vessel) {
          if (!byEdge.has(abduction.edge)) byEdge.set(abduction.edge, abduction.originallyTo);
        }
      }
      this.sequenceEdges.set(sequence, byEdge);
    }
    return byEdge.get(edge) ?? null;
  }

  refreshNeighbors(g, node, guard) {
    const info = this.infos.get(node) ?? null;
    if (info === null) throw errorf('TALA AddClusters cannot find node discovery index');
    const neighbors = [];
    const neighborSet = new Set();
    for (const edge of node.edges) {
      guard.step();
      let adjacent = node.adjacent(edge);
      const sequence = g.sequences.get(adjacent) ?? null;
      if (sequence !== null) {
        adjacent = this.sequenceOriginal(sequence, edge, guard);
      }
      if (!neighborSet.has(adjacent)) {
        neighborSet.add(adjacent);
        neighbors.push(adjacent);
      }
    }
    info.neighbors = neighbors;
    info.neighborSet = neighborSet;
    guard.finish();
  }

  refreshAfterClusterAbduction(g, cluster, edges, guard) {
    const affected = [];
    const seen = new Set();
    const addAffected = (node) => {
      guard.step();
      if (node === null || node === cluster.vessel || (this.infos.get(node) ?? null) === null) return;
      if (seen.has(node)) return;
      seen.add(node);
      affected.push(node);
    };
    // clusterIncidentEdges returns graph-edge order. Preserve it and the original
    // candidate-node discovery order. Using the reverse adjacency index also
    // preserves legacy behavior for tolerated asymmetric node.Edges inventories.
    for (const edge of edges) {
      for (const node of this.edgeNodes.get(edge) ?? []) addAffected(node);
    }
    for (const node of affected) this.refreshNeighbors(g, node, guard);
    guard.finish();
  }
}

function clusterIsDescendantOfGuarded(descendant, ancestor, guard) {
  const seen = new Set();
  for (;;) {
    guard.step();
    if (ancestor === descendant) return true;
    if (descendant === null) return false;
    if (seen.has(descendant)) throw errorf('TALA AddClusters found a cycle in node ancestry');
    if (seen.size >= maxEngineNodes) throw errorf('TALA AddClusters ancestry exceeds node limit');
    seen.add(descendant);
    if (descendant.container !== null) {
      descendant = descendant.container;
    } else if (descendant.cluster !== null && descendant.cluster.vessel !== null) {
      descendant = descendant.cluster.vessel;
    } else if (descendant.sequence !== null && descendant.sequence.vessel !== null) {
      descendant = descendant.sequence.vessel;
    } else {
      return ancestor === null;
    }
  }
}

function clusterHasLeakyEdgeGuarded(g, node, guard) {
  if (!node.isContainer()) return false;
  const descendants = g.allDescendantNodesWithWorkGuard(node, true, guard);
  for (const descendant of descendants) {
    guard.step();
    for (const edge of descendant.edges) {
      guard.step();
      const adjacent = descendant.adjacent(edge);
      const inside = clusterIsDescendantOfGuarded(adjacent, node, guard);
      if (!inside) return true;
    }
  }
  guard.finish();
  return false;
}

function buildClusterDiscoveryIndex(g, containerOrder, guard) {
  const orderedNodes = [];
  const seenNodes = new Set();
  const addNode = (node) => {
    guard.step();
    if (node === null) throw errorf('TALA AddClusters contains a nil node');
    if (seenNodes.has(node)) return;
    if (seenNodes.size >= maxEngineNodes) throw errorf(`TALA AddClusters unique node count exceeds limit ${maxEngineNodes}`);
    seenNodes.add(node);
    orderedNodes.push(node);
  };
  for (const container of containerOrder) {
    addNode(container);
    for (const child of g.containers.get(container) ?? []) addNode(child);
  }
  for (const child of g.containers.get(null) ?? []) addNode(child);

  const index = new ClusterDiscoveryIndex();
  for (const node of orderedNodes) {
    const info = new ClusterDiscoveryInfo();
    info.estimatedWidth = node.width;
    info.estimatedHeight = node.height;
    index.infos.set(node, info);
  }

  for (const node of orderedNodes) {
    const info = index.infos.get(node);
    let hasLoop = false;
    for (const edge of node.edges) {
      guard.step();
      const list = index.edgeNodes.get(edge);
      if (list === undefined) index.edgeNodes.set(edge, [node]);
      else list.push(node);
      if (edge.isLoop()) hasLoop = true;
      if (edge.fromTableColumnIndex !== null || edge.toTableColumnIndex !== null) info.toTableColumn = true;
    }
    index.refreshNeighbors(g, node, guard);
    const leaky = clusterHasLeakyEdgeGuarded(g, node, guard);
    info.noClustering = g.isTreeSentinel(node) ||
      node.isClusterVessel() ||
      g.isSequenceVessel(node) ||
      node.isTable() ||
      node.hierarchy !== null ||
      node.fixedTopLeft !== null ||
      leaky ||
      hasLoop;
  }

  for (let edgeIndex = 0; edgeIndex < g.edges.length; edgeIndex++) {
    const edge = g.edges[edgeIndex];
    guard.step();
    if (!index.edgeOrder.has(edge)) index.edgeOrder.set(edge, edgeIndex);
    let info = index.infos.get(edge.from) ?? null;
    if (info !== null) {
      info.edges.push(edge);
      info.edgeSignature.add(edge.from, edge);
    }
    if (edge.to !== edge.from) {
      info = index.infos.get(edge.to) ?? null;
      if (info !== null) {
        info.edges.push(edge);
        info.edgeSignature.add(edge.to, edge);
      }
    }
  }

  guard.finish();
  return index;
}

function clusterIncidentEdges(cluster, infos, edgeOrder, guard) {
  const unique = new Set();
  for (const node of cluster.nodes) {
    guard.step();
    const info = infos.get(node) ?? null;
    if (info === null) throw errorf('TALA AddClusters cannot find cluster member index');
    for (const edge of info.edges) {
      guard.step();
      unique.add(edge);
    }
  }
  const edges = [...unique];
  for (let width = 1; width < edges.length; width *= 2) {
    for (let i = 0; i < edges.length; i++) guard.step();
    if (width > Math.trunc(edges.length / 2)) break;
  }
  sortFunc(edges, (a, b) => compare(edgeOrder.get(a) ?? 0, edgeOrder.get(b) ?? 0));
  guard.finish();
  return edges;
}

// ============================== join.go ==============================

/**
 * joinPositionJournal keeps capture order because separate nodes may share a TopLeft pointer and first reach the journal after
 * different movements.
 */
class JoinPositionJournal {
  constructor() {
    this.captured = null;
    this.snapshots = [];
  }

  capture(node) {
    if (node === null) return false;
    if (this.captured === null) this.captured = new Set();
    if (this.captured.has(node)) return false;
    this.captured.add(node);
    const snapshot = { node, pointer: node.topLeft, value: new geo.Point(0, 0) };
    if (node.topLeft !== null) snapshot.value = node.topLeft.copy();
    this.snapshots.push(snapshot);
    return true;
  }

  moveWithChildren(node, dx, dy, guard) {
    if (dx === 0 && dy === 0) return;
    const firstCapture = this.capture(node);
    if (node.graph === null) {
      guard.step();
      // Preserve the legacy malformed-node panic after journaling the root.
      node.moveWithChildren(dx, dy);
      guard.finish();
      return;
    }
    const graph = node.graph;
    let hasDescendants = node.isContainer() && (graph.containers.get(node) ?? []).length > 0;
    if (node.isClusterVessel()) {
      hasDescendants = hasDescendants || ((graph.clusters.get(node) ?? null) !== null && graph.clusters.get(node).nodes.length > 0);
    }
    hasDescendants = hasDescendants || ((graph.sequences.get(node) ?? null) !== null && graph.sequences.get(node).nodes.length > 0);
    let descendants = [];
    if (hasDescendants) {
      descendants = graph.allDescendantNodesWithWorkGuard(node, true, guard);
    }
    if (firstCapture) {
      for (const descendant of descendants) this.capture(descendant);
    }
    // Reject the complete translation before changing any shared point. The
    // guarded descendant walk above separately accounts hierarchy discovery.
    guard.add(1 + descendants.length);
    node.translate(dx, dy);
    for (const descendant of descendants) descendant.translate(dx, dy);
  }

  restore() {
    // Reverse capture order restores shared pointers through every intermediate
    // value before returning them to their original value.
    for (let index = this.snapshots.length - 1; index >= 0; index--) {
      const snapshot = this.snapshots[index];
      snapshot.node.topLeft = snapshot.pointer;
      if (snapshot.pointer !== null) {
        snapshot.pointer.x = snapshot.value.x;
        snapshot.pointer.y = snapshot.value.y;
      }
    }
  }
}

function joinMedian(points, guard) {
  guard.add(2 * points.length);
  for (let width = 1; width < points.length; width *= 2) {
    guard.add(2 * points.length);
    if (width > Math.trunc(points.length / 2)) break;
  }
  return geo.Points.getMedian(points);
}

function joinContainerFixedOrigin(graph, container, guard) {
  for (const node of graph.nodes) {
    guard.step();
    if (node.owningContainer() !== container) continue;
    const origin = node.fixedOrigin();
    if (origin !== null) return origin;
  }
  return null;
}

/** JoinDistancedClusters incrementally pulls disconnected placement islands toward their common center without introducing overlap. */
export function joinDistancedClusters(ctx, graph) {
  if (ctx.err() !== null) throw errorf(`PlaceNodes: ${ctx.err().message}`, ctx.err());
  let [guard, sharedGuard] = lg.existingTransactionWorkGuard(ctx, 'PlaceNodes');
  let preflightWork = graph.nodes.length;
  if (sharedGuard) guard.add(preflightWork);
  const fixedNodes = graph.fixedNodes();
  if (graph.nodes.length - fixedNodes.length <= 1) {
    if (sharedGuard) guard.finish();
    return;
  }
  if (graph.edges.length === 0) {
    preflightWork += graph.nodes.length;
    if (sharedGuard) guard.add(graph.nodes.length);
    let hasJoinReference = false;
    for (const node of graph.nodes) {
      if (node.edges.length > 0 || node.nears.size > 0) {
        hasJoinReference = true;
        break;
      }
    }
    if (!hasJoinReference) {
      if (sharedGuard) guard.finish();
      return;
    }
  }
  if (!sharedGuard) {
    guard = limits.newWorkGuard(ctx, 'PlaceNodes', limits.MaxTransactionWorkUnits);
    guard.add(preflightWork);
  }
  const positions = new JoinPositionJournal();
  let complete = false;
  try {
    const finish = () => {
      guard.finish();
      complete = true;
    };
    const clusters = lg.Nodes.distanceClustersWithWorkGuard(graph.nodes, 3 * graph.cellSize, guard);
    if (clusters === null || clusters.length === 0) {
      finish();
      return;
    }

    let target;
    if (fixedNodes.length > 0) {
      target = lg.Nodes.centerWithWorkGuard(fixedNodes, guard);
    } else {
      const centers = [];
      for (const cluster of clusters) {
        centers.push(lg.Nodes.centerWithWorkGuard(cluster, guard));
      }
      target = joinMedian(centers, guard);
    }

    const inchTowardsTarget = (cluster, fixedOrigin) => {
      const [topLeft, bottomRight] = lg.Nodes.boundingBoxWithWorkGuard(cluster, guard);
      const center = new geo.Point(topLeft.x + (bottomRight.x - topLeft.x) / 2, topLeft.y + (bottomRight.y - topLeft.y) / 2);
      const distance = geo.euclideanDistance(center.x, center.y, target.x, target.y);
      const length = Math.max(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      if (distance < length / 2) return false;
      let deltaX = 0;
      let deltaY = 0;
      const orientation = center.getOrientation(target);
      if (orientation === Orientation.NONE) throw invariant.newError('No orientation');
      if (orientation === Orientation.Top || orientation === Orientation.TopLeft || orientation === Orientation.TopRight) deltaY = 1;
      if (orientation === Orientation.Bottom || orientation === Orientation.BottomLeft || orientation === Orientation.BottomRight) deltaY = -1;
      if (orientation === Orientation.Left || orientation === Orientation.BottomLeft || orientation === Orientation.TopLeft) deltaX = 1;
      if (orientation === Orientation.Right || orientation === Orientation.TopRight || orientation === Orientation.BottomRight) deltaX = -1;
      if (deltaX === 0 && deltaY === 0) return false;
      deltaX *= graph.cellSize;
      deltaY *= graph.cellSize;

      let hasOverlap = false;
      let hasOverlapX = false;
      let hasOverlapY = false;
      for (const node of cluster) {
        const x = node.topLeft.x + deltaX;
        const y = node.topLeft.y + deltaY;
        if (!hasOverlap) {
          if (fixedOrigin !== null) {
            if (x < fixedOrigin.x) {
              hasOverlapX = true;
              hasOverlap = true;
            }
            if (y < fixedOrigin.y) {
              hasOverlapY = true;
              hasOverlap = true;
            }
          }
          if (!hasOverlap) {
            hasOverlap = graph.wouldOverlapWithWorkGuard(node, new geo.Point(x, y), cluster, null, guard);
          }
        }
        positions.moveWithChildren(node, deltaX, deltaY, guard);
      }
      if (hasOverlap) {
        for (const node of cluster) positions.moveWithChildren(node, -deltaX, -deltaY, guard);
      }
      if (deltaX !== 0 && deltaY !== 0) {
        if (hasOverlapX && !hasOverlapY) {
          hasOverlap = false;
          for (const node of cluster) {
            const x = node.topLeft.x;
            const y = node.topLeft.y + deltaY;
            let overlaps = fixedOrigin !== null && (x < fixedOrigin.x || y < fixedOrigin.y);
            if (!overlaps) {
              overlaps = graph.wouldOverlapWithWorkGuard(node, new geo.Point(x, y), cluster, null, guard);
            }
            if (overlaps) hasOverlap = true;
            positions.moveWithChildren(node, 0, deltaY, guard);
          }
          if (hasOverlap) {
            for (const node of cluster) positions.moveWithChildren(node, 0, -deltaY, guard);
          }
        } else if (!hasOverlapX && hasOverlapY) {
          hasOverlap = false;
          for (const node of cluster) {
            const x = node.topLeft.x + deltaX;
            const y = node.topLeft.y;
            let overlaps = fixedOrigin !== null && (x < fixedOrigin.x || y < fixedOrigin.y);
            if (!overlaps) {
              overlaps = graph.wouldOverlapWithWorkGuard(node, new geo.Point(x, y), cluster, null, guard);
            }
            if (overlaps) hasOverlap = true;
            positions.moveWithChildren(node, deltaX, 0, guard);
          }
          if (hasOverlap) {
            for (const node of cluster) positions.moveWithChildren(node, -deltaX, 0, guard);
          }
        }
      }
      return !hasOverlap;
    };

    for (let iter = 0; iter < 1000; iter++) {
      if (ctx.err() !== null) throw errorf(`PlaceNodes: ${ctx.err().message}`, ctx.err());
      guard.add(1 + clusters.length);
      let moved = false;
      for (const cluster of clusters) {
        if (ctx.err() !== null) throw errorf(`PlaceNodes: ${ctx.err().message}`, ctx.err());
        let fixedOrigin = null;
        if (fixedNodes.length > 0) {
          fixedOrigin = joinContainerFixedOrigin(graph, cluster[0].owningContainer(), guard);
        }
        const clusterMoved = inchTowardsTarget(cluster, fixedOrigin);
        if (clusterMoved) moved = true;
      }
      if (!moved) break;
    }
    if (ctx.err() !== null) throw errorf(`PlaceNodes: ${ctx.err().message}`, ctx.err());
    finish();
  } finally {
    if (!complete) positions.restore();
  }
}

// ============================== lifecycle.go ==============================

/** ResetClusters removes inactive vessel metadata so a later layout rediscovers clusters from ordinary nodes and edges. */
export function resetClusters(graph) {
  if (graph.clusters.size === 0) return;
  const bulkFilter = graph.clusters.size > 1;
  let singleRetiredVessel = null;
  let retiredVesselCount = 0;
  for (const [vessel, cluster] of graph.clusters) {
    if (cluster === null) continue;
    for (const abduction of cluster.edgeAbductions) {
      if (abduction === null || abduction.edge === null) continue;
      if (abduction.originallyFrom !== null) abduction.edge.reconnect(abduction.originallyFrom, false);
      if (abduction.originallyTo !== null) abduction.edge.reconnect(abduction.originallyTo, true);
    }
    for (const node of cluster.nodes) {
      if (node !== null && node.cluster === cluster) node.cluster = null;
      if (node !== null && node.nears !== null) node.nears.delete(vessel);
    }
    if (vessel === null) continue;
    for (const near of vessel.nears) {
      if (near !== null && near.nears !== null) near.nears.delete(vessel);
    }
    vessel.nears = new Set();
    if (bulkFilter) {
      retiredVesselCount++;
      if (retiredVesselCount === 1) singleRetiredVessel = vessel;
    } else {
      graph.nodes = graph.nodes.filter((node) => node !== vessel);
      for (const [container, children] of [...graph.containers]) {
        graph.containers.set(container, children.filter((child) => child !== vessel));
      }
    }
    vessel.container = null;
    vessel.graph = null;
    vessel.unmarkClusterVessel();
  }
  if (!bulkFilter) {
    graph.clusters.clear();
    return;
  }
  if (retiredVesselCount === 0) {
    graph.clusters.clear();
    return;
  }
  if (retiredVesselCount === 1) {
    graph.nodes = graph.nodes.filter((node) => node !== singleRetiredVessel);
    for (const [container, children] of [...graph.containers]) {
      graph.containers.set(container, children.filter((child) => child !== singleRetiredVessel));
    }
    graph.clusters.clear();
    return;
  }
  // The loop above detaches every removable vessel. Check that cheap marker
  // before consulting Clusters so ordinary survivors avoid a map lookup.
  graph.nodes = graph.nodes.filter((node) => !(node !== null && node.graph === null && (graph.clusters.get(node) ?? null) !== null));
  for (const [container, children] of [...graph.containers]) {
    graph.containers.set(container, children.filter((child) => !(child !== null && child.graph === null && (graph.clusters.get(child) ?? null) !== null)));
  }
  graph.clusters.clear();
}

/** Cleanup restores cluster and sequence members after node placement and retires the temporary vessels while retaining rediscovery metadata. */
export function cleanup(graph) {
  for (const key of graph.clusterOrder()) {
    const cluster = graph.clusters.get(key);
    cluster.arrangeClusterNodes();
    for (const node of cluster.nodes) {
      graph.addNewNodeToContainer(cluster.container, node);
    }
    for (const abduction of cluster.edgeAbductions) {
      if (abduction.originallyFrom !== null) abduction.edge.reconnect(abduction.originallyFrom, false);
      if (abduction.originallyTo !== null) abduction.edge.reconnect(abduction.originallyTo, true);
    }
    if (cluster.vessel.nears.size !== 0) {
      for (const near of cluster.vessel.orderedNears()) {
        near.nears.delete(cluster.vessel);
        for (const node of cluster.nodes) near.addNear(node);
      }
      cluster.vessel.nears = new Set();
    }
    graph.removeNode(cluster.vessel);
    const updated = [];
    for (const child of graph.containers.get(cluster.container) ?? []) {
      if (child !== cluster.vessel) updated.push(child);
    }
    graph.containers.set(cluster.container, updated);
    cluster.vessel.container = null;
    cluster.vessel.graph = null;
  }

  for (const vessel of graph.sequenceOrder()) {
    const sequence = graph.sequences.get(vessel);
    sequence.arrangeSteps();
    for (const node of sequence.nodes) {
      graph.addNewNodeToContainer(sequence.container, node);
    }
    for (const abduction of sequence.edgeAbductions) {
      if (abduction.originallyFrom !== null) abduction.edge.reconnect(abduction.originallyFrom, false);
      if (abduction.originallyTo !== null) abduction.edge.reconnect(abduction.originallyTo, true);
    }
    if (sequence.vessel.nears.size !== 0) {
      for (const near of sequence.vessel.orderedNears()) {
        near.nears.delete(sequence.vessel);
        for (const node of sequence.nodes) near.addNear(node);
      }
      sequence.vessel.nears = new Set();
    }
    graph.removeNode(vessel);
    const updated = [];
    for (const child of graph.containers.get(sequence.container) ?? []) {
      if (child !== vessel) updated.push(child);
    }
    graph.containers.set(sequence.container, updated);
    sequence.vessel.container = null;
    sequence.vessel.graph = null;
  }
  for (const node of graph.nodes) {
    node.herdAssignment = null;
  }
}

export { identifySequences as _identifySequences }; // for the unit tests
