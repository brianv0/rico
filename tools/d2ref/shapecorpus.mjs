// Input for `node diff.mjs shape shape.jsonl`: every shape type over a grid of box sizes.
//   node shapecorpus.mjs > shape.jsonl
const types = ['Square', 'RealSquare', 'Parallelogram', 'Document', 'Cylinder', 'Queue', 'Page', 'Package', 'Step', 'Callout', 'StoredData',
  'Person', 'C4Person', 'Diamond', 'Oval', 'Circle', 'Hexagon', 'Cloud', 'Table', 'Class', 'Text', 'Code', 'Image', 'Unknown'];
const sizes = [[10, 10], [20, 20], [26, 40], [35, 12], [50, 30], [100, 100], [200, 60], [60, 200], [333, 77], [1000, 400], [76.5, 33.25], [48, 96], [150, 150], [75, 25], [500, 500]];
const out = [];
for (const shape of types) for (const [width, height] of sizes) out.push(JSON.stringify({ shape, width, height }));
process.stdout.write(out.join('\n') + '\n');
