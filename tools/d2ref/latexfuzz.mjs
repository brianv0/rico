// Generates LaTeX formulas for the `latex` stage of diff.mjs (one {"text": ...} per line) from a small grammar:
//   node latexfuzz.mjs N seed [--invalid P]    (P: fraction of formulas that get a random mutation that makes them (probably) invalid)
// Valid formulas use the constructs of D2's TeX packages (base, ams, mathtools, amscd, braket, cancel, cases, color, gensymb, mhchem,
// physics); mutations truncate, drop or duplicate characters and insert undefined macros, stray braces, `#`, `&`, `$`, `%`.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const [n = 200, seed = 1, ...rest] = process.argv.slice(2).map((a) => (/^-?\d+(\.\d+)?$/.test(a) ? Number(a) : a));
const invalidP = rest.includes('--invalid') ? Number(rest[rest.indexOf('--invalid') + 1]) : 0.15;
const r = rng(seed * 2654435761);
const pick = (a) => a[Math.floor(r() * a.length)];
const chance = (p) => r() < p;

const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const greek = ['\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\varepsilon', '\\zeta', '\\eta', '\\theta', '\\vartheta', '\\iota', '\\kappa', '\\lambda', '\\mu', '\\nu', '\\xi', '\\pi', '\\varpi', '\\rho', '\\sigma', '\\tau', '\\upsilon', '\\phi', '\\varphi', '\\chi', '\\psi', '\\omega', '\\Gamma', '\\Delta', '\\Theta', '\\Lambda', '\\Xi', '\\Pi', '\\Sigma', '\\Phi', '\\Psi', '\\Omega'];
const syms = ['\\infty', '\\partial', '\\nabla', '\\hbar', '\\ell', '\\forall', '\\exists', '\\emptyset', '\\neg', '\\angle', '\\triangle', '\\cdots', '\\ldots', '\\vdots', '\\ddots', '\\prime', '\\Re', '\\Im', '\\aleph', '\\wp', '\\top', '\\bot', '\\degree', '\\celsius', '\\micro', '\\ohm', '\\perthousand', '\\checkmark', '\\dagger', '\\therefore', '\\because'];
const binops = ['+', '-', '\\pm', '\\mp', '\\times', '\\div', '\\cdot', '\\ast', '\\star', '\\circ', '\\bullet', '\\oplus', '\\otimes', '\\cup', '\\cap', '\\setminus', '\\wedge', '\\vee', '*', '/'];
const rels = ['=', '\\neq', '<', '>', '\\leq', '\\geq', '\\ll', '\\gg', '\\approx', '\\equiv', '\\sim', '\\simeq', '\\cong', '\\propto', '\\in', '\\notin', '\\subset', '\\subseteq', '\\supset', '\\to', '\\mapsto', '\\Rightarrow', '\\Leftrightarrow', '\\leftarrow', '\\longrightarrow', '\\implies', '\\iff', '\\perp', '\\parallel', '\\mid', ':=', '\\coloneqq', '\\eqqcolon', '\\vcentcolon'];
const bigops = ['\\sum', '\\prod', '\\coprod', '\\int', '\\iint', '\\iiint', '\\oint', '\\bigcup', '\\bigcap', '\\bigoplus', '\\bigotimes', '\\bigvee', '\\bigwedge', '\\lim', '\\limsup', '\\liminf', '\\max', '\\min', '\\sup', '\\inf', '\\det', '\\gcd', '\\Pr'];
const funcs = ['\\sin', '\\cos', '\\tan', '\\cot', '\\sec', '\\csc', '\\arcsin', '\\arccos', '\\arctan', '\\sinh', '\\cosh', '\\tanh', '\\log', '\\ln', '\\lg', '\\exp', '\\deg', '\\dim', '\\ker', '\\arg', '\\hom', '\\mod'];
const accents = ['\\hat', '\\check', '\\tilde', '\\acute', '\\grave', '\\dot', '\\ddot', '\\dddot', '\\breve', '\\bar', '\\vec', '\\widehat', '\\widetilde', '\\overline', '\\underline', '\\overrightarrow', '\\overleftarrow', '\\overleftrightarrow', '\\underrightarrow', '\\mathring', '\\not'];
const fonts = ['\\mathrm', '\\mathbf', '\\mathit', '\\mathsf', '\\mathtt', '\\mathbb', '\\mathcal', '\\mathscr', '\\mathfrak', '\\boldsymbol', '\\bm', '\\textbf', '\\textit', '\\textrm', '\\textsf', '\\texttt', '\\pmb', '\\operatorname'];
const sizes = ['\\tiny', '\\scriptsize', '\\small', '\\normalsize', '\\large', '\\Large', '\\LARGE', '\\huge', '\\Huge'];
const styles = ['\\displaystyle', '\\textstyle', '\\scriptstyle', '\\scriptscriptstyle'];
const spaces = ['\\,', '\\;', '\\:', '\\!', '\\ ', '\\quad', '\\qquad', '~', '\\enspace', '\\thinspace', '\\hspace{1em}', '\\hspace{3pt}', '\\kern2mu', '\\mkern-3mu', '\\mskip5mu', '\\phantom{x}', '\\hphantom{ab}', '\\vphantom{\\int}', '\\smash{x}'];
const words = ['if', 'otherwise', 'for all', 'where', 'and', 'hello world', 'x is positive', 'speed (m/s)', 'a, b; c', 'ünïcode', 'café', 'price: $5', '50%', 'A&B', 'a_b', 'e.g.', "it's", 'tab\tsep', '100\\%', 'end.', '中文', 'naive', 'x/y', 'a-b', '"quoted"', '#1', '~tilde'];
const colors = ['red', 'blue', 'green', 'black', 'orange', 'purple', 'gray', 'cyan', 'magenta', '#ff8800', 'RGB'];
const delims = [['(', ')'], ['[', ']'], ['\\{', '\\}'], ['\\langle', '\\rangle'], ['|', '|'], ['\\|', '\\|'], ['\\lfloor', '\\rfloor'], ['\\lceil', '\\rceil'], ['.', ')'], ['(', '.'], ['\\lbrace', '\\rbrace'], ['\\vert', '\\vert'], ['\\Vert', '\\Vert']];
const chems = ['H2O', 'CO2', '2H2 + O2 -> 2H2O', 'H+', 'SO4^2-', 'Fe^{3+}', 'A <=> B', 'A <-> B', 'N2 + 3H2 <=>[Fe] 2NH3', 'CH3-CH2-OH', '^{227}_{90}Th+', 'NaCl(aq)', 'x A + y B -> z C', 'CuSO4*5H2O', '\\mu mol', '1/2 O2', 'A ->[\\text{heat}] B', 'H2O(l)', '$n$ H2O', 'C6H12O6', 'Ca(OH)2', '\\pu{1.2 kg}', '\\pu{123 mol/L}', '\\pu{8.3e-3 m s-1}', 'ATP4-', 'e-', 'Pb^2+', 'v', '^3He', 'RNA', 'K4[Fe(CN)6]', 'a<->b', 'A + B <=>> C', 'X -> Y ->[a][b] Z'];

