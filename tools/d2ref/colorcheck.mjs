// JS side of `color` mode (tools/d2ref/colorcheck.go), plus the generator for its input:
//   node colorcheck.mjs > color.jsonl
import * as color from '../../public/d2/color.js';

const F = (v) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : v);

export function colorCheck(c) {
  const s = c.text;
  const out = {};
  const put = (name, fn) => {
    try { out[name] = fn(); } catch (e) { out[name] = { err: e.message }; }
  };
  put('darken', () => color.darken(s));
  put('lumcat', () => color.luminanceCategory(s));
  put('lum', () => F(color.luminance(s)));
  out.valid = color.validColor(s);
  out.isTheme = color.isThemeColor(s);
  out.isGradient = color.isGradient(s);
  out.isURLGradient = color.isURLGradientID(s);
  put('hex2rgb', () => { const r = color.hex2RGB(s); return [r.Red, r.Green, r.Blue]; });
  const n = color.name2RGB(s);
  out.name2rgb = [n.Red, n.Green, n.Blue];
  out.isLight = color.isLight(n);
  try {
    const g = color.parseGradient(s);
    out.gradient = { g: { ...g, ColorStops: g.ColorStops.length ? g.ColorStops : null }, svg: color.gradientToSVG(g) };
  } catch (e) { out.gradient = { err: e.message }; }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const list = [
    '', ' ', 'red', 'RED', 'Transparent', 'transparent', 'currentcolor', 'rebeccapurple', 'muintcream', 'mintcream', 'N1', 'N7', 'B1', 'B6', 'AA2', 'AA5', 'AB4', 'AB5', 'N8', 'B7', 'AA3',
    '#fff', '#FFF', '#ffffff', '#FFFFFF', '#12345678', '#1234', '#12', '#gggggg', '#', 'ffffff', 'fff', '123456', '#0f0', '#abcdef',
    'rgb(1,2,3)', 'rgb(255 0 0 / 50%)', 'rgba(10%, 20%, 30%, 0.4)', 'rgb(1,2)', 'rgb(a,b,c)', 'RGB( 1 , 2 , 3 )', 'rgb(300, -5, 1.5)',
    'hsl(120, 100%, 50%)', 'hsl(120deg 50% 50%)', 'hsla(0.5turn, 50%, 50%, 0.5)', 'hsl(2rad, 0.3, 0.4)', 'hsl(100grad 10% 10%)', 'hsl(0, 0%, 0%)', 'hsl(360, 100%, 25%)', 'hsl(-30, 40%, 60%)',
    'hwb(194 0% 0%)', 'hwb(0 50% 50%)', 'hsv(120 100% 100%)', 'hsv(0 0% 50%)', 'oklab(0.5 0.1 0.1)', 'oklab(50% 0.1 -20%)', 'oklch(0.7 0.1 120)', 'oklch(60% 50% 30deg)',
    'foo(1,2,3)', 'rgb(1,2,3', '(1,2,3)', 'rgb', 'rgb()',
    'linear-gradient(red, blue)', 'linear-gradient(to right, red, blue)', 'linear-gradient(45deg, #fff 0%, #000 100%)', 'linear-gradient(to bottom left, red 10%, rgb(1, 2, 3) 50%, blue)', 'radial-gradient(circle, red, blue)',
    'radial-gradient(red, yellow, green)', 'linear-gradient(red)', 'linear-gradient()', 'linear-gradient(to top)', 'linear-gradient(90deg, red, blue, green, yellow)', 'linear-gradient(abcdeg, red, blue)',
    'linear-gradient(135.5deg, red, blue)', 'linear-gradient(red 1 2, blue)', "url('#grad-0123456789abcdef0123456789abcdef01234567')", "url('#grad-xyz')", 'conic-gradient(red, blue)', 'linear-gradient(red, blue', '  linear-gradient( red , blue )  ',
  ];
  for (const n of ['black', 'white', 'gold', 'darkgrey', 'lightgoldenrodyellow', 'aliceblue', 'yellowgreen']) list.push(n);
  const hex = () => '#' + Array.from({ length: 3 }, () => rnd(256).toString(16).padStart(2, '0')).join('');
  for (let i = 0; i < 1500; i++) list.push(hex());
  for (let i = 0; i < 300; i++) list.push(`rgb(${rnd(256)}, ${rnd(256)}, ${rnd(256)})`);
  for (let i = 0; i < 300; i++) list.push(`hsl(${rnd(361)}, ${rnd(101)}%, ${rnd(101)}%)`);
  for (let i = 0; i < 100; i++) list.push(`hsl(${rnd(3600) / 10}, ${rnd(1000) / 10}%, ${rnd(1000) / 10}%)`);
  for (let i = 0; i < 100; i++) list.push(`hwb(${rnd(361)} ${rnd(101)}% ${rnd(101)}%)`);
  for (let i = 0; i < 50; i++) list.push(`linear-gradient(${rnd(360)}deg, ${hex()}, ${hex()} ${rnd(100)}%)`);
  process.stdout.write(list.map((text) => JSON.stringify({ text })).join('\n') + '\n');
}
