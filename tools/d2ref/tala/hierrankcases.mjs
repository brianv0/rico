// Random inputs of the hierrank check (the network-simplex ranker as a pure function):
//   node tala/hierrankcases.mjs [count=3000] [seed=1] > tala-hierrank.jsonl
// Case: {args: {nodes: [ids], edges: [{id, from, to, weight}], limits: [work limits]}}. Mostly connected simple DAGs of every density and
// weight pattern; a share of defective inputs (cycle, self edge, duplicate edge, zero weight, disconnected) exercises the error paths, and
// the small work limits make the budget run out at every kind of step.
const count = Number(process.argv[2] || 3000);
let state = Number(process.argv[3] || 1) >>> 0;
const rnd = () => { // mulberry32
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];

function makeCase(i) {
  const shape = pick(['tiny', 'small', 'small', 'medium', 'medium', 'wide', 'chain', 'layered', 'big']);
  const n = shape === 'tiny' ? 1 + int(4) : shape === 'small' ? 2 + int(10) : shape === 'medium' ? 8 + int(30) : shape === 'wide' ? 5 + int(25) : shape === 'chain' ? 3 + int(30) : shape === 'layered' ? 6 + int(40) : 60 + int(120);
  const idStyle = pick(['seq', 'rand', 'big', 'neg']);
  const used = new Set();
  const ids = [];
  while (ids.length < n) {
    let id;
    if (idStyle === 'seq') id = ids.length + 1;
    else if (idStyle === 'rand') id = 1 + int(1e6);
    else if (idStyle === 'big') id = 1 + int(2 ** 30) * 2 ** 21 + int(2 ** 21); // beyond 2^50: numbers stay exact below 2^53
    else id = int(2000) - 1000;
    if (!used.has(id)) { used.add(id); ids.push(id); }
  }
  // a topological order over a shuffled copy: edges go forward in it (a DAG), then the nodes are named in the random order
  const order = ids.slice();
  for (let k = order.length - 1; k > 0; k--) { const j = int(k + 1); [order[k], order[j]] = [order[j], order[k]]; }
  const edges = [];
  const have = new Set();
  const edgeIDs = new Set();
  const addEdge = (a, b) => {
    const key = `${a},${b}`;
    if (have.has(key)) return false;
    have.add(key);
    let eid;
    do { eid = pick([1 + int(5000), 1 + int(2 ** 31)]); } while (edgeIDs.has(eid));
    edgeIDs.add(eid);
    edges.push({ id: eid, from: a, to: b, weight: pick([1, 1, 1, 1, 2, 3, 1 + int(7)]) });
    return true;
  };
  // spanning connection first
  for (let k = 1; k < n; k++) {
    let p;
    if (shape === 'chain') p = k - 1;
    else if (shape === 'layered') p = Math.max(0, k - 1 - int(Math.min(k, 4)));
    else p = int(k);
    if (rnd() < 0.5) addEdge(order[p], order[k]);
    else addEdge(order[p], order[k]);
  }
  const extra = shape === 'tiny' ? int(3) : shape === 'wide' ? int(n) : shape === 'chain' ? int(n) : shape === 'big' ? int(2 * n) : int(2 * n);
  for (let k = 0; k < extra; k++) {
    const a = int(n), b = int(n);
    if (a === b) continue;
    addEdge(order[Math.min(a, b)], order[Math.max(a, b)]);
  }
  // edge declaration order is part of the input: shuffle
  for (let k = edges.length - 1; k > 0; k--) { const j = int(k + 1); [edges[k], edges[j]] = [edges[j], edges[k]]; }
  let defect = null;
  const roll = rnd();
  if (roll < 0.04 && edges.length > 1) { defect = 'cycle'; const e = pick(edges); addEdge(e.to, e.from); }
  else if (roll < 0.06) { defect = 'self'; const a = pick(ids); edges.push({ id: 90000000 + i, from: a, to: a, weight: 1 }); }
  else if (roll < 0.08 && edges.length) { defect = 'weight'; pick(edges).weight = pick([0, -3]); }
  else if (roll < 0.10 && n > 2) { defect = 'disconnected'; edges.splice(int(edges.length), 1); }
  else if (roll < 0.11 && edges.length) { defect = 'dupid'; const e = pick(edges); const e2 = pick(edges); e2.id = e.id; }
  return { name: `rank/${i}/${shape}${defect ? '/' + defect : ''}`, args: { nodes: ids, edges, limits: [30, 120 + int(400), 1500 + int(5000), 30000, 200000] } };
}

for (let i = 0; i < count; i++) console.log(JSON.stringify(makeCase(i)));