function atom(d) {
  const x = r();
  if (x < 0.25) return pick(letters) + (chance(0.15) ? pick(['', '1', '2', 'i', 'n']) : '');
  if (x < 0.30) return String(Math.floor(r() * 1000)) + (chance(0.2) ? '.' + Math.floor(r() * 100) : '');
  if (x < 0.40) return pick(greek);
  if (x < 0.46) return pick(syms);
  if (x < 0.50) return pick(funcs);
  if (x < 0.55) return pick(['(', ')', '[', ']', '|', '!', '?', "'", ',', ';', ':', '.', '@', '`', '"', '<', '>', '\\{', '\\}', '\\|', '\\backslash', '\\%', '\\&', '\\#', '\\$', '\\_', '\\ldots', '/']);
  return group(d);
}
function ssub(d) {
  let a = atom(d);
  if (chance(0.3)) a += '_' + arg(d);
  if (chance(0.3)) a += '^' + arg(d);
  return a;
}
function arg(d) {
  if (chance(0.5)) return pick(letters.slice(0, 26)) ;
  return '{' + expr(d + 1) + '}';
}
function expr(d) {
  if (d > 4) return pick(letters);
  const k = 1 + Math.floor(r() * (d > 2 ? 3 : 5));
  const parts = [];
  for (let i = 0; i < k; i++) {
    parts.push(term(d));
    if (i < k - 1) parts.push(chance(0.6) ? pick(binops) : pick(rels));
  }
  // a control word must not run into a following letter (`\\cap` + `S` would read as `\\capS`)
  let out = '';
  for (const p of parts) {
    if (out !== '' && (/[A-Za-z]$/.test(out) && /^[A-Za-z]/.test(p) && /\\[A-Za-z]+$/.test(out) || chance(0.3))) out += ' ';
    out += p;
  }
  return out;
}
function table(d, cols, rows, sep = '&') {
  const rws = [];
  for (let i = 0; i < rows; i++) {
    const cs = [];
    for (let j = 0; j < cols; j++) cs.push(chance(0.2) ? pick(letters) : expr(d + 2));
    rws.push(cs.join(sep));
  }
  return rws.join(' \\\\ ');
}
function group(d) {
  const x = r();
  if (d > 3) return pick(letters);
  if (x < 0.14) return `\\frac{${expr(d + 1)}}{${expr(d + 1)}}`;
  if (x < 0.18) return `${pick(['\\dfrac', '\\tfrac', '\\cfrac', '\\binom', '\\dbinom', '\\genfrac(){0pt}{}'])}{${expr(d + 1)}}{${expr(d + 1)}}`;
  if (x < 0.24) return chance(0.3) ? `\\sqrt[${pick(['3', 'n', '\\alpha'])}]{${expr(d + 1)}}` : `\\sqrt{${expr(d + 1)}}`;
  if (x < 0.32) {
    const op = pick(bigops);
    return `${op}${chance(0.7) ? '_{' + expr(d + 2) + '}' : ''}${chance(0.7) ? '^{' + expr(d + 2) + '}' : ''} ${term(d + 1)}`;
  }
  if (x < 0.38) { const [l, rr] = pick(delims); return `\\left${l} ${expr(d + 1)} \\right${rr}`; }
  if (x < 0.40) { const [l, rr] = pick(delims); return `${pick(['\\big', '\\Big', '\\bigg', '\\Bigg'])}${l} ${expr(d + 1)} ${pick(['\\big', '\\Big', '\\bigg', '\\Bigg'])}${rr}`; }
  if (x < 0.46) return `${pick(accents)}{${expr(d + 2)}}`;
  if (x < 0.52) return `${pick(fonts)}{${chance(0.5) ? expr(d + 2) : pick(words)}}`;
  if (x < 0.56) return `\\text{${pick(words)}}`;
  if (x < 0.60) { const env = pick(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix']); return `\\begin{${env}} ${table(d, 1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3))} \\end{${env}}`; }
  if (x < 0.63) return `\\begin{cases} ${table(d, 2, 1 + Math.floor(r() * 3))} \\end{cases}`;
  if (x < 0.67) { const env = pick(['aligned', 'gathered', 'split']); return `\\begin{${env}} ${table(d, env.startsWith('gath') ? 1 : 2, 1 + Math.floor(r() * 3))} \\end{${env.replace(/\{.*/, '')}}`; }
  if (x < 0.69) return `\\begin{array}{${pick(['cc', 'lcr', 'c|c', 'rl'])}} ${table(d, pick(['cc', 'lcr', 'c|c', 'rl']).replace(/\|/g, '').length, 1 + Math.floor(r() * 3))} \\end{array}`;
  if (x < 0.71) return `\\${pick(['overbrace', 'underbrace'])}{${expr(d + 2)}}${chance(0.5) ? pick(['_', '^']) + '{' + expr(d + 2) + '}' : ''}`;
  if (x < 0.73) return `\\${pick(['overset', 'underset', 'stackrel'])}{${expr(d + 2)}}{${expr(d + 2)}}`;
  if (x < 0.75) return `\\${pick(['xrightarrow', 'xleftarrow', 'xRightarrow'])}${chance(0.4) ? '[' + expr(d + 2) + ']' : ''}{${expr(d + 2)}}`;
  if (x < 0.77) return `{\\color{${pick(colors)}} ${expr(d + 2)}}`;
  if (x < 0.78) return `\\colorbox{${pick(colors)}}{${pick(words)}}`;
  if (x < 0.79) return `\\${pick(['boxed', 'fbox', 'mbox', 'cancel', 'bcancel', 'xcancel', 'phantom'])}{${expr(d + 2)}}`;
  if (x < 0.80) return `\\cancelto{${pick(['0', '\\infty', 'x'])}}{${expr(d + 2)}}`;
  if (x < 0.82) return `${pick(styles)} ${expr(d + 2)}`;
  if (x < 0.83) return `${pick(sizes)}{${expr(d + 2)}}`;
  if (x < 0.85) return pick(spaces);
  if (x < 0.88) return pick([`\\bra{${expr(d + 2)}}`, `\\ket{${expr(d + 2)}}`, `\\braket{${expr(d + 2)}}`, `\\braket{a|b}`, `\\ketbra{a}{b}`, `\\expval{${expr(d + 2)}}`, `\\Bra{x}`, `\\Ket{x}`, `\\bra{a}\\ket{b}`]);
  if (x < 0.91) return pick([`\\dv{x}f(x)`, `\\pdv{f}{x}`, `\\pdv[2]{f}{x}`, `\\dd{x}`, `\\dd[3]{x}`, `\\qty(${expr(d + 2)})`, `\\qty[${expr(d + 2)}]`, `\\abs{${expr(d + 2)}}`, `\\norm{${expr(d + 2)}}`, `\\grad f`, `\\curl{\\vb{v}}`, `\\div{\\vb{v}}`, `\\laplacian`, `\\comm{A}{B}`, `\\acomm{A}{B}`, `\\order{n^2}`, `\\vb{x}`, `\\va{a}`, `\\vu{n}`, `\\var{f}`, `\\tr A`, `\\Tr(A)`, `\\rank A`, `\\erf x`, `\\mqty(a & b \\\\ c & d)`, `\\mqty[1 & 2]`, `\\dyad{a}{b}`, `\\eval{f}_0^1`, `\\ip{a}{b}`, `\\op{a}`, `\\xmat{a}{2}{2}`, `\\vdot`, `\\cross`, `\\pb{f}{g}`, `\\fdv{F}{f}`, `\\flatfrac{a}{b}`]);
  if (x < 0.94) return `\\ce{${pick(chems)}}`;
  if (x < 0.95) return `\\begin{CD} ${pick(['A @>f>> B', 'A @<g<< B @>>> C', 'A @= B', 'A @VVV B', 'A @AAA B', 'A @>>> B \\\\ @VVV @VVV \\\\ C @>>> D'])} \\end{CD}`;
  if (x < 0.96) return pick([`\\mathclap{${expr(d + 2)}}`, `\\mathllap{x}`, `\\mathrlap{y}`, `\\smashoperator{\\sum_{i}}`, `\\substack{a \\\\ b}`, `\\prescript{a}{b}{X}`, `\\overbracket{x}`, `\\underbracket{x}`, `\\xhookrightarrow{f}`, `\\mathtoolsset{centercolon}`, `\\vdotswithin{=}`, `\\DeclarePairedDelimiter\\abs{\\lvert}{\\rvert}`, `\\shortintertext{x}`, `\\newcommand{\\foo}{x}\\foo`, `\\def\\bar{y}\\bar`, `\\tag{1}`, `\\label{a}`, `\\ref{a}`, `\\eqref{a}`, `\\nonumber`, `\\notag`, `\\hline`, `\\hdashline`, `\\require{cancel}`, `\\unicode{x41}`, `\\href{x}{y}`, `\\class{c}{x}`, `\\style{color:red}{x}`, `\\mathchoice{a}{b}{c}{d}`, `\\raise2pt{x}`, `\\lower2pt{x}`, `\\rule{1em}{1pt}`, `\\char"41`, `\\mathop{x}\\limits_a`, `\\mathbin{x}`, `\\mathrel{y}`, `\\mathpunct{,}`, `\\mathinner{x}`, `\\mathord{x}`, `\\mathopen{(}`, `\\mathclose{)}`, `\\textcolor{red}{x}`, `\\fcolorbox{red}{blue}{x}`, `\\pmod{n}`, `\\bmod`, `\\pod{x}`, `\\over`, `{a \\over b}`, `{a \\choose b}`, `{a \\atop b}`, `\\buildrel{a}\\over{b}`, `\\root 3 \\of x`, `\\left. x \\right|_0^1`, `\\operatorname*{argmax}_x`, `\\DeclareMathOperator{\\foo}{foo}`, `\\emph{x}`, `\\verb|x|`, `\\mathstrut`, `\\strut`, `\\not=`, `\\not\\in`, `\\;`, `\\\\`, `\\cr`, `\\hfil`, `\\hskip 1em`, `\\nolimits`, `\\limits`, `\\color`, `\\bbox[red]{x}`, `\\ang{1}`]);
  return `{${expr(d + 1)}}`;
}
function term(d) {
  let t = ssub(d);
  if (chance(0.12)) t += pick(spaces);
  return t;
}
function formula() {
  const k = 1 + Math.floor(r() * 3);
  const lines = [];
  for (let i = 0; i < k; i++) lines.push(expr(0));
  let t = lines.join(chance(0.5) ? '\n' : ' ');
  if (chance(0.08)) t = '\\begin{equation}' + t + '\\end{equation}';
  if (chance(0.03)) t = '\\displaylines{' + lines.join(' \\\\ ') + '}';
  return t;
}
function mutate(t) {
  const k = Math.floor(r() * 9);
  const i = Math.floor(r() * (t.length + 1));
  switch (k) {
    case 0: return t.slice(0, i);
    case 1: return t.slice(0, i) + t.slice(i + 1 + Math.floor(r() * 3));
    case 2: return t.slice(0, i) + pick(['\\foo', '\\undefined{x}', '\\begin{nope}', '\\end{matrix}', '{', '}', '#', '#1', '&', '$', '%', '^', '_', '\\', '\\\\', '\\left', '\\right)', '\\frac', '\\frac{1}', '\\sqrt[', '\\color{', '\\text{', '^^', '__', '\\ce{', '\\ce{A->}', '\\bra{', '\\begin{pmatrix}a&b', '\\hat', '\\middle|', '\\\\[', '\\tag{', '\\label', '\\newcommand', '\\def', '\\cancelto', '@', '@>', '\\begin{CD}', '\\unicode{zz}']) + t.slice(i);
    case 3: return t.slice(0, i) + t.slice(i, i + 4) + t.slice(i);
    case 4: return t.replace(/\{/, '');
    case 5: return t.replace(/\}/, '');
    case 6: return t.replace(/\\[a-zA-Z]+/, '\\zzzz');
    case 7: return t + pick(['\\', '^', '_', '{', '}', '\\end{x}', '\\\\', '&']);
    default: return t.toUpperCase();
  }
}
const out = [];
for (let i = 0; i < n; i++) {
  let t = formula();
  if (chance(invalidP)) t = mutate(t);
  out.push(JSON.stringify({ text: t }));
}
console.log(out.join('\n'));
