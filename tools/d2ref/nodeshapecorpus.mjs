// Cases for the talanodeshape stage: every shape type x several box sizes x table column counts. node nodeshapecorpus.mjs > tala-nodeshape.jsonl
const types = ['', 'rectangle', 'square', 'page', 'parallelogram', 'document', 'cylinder', 'queue', 'package', 'step', 'callout', 'stored_data',
  'person', 'c4-person', 'diamond', 'oval', 'circle', 'hexagon', 'cloud', 'sql_table', 'class', 'text', 'code', 'image', 'Square', 'Circle', 'Table', 'Class',
  'Text', 'Code', 'Image', 'Person', 'C4Person', 'Cloud', 'Oval', 'Diamond', 'Hexagon', 'Cylinder', 'Queue', 'Package', 'Page', 'Parallelogram', 'Document',
  'Callout', 'StoredData', 'Step', 'RealSquare', 'Table', 'unknown'];
const sizes = [[100, 100], [53, 66], [300, 80], [40, 200], [20, 20], [150, 90], [74.5, 31.25]];
const out = [];
for (const shape of types) {
  for (const [width, height] of sizes) {
    for (const numColumns of (/table|sql/i.test(shape) ? [0, 1, 2, 3, 5] : [0])) {
      out.push({ shape, x: 7, y: 13, width, height, numColumns });
    }
  }
}
console.log(out.map((c) => JSON.stringify(c)).join('\n'));
