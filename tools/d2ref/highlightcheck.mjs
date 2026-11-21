// node highlightcheck.mjs [N] [seed]: public/d2/highlight.js (the chroma port) against chroma on random ASCII code snippets of every ported
// language: the token types and values of d2svg's code labels, line by line.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { index, loadLexer, highlight } from '../../public/d2/highlight.js';

for (const f of Object.values(index.files)) await loadLexer(f);
const here = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 1500);
let seed = Number(process.argv[3] || 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[(rnd() * a.length) | 0];

const common = ['foo', 'bar_baz', 'x1', 'Hello', 'self', 'None', 'True', 'nil', 'true', 'null', '42', '3.14', '0x1F', '1e-5', '0b101', '10_000', '"str"', "'c'", '"a\\"b"', "'it\\'s'", '`raw`', '"""doc"""', "'''d'''",
  '# comment', '// comment', '/* multi\nline */', '(', ')', '[', ']', '{', '}', ',', ';', ':', '.', '=', '==', '!=', '+', '-', '*', '/', '%', '&&', '||', '<=', '->', '=>', '::', '...', '@', '$', '$x', '${y}', '`cmd`', '\\', '!', '?', '|', '&', '<', '>', '~', '^', '#!/bin/sh', '\n', '\n', '\n', '    ', '\t', ' ', ' ', ' ', '\n  ', '\n\n'];
const langs = {
  python: ['def', 'class', 'import', 'from', 'as', 'if', 'elif', 'else', 'for', 'in', 'while', 'return', 'yield', 'lambda', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'print', 'len', 'range', 'async', 'await', '@decorator', 'f"x{y}"', 'r"\\d+"', 'b"bytes"', '__init__', 'is', 'not', 'and', 'or', ':=', '**', '//'],
  go: ['package', 'import', 'func', 'type', 'struct', 'interface', 'var', 'const', 'if', 'else', 'for', 'range', 'return', 'go', 'defer', 'map', 'chan', 'string', 'int', 'error', 'make', 'len', 'fmt.Println', ':=', '<-', '...', '`a {{.B}} c`', '\'x\'', 'nil', 'iota'],
  bash: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'echo', 'export', 'cd', 'ls', '$(', '$((', '))', '[[', ']]', '|', '&', '>>', '2>&1', '<<EOF', 'EOF', '$@', '$1', '${a:-b}', '"$x"', "'a b'", 'local', 'return', 'exit'],
  javascript: ['function', 'const', 'let', 'var', 'class', 'extends', 'return', 'if', 'else', 'for', 'while', 'new', 'this', 'async', 'await', 'import', 'export', 'default', 'from', 'typeof', '=>', '`t ${x} u`', '/re+/g', 'console.log', 'undefined', 'NaN', 'yield'],
  typescript: ['interface', 'type', 'enum', 'namespace', 'public', 'private', 'readonly', 'implements', 'string', 'number', 'boolean', 'any', 'void', 'function', 'const', 'let', 'class', 'extends', 'return', '=>', ': string', '<T>', 'as', 'keyof', 'import', 'export'],
  json: ['"key"', ':', '{', '}', '[', ']', 'true', 'false', 'null', '1', '-2.5e3', '"v"', ',', '"a\\u00e9"'],
  yaml: ['key:', '- item', '---', '...', '&anchor', '*alias', '!!str', '|', '>', '"q"', "'s'", '# c', 'true', 'null', '1.5', '? x', ': y', '- ', 'a: b', '[1, 2]', '{a: 1}'],
};
const aliasOf = { python: ['python', 'py', 'Python'], go: ['go', 'golang'], bash: ['bash', 'sh'], javascript: ['javascript', 'js'], typescript: ['typescript', 'ts'], json: ['json'], yaml: ['yaml', 'yml'] };
// every other exported lexer: the generic fragments, under one of its names
const names = {};
for (const [k, v] of Object.entries(index.names)) if (index.files[v] && !(v in names && names[v].length <= k.length)) names[v] = k;
for (const [v, k] of Object.entries(names)) if (!Object.values(aliasOf).flat().includes(k) && !(k in langs)) { langs[k] = ['SELECT', 'FROM', 'WHERE', 'public', 'static', 'void', 'int', 'class', 'struct', '#include', '<stdio.h>', 'fn', 'let', 'mut', 'impl', 'def', 'end', 'begin', 'module', 'use', 'require', '<div class="x">', '</div>', '<?xml version="1.0"?>', '<!-- c -->', '&amp;', 'color: red;', '.cls {', '@media', '$var', 'all:', '\t@echo', '[section]', 'key=value', '+++', '--- a', '@@ -1 +1 @@', 'FROM alpine', 'RUN x'].concat(common); aliasOf[k] = [k]; }
const cases = [];
for (let i = 0; i < N; i++) {
  const lang = pick(Object.keys(langs));
  const words = [...common, ...langs[lang]];
  let text = '';
  const n = 1 + ((rnd() * 40) | 0);
  for (let k = 0; k < n; k++) text += pick(words) + (rnd() < 0.5 ? ' ' : '');
  cases.push({ language: pick(aliasOf[lang]), text });
}
cases.push({ language: 'asdf', text: 'x := 1\n\nfoo' }, { language: 'Text', text: 'plain text\nmore' }, { language: 'go', text: '' });
const out = execFileSync('go', ['run', '.', 'highlight'], { cwd: here, input: cases.map((c) => JSON.stringify(c)).join('\n'), maxBuffer: 1 << 28 }).toString().trim().split('\n');
let same = 0, deferred = 0;
const defBy = {}, okBy = {};
const bad = [];
cases.forEach((c, i) => {
  const want = JSON.parse(out[i]);
  if (want.panic) { deferred++; defBy['(go panic)'] = (defBy['(go panic)'] || 0) + 1; return; }
  let got;
  try { got = highlight(c.language, c.text).light.lines.map((l) => l.map((t) => [t.type, t.value])); } catch (e) { if (e.name === 'Deferred') { deferred++; defBy[c.language] = (defBy[c.language] || 0) + 1; return; } got = String(e); }
  if (JSON.stringify(got) === JSON.stringify(want.lines)) { same++; okBy[c.language] = (okBy[c.language] || 0) + 1; }
  else bad.push(`${JSON.stringify(c)}\n   got  ${JSON.stringify(got).slice(0, 400)}\n   want ${JSON.stringify(want.lines).slice(0, 400)}`);
});
const perLang = {};
for (const b of bad) { const l = JSON.parse(b.split('\n')[0]).language; perLang[l] = (perLang[l] || 0) + 1; }
console.log(`highlight: ${same}/${cases.length - deferred} identical to chroma` + (deferred ? `, ${deferred} deferred/skipped` : '') + (bad.length ? `; mismatches by language ${JSON.stringify(perLang)}` : ''));
for (const b of bad.slice(0, 6)) console.log(b);
if (process.env.BYLANG) console.log('deferred by language', JSON.stringify(defBy), '\nidentical by language', JSON.stringify(okBy));
process.exitCode = bad.length ? 1 : 0;
