// Hand-written D2 programs with LaTeX labels for the layout and svg stages:
//   node latexcases.mjs > extra-latex.jsonl && node diff.mjs layout extra-latex.jsonl && node diff.mjs svg extra-latex.jsonl
//   node latexcases.mjs --gap > extra-latex-gap.jsonl     # the programs on which MathJax and mathjax-go differ (see docs/d2-port.md, "LaTeX")
const progs = {
  'shape': 'a: |latex\n  x^2 + y^2 = r^2\n|',
  'tex-alias': 'a: |tex \\frac{1}{2} |',
  'edge-label': 'a -> b: |latex \\sum_{i=0}^n i |\nb -> a: plain',
  'edge-label-bidirectional': 'a <-> b: |latex \\alpha \\to \\beta |',
  'text-shape': 'a: {\n  shape: text\n  label: |latex e = mc^2 |\n}\nb\na -> b',
  'style': 'a: |latex x |\na.style.font-color: red\na.style.fill: lightblue\na.style.stroke: green\na.style.opacity: 0.5\nb: |latex y |\nb.style.font-color: "#ff00aa"',
  'dark-theme': 'a: |latex \\int_0^1 x\\,dx |\nb: |latex \\ce{H2O} |\na -> b\nd2-config: { theme-id: 200; dark-theme-id: 200 }',
  'theme-300': 'a: |latex \\frac{a}{b} |\nb\na -> b: |latex \\beta |\nd2-config: { theme-id: 300 }',
  'container': 'g: {\n  label: |latex \\Omega |\n  x\n  y: |latex \\Sigma |\n  x -> y\n}',
  'label-positions': 'a: |latex x_1 |\na.near: top-center\nb: |latex y | {\n  label.near: outside-bottom-center\n}\nc: |latex z | {\n  label.near: border-top-left\n}\nd: |latex w | {\n  label.near: inside-bottom-right\n}',
  'link': 'a: |latex x | {\n  link: https://example.com\n}\na -> b: |latex y | {\n  link: https://example.com/b\n}',
  'tooltip-icon': 'a: |latex x | {\n  tooltip: hello\n  icon: https://icons.terrastruct.com/essentials%2F092-graph%20bar.svg\n}',
  'shapes': 'a: |latex x | {shape: circle}\nb: |latex y | {shape: hexagon}\nc: |latex z | {shape: diamond}\nd: |latex w | {shape: oval}\ne: |latex v | {shape: cloud}\nf: |latex u | {shape: person}',
  'sizes': 'a: |latex \\Huge x | {width: 300; height: 200}\nb: |latex \\tiny y |',
  '3d-multiple': 'a: |latex x | {style.3d: true}\nb: |latex y | {style.multiple: true}\nc: |latex z | {style.shadow: true}',
  'sequence': 'shape: sequence_diagram\na -> b: |latex \\frac{x}{y} |\nb -> a: ok\na: |latex A |',
  'grid': 'grid-rows: 2\na: |latex \\alpha |\nb: |latex \\beta |\nc\nd: |latex \\delta |',
  'near': 'a: |latex x |\nn: |latex y | {near: top-right}',
  'direction': 'direction: right\na: |latex \\gamma |\nb: |latex \\delta |\nc: |latex \\epsilon |\na -> b -> c',
  'layers': 'a: |latex x |\nlayers: {\n  l: {\n    b: |latex y |\n    b -> c: |latex \\to |\n  }\n}\nscenarios: {\n  s: {\n    a: |latex z |\n  }\n}\nsteps: {\n  one: {\n    d: |latex w |\n  }\n}',
  'class': 'classes: { m: { label: |latex x^2 | } }\na.class: m\nb.class: m',
  'invalid-merror': 'a: |latex \\frac{1} |\nb: |latex \\undefinedmacro |\nc: |latex { |\na -> b -> c',
  'tag-error': 'a: |latex x \\tag{1} |',
  'empty': 'a: |latex |',
  'whitespace': 'a: |latex\n\n   x   \n\n|',
  'multiline': 'a: |latex\n  a + b\n  = c\n|\nb: |latex \\begin{aligned} a &= b \\\\ c &= d \\end{aligned} |',
  'unicode': 'a: |latex \\text{caf\u00e9 \u4e2d\u6587 \u03c0} |\nb: |latex \u03b1 + \u03b2 |',
  'special': 'a: |latex a`b${c} |\nb: |latex $x$ |\nc: |latex 50\\% \\& \\# |',
  'mhchem': 'a: |latex \\ce{SO4^2- + Ba^2+ -> BaSO4 v} |\nb: |latex \\pu{1.2 kg} |',
  'physics': 'a: |latex \\bra{a}\\ket{b} + \\dd{x} |\nb: |latex \\cancel{x} + \\color{red}{y} |',
  'text-transform': 'a: |latex x | {style.text-transform: uppercase}\nb: |latex y | {style.font: mono; style.bold: true; style.font-size: 30}',
  'markdown-and-latex': 'a: |md # hi |\nb: |latex x |\nc: |python print(1) |\na -> b: |latex y |\nb -> c: |md **bold** |',
  'connection-styles': 'a -> b: |latex \\sqrt{x} | {\n  style.stroke: red\n  style.font-color: blue\n  style.opacity: 0.4\n  style.animated: true\n}\na -> b: second',
  'arrowhead-label': 'a -> b: {\n  source-arrowhead.label: |latex x |\n  target-arrowhead: {label: |latex y |; shape: diamond}\n}',
  'near-edge': 'a -> b: |latex hello |\nb -> c: x {\n  label.near: 0.1\n}',
  'import-vars': 'vars: { f: "x^2" }\na: |latex ${f} |',
  'big-formula': 'a: |latex\n  \\begin{equation} \\label{eq1}\n  \\begin{split}\n  A & = \\frac{\\pi r^2}{2} \\\\\n   & = \\frac{1}{2} \\pi r^2\n  \\end{split}\n  \\end{equation}\n|',
};
// formulas on which MathJax 3.2.2 and D2 v0.9.0's mathjax-go give different SVG (error message text, the ` character, \pu spacing)
const gap = new Set(['invalid-merror', 'special', 'mhchem']);
const wantGap = process.argv.includes('--gap');
for (const [name, text] of Object.entries(progs)) if (gap.has(name) === wantGap) console.log(JSON.stringify({ from: `extra:latex-${name}`, path: 'index.d2', text }));
