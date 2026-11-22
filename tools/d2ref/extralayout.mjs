// Hand-written layout cases for what v0.8.x-v0.9.0 changed (dagre 3.1 self-loops and parallel edges, batched nested extraction, sequence
// and Markdown errors, glyph rounding of composite glyphs, Markdown unicode): node extralayout.mjs > extralayout.jsonl
// then node diff.mjs layout extralayout.jsonl
const cases = {};
const add = (name, text) => { cases[name] = text; };

for (const dir of ['up', 'down', 'left', 'right']) {
  add(`selfloop-${dir}`, `direction: ${dir}\na -> a: self\nb -> a\na -> b: x\nc: {d -> d; e -> d: out}\nc -> c: container loop`);
  add(`selfloop-multi-${dir}`, `direction: ${dir}\na -> a: one\na -> a: two\na -> a\nb -> b: x\na -> b`);
  add(`parallel-${dir}`, `direction: ${dir}\na -> b: one\na -> b: two\na -> b: three\nb -> a: back\nb -> a: back2\nc -> d\nd -> c\nc -> d: again`);
  add(`container-edges-${dir}`, `direction: ${dir}\nx: {a -> b -> c; d}\ny: {e -> f}\nx -> y: between\nx.a -> y: into\ny -> x.c\nx -> x.d\nx.d -> x`);
}
add('same-direction-triple', 'a -> b\na -> b\na -> b\nb -> a\na -> a');
add('reversed-pairs', 'a <- b\na -> b\nb <- a: x\na <-> b\nb -- a');
add('zero-size-nodes', 'a: {shape: circle; label: ""; width: 0; height: 0}\nb: {label: ""; width: 1; height: 1}\na -> b -> a\nb -> b\na -> a');

add('two-grids-and-sequence', 'g1: {grid-rows: 2\n  a\n  b\n  c\n  d}\ng2: {grid-columns: 2\n  e\n  f\n  g}\nseq: {shape: sequence_diagram\n  x -> y: hi\n  y -> x: ho}\ng1.a -> g2.e: cross\nseq.x -> g1.b\ng2.f -> seq.y: back\nplain -> g1\nplain -> seq');
add('nested-diagrams-chain', 'o: {\n  g: {grid-columns: 2\n    a\n    b: {c -> d}\n  }\n  s: {shape: sequence_diagram\n    p -> q\n  }\n  x -> g\n  s -> x\n}\no.g.a -> o.s.p');
add('three-grids-edges', 'a: {grid-rows: 1\n  x\n  y}\nb: {grid-rows: 1\n  z\n  w}\nc: {grid-rows: 1\n  u\n  v}\na.x -> b.z\nb.w -> c.u\nc.v -> a.y\na -> c\nb -> a.x');
add('near-twice', 'title: {near: top-center; shape: text}\nlegend: {near: bottom-right\n  k1\n  k2}\nlegend2: {near: top-left\n  g: {grid-rows: 1\n    q\n    r}\n}\na -> b\nlegend.k1 -> a');
add('grid-in-container-near', 'c: {\n  g: {grid-rows: 2\n    1\n    2\n    3}\n  h: {shape: sequence_diagram\n    a -> b}\n}\nn: {near: top-right\n  inner}\nc -> n');
add('infinite-sequence', 'Office chatter: {\n  shape: sequence_diagram\n  alice: Alice\n  bob: Bobby\n  awkward small talk: {\n    awkward small talk.ok\n    alice -> bob: uhm, hi\n    bob -> alice: oh, hello\n    icebreaker attempt: {\n      alice -> bob: what did you have for lunch?\n    }\n    unfortunate outcome: {\n      bob -> alice: that\'s personal\n    }\n  }\n}');
add('sequence-actor-is-sequence', 's: {shape: sequence_diagram\n  a: {shape: sequence_diagram\n    x -> y}\n  b\n  a -> b}');
add('sequence-lifeline-ids', 'shape: sequence_diagram\nalice-lifeline-end-1: A\nbob\nalice-lifeline-end-1 -> bob: hi\nbob -> alice-lifeline-end-1');

add('md-div-error', 'a: |md\n  <div>raw</div>\n|\na -> b');
add('md-span-error', 'a: |md\n  <span>inline</span> text\n|');
add('md-ok-html', 'a: |||md\n  # T\n  <b>bold</b> <em>em</em> <br/> <del>x</del> <a href="https://x.y?a=1&b=2">l</a>\n  | h | i |\n  |---|---|\n  | j | k |\n|||');
add('md-unicode', 'a: |md\n  ❤️ heart \u{1F468}‍\u{1F469}‍\u{1F467} family 日本語 \u{1F1FA}\u{1F1F8}\n  x‍y a­b café\n|\nb: |md\n  ​ zero⁠width ️ lone\n|');
add('md-nested', 'a: |md\n  - one\n    - two\n      - three\n  1. x\n  2. y\n\n  > quote\n  > > nested\n\n  ```go\n  func main() {}\n  ```\n\n  ---\n|');
add('md-font-sizes', 'a: |md\n  ## Title `code`\n  text *em* **strong** ***both***\n|\na.style.font-size: 13\nb: |md\n  ###### small\n|\nb.style.font-size: 20');

for (const size of [10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32]) {
  add(`glyph-i-${size}`, `a: "ijijijiiii jjj" {style.font-size: ${size}}\nb: "i" {style.font-size: ${size}}\nc: "j" {style.font-size: ${size}; style.bold: true}\nd: "ij" {style.font-size: ${size}; style.italic: true}\ne: {shape: sql_table\n  id: int {style.font-size: ${size}}\n  name: varchar\n}\nf: |go\n  func i() { j() }\n| {style.font-size: ${size}}`);
}
add('glyph-fonts', 'a: ijij {style.font: mono}\nb: ijij {style.font: mono; style.bold: true}\nc: ijij {style.font: mono; style.italic: true}\nd: ijij {style.font: mono; style.font-size: 28; style.italic: true}\nvars: {d2-config: {sketch: true}}');
add('unicode-labels', 'a: "日本語 テキスト"\nb: "😀 smile ❤️"\nc: "שלום עולם"\nd: "é combined"\ne: "mixed 中文 english"\na -> b -> c -> d -> e');

add('big-grid', `grid-rows: 5\n${Array.from({ length: 31 }, (_, i) => `n${i}: {width: ${20 + ((i * 37) % 160)}; height: ${20 + ((i * 53) % 90)}}`).join('\n')}`);
add('big-grid-columns', `grid-columns: 6\ngrid-gap: 7\n${Array.from({ length: 40 }, (_, i) => `n${i}: ${'x'.repeat(1 + ((i * 7) % 11))}`).join('\n')}`);
add('sparse-grid', `grid-rows: 3\ngrid-columns: 7\n${Array.from({ length: 17 }, (_, i) => `n${i}: {height: ${20 + ((i * 29) % 100)}; width: ${20 + ((i * 41) % 130)}}`).join('\n')}\nn0 -> n9\nn3 -> n16`);

for (const [name, text] of Object.entries(cases)) console.log(JSON.stringify({ from: `extralayout:${name}`, path: 'x.d2', text: text + '\n' }));
