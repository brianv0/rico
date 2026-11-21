// node regexp2check.mjs chroma_all.json [seed] [only lexer name regexp]: public/d2/regexp2.js against regexp2 v2 (Go) on every rule pattern of every chroma lexer
// (chromadump output of all lexers): the groups of the match at every position of generated strings (pattern literals, code snippets, Unicode text).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Regexp } from '../../public/d2/regexp2.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let seed = Number(process.argv[3] || 1);
const only = process.argv[4] ? new RegExp(process.argv[4]) : null;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[(rnd() * a.length) | 0];
const base = ['def foo(x): return x + 1  # comment\n', 'if (a == b) { c = "str\\"ing"; } // c\n', '0x1F 3.14e-5 10_000 .5 1.\n', 'SELECT * FROM t WHERE a = \'b\' -- x\n',
  '<div class="a">text &amp; more</div>\n', '#include <stdio.h>\nint main() { return 0; }\n', '$var = ${x} + $(cmd) "$a" `b`\n', 'ünïcödé Ωμέγα привет 漢字 🙂 αβγ_1\n',
  '\t  \n\n  x\r\ny', 'a.b::c->d => e <= f !== g ... h\n', '@decorator\nclass Foo<T> extends Bar implements Baz {}\n', '/* multi\nline */ end',
  'ÀÉÎ àéî İstanbul ǅ ß ſ K\n', '"""doc""" \'\'\'x\'\'\' `raw` <<EOF\nx\nEOF\n', 'ΑΒΓ αβγ ΣΊΣΥΦΟΣ\n'];
const alphabet = ' \n\t_-.,:;()[]{}<>"\'`\\/|&*+=!?#$%^~@aAzZ09éÉΩ漢🙂  ';
const flagsOf = (tree) => {
  const config = tree.c.find((c) => c.n === 'config');
  const flag = (tag) => config.c.some((c) => c.n === tag && c.t.trim() === 'true');
  return (flag('not_multiline') ? '' : 'm') + (flag('case_insensitive') ? 'i' : '') + (flag('dot_all') ? 's' : '');
};
const jobs = [];
for (const [name, tree] of Object.entries(dump.lexers)) {
  if (tree.error || (only && !only.test(name))) continue;
  const flags = flagsOf(tree);
  const seen = new Set();
  for (const st of tree.c.find((c) => c.n === 'rules').c) for (const rule of st.c ?? []) {
    const p = rule.a?.pattern ?? '';
    if (seen.has(p)) continue;
    seen.add(p);
    const toks = [...(p.match(/[A-Za-z0-9_]{1,12}/g) ?? []), ...(p.match(/[^A-Za-z0-9_\\()\[\]{}|*+?.^$]/g) ?? [])];
    const corpus = [...base.slice(0, 4 + ((rnd() * 10) | 0))];
    for (let k = 0; k < 6; k++) {
      let s = '';
      for (let n = 1 + ((rnd() * 10) | 0); n > 0; n--) s += (toks.length && rnd() < 0.6 ? pick(toks) : pick([...alphabet])) + (rnd() < 0.4 ? ' ' : '');
      corpus.push(s);
    }
    jobs.push({ lexer: name, text: p, language: flags, corpus: corpus.join('\0') });
  }
}
console.error(`${jobs.length} rules`);
const out = execFileSync('/tmp/d2refbin_mine', ['regexp2groups'], { cwd: here, input: jobs.map((j) => JSON.stringify(j)).join('\n'), maxBuffer: 1 << 30 }).toString().trim().split('\n');
let same = 0, bothErr = 0, bad = 0, positions = 0;
const byLexer = {};
jobs.forEach((j, i) => {
  const want = JSON.parse(out[i]);
  let re = null, err = null;
  try { re = new Regexp(`\\G${j.language ? `(?${j.language})` : ''}(?:${j.text})`); } catch (e) { err = e; }
  if (want.err) { if (err) bothErr++; else { bad++; (byLexer[j.lexer] ??= []).push(`${j.text}\n   Go error ${want.err}; JS compiled`); } return; }
  if (err) { bad++; (byLexer[j.lexer] ??= []).push(`${j.text}\n   JS error ${err.message}`); return; }
  const strings = j.corpus.split('\0');
  for (let si = 0; si < strings.length; si++) {
    const runes = Array.from(strings[si], (c) => c.codePointAt(0));
    for (let pos = 0; pos <= runes.length; pos++) {
      positions++;
      let got;
      try { got = re.matchAt(runes, pos); } catch (e) { got = 'throw ' + e.message; }
      const w = want.matches[si][pos];
      if (JSON.stringify(got) !== JSON.stringify(w)) {
        bad++;
        (byLexer[j.lexer] ??= []).push(`${j.text}\n   at ${JSON.stringify(strings[si])}@${pos}: js ${JSON.stringify(got)} go ${JSON.stringify(w)}`);
        return;
      }
    }
  }
  same++;
});
console.log(`regexp2: ${same}/${jobs.length - bothErr} rules identical to Go on ${positions} positions (${bothErr} rejected by both), ${bad} different`);
let shown = 0;
for (const [l, v] of Object.entries(byLexer)) { if (shown++ < Number(process.env.SHOW || 8)) console.log(`\n[${l}] ${v.length} rules differ, e.g.\n${v[0]}`); }
console.log('lexers with differences:', Object.keys(byLexer).length);
process.exitCode = bad ? 1 : 0;
