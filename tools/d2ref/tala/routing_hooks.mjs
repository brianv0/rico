// Inserts the harness hooks (routing_xdump.go: xHook*) into graph_stage.go and coordinator.go of the writable D2 copy.
// Usage: node routing_hooks.mjs <dir of internal/routing>. Idempotent (a marker comment); fails loudly if an anchor is missing.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: routing_hooks.mjs <internal/routing dir>'); process.exit(2); }
const MARK = '// xdump-hook';

function patch(file, edits) {
  const p = path.join(dir, file);
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes(MARK)) return; // already patched
  for (const [anchor, replacement] of edits) {
    const i = s.indexOf(anchor);
    if (i < 0) { console.error(`routing_hooks: anchor not found in ${file}: ${anchor}`); process.exit(1); }
    s = s.slice(0, i) + replacement + s.slice(i + anchor.length);
  }
  fs.writeFileSync(p, s + `\n${MARK}\n`);
}

patch('graph_stage.go', [
  ['\t\tsubgraphs, splitOwnership, splitErr := graph.SplitSubgraphsTracked(',
    '\t\txHookRouteGraph(graph)\n\t\tsubgraphs, splitOwnership, splitErr := graph.SplitSubgraphsTracked('],
  ['\t\t\tovg, routeErr := routeEdgesWithResourceGuards(routingCtx, subgraph, nodesInBoundingBox, ovgGuard, maxRouteSearchWorkUnits)\n',
    '\t\t\txHookSubgraph(subgraph, nodesInBoundingBox)\n\t\t\tovg, routeErr := routeEdgesWithResourceGuards(routingCtx, subgraph, nodesInBoundingBox, ovgGuard, maxRouteSearchWorkUnits)\n\t\t\txHookSubgraphDone(subgraph, routeErr)\n'],
]);
patch('coordinator.go', [
  ['\tovg, err := buildOVGFromGraphWithGuard(g, nearbyNodes, ovgGuard)\n',
    '\tovg, err := buildOVGFromGraphWithGuard(g, nearbyNodes, ovgGuard)\n\txHookOVG(g, ovg, ovgGuard, err)\n'],
  ['\tflavors := []RouteGenerationFlavor{ShortestToLongest, LongestToShortest, Default}\n',
    '\txHookExisting(ovg, existingRoutes, unroutedEdges)\n\tflavors := []RouteGenerationFlavor{ShortestToLongest, LongestToShortest, Default}\n'],
  ['\tresponses, err := generateRouteFlavorResponses(ctx, routers, true)\n',
    '\tresponses, err := generateRouteFlavorResponses(ctx, routers, true)\n\txHookResponses(ovg, routers, responses, err)\n'],
]);
