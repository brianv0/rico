// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the part of github.com/dlclark/regexp2 v2.6.0 (MIT, Copyright (c) Doug Clark; the engine is a port of the .NET regex
// engine, Copyright (c) Microsoft) that alecthomas/chroma's RegexLexer uses (chroma compiles every lexer rule with
// regexp2.Compile(`\G(?flags)(?:pattern)`) with the default options and matches with FindRunesMatchStartingAt): the .NET syntax parser
// (syntax/parser.go, charclass.go), the tree (tree.go: only the reductions the parser relies on, not the optimizations), the code writer
// (writer.go) and the backtracking interpreter (runner.go, `executeDefault`), without the ECMAScript/RE2 modes, balancing groups,
// conditionals' error cases, \R \X \Q..\E, replacement and the prefix/dispatch/codegen optimizations (all of which only change speed).
// Text is an array of code points (Go's []rune), so positions and group lengths are in runes.
//
// Why not translate to JavaScript regular expressions: .NET semantics differ in many small ways (captures persist across loop iterations,
// an empty loop iteration ends the loop, backreferences to unset groups fail, `\w` and `\b` are Unicode classes, `$` and `^`
// only know \n, possessive quantifiers and `(?i)` in the middle of a pattern, regexp2's character class quirks such as `[^\W\d]` matching digits);
// running the same program as Go makes lexer output identical by construction.

export class RegexError extends Error {}

// ---- Go's unicode package, as far as regexp2 uses it ----

const MaxRune = 0x10ffff;
const cat = (name) => new RegExp(`\\p{${name}}`, 'u');
const catTests = new Map();
const GENERAL_CATEGORIES = new Set(['C', 'Cc', 'Cf', 'Co', 'Cs', 'L', 'Ll', 'Lm', 'Lo', 'Lt', 'Lu', 'M', 'Mc', 'Me', 'Mn', 'N', 'Nd', 'Nl', 'No', 'P', 'Pc', 'Pd', 'Pe', 'Pf', 'Pi',
  'Po', 'Ps', 'S', 'Sc', 'Sk', 'Sm', 'So', 'Z', 'Zl', 'Zp', 'Zs']);

/** unicode.Is(unicodeCategories[name], r) for general categories and scripts */
function inCategory(name, r) {
  let t = catTests.get(name);
  if (t === undefined) {
    t = cat(GENERAL_CATEGORIES.has(name) ? name : `Script=${name}`);
    catTests.set(name, t);
  }
  return t.test(String.fromCodePoint(r));
}

/** canonicalUnicodeCatName for the names JavaScript knows (general categories, scripts) */
function canonicalCatName(name) {
  if (GENERAL_CATEGORIES.has(name)) return name;
  try { cat(`Script=${name}`); } catch (e) { return null; }
  return name;
}

const reWord = /[\p{L}\p{Mn}\p{Nd}\p{Pc}]/u;
/** syntax.IsWordChar */
export function isWordChar(r) {
  if (r < 128) return (r >= 0x61 && r <= 0x7a) || (r >= 0x41 && r <= 0x5a) || (r >= 0x30 && r <= 0x39) || r === 0x5f;
  return r === 0x200d || r === 0x200c || (r <= MaxRune && reWord.test(String.fromCodePoint(r)));
}

/** unicode.IsSpace */
export function isSpaceRune(r) {
  if (r <= 0xff) return r === 0x20 || (r >= 9 && r <= 13) || r === 0x85 || r === 0xa0;
  return r === 0x1680 || (r >= 0x2000 && r <= 0x200a) || r === 0x2028 || r === 0x2029 || r === 0x202f || r === 0x205f || r === 0x3000;
}

const reLower = /\p{Ll}/u, reUpper = /\p{Lu}/u;
const isLowerRune = (r) => (r < 128 ? r >= 0x61 && r <= 0x7a : reLower.test(String.fromCodePoint(r)));
const isUpperRune = (r) => (r < 128 ? r >= 0x41 && r <= 0x5a : reUpper.test(String.fromCodePoint(r)));

/** unicode.ToLower: the simple lowercase mapping (JavaScript's toLowerCase is the full mapping: only U+0130 differs) */
export function toLowerRune(r) {
  if (r < 128) return r >= 0x41 && r <= 0x5a ? r + 32 : r;
  if (r === 0x130) return 0x69;
  const s = String.fromCodePoint(r).toLowerCase();
  const c = s.codePointAt(0);
  return s.length === (c > 0xffff ? 2 : 1) ? c : r;
}
const toUpperSimple = (r) => {
  const s = String.fromCodePoint(r).toUpperCase();
  const c = s.codePointAt(0);
  return s.length === (c > 0xffff ? 2 : 1) ? c : r;
};

// unicode.SimpleFold orbits: the connected components of the simple lower/upper case mappings (CaseFolding.txt's orbits, except that U+0130 and U+0131
// have no simple folding)
let reverseCase = null;
function caseOrbit(ch) {
  if (ch < 128 && !((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a))) return null;
  if (reverseCase === null) {
    reverseCase = new Map();
    const add = (a, b) => { if (a !== b) { if (!reverseCase.has(b)) reverseCase.set(b, []); reverseCase.get(b).push(a); } };
    for (let c = 0x41; c <= 0x1ffff; c++) {
      if (c === 0x130 || c === 0x131 || (c >= 0xd800 && c <= 0xdfff)) continue;
      add(c, toLowerRune(c));
      add(c, toUpperSimple(c));
    }
  }
  const seen = new Set([ch]);
  const queue = [ch];
  while (queue.length > 0) {
    const c = queue.pop();
    const next = [];
    if (c !== 0x130 && c !== 0x131) next.push(toLowerRune(c), toUpperSimple(c));
    next.push(...(reverseCase.get(c) ?? []));
    for (const n of next) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return seen.size > 1 ? [...seen].filter((c) => c !== ch) : null;
}

const participatesInCaseConversion = (ch) => !(inCategory('Pe', ch) || inCategory('Pc', ch) || inCategory('Cc', ch) || inCategory('Pd', ch) || inCategory('Nd', ch) ||
  inCategory('Pf', ch) || inCategory('Pi', ch) || inCategory('Zl', ch) || inCategory('Ps', ch) || inCategory('No', ch) || inCategory('Po', ch) ||
  inCategory('Zp', ch) || inCategory('Zs', ch));

// ---- CharSet (syntax/charclass.go) ----

const SPACE_CAT = ' ', WORD_CAT = 'W';

// the table of addLowercase: [chMin, chMax, op, data] (0 set, 1 add, 2 bor, 3 bad)
const LC = [[0x41, 0x5a, 1, 32], [0xc0, 0xde, 1, 32], [0x100, 0x12e, 2, 0], [0x130, 0x130, 0, 0x69], [0x132, 0x136, 2, 0], [0x139, 0x147, 3, 0], [0x14a, 0x176, 2, 0],
  [0x178, 0x178, 0, 0xff], [0x179, 0x17d, 3, 0], [0x181, 0x181, 0, 0x253], [0x182, 0x184, 2, 0], [0x186, 0x186, 0, 0x254], [0x187, 0x187, 0, 0x188], [0x189, 0x18a, 1, 205],
  [0x18b, 0x18b, 0, 0x18c], [0x18e, 0x18e, 0, 0x1dd], [0x18f, 0x18f, 0, 0x259], [0x190, 0x190, 0, 0x25b], [0x191, 0x191, 0, 0x192], [0x193, 0x193, 0, 0x260],
  [0x194, 0x194, 0, 0x263], [0x196, 0x196, 0, 0x269], [0x197, 0x197, 0, 0x268], [0x198, 0x198, 0, 0x199], [0x19c, 0x19c, 0, 0x26f], [0x19d, 0x19d, 0, 0x272],
  [0x19f, 0x19f, 0, 0x275], [0x1a0, 0x1a4, 2, 0], [0x1a7, 0x1a7, 0, 0x1a8], [0x1a9, 0x1a9, 0, 0x283], [0x1ac, 0x1ac, 0, 0x1ad], [0x1ae, 0x1ae, 0, 0x288],
  [0x1af, 0x1af, 0, 0x1b0], [0x1b1, 0x1b2, 1, 217], [0x1b3, 0x1b5, 3, 0], [0x1b7, 0x1b7, 0, 0x292], [0x1b8, 0x1b8, 0, 0x1b9], [0x1bc, 0x1bc, 0, 0x1bd],
  [0x1c4, 0x1c5, 0, 0x1c6], [0x1c7, 0x1c8, 0, 0x1c9], [0x1ca, 0x1cb, 0, 0x1cc], [0x1cd, 0x1db, 3, 0], [0x1de, 0x1ee, 2, 0], [0x1f1, 0x1f2, 0, 0x1f3],
  [0x1f4, 0x1f4, 0, 0x1f5], [0x1fa, 0x216, 2, 0], [0x386, 0x386, 0, 0x3ac], [0x388, 0x38a, 1, 37], [0x38c, 0x38c, 0, 0x3cc], [0x38e, 0x38f, 1, 63],
  [0x391, 0x3ab, 1, 32], [0x3e2, 0x3ee, 2, 0], [0x401, 0x40f, 1, 80], [0x410, 0x42f, 1, 32], [0x460, 0x480, 2, 0], [0x490, 0x4be, 2, 0], [0x4c1, 0x4c3, 3, 0],
  [0x4c7, 0x4c7, 0, 0x4c8], [0x4cb, 0x4cb, 0, 0x4cc], [0x4d0, 0x4ea, 2, 0], [0x4ee, 0x4f4, 2, 0], [0x4f8, 0x4f8, 0, 0x4f9], [0x531, 0x556, 1, 48],
  [0x10a0, 0x10c5, 1, 48], [0x1e00, 0x1ef8, 2, 0], [0x1f08, 0x1f0f, 1, -8], [0x1f18, 0x1f1f, 1, -8], [0x1f28, 0x1f2f, 1, -8], [0x1f38, 0x1f3f, 1, -8],
  [0x1f48, 0x1f4d, 1, -8], [0x1f59, 0x1f59, 0, 0x1f51], [0x1f5b, 0x1f5b, 0, 0x1f53], [0x1f5d, 0x1f5d, 0, 0x1f55], [0x1f5f, 0x1f5f, 0, 0x1f57],
  [0x1f68, 0x1f6f, 1, -8], [0x1f88, 0x1f8f, 1, -8], [0x1f98, 0x1f9f, 1, -8], [0x1fa8, 0x1faf, 1, -8], [0x1fb8, 0x1fb9, 1, -8], [0x1fba, 0x1fbb, 1, -74],
  [0x1fbc, 0x1fbc, 0, 0x1fb3], [0x1fc8, 0x1fcb, 1, -86], [0x1fcc, 0x1fcc, 0, 0x1fc3], [0x1fd8, 0x1fd9, 1, -8], [0x1fda, 0x1fdb, 1, -100], [0x1fe8, 0x1fe9, 1, -8],
  [0x1fea, 0x1feb, 1, -112], [0x1fec, 0x1fec, 0, 0x1fe5], [0x1ff8, 0x1ff9, 1, -128], [0x1ffa, 0x1ffb, 1, -126], [0x1ffc, 0x1ffc, 0, 0x1ff3], [0x2160, 0x216f, 1, 16],
  [0x24b6, 0x24d0, 1, 26], [0xff21, 0xff3a, 1, 32]];

export class CharSet {
  constructor() { this.ranges = []; this.categories = []; this.sub = null; this.negate = false; this.anything = false; this.ascii = null; this.cache = null; }

  copy() {
    const c = new CharSet();
    c.anything = this.anything;
    c.negate = this.negate;
    c.ranges = this.ranges.map((r) => ({ ...r }));
    c.categories = this.categories.map((x) => ({ ...x }));
    if (this.sub !== null) c.sub = this.sub.copy();
    return c;
  }

  isSingleton() { return !this.negate && this.categories.length === 0 && this.ranges.length === 1 && this.sub === null && this.ranges[0].first === this.ranges[0].last; }
  isSingletonInverse() { return this.negate && this.categories.length === 0 && this.ranges.length === 1 && this.sub === null && this.ranges[0].first === this.ranges[0].last; }

  /** CharIn: handles negations and subtracted sub-sets (with an ASCII bitmap, Go's PrepareCharSetASCIIBitmaps, built on first use) */
  charIn(ch) {
    if (ch >= 0 && ch < 128) {
      if (this.ascii === null) {
        this.ascii = new Uint8Array(128);
        for (let i = 0; i < 128; i++) this.ascii[i] = this.charInSlow(i) ? 1 : 0;
      }
      return this.ascii[ch] === 1;
    }
    if (this.categories.length > 0 || this.sub !== null) {
      if (this.cache === null) this.cache = new Map();
      let v = this.cache.get(ch);
      if (v === undefined) { v = this.charInSlow(ch); this.cache.set(ch, v); }
      return v;
    }
    return this.charInSlow(ch);
  }

  charInSlow(ch) {
    let val = false;
    const n = this.ranges.length;
    if (n > 0) {
      if (n <= 4) {
        for (const r of this.ranges) {
          if (ch < r.first) break;
          if (ch <= r.last) { val = true; break; }
        }
      } else {
        let lo = 0, hi = n;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (this.ranges[mid].first <= ch) lo = mid + 1; else hi = mid;
        }
        if (lo > 0 && ch <= this.ranges[lo - 1].last) val = true;
      }
    }
    // check categories if we haven't already found a range
    if (!val && this.categories.length > 0) val = this.charInCategories(ch);
    // negate the whole char set
    if (this.negate) val = !val;
    // get subtracted recurse
    if (val && this.sub !== null) val = !this.sub.charIn(ch);
    return val;
  }

  charInCategories(ch) {
    for (const ct of this.categories) {
      // special categories...then unicode
      if (ct.cat === SPACE_CAT) {
        if (isSpaceRune(ch)) return !ct.negate; // we found a space so we're done; negate means this is a "bad" thing
        else if (ct.negate) return true;
      } else if (ct.cat === WORD_CAT) {
        if (isWordChar(ch)) return !ct.negate;
        else if (ct.negate) return true;
      } else if (inCategory(ct.cat, ch)) {
        return !ct.negate; // if we're in this unicode category then we're done; if negate=true on this category then we "failed" our test
      } else if (ct.negate) {
        return true;
      }
    }
    return false;
  }

  addDigit(negate) { this.addCategories({ cat: 'Nd', negate }); }
  addSpace(negate) { this.addCategories({ cat: SPACE_CAT, negate }); }
  addWord(negate) { this.addCategories({ cat: WORD_CAT, negate }); }
  addChar(ch) { this.addRange(ch, ch); }

  makeAnything() {
    this.anything = true;
    this.categories = [];
    this.ranges = [{ first: 0, last: MaxRune }];
  }

  addCategories(...cats) {
    // don't add dupes and remove positive+negative
    if (this.anything) return;
    for (const ct of cats) {
      let found = false;
      for (const ct2 of this.categories) {
        if (ct.cat === ct2.cat) {
          if (ct.negate !== ct2.negate) { this.makeAnything(); return; } // opposite negations: as broad as we can get
          found = true;
          break;
        }
      }
      if (!found) this.categories.push(ct);
    }
  }

  addRange(chMin, chMax) {
    this.ranges.push({ first: chMin, last: chMax });
    this.canonicalize();
  }

  addCategory(categoryName, negate, caseInsensitive) {
    const canonical = canonicalCatName(categoryName);
    if (canonical === null) throw new RegexError(`unknown unicode category, script, or property '${categoryName}'`);
    categoryName = canonical;
    if (caseInsensitive && (categoryName === 'Ll' || categoryName === 'Lu' || categoryName === 'Lt')) {
      // when RegexOptions.IgnoreCase is specified then {Ll} {Lu} and {Lt} cases should all match
      this.addCategories({ cat: 'Ll', negate }, { cat: 'Lu', negate }, { cat: 'Lt', negate });
    }
    this.addCategories({ cat: categoryName, negate });
  }

  /** adds to the class any case-equivalence versions of characters already in the class (case-insensitivity) */
  addCaseEquivalences() {
    if (this.anything) return; // we already have all case equiv
    const rangeCount = this.ranges.length;
    for (let i = 0; i < rangeCount; i++) {
      const r = this.ranges[i];
      for (let c = r.first; c <= r.last; c++) {
        const equiv = caseOrbit(c);
        if (equiv !== null) for (const eq of equiv) this.ranges.push({ first: eq, last: eq });
      }
    }
    this.canonicalize();
  }

  addSubtraction(sub) { this.sub = sub; }

  /** reduces a character class to a unique, sorted form */
  canonicalize() {
    const ranges = this.ranges;
    if (ranges.length === 0) return;
    // find and eliminate overlapping or abutting ranges
    if (ranges.length > 1) {
      ranges.sort((a, b) => a.first - b.first);
      let done = false, i = 1, j = 0, last;
      for (; ; i++) {
        for (last = ranges[j].last; ; i++) {
          if (i === ranges.length || last >= MaxRune) { done = true; break; }
          const cur = ranges[i];
          if (cur.first > last + 1) break;
          if (last < cur.last) last = cur.last;
        }
        ranges[j] = { first: ranges[j].first, last };
        j++;
        if (done) break;
        if (j < i) ranges[j] = ranges[i];
      }
      ranges.length = j;
    }
    // If the class now represents a single negated range, but does so by including every other character, invert it to produce a normalized form
    if (!this.negate && this.sub === null && this.categories.length === 0) {
      if (ranges.length === 2) {
        if (ranges[0].first === 0 && ranges[1].last >= MaxRune && ranges[0].last < ranges[1].first - 1) {
          this.ranges = [{ first: ranges[0].last + 1, last: ranges[1].first - 1 }];
          this.negate = true;
        }
      } else if (ranges.length === 1) {
        switch (ranges[0].first) {
          case 0:
            if (ranges[0].last === MaxRune - 1) { ranges[0] = { first: MaxRune, last: MaxRune }; this.negate = true; }
            break;
          case 1:
            if (ranges[0].last >= MaxRune) { ranges[0] = { first: 0, last: 0 }; this.negate = true; }
            break;
        }
      }
    }
    // a range that includes everything (without subtraction) makes the categories duplicative
    if (!this.negate && this.sub === null && this.ranges.length === 1 && this.ranges[0].first === 0 && this.ranges[0].last >= MaxRune) this.makeAnything();
    // a single character omitted from the ranges, with categories: see if that character is in the categories
    if (!this.negate && this.sub === null && this.categories.length > 0 && this.ranges.length === 2 && this.ranges[0].first === 0 &&
      this.ranges[0].last + 2 === this.ranges[1].first && this.ranges[1].last === MaxRune) {
      if (this.charInCategories(this.ranges[0].last + 1)) this.makeAnything();
      else {
        this.negate = true;
        this.ranges = [{ first: this.ranges[0].last + 1, last: this.ranges[0].last + 1 }];
        this.categories = [];
      }
    }
  }

  /** adds to the class any lowercase versions of characters already in the class (case-insensitivity) */
  addLowercase() {
    if (this.anything) return;
    const toAdd = [];
    for (let i = 0; i < this.ranges.length; i++) {
      const r = this.ranges[i];
      if (r.first === r.last) {
        const lower = toLowerRune(r.first);
        this.ranges[i] = { first: lower, last: lower };
      } else toAdd.push(r);
    }
    for (const r of toAdd) this.addLowercaseRange(r.first, r.last);
    this.canonicalize();
  }

  addLowercaseRange(chMin, chMax) {
    let i = 0, iMax = LC.length;
    while (i < iMax) {
      const iMid = (i + iMax) >> 1;
      if (LC[iMid][1] < chMin) i = iMid + 1; else iMax = iMid;
    }
    for (; i < LC.length; i++) {
      const [lcMin, lcMax, op, data] = LC[i];
      if (lcMin > chMax) return;
      let chMinT = lcMin < chMin ? chMin : lcMin;
      let chMaxT = lcMax > chMax ? chMax : lcMax;
      switch (op) {
        case 0: chMinT = data; chMaxT = data; break;
        case 1: chMinT += data; chMaxT += data; break;
        case 2: chMinT |= 1; chMaxT |= 1; break;
        case 3: chMinT += chMinT & 1; chMaxT += chMaxT & 1; break;
      }
      if (chMinT < chMin || chMaxT > chMax) this.ranges.push({ first: chMinT, last: chMaxT });
    }
  }
}

// the shorthand classes
const catSet = (negateSet, negateCat, name) => { const c = new CharSet(); c.negate = negateSet; c.categories = [{ cat: name, negate: negateCat }]; return c; };
const WordClass = () => catSet(false, false, WORD_CAT);
const NotWordClass = () => catSet(true, false, WORD_CAT);
const SpaceClass = () => catSet(false, false, SPACE_CAT);
const NotSpaceClass = () => catSet(true, false, SPACE_CAT);
const DigitClass = () => catSet(false, false, 'Nd');
const NotDigitClass = () => catSet(false, true, 'Nd');
const AnyClass = () => { const c = new CharSet(); c.ranges = [{ first: 0, last: MaxRune }]; c.anything = true; return c; };

// ---- the tree (tree.go) ----

const IgnoreCase = 1, Multiline = 2, ExplicitCapture = 4, Singleline = 16, IgnorePatternWhitespace = 32, RightToLeft = 64;

const Nt = {
  Oneloop: 3, Notoneloop: 4, Setloop: 5, Onelazy: 6, Notonelazy: 7, Setlazy: 8, One: 9, Notone: 10, Set: 11, Multi: 12, Ref: 13, Bol: 14, Eol: 15, Boundary: 16,
  Nonboundary: 17, Beginning: 18, Start: 19, EndZ: 20, End: 21, Nothing: 22, Empty: 23, Alternate: 24, Concatenate: 25, Loop: 26, Lazyloop: 27, Capture: 28,
  Group: 29, PosLook: 30, NegLook: 31, Atomic: 32, BackRefCond: 33, ExprCond: 34,
};
const MaxInt32 = 2147483647;
const MultiVsRepeaterLimit = 64;

class RegexNode {
  constructor(t, options) { this.t = t; this.children = []; this.str = null; this.set = null; this.ch = 0; this.m = 0; this.n = 0; this.options = options; this.parent = null; }

  addChild(child) {
    child.parent = this;
    const reduced = child.reduce();
    reduced.parent = this;
    this.children.push(reduced);
  }

  replaceChild(index, newChild) {
    newChild.parent = this;
    newChild = newChild.reduce();
    newChild.parent = this;
    this.children[index] = newChild;
  }

  makeRep(t, min, max) { this.t += t - Nt.One; this.m = min; this.n = max; }

  reduce() {
    // Remove IgnoreCase option from everything except a Backreference
    if (this.t !== Nt.Ref) this.options &= ~IgnoreCase;
    switch (this.t) {
      case Nt.Alternate: return this.reduceAlternation();
      case Nt.Concatenate: return this.reduceConcatenation();
      case Nt.Group: return this.reduceGroup();
      case Nt.Loop: case Nt.Lazyloop: return this.reduceRep();
      case Nt.PosLook: case Nt.NegLook: return this.reduceLookaround();
      case Nt.Set: case Nt.Setloop: case Nt.Setlazy: return this.reduceSet();
      case Nt.ExprCond: return this.reduceExpressionConditional();
      case Nt.BackRefCond: return this.reduceBackreferenceConditional();
      default: return this;
    }
  }

  reduceLookaround() {
    // A positive lookaround wrapped around an empty is a nop; a negative one is a guaranteed no-match
    if (this.children[0].t === Nt.Empty) {
      this.t = this.t === Nt.PosLook ? Nt.Empty : Nt.Nothing;
      this.children = [];
    }
    return this;
  }

  reduceBackreferenceConditional() {
    if (this.children.length === 1) this.addChild(new RegexNode(Nt.Empty, this.options));
    return this;
  }

  reduceExpressionConditional() {
    if (this.children.length === 2) this.addChild(new RegexNode(Nt.Empty, this.options));
    const condition = this.children[0];
    if (condition.t === Nt.PosLook && (condition.options & RightToLeft) === 0) this.replaceChild(0, condition.children[0]);
    return this;
  }

  /** the alternation of one branch is that branch, of none is Nothing */
  reduceAlternation() {
    if (this.children.length === 0) return new RegexNode(Nt.Nothing, this.options);
    if (this.children.length === 1) return this.children[0];
    return this;
  }

  reduceConcatenation() {
    if (this.children.length === 0) return new RegexNode(Nt.Empty, this.options);
    if (this.children.length === 1) return this.children[0];
    // If any node in the concatenation is a Nothing, the concatenation itself is a Nothing.
    for (const child of this.children) if (child.t === Nt.Nothing) return child;
    return this;
  }

  reduceGroup() {
    let u = this;
    while (u.t === Nt.Group) u = u.children[0];
    return u;
  }

  reduceRep() {
    if (this.children.length === 1 && this.children[0].t === Nt.Empty) return this.children[0];
    let u = this;
    const t = this.t, min = this.m, max = this.n;
    while (u.children.length > 0) {
      const child = u.children[0];
      // multiply reps of the same type only
      if (child.t !== t) {
        let valid = false;
        if (t === Nt.Loop) valid = child.t === Nt.Oneloop || child.t === Nt.Notoneloop || child.t === Nt.Setloop;
        else valid = child.t === Nt.Onelazy || child.t === Nt.Notonelazy || child.t === Nt.Setlazy;
        if (!valid) break;
      }
      // child can be too lumpy to blur, e.g., (a {100,105}) {3} or (a {2,})?
      if ((u.m === 0 && child.m > 1) || maxLessThanTwiceMin(child.n, child.m)) break;
      u = child;
      if (u.m > 0) u.m = Math.floor((MaxInt32 - 1) / u.m) < min ? MaxInt32 : u.m * min;
      if (u.n > 0) u.n = Math.floor((MaxInt32 - 1) / u.n) < max ? MaxInt32 : u.n * max;
    }
    if (min === MaxInt32) return new RegexNode(Nt.Nothing, this.options);
    // If the Loop or Lazyloop now only has one child node and its a Set, One, or Notone, reduce to just Setloop/lazy, Oneloop/lazy, or Notoneloop/lazy.
    if (u.children.length === 1) {
      const child = u.children[0];
      if (child.t === Nt.One || child.t === Nt.Notone || child.t === Nt.Set) {
        child.makeRep(u.t === Nt.Lazyloop ? Nt.Onelazy : Nt.Oneloop, u.m, u.n);
        u = child;
      }
    }
    return u;
  }

  /** a singleton, an inverse singleton or an empty set is simplified */
  reduceSet() {
    if (this.set === null) this.t = Nt.Nothing;
    else if (this.set.isSingleton()) {
      this.ch = this.set.ranges[0].first;
      this.set = null;
      this.t += Nt.One - Nt.Set;
    } else if (this.set.isSingletonInverse()) {
      this.ch = this.set.ranges[0].first;
      this.set = null;
      this.t += Nt.Notone - Nt.Set;
    }
    return this;
  }

  reverseLeft() {
    if ((this.options & RightToLeft) !== 0 && this.t === Nt.Concatenate && this.children.length > 0) this.children.reverse();
    return this;
  }

  makeQuantifier(lazy, min, max) {
    if (min === 0 && max === 0) return new RegexNode(Nt.Empty, this.options); // repeated 0 times: empty
    if (min === 1 && max === 1) return this; // repeated 1 time: not a repeater
    if (min === max && max <= MultiVsRepeaterLimit && this.t === Nt.One) {
      // the same character is repeated a fixed number of times: a multi
      this.t = Nt.Multi;
      this.str = new Array(max).fill(this.ch);
      this.ch = 0;
      return this;
    }
    switch (this.t) {
      case Nt.One: case Nt.Notone: case Nt.Set:
        this.makeRep(lazy ? Nt.Onelazy : Nt.Oneloop, min, max);
        return this;
      default: {
        const result = new RegexNode(lazy ? Nt.Lazyloop : Nt.Loop, this.options);
        result.m = min;
        result.n = max;
        result.addChild(this);
        return result;
      }
    }
  }
}

function maxLessThanTwiceMin(max, min) {
  if (min > Math.floor(MaxInt32 / 2)) return false; // twice min overflows
  return max < min * 2;
}

/** nodeWithCaseConversion: with IgnoreCase a cased character or a set becomes a set of its case equivalences */
function nodeWithCaseConversion(n) {
  if ((n.options & IgnoreCase) === 0) return n;
  if (n.ch > 0) {
    const ch = n.ch;
    if (isLowerRune(ch) || isUpperRune(ch)) {
      const set = new CharSet();
      set.addChar(ch);
      set.addCaseEquivalences();
      let t = Nt.Set;
      if (n.t === Nt.Oneloop || n.t === Nt.Notoneloop) t = Nt.Setloop;
      else if (n.t === Nt.Onelazy || n.t === Nt.Notonelazy) t = Nt.Setlazy;
      set.negate = n.t === Nt.Notone || n.t === Nt.Notoneloop || n.t === Nt.Notonelazy;
      const r = new RegexNode(t, n.options & ~IgnoreCase);
      r.set = set;
      return r;
    }
  } else if (n.set !== null) {
    const s = n.set.copy();
    s.addCaseEquivalences();
    n.set = s;
    n.options &= ~IgnoreCase;
  }
  return n;
}
const nodeCh = (t, opt, ch) => { const n = new RegexNode(t, opt); n.ch = ch; return nodeWithCaseConversion(n); };
const nodeStr = (t, opt, str) => { const n = new RegexNode(t, opt); n.str = str; return n; };
const nodeSet = (t, opt, set) => { const n = new RegexNode(t, opt); n.set = set; return nodeWithCaseConversion(n); };
const nodeM = (t, opt, m) => { const n = new RegexNode(t, opt); n.m = m; return n; };
const nodeMN = (t, opt, m, n2) => { const n = new RegexNode(t, opt); n.m = m; n.n = n2; return n; };

// ---- the parser (syntax/parser.go) ----

const Q = 5, S = 4, Z = 3, X = 2;
const code = (c) => c.charCodeAt(0);
// categorizing the ASCII characters (Go's _category table): whitespace, # (a ScanBlank stopper), ordinary stoppers and quantifiers
const CATEGORY = (() => {
  const t = new Array(128).fill(0);
  for (const c of [9, 10, 11, 12, 13, 0x20]) t[c] = X;
  t[code('#')] = Z;
  for (const c of '$().[\\^|') t[code(c)] = S;
  for (const c of '*+?{') t[code(c)] = Q;
  return t;
})();

const isSpace = (ch) => ch <= 0x20 && CATEGORY[ch] === X;
const isSpecial = (ch) => ch <= 0x7c && CATEGORY[ch] >= S;
const isStopperX = (ch) => ch <= 0x7c && CATEGORY[ch] >= X;
const isQuantifier = (ch) => ch <= 0x7b && CATEGORY[ch] >= Q;

const optionFromCode = (ch) => {
  switch (ch) {
    case 0x69: case 0x49: return IgnoreCase;
    case 0x72: case 0x52: return RightToLeft;
    case 0x6d: case 0x4d: return Multiline;
    case 0x6e: case 0x4e: return ExplicitCapture;
    case 0x73: case 0x53: return Singleline;
    case 0x78: case 0x58: return IgnorePatternWhitespace;
    case 0x65: case 0x45: return -1; // ECMAScript (not supported)
    case 0x75: case 0x55: return 0x400; // Unicode (no effect without ECMAScript)
    default: return 0;
  }
};

const hexDigit = (ch) => {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
  return -1;
};
class Parser {
  constructor(pattern) {
    this.pattern = Array.from(pattern, (c) => c.codePointAt(0));
    this.patternRaw = pattern;
    this.currentPos = 0;
    this.options = 0;
    this.optionsStack = [];
    this.caps = new Map();
    this.capnames = null;
    this.capnamelist = [];
    this.capnumlist = null;
    this.capcount = 0;
    this.captop = 0;
    this.autocap = 0;
    this.ignoreNextParen = false;
    this.stack = null; this.group = null; this.alternation = null; this.concatenation = null; this.unit = null;
  }

  err(msg) { return new RegexError(`error parsing regexp: ${msg} in \`${this.patternRaw}\``); }

  noteCaptureSlot(i, pos) {
    if (!this.caps.has(i)) {
      this.caps.set(i, pos);
      this.capcount++;
      if (this.captop <= i) this.captop = i === MaxInt32 ? i : i + 1;
    }
  }

  noteCaptureName(name, pos) {
    if (this.capnames === null) this.capnames = new Map();
    if (!this.capnames.has(name)) {
      this.capnames.set(name, pos);
      this.capnamelist.push(name);
    }
  }

  assignNameSlots() {
    if (this.capnames !== null) {
      for (const name of this.capnamelist) {
        while (this.isCaptureSlot(this.autocap)) this.autocap++;
        const pos = this.capnames.get(name);
        this.capnames.set(name, this.autocap);
        this.noteCaptureSlot(this.autocap, pos);
        this.autocap++;
      }
    }
    // if the caps array has at least one gap, construct the list of used slots
    if (this.capcount < this.captop) this.capnumlist = [...this.caps.keys()].sort((a, b) => a - b);
  }

  consumeAutocap() { return this.autocap++; }

  /** the prescan of the captures: a partial tokenization of the pattern */
  countCaptures() {
    this.noteCaptureSlot(0, 0);
    this.autocap = 1;
    while (this.charsRight() > 0) {
      const pos = this.textpos();
      let ch = this.moveRightGetChar();
      switch (ch) {
        case 0x5c: // \
          if (this.charsRight() > 0) { try { this.scanBackslash(true); } catch (e) { /* the prescan ignores errors */ } }
          break;
        case 0x23: // #
          if (this.useOptionX()) { this.moveLeft(); this.scanBlank(); }
          break;
        case 0x5b: // [
          try { this.scanCharSet(false, true); } catch (e) { /* the prescan ignores errors */ }
          break;
        case 0x29: // )
          if (!this.emptyOptionsStack()) this.popOptions();
          break;
        case 0x28: // (
          if (this.charsRight() >= 2 && this.rightChar(1) === 0x23 && this.rightChar(0) === 0x3f) {
            this.moveLeft();
            this.scanBlank();
          } else {
            this.pushOptions();
            if (this.charsRight() > 0 && this.rightChar(0) === 0x3f) {
              // we have (?...
              this.moveRight(1);
              if (this.charsRight() > 1 && (this.rightChar(0) === 0x3c || this.rightChar(0) === 0x27)) {
                // named group: (?<... or (?'...
                this.moveRight(1);
                ch = this.rightChar(0);
                if (ch !== 0x30 && this.isGroupNameStartChar(ch)) {
                  if (ch >= 0x31 && ch <= 0x39) {
                    const dec = this.scanDecimal();
                    this.noteCaptureSlot(dec, pos);
                  } else {
                    this.noteCaptureName(this.scanCapname(), pos);
                  }
                }
              } else {
                // (?... get the options if it's an option construct (?cimsx-cimsx...)
                this.scanOptions();
                if (this.charsRight() > 0) {
                  if (this.rightChar(0) === 0x29) {
                    // (?cimsx-cimsx)
                    this.moveRight(1);
                    this.popKeepOptions();
                  } else if (this.rightChar(0) === 0x28) {
                    // alternation construct: (?(foo)yes|no): ignore the next paren so we don't capture the condition
                    this.ignoreNextParen = true;
                    continue; // so we don't reset ignoreNextParen
                  }
                }
              }
            } else if (!this.useOptionN() && !this.ignoreNextParen) {
              this.noteCaptureSlot(this.consumeAutocap(), pos);
            }
          }
          this.ignoreNextParen = false;
          break;
        default:
      }
    }
    this.assignNameSlots();
  }

  reset(topopts) {
    this.currentPos = 0;
    this.autocap = 1;
    this.ignoreNextParen = false;
    this.optionsStack = [];
    this.options = topopts;
    this.stack = null;
  }

  scanRegex() {
    let ch; // nonspecial ch, means at beginning
    let isQuant = false;
    this.startGroup(nodeMN(Nt.Capture, this.options, 0, -1));
    outer:
    while (this.charsRight() > 0) {
      let wasPrevQuantifier = isQuant;
      isQuant = false;
      this.scanBlank();
      let startpos = this.textpos();
      // move past all of the normal characters. We'll stop when we hit some kind of control character, or if IgnorePatternWhitespace is on, we'll stop when we see some whitespace.
      if (this.useOptionX()) {
        while (this.charsRight() > 0) {
          ch = this.rightChar(0);
          if (isStopperX(ch) && (ch !== 0x7b || this.isTrueQuantifier())) break;
          this.moveRight(1);
        }
      } else {
        while (this.charsRight() > 0) {
          ch = this.rightChar(0);
          if (isSpecial(ch) && (ch !== 0x7b || this.isTrueQuantifier())) break;
          this.moveRight(1);
        }
      }
      const endpos = this.textpos();
      this.scanBlank();
      if (this.charsRight() === 0) ch = 0x21; // nonspecial, means at end
      else if (isSpecial((ch = this.rightChar(0)))) {
        isQuant = isQuantifier(ch);
        this.moveRight(1);
      } else ch = 0x20; // nonspecial, means at ordinary char

      if (startpos < endpos) {
        let cchUnquantified = endpos - startpos;
        if (isQuant) cchUnquantified--;
        wasPrevQuantifier = false;
        if (cchUnquantified > 0) this.addToConcatenate(startpos, cchUnquantified, false);
        if (isQuant) this.addUnitOne(this.charAt(endpos - 1));
      }

      switch (ch) {
        case 0x21: // !
          break outer;
        case 0x20: // ' '
          continue outer;
        case 0x5b: { // [
          const cc = this.scanCharSet(this.useOptionI(), false);
          this.addUnitSet(cc);
          break;
        }
        case 0x28: { // (
          this.pushOptions();
          const grouper = this.scanGroupOpen();
          if (grouper === null) this.popKeepOptions();
          else {
            this.pushGroup();
            this.startGroup(grouper);
          }
          continue outer;
        }
        case 0x7c: // |
          this.addAlternate();
          continue outer;
        case 0x29: // )
          if (this.emptyStack()) throw this.err('unexpected )');
          this.addGroup();
          this.popGroup();
          this.popOptions();
          if (this.unit === null) continue outer;
          break;
        case 0x5c: { // \
          if (this.charsRight() > 0 && this.rightChar(0) === 0x51) throw this.err('\\Q is not supported');
          this.addUnitNode(this.scanBackslash(false));
          break;
        }
        case 0x5e: // ^
          this.addUnitType(this.useOptionM() ? Nt.Bol : Nt.Beginning);
          break;
        case 0x24: // $
          this.addUnitType(this.useOptionM() ? Nt.Eol : Nt.EndZ);
          break;
        case 0x2e: // .
          if (this.useOptionS()) this.addUnitSet(AnyClass());
          else this.addUnitNotone(0x0a);
          break;
        case 0x7b: case 0x2a: case 0x2b: case 0x3f: // { * + ?
          if (this.unit === null) throw this.err(wasPrevQuantifier ? 'invalid repeat operator' : 'missing argument to repetition operator');
          this.moveLeft();
          break;
        default:
          throw this.err('internal error');
      }

      this.scanBlank();
      if (this.charsRight() > 0) isQuant = this.isTrueQuantifier();
      if (this.charsRight() === 0 || !isQuant) {
        this.addConcatenate();
        continue outer;
      }
      ch = this.moveRightGetChar();

      // Handle quantifiers
      while (this.unit !== null) {
        let min, max, lazy = false, possessive = false;
        switch (ch) {
          case 0x2a: min = 0; max = MaxInt32; break; // *
          case 0x3f: min = 0; max = 1; break; // ?
          case 0x2b: min = 1; max = MaxInt32; break; // +
          case 0x7b: { // {
            startpos = this.textpos();
            min = this.scanDecimal();
            max = min;
            if (startpos < this.textpos()) {
              if (this.charsRight() > 0 && this.rightChar(0) === 0x2c) {
                this.moveRight(1);
                if (this.charsRight() === 0 || this.rightChar(0) === 0x7d) max = MaxInt32;
                else max = this.scanDecimal();
              }
            }
            if (startpos === this.textpos() || this.charsRight() === 0 || this.moveRightGetChar() !== 0x7d) {
              this.addConcatenate();
              this.textto(startpos - 1);
              continue outer;
            }
            break;
          }
          default:
            throw this.err('internal error');
        }
        this.scanBlank();
        if (this.charsRight() > 0 && this.rightChar(0) === 0x3f) { this.moveRight(1); lazy = true; } else if (this.charsRight() > 0 && this.rightChar(0) === 0x2b) { this.moveRight(1); possessive = true; }
        if (min > max) throw this.err('invalid repeat size');
        this.addConcatenate3(lazy, possessive, min, max);
      }
    }
    if (!this.emptyStack()) throw this.err('missing closing )');
    this.addGroup();
    return this.unit;
  }

  isGroupNameStartChar(ch) { return isWordChar(ch); }

  /** scans a group opening: returns the group node, or null for an option-only group (?i) */
  scanGroupOpen() {
    let nt;
    let close = 0x3e;
    const start = this.textpos();
    // "(" followed by nothing, "(x" where x != ?, or "(?)"
    if (this.charsRight() === 0 || this.rightChar(0) !== 0x3f || (this.rightChar(0) === 0x3f && this.charsRight() > 1 && this.rightChar(1) === 0x29)) {
      if (this.useOptionN() || this.ignoreNextParen) {
        this.ignoreNextParen = false;
        return new RegexNode(Nt.Group, this.options);
      }
      return nodeMN(Nt.Capture, this.options, this.consumeAutocap(), -1);
    }
    this.moveRight(1);
    recognize:
    while (this.charsRight() > 0) {
      let ch = this.moveRightGetChar();
      switch (ch) {
        case 0x3a: nt = Nt.Group; break; // :
        case 0x3d: this.options &= ~RightToLeft; nt = Nt.PosLook; break; // =
        case 0x21: this.options &= ~RightToLeft; nt = Nt.NegLook; break; // !
        case 0x3e: nt = Nt.Atomic; break; // >
        case 0x27: case 0x3c: { // ' <
          if (ch === 0x27) close = 0x27;
          if (this.charsRight() === 0) break recognize;
          ch = this.moveRightGetChar();
          if (ch === 0x3d) { // (?<=
            if (close === 0x27) break recognize;
            this.options |= RightToLeft;
            nt = Nt.PosLook;
          } else if (ch === 0x21) { // (?<!
            if (close === 0x27) break recognize;
            this.options |= RightToLeft;
            nt = Nt.NegLook;
          } else {
            this.moveLeft();
            let capnum = -1, uncapnum = -1, proceed = false;
            // grab part before -
            if (ch >= 0x30 && ch <= 0x39) {
              capnum = this.scanDecimal();
              if (!this.isCaptureSlot(capnum)) capnum = -1;
              // check if we have bogus characters after the number
              if (this.charsRight() > 0 && this.rightChar(0) !== close && this.rightChar(0) !== 0x2d) throw this.err('invalid group name');
              if (capnum === 0) throw this.err('capture number cannot be zero');
            } else if (this.isGroupNameStartChar(ch)) {
              const capname = this.scanCapname();
              if (this.isCaptureName(capname)) capnum = this.captureSlotFromName(capname);
              // check if we have bogus character after the name
              if (this.charsRight() > 0 && this.rightChar(0) !== close && this.rightChar(0) !== 0x2d) throw this.err('invalid group name');
            } else if (ch === 0x2d) proceed = true;
            else throw this.err('invalid group name');
            // grab part after - if any
            if ((capnum !== -1 || proceed) && this.charsRight() > 0 && this.rightChar(0) === 0x2d) {
              this.moveRight(1);
              if (this.charsRight() === 0) throw this.err('invalid group name');
              ch = this.rightChar(0);
              if (ch >= 0x30 && ch <= 0x39) {
                uncapnum = this.scanDecimal();
                if (!this.isCaptureSlot(uncapnum)) throw this.err(`reference to undefined group number ${uncapnum}`);
                if (this.charsRight() > 0 && this.rightChar(0) !== close) throw this.err('invalid group name');
              } else if (isWordChar(ch)) {
                const uncapname = this.scanCapname();
                if (!this.isCaptureName(uncapname)) throw this.err(`reference to undefined group name ${uncapname}`);
                uncapnum = this.captureSlotFromName(uncapname);
                if (this.charsRight() > 0 && this.rightChar(0) !== close) throw this.err('invalid group name');
              } else throw this.err('invalid group name');
            }
            // actually make the node
            if ((capnum !== -1 || uncapnum !== -1) && this.charsRight() > 0 && this.moveRightGetChar() === close) return nodeMN(Nt.Capture, this.options, capnum, uncapnum);
            break recognize;
          }
          break;
        }
        case 0x28: { // alternation construct (?(...) | )
          const parenPos = this.textpos();
          if (this.charsRight() > 0) {
            ch = this.rightChar(0);
            // check if the alternation condition is a backref
            if (ch >= 0x30 && ch <= 0x39) {
              const capnum = this.scanDecimal();
              if (this.charsRight() > 0 && this.moveRightGetChar() === 0x29) {
                if (this.isCaptureSlot(capnum)) return nodeM(Nt.BackRefCond, this.options, capnum);
                throw this.err(`reference to undefined group number ${capnum}`);
              }
              throw this.err(`(?(${capnum}) malformed reference`);
            } else if (isWordChar(ch)) {
              const capname = this.scanCapname();
              if (this.isCaptureName(capname) && this.charsRight() > 0 && this.moveRightGetChar() === 0x29) return nodeM(Nt.BackRefCond, this.options, this.captureSlotFromName(capname));
            }
          }
          // not a backref
          nt = Nt.ExprCond;
          this.textto(parenPos - 1); // jump to the start of the parentheses
          this.ignoreNextParen = true; // but make sure we don't try to capture the insides
          const charsRight = this.charsRight();
          if (charsRight >= 3 && this.rightChar(1) === 0x3f) {
            const rightchar2 = this.rightChar(2);
            if (rightchar2 === 0x23) throw this.err('alternation conditions cannot be comments');
            if (rightchar2 === 0x27) throw this.err('alternation conditions do not capture and cannot be named');
            if (charsRight >= 4 && rightchar2 === 0x3c && this.rightChar(3) !== 0x21 && this.rightChar(3) !== 0x3d) throw this.err('alternation conditions do not capture and cannot be named');
          }
          break;
        }
        default: {
          this.moveLeft();
          nt = Nt.Group;
          // disallow options in the children of a testgroup node
          if (this.group.t !== Nt.ExprCond) this.scanOptions();
          if (this.charsRight() === 0) break recognize;
          ch = this.moveRightGetChar();
          if (ch === 0x29) return null;
          if (ch !== 0x3a) break recognize;
        }
      }
      return new RegexNode(nt, this.options);
    }
    throw this.err(`unrecognized grouping construct: (${String.fromCodePoint(...this.pattern.slice(start, this.textpos()))}`);
  }

  /** scans backslash specials and basics */
  scanBackslash(scanOnly) {
    if (this.charsRight() === 0) throw this.err('illegal \\ at end of pattern');
    const ch = this.rightChar(0);
    switch (ch) {
      case 0x51: case 0x52: case 0x58: // Q R X
        throw this.err(`\\${String.fromCodePoint(ch)} is not supported`);
      case 0x62: case 0x42: case 0x41: case 0x47: case 0x5a: case 0x7a: // b B A G Z z
        this.moveRight(1);
        return new RegexNode(this.typeFromCode(ch), this.options);
      case 0x77: this.moveRight(1); return nodeSet(Nt.Set, this.options, WordClass()); // w
      case 0x57: this.moveRight(1); return nodeSet(Nt.Set, this.options, NotWordClass()); // W
      case 0x73: this.moveRight(1); return nodeSet(Nt.Set, this.options, SpaceClass()); // s
      case 0x53: this.moveRight(1); return nodeSet(Nt.Set, this.options, NotSpaceClass()); // S
      case 0x64: this.moveRight(1); return nodeSet(Nt.Set, this.options, DigitClass()); // d
      case 0x44: this.moveRight(1); return nodeSet(Nt.Set, this.options, NotDigitClass()); // D
      case 0x70: case 0x50: { // p P
        this.moveRight(1);
        const prop = this.parseProperty();
        const cc = new CharSet();
        cc.addCategory(prop, ch !== 0x70, this.useOptionI());
        if (this.useOptionI()) cc.addLowercase();
        return nodeSet(Nt.Set, this.options, cc);
      }
      default:
        return this.scanBasicBackslash(scanOnly);
    }
  }

  /** scans \-style backreferences and character escapes */
  scanBasicBackslash(scanOnly) {
    if (this.charsRight() === 0) throw this.err('illegal \\ at end of pattern');
    let angled = false, k = false, close = 0;
    const backpos = this.textpos();
    let ch = this.rightChar(0);
    // Allow \k<foo> instead of \<foo>, which is now deprecated.
    if (ch === 0x6b) {
      if (this.charsRight() >= 2) {
        this.moveRight(1);
        ch = this.moveRightGetChar();
        if (ch === 0x3c || ch === 0x27) {
          angled = true;
          close = ch === 0x27 ? 0x27 : 0x3e;
        }
      }
      if (!angled || this.charsRight() <= 0) throw this.err('malformed \\k<...> named back reference');
      ch = this.rightChar(0);
      k = true;
    } else if ((ch === 0x3c || ch === 0x27) && this.charsRight() > 1) { // angle without \g
      angled = true;
      close = ch === 0x27 ? 0x27 : 0x3e;
      this.moveRight(1);
      ch = this.rightChar(0);
    }
    // Try to parse backreference: \<1> or \<cap>
    if (angled && ch >= 0x30 && ch <= 0x39) {
      const capnum = this.scanDecimal();
      if (this.charsRight() > 0 && this.moveRightGetChar() === close) {
        if (this.isCaptureSlot(capnum)) return nodeM(Nt.Ref, this.options, capnum);
        throw this.err(`reference to undefined group number ${capnum}`);
      }
    } else if (!angled && ch >= 0x31 && ch <= 0x39) { // Try to parse backreference or octal: \1
      const capnum = this.scanDecimal();
      if (scanOnly) return null;
      if (this.isCaptureSlot(capnum)) return nodeM(Nt.Ref, this.options, capnum);
      if (capnum <= 9) throw this.err(`reference to undefined group number ${capnum}`);
    } else if (angled) {
      const capname = this.scanCapname();
      if (capname !== '' && this.charsRight() > 0 && this.moveRightGetChar() === close) {
        if (scanOnly) return null;
        if (this.isCaptureName(capname)) return nodeM(Nt.Ref, this.options, this.captureSlotFromName(capname));
        throw this.err(`reference to undefined group name ${capname}`);
      } else if (k) throw this.err('malformed \\k<...> named back reference');
    }
    // Not backreference: must be char code
    this.textto(backpos);
    let c = this.scanCharEscape();
    if (scanOnly) return null;
    if (this.useOptionI()) c = toLowerRune(c);
    return nodeCh(Nt.One, this.options, c);
  }

  /** scans X for \p{X} or \P{X} */
  parseProperty() {
    // PCRE and RE2 support \pX syntax (no {} and only 1 letter unicode cats supported)
    if (this.charsRight() >= 1 && this.rightChar(0) !== 0x7b) {
      const ch = String.fromCodePoint(this.moveRightGetChar());
      const canonical = canonicalCatName(ch);
      if (canonical === null) throw this.err(`unknown property ${ch}`);
      return canonical;
    }
    if (this.charsRight() < 3) throw this.err('incomplete \\p{X} character escape');
    let ch = this.moveRightGetChar();
    if (ch !== 0x7b) throw this.err('malformed \\p{X} character escape');
    const startpos = this.textpos();
    while (this.charsRight() > 0) {
      ch = this.moveRightGetChar();
      if (!isWordChar(ch) && ch !== 0x2d && ch !== 0x3d) { this.moveLeft(); break; }
    }
    const capname = String.fromCodePoint(...this.pattern.slice(startpos, this.textpos()));
    if (this.charsRight() === 0 || this.moveRightGetChar() !== 0x7d) throw this.err('incomplete \\p{X} character escape');
    const canonical = canonicalCatName(capname);
    if (canonical === null) throw this.err(`unknown property ${capname}`);
    return canonical;
  }

  typeFromCode(ch) {
    switch (ch) {
      case 0x62: return Nt.Boundary;
      case 0x42: return Nt.Nonboundary;
      case 0x41: return Nt.Beginning;
      case 0x47: return Nt.Start;
      case 0x5a: return Nt.EndZ;
      case 0x7a: return Nt.End;
      default: return Nt.Nothing;
    }
  }

  /** scans whitespace or x-mode comments */
  scanBlank() {
    if (this.useOptionX()) {
      for (;;) {
        while (this.charsRight() > 0 && isSpace(this.rightChar(0))) this.moveRight(1);
        if (this.charsRight() === 0) break;
        if (this.rightChar(0) === 0x23) {
          while (this.charsRight() > 0 && this.rightChar(0) !== 0x0a) this.moveRight(1);
        } else if (this.charsRight() >= 3 && this.rightChar(2) === 0x23 && this.rightChar(1) === 0x3f && this.rightChar(0) === 0x28) {
          while (this.charsRight() > 0 && this.rightChar(0) !== 0x29) this.moveRight(1);
          if (this.charsRight() === 0) throw this.err('unterminated (?#...) comment');
          this.moveRight(1);
        } else break;
      }
    } else {
      for (;;) {
        if (this.charsRight() < 3 || this.rightChar(2) !== 0x23 || this.rightChar(1) !== 0x3f || this.rightChar(0) !== 0x28) return;
        while (this.charsRight() > 0 && this.rightChar(0) !== 0x29) this.moveRight(1);
        if (this.charsRight() === 0) throw this.err('unterminated (?#...) comment');
        this.moveRight(1);
      }
    }
  }

  scanWord() {
    const startpos = this.textpos();
    while (this.charsRight() > 0) {
      if (!isWordChar(this.moveRightGetChar())) { this.moveLeft(); break; }
    }
    return String.fromCodePoint(...this.pattern.slice(startpos, this.textpos()));
  }

  scanCapname() { return this.scanWord(); }

  /** scans contents of [] (not including []'s), and converts to a set */
  scanCharSet(caseInsensitive, scanOnly) {
    let ch, chPrev = 0, inRange = false, firstChar = true, closed = false;
    const cc = scanOnly ? null : new CharSet();
    if (this.charsRight() > 0 && this.rightChar(0) === 0x5e) {
      this.moveRight(1);
      if (!scanOnly) cc.negate = true;
    }
    for (; this.charsRight() > 0; firstChar = false) {
      let fTranslatedChar = false;
      ch = this.moveRightGetChar();
      if (ch === 0x5d) {
        if (!firstChar) { closed = true; break; }
      } else if (ch === 0x5c && this.charsRight() > 0) {
        ch = this.moveRightGetChar();
        switch (ch) {
          case 0x44: case 0x64: // D d
            if (!scanOnly) {
              if (inRange) throw this.err(`cannot include class \\${String.fromCodePoint(ch)} in character range`);
              cc.addDigit(ch === 0x44);
            }
            continue;
          case 0x53: case 0x73: // S s
            if (!scanOnly) {
              if (inRange) throw this.err(`cannot include class \\${String.fromCodePoint(ch)} in character range`);
              cc.addSpace(ch === 0x53);
            }
            continue;
          case 0x57: case 0x77: // W w
            if (!scanOnly) {
              if (inRange) throw this.err(`cannot include class \\${String.fromCodePoint(ch)} in character range`);
              cc.addWord(ch === 0x57);
            }
            continue;
          case 0x70: case 0x50: { // p P
            const prop = this.parseProperty();
            if (!scanOnly) {
              if (inRange) throw this.err('cannot include class in character range');
              cc.addCategory(prop, ch !== 0x70, caseInsensitive);
            }
            continue;
          }
          case 0x2d: // -
            if (!scanOnly) cc.addRange(ch, ch);
            continue;
          default:
            this.moveLeft();
            ch = this.scanCharEscape(); // non-literal character
            fTranslatedChar = true;
        }
      } else if (ch === 0x5b && !fTranslatedChar) {
        // Posix style properties - [:Ll:] or [:IsTibetan:]: skipped (not a feature in the default mode)
        if (this.charsRight() > 0 && this.rightChar(0) === 0x3a && !inRange) {
          const savePos = this.textpos();
          this.moveRight(1);
          if (this.charsRight() > 1 && this.rightChar(0) === 0x5e) this.moveRight(1);
          this.scanWord();
          if (this.charsRight() < 2 || this.moveRightGetChar() !== 0x3a || this.moveRightGetChar() !== 0x5d) this.textto(savePos);
        }
      }

      if (inRange) {
        inRange = false;
        if (!scanOnly) {
          if (ch === 0x5b && !fTranslatedChar && !firstChar) {
            // We thought we were in a range, but we're actually starting a subtraction.
            cc.addChar(chPrev);
            const sub = this.scanCharSet(caseInsensitive, false);
            cc.addSubtraction(sub);
            if (this.charsRight() > 0 && this.rightChar(0) !== 0x5d) throw this.err('a subtraction must be the last element in a character class');
          } else {
            // a regular range, like a-z
            if (chPrev > ch) throw this.err('[x-y] range in reverse order');
            cc.addRange(chPrev, ch);
          }
        }
      } else if (this.charsRight() >= 2 && this.rightChar(0) === 0x2d && this.rightChar(1) !== 0x5d) {
        // this could be the start of a range
        chPrev = ch;
        inRange = true;
        this.moveRight(1);
      } else if (this.charsRight() >= 1 && ch === 0x2d && !fTranslatedChar && this.rightChar(0) === 0x5b && !firstChar) {
        // we aren't in a range, and now there is a subtraction. Usually this happens only when a subtraction follows a range, like [a-z-[b]]
        if (!scanOnly) {
          this.moveRight(1);
          const sub = this.scanCharSet(caseInsensitive, false);
          cc.addSubtraction(sub);
          if (this.charsRight() > 0 && this.rightChar(0) !== 0x5d) throw this.err('a subtraction must be the last element in a character class');
        } else {
          this.moveRight(1);
          this.scanCharSet(caseInsensitive, true);
        }
      } else if (!scanOnly) cc.addRange(ch, ch);
    }
    if (!closed) throw this.err('missing closing ]');
    if (!scanOnly && caseInsensitive) cc.addLowercase();
    return cc;
  }

  /** scans any number of decimal digits (pegs value at 2^31-1 if too large) */
  scanDecimal() {
    let i = 0;
    while (this.charsRight() > 0) {
      const d = this.rightChar(0) - 0x30;
      if (d < 0 || d > 9) break;
      this.moveRight(1);
      if (i > 214748364 || (i === 214748364 && d > 7)) throw this.err('capture group number out of range');
      i = i * 10 + d;
    }
    return i;
  }

  /** scans imnsxu-imnsxu option string, stops at the first unrecognized char */
  scanOptions() {
    for (let off = false; this.charsRight() > 0; this.moveRight(1)) {
      const ch = this.rightChar(0);
      if (ch === 0x2d) off = true;
      else if (ch === 0x2b) off = false;
      else {
        const option = optionFromCode(ch);
        if (option === 0 || option === RightToLeft || option === -1) return;
        if (option === 0x400) continue;
        if (off) this.options &= ~option;
        else this.options |= option;
      }
    }
  }

  /** scans \ code for escape codes that map to single unicode chars */
  scanCharEscape() {
    const ch = this.moveRightGetChar();
    if (ch >= 0x30 && ch <= 0x37) {
      this.moveLeft();
      return this.scanOctal();
    }
    switch (ch) {
      case 0x78: // x
        if (this.charsRight() > 0 && this.rightChar(0) === 0x7b) { this.moveRight(1); return this.scanHexUntilBrace(); }
        return this.scanHex(2);
      case 0x75: return this.scanHex(4); // u
      case 0x61: return 7; // a
      case 0x62: return 8; // b
      case 0x65: return 0x1b; // e
      case 0x66: return 12; // f
      case 0x6e: return 10; // n
      case 0x72: return 13; // r
      case 0x74: return 9; // t
      case 0x76: return 11; // v
      case 0x63: return this.scanControl(); // c
      default:
        if (isWordChar(ch)) throw this.err(`unrecognized escape sequence \\${String.fromCodePoint(ch)}`);
        return ch;
    }
  }

  scanControl() {
    if (this.charsRight() <= 0) throw this.err('missing control character');
    let ch = this.moveRightGetChar();
    // \ca interpreted as \cA
    if (ch >= 0x61 && ch <= 0x7a) ch -= 0x20;
    ch -= 0x40;
    if (ch >= 0 && ch < 0x20) return ch;
    throw this.err('unrecognized control character');
  }

  scanHexUntilBrace() {
    let i = 0, hasContent = false;
    while (this.charsRight() > 0) {
      const ch = this.moveRightGetChar();
      if (ch === 0x7d) {
        if (!hasContent) throw this.err('insufficient hexadecimal digits');
        return i;
      }
      hasContent = true;
      const d = hexDigit(ch);
      if (d < 0) throw this.err('missing closing }');
      i = i * 16 + d;
      if (i > MaxRune) throw this.err('hex value too large');
    }
    throw this.err('missing closing }');
  }

  scanHex(c) {
    let i = 0;
    if (this.charsRight() >= c) {
      for (; c > 0; c--) {
        const d = hexDigit(this.moveRightGetChar());
        if (d < 0) break;
        i = i * 16 + d;
      }
    }
    if (c > 0) throw this.err('insufficient hexadecimal digits');
    return i;
  }

  /** up to three octal digits (stops before exceeding 0377) */
  scanOctal() {
    let c = 3;
    if (c > this.charsRight()) c = this.charsRight();
    let i = 0;
    let d = this.rightChar(0) - 0x30;
    while (c > 0 && d <= 7 && d >= 0) {
      i = i * 8 + d;
      c--;
      this.moveRight(1);
      if (!this.rightMost()) d = this.rightChar(0) - 0x30;
    }
    // Octal codes only go up to 255. Any larger and the behavior that Perl follows is simply to truncate the high bits.
    return i & 0xff;
  }

  textpos() { return this.currentPos; }
  textto(pos) { this.currentPos = pos; }
  moveRightGetChar() { return this.pattern[this.currentPos++]; }
  moveRight(i) { this.currentPos += i; }
  moveLeft() { this.currentPos--; }
  charAt(i) { return this.pattern[i]; }
  rightChar(i) { return this.pattern[this.currentPos + i]; }
  charsRight() { return this.pattern.length - this.currentPos; }
  rightMost() { return this.currentPos === this.pattern.length; }
  captureSlotFromName(capname) { return this.capnames.get(capname); }
  isCaptureSlot(i) { return this.caps.has(i); }
  isCaptureName(capname) { return this.capnames !== null && this.capnames.has(capname); }
  useOptionN() { return (this.options & ExplicitCapture) !== 0; }
  useOptionI() { return (this.options & IgnoreCase) !== 0; }
  useOptionM() { return (this.options & Multiline) !== 0; }
  useOptionS() { return (this.options & Singleline) !== 0; }
  useOptionX() { return (this.options & IgnorePatternWhitespace) !== 0; }
  emptyOptionsStack() { return this.optionsStack.length === 0; }

  /** finish the current quantifiable (when a quantifier is not found or is not possible) */
  addConcatenate() { this.concatenation.addChild(this.unit); this.unit = null; }

  /** finish the current quantifiable (when a quantifier is found) */
  addConcatenate3(lazy, possessive, min, max) {
    let node = this.unit.makeQuantifier(lazy, min, max);
    if (possessive) {
      const atomic = new RegexNode(Nt.Atomic, this.options);
      atomic.addChild(node);
      node = atomic;
    }
    this.concatenation.addChild(node);
    this.unit = null;
  }

  addUnitOne(ch) { this.unit = nodeCh(Nt.One, this.options, ch); }
  addUnitNotone(ch) { this.unit = nodeCh(Nt.Notone, this.options, ch); }
  addUnitSet(set) { this.unit = nodeSet(Nt.Set, this.options, set); }
  addUnitNode(node) { this.unit = node; }
  addUnitType(t) { this.unit = new RegexNode(t, this.options); }

  /** finish the current group (in response to a ')' or end) */
  addGroup() {
    if (this.group.t === Nt.ExprCond || this.group.t === Nt.BackRefCond) {
      this.group.addChild(this.concatenation.reverseLeft());
      if ((this.group.t === Nt.BackRefCond && this.group.children.length > 2) || this.group.children.length > 3) throw this.err('too many | in (?()|)');
    } else {
      this.alternation.addChild(this.concatenation.reverseLeft());
      this.group.addChild(this.alternation);
    }
    this.unit = this.group;
  }

  popKeepOptions() { this.optionsStack.pop(); }
  popOptions() { this.options = this.optionsStack.pop(); }
  pushOptions() { this.optionsStack.push(this.options); }

  /** add a string to the last concatenate */
  addToConcatenate(pos, cch, isReplacement) {
    if (cch === 0) return;
    if (cch === 1) {
      this.concatenation.addChild(nodeCh(Nt.One, isReplacement ? this.options & ~IgnoreCase : this.options, this.pattern[pos]));
      return;
    }
    if (cch > 1 && (!this.useOptionI() || isReplacement || !this.pattern.slice(pos, pos + cch).some(participatesInCaseConversion))) {
      this.concatenation.addChild(nodeStr(Nt.Multi, this.options & ~IgnoreCase, this.pattern.slice(pos, pos + cch)));
      return;
    }
    // each letter gets an upper-lower range
    for (let i = pos; i < pos + cch; i++) this.concatenation.addChild(nodeCh(Nt.One, this.options, this.pattern[i]));
  }

  /** push the parser state (in response to an open paren) */
  pushGroup() {
    this.group.parent = this.stack;
    this.alternation.parent = this.group;
    this.concatenation.parent = this.alternation;
    this.stack = this.concatenation;
  }

  /** remember the pushed state (in response to a ')') */
  popGroup() {
    this.concatenation = this.stack;
    this.alternation = this.concatenation.parent;
    this.group = this.alternation.parent;
    this.stack = this.group.parent;
    // The first () inside a Testgroup group goes directly to the group
    if (this.group.t === Nt.ExprCond && this.group.children.length === 0) {
      if (this.unit === null) throw this.err('alternation conditions must be a lookahead');
      this.group.addChild(this.unit);
      this.unit = null;
    }
  }

  emptyStack() { return this.stack === null; }

  /** start a new round for the parser state (in response to an open paren or string start) */
  startGroup(openGroup) {
    this.group = openGroup;
    this.alternation = new RegexNode(Nt.Alternate, this.options);
    this.concatenation = new RegexNode(Nt.Concatenate, this.options);
  }

  /** finish the current concatenation (in response to a |) */
  addAlternate() {
    // The | parts inside a Testgroup group go directly to the group
    if (this.group.t === Nt.ExprCond || this.group.t === Nt.BackRefCond) this.group.addChild(this.concatenation.reverseLeft());
    else this.alternation.addChild(this.concatenation.reverseLeft());
    this.concatenation = new RegexNode(Nt.Concatenate, this.options);
  }

  isTrueQuantifier() {
    let nChars = this.charsRight();
    if (nChars === 0) return false;
    const startpos = this.textpos();
    let ch = this.charAt(startpos);
    if (ch !== 0x7b) return ch <= 0x7b && CATEGORY[ch] >= Q;
    let pos = startpos;
    for (;;) {
      nChars--;
      if (nChars <= 0) break;
      pos++;
      ch = this.charAt(pos);
      if (ch < 0x30 || ch > 0x39) break;
    }
    if (nChars === 0 || pos - startpos === 1) return false;
    if (ch === 0x7d) return true;
    if (ch !== 0x2c) return false;
    for (;;) {
      nChars--;
      if (nChars <= 0) break;
      pos++;
      ch = this.charAt(pos);
      if (ch < 0x30 || ch > 0x39) break;
    }
    return nChars > 0 && ch === 0x7d;
  }
}

// ---- the program (syntax/code.go) and its writer (writer.go) ----

const Op = {
  Onerep: 0, Notonerep: 1, Setrep: 2, Oneloop: 3, Notoneloop: 4, Setloop: 5, Onelazy: 6, Notonelazy: 7, Setlazy: 8, One: 9, Notone: 10, Set: 11, Multi: 12, Ref: 13,
  Bol: 14, Eol: 15, Boundary: 16, Nonboundary: 17, Beginning: 18, Start: 19, EndZ: 20, End: 21, Nothing: 22, Lazybranch: 23, Branchmark: 24, Lazybranchmark: 25,
  Nullcount: 26, Setcount: 27, Branchcount: 28, Lazybranchcount: 29, Nullmark: 30, Setmark: 31, Capturemark: 32, Getmark: 33, Setjump: 34, Backjump: 35,
  Forejump: 36, Testref: 37, Goto: 38, Prune: 39, Stop: 40,
  Mask: 63, Rtl: 64, Back: 128, Back2: 256, Ci: 512,
};
const BeforeChild = 64, AfterChild = 128;

/** writes the program of a tree: Codes (ints), Strings, Sets, and the capture slot mapping */
function writeCode(root, parser) {
  const w = { emitted: [], curpos: 0, stringhash: new Map(), stringtable: [], sets: new Map(), settable: [], intStack: [] };
  let caps = null, capsize;
  if (parser.capnumlist === null || parser.captop === parser.capnumlist.length) {
    capsize = parser.captop;
  } else {
    capsize = parser.capnumlist.length;
    caps = new Map();
    for (let i = 0; i < parser.capnumlist.length; i++) caps.set(parser.capnumlist[i], i);
  }
  const mapCapnum = (n) => (n === -1 ? -1 : caps !== null ? caps.get(n) : n);
  const emit = (...ops) => { for (const o of ops) w.emitted[w.curpos++] = o; };
  const patchJump = (offset, dest) => { w.emitted[offset + 1] = dest; };
  const pushInt = (i) => w.intStack.push(i);
  const popInt = () => w.intStack.pop();
  const setCode = (set) => {
    let i = w.sets.get(set);
    if (i === undefined) { i = w.settable.length; w.sets.set(set, i); w.settable.push(set); }
    return i;
  };
  const stringCode = (str) => {
    const hash = String.fromCodePoint(...str);
    let i = w.stringhash.get(hash);
    if (i === undefined) { i = w.stringtable.length; w.stringhash.set(hash, i); w.stringtable.push(str); }
    return i;
  };

  const emitFragment = (nodetype, node, curIndex) => {
    let bits = 0;
    if ((node.options & RightToLeft) !== 0) bits |= Op.Rtl;
    if ((node.options & IgnoreCase) !== 0) bits |= Op.Ci;
    switch (nodetype) {
      case Nt.Concatenate | BeforeChild: case Nt.Concatenate | AfterChild: case Nt.Empty:
        break;
      case Nt.Alternate | BeforeChild:
        if (curIndex < node.children.length - 1) {
          pushInt(w.curpos);
          emit(Op.Lazybranch, 0);
        }
        break;
      case Nt.Alternate | AfterChild:
        if (curIndex < node.children.length - 1) {
          const lbPos = popInt();
          pushInt(w.curpos);
          emit(Op.Goto, 0);
          patchJump(lbPos, w.curpos);
        } else {
          for (let i = 0; i < curIndex; i++) patchJump(popInt(), w.curpos);
        }
        break;
      case Nt.BackRefCond | BeforeChild:
        if (curIndex === 0) {
          emit(Op.Setjump);
          pushInt(w.curpos);
          emit(Op.Lazybranch, 0);
          emit(Op.Testref, mapCapnum(node.m));
          emit(Op.Forejump);
        }
        break;
      case Nt.BackRefCond | AfterChild:
        switch (curIndex) {
          case 0: {
            const branchpos = popInt();
            pushInt(w.curpos);
            emit(Op.Goto, 0);
            patchJump(branchpos, w.curpos);
            emit(Op.Forejump);
            if (node.children.length <= 1) patchJump(popInt(), w.curpos);
            break;
          }
          case 1: patchJump(popInt(), w.curpos); break;
        }
        break;
      case Nt.ExprCond | BeforeChild:
        if (curIndex === 0) {
          emit(Op.Setjump);
          emit(Op.Setmark);
          pushInt(w.curpos);
          emit(Op.Lazybranch, 0);
        }
        break;
      case Nt.ExprCond | AfterChild:
        switch (curIndex) {
          case 0:
            emit(Op.Getmark);
            emit(Op.Forejump);
            break;
          case 1: {
            const branchpos = popInt();
            pushInt(w.curpos);
            emit(Op.Goto, 0);
            patchJump(branchpos, w.curpos);
            emit(Op.Getmark);
            emit(Op.Forejump);
            if (node.children.length <= 2) patchJump(popInt(), w.curpos);
            break;
          }
          case 2: patchJump(popInt(), w.curpos); break;
        }
        break;
      case Nt.Loop | BeforeChild: case Nt.Lazyloop | BeforeChild:
        if (node.n < MaxInt32 || node.m > 1) {
          if (node.m === 0) emit(Op.Nullcount, 0);
          else emit(Op.Setcount, 1 - node.m);
        } else if (node.m === 0) emit(Op.Nullmark);
        else emit(Op.Setmark);
        if (node.m === 0) {
          pushInt(w.curpos);
          emit(Op.Goto, 0);
        }
        pushInt(w.curpos);
        break;
      case Nt.Loop | AfterChild: case Nt.Lazyloop | AfterChild: {
        const startJumpPos = w.curpos;
        const lazy = nodetype - (Nt.Loop | AfterChild);
        if (node.n < MaxInt32 || node.m > 1) {
          if (node.n === MaxInt32) emit(Op.Branchcount + lazy, popInt(), MaxInt32);
          else emit(Op.Branchcount + lazy, popInt(), node.n - node.m);
        } else emit(Op.Branchmark + lazy, popInt());
        if (node.m === 0) patchJump(popInt(), startJumpPos);
        break;
      }
      case Nt.Group | BeforeChild: case Nt.Group | AfterChild:
        break;
      case Nt.Capture | BeforeChild:
        emit(Op.Setmark);
        break;
      case Nt.Capture | AfterChild:
        emit(Op.Capturemark, mapCapnum(node.m), mapCapnum(node.n));
        break;
      case Nt.PosLook | BeforeChild:
        // lookahead/lookbehind are NON-BACKTRACKING
        emit(Op.Setjump);
        emit(Op.Setmark);
        break;
      case Nt.PosLook | AfterChild:
        emit(Op.Getmark);
        emit(Op.Forejump);
        break;
      case Nt.NegLook | BeforeChild:
        emit(Op.Setjump);
        pushInt(w.curpos);
        emit(Op.Lazybranch, 0);
        break;
      case Nt.NegLook | AfterChild:
        emit(Op.Backjump);
        patchJump(popInt(), w.curpos);
        emit(Op.Forejump);
        break;
      case Nt.Atomic | BeforeChild:
        emit(Op.Setjump);
        break;
      case Nt.Atomic | AfterChild:
        emit(Op.Forejump);
        break;
      case Nt.One: case Nt.Notone:
        emit(node.t | bits, node.ch);
        break;
      case Nt.Notoneloop: case Nt.Notonelazy: case Nt.Oneloop: case Nt.Onelazy:
        if (node.m > 0) {
          if (node.t === Nt.Oneloop || node.t === Nt.Onelazy) emit(Op.Onerep | bits, node.ch, node.m);
          else emit(Op.Notonerep | bits, node.ch, node.m);
        }
        if (node.n > node.m) emit(node.t | bits, node.ch, node.n === MaxInt32 ? MaxInt32 : node.n - node.m);
        break;
      case Nt.Setloop: case Nt.Setlazy:
        if (node.m > 0) emit(Op.Setrep | bits, setCode(node.set), node.m);
        if (node.n > node.m) emit(node.t | bits, setCode(node.set), node.n === MaxInt32 ? MaxInt32 : node.n - node.m);
        break;
      case Nt.Multi:
        if (node.str.length > 0) emit(node.t | bits, stringCode(node.str));
        break;
      case Nt.Set:
        emit(node.t | bits, setCode(node.set));
        break;
      case Nt.Ref:
        emit(node.t | bits, mapCapnum(node.m));
        break;
      case Nt.Nothing: case Nt.Bol: case Nt.Eol: case Nt.Boundary: case Nt.Nonboundary: case Nt.Beginning: case Nt.Start: case Nt.EndZ: case Nt.End:
        emit(node.t);
        break;
      default:
        throw new RegexError(`unexpected opcode in regular expression generation: ${nodetype}`);
    }
  };

  let curNode = root, curChild = 0;
  emit(Op.Lazybranch, 0);
  for (;;) {
    if (curNode.children.length === 0) emitFragment(curNode.t, curNode, 0);
    else if (curChild < curNode.children.length) {
      emitFragment(curNode.t | BeforeChild, curNode, curChild);
      curNode = curNode.children[curChild];
      pushInt(curChild);
      curChild = 0;
      continue;
    }
    if (w.intStack.length === 0) break;
    curChild = popInt();
    curNode = curNode.parent;
    emitFragment(curNode.t | AfterChild, curNode, curChild);
    curChild++;
  }
  patchJump(0, w.curpos);
  emit(Op.Stop);
  return { codes: w.emitted, strings: w.stringtable, sets: w.settable, caps, capsize };
}

// ---- the interpreter (runner.go, executeDefault) ----

const MAX_STEPS = 20000000;

class Matcher {
  constructor(code) {
    this.code = code;
    this.codes = code.codes;
  }

  /** runs the program on text (array of code points) with \G at textstart; returns the match arrays (per capture slot: [start, len] or null), or null */
  run(text, textstart) {
    const codes = this.codes, sets = this.code.sets, strings = this.code.strings;
    const textend = text.length;
    const capsize = this.code.capsize;
    // captures: per slot, a list of [start, len] pairs and a count
    const matches = new Array(capsize), matchcount = new Array(capsize).fill(0);
    for (let i = 0; i < capsize; i++) matches[i] = [];
    const isMatched = (c) => c < capsize && matchcount[c] > 0;
    // the backtracking stacks grow upward here (Go's grow downward): `depth` is the number of items; a peek reads the item just above the top
    const track = [], stack = [], crawl = [];
    let tp = 0, sp = 0, cp = 0;
    let textpos = textstart;
    let codepos = 0;
    let operator = 0, rightToLeft = false, caseInsensitive = false;
    const setOperator = (op) => {
      caseInsensitive = (op & Op.Ci) !== 0;
      rightToLeft = (op & Op.Rtl) !== 0;
      operator = op & ~(Op.Rtl | Op.Ci);
    };
    const advance = (i) => { codepos += i + 1; setOperator(codes[codepos]); };
    const goTo = (newpos) => { setOperator(codes[newpos]); codepos = newpos; };
    const operand = (i) => codes[codepos + i + 1];
    const trackPush = () => { track[tp++] = codepos; };
    const trackPush1 = (a) => { track[tp++] = a; track[tp++] = codepos; };
    const trackPush2 = (a, b) => { track[tp++] = a; track[tp++] = b; track[tp++] = codepos; };
    const trackPush3 = (a, b, c) => { track[tp++] = a; track[tp++] = b; track[tp++] = c; track[tp++] = codepos; };
    const trackPushNeg1 = (a) => { track[tp++] = a; track[tp++] = -codepos; };
    const trackPushNeg2 = (a, b) => { track[tp++] = a; track[tp++] = b; track[tp++] = -codepos; };
    const trackPeek = () => track[tp];
    const trackPeekN = (i) => track[tp + i];
    const stackPush = (a) => { stack[sp++] = a; };
    const stackPush2 = (a, b) => { stack[sp++] = a; stack[sp++] = b; };
    const stackPeek = () => stack[sp];
    const stackPeekN = (i) => stack[sp + i];
    const crawlPush = (i) => { crawl[cp++] = i; };
    const uncapture = () => { matchcount[crawl[--cp]]--; };
    const capture = (capnum, start, end) => {
      if (end < start) { const t = end; end = start; start = t; }
      crawlPush(capnum);
      const m = matches[capnum], c = matchcount[capnum];
      m[c * 2] = start;
      m[c * 2 + 1] = end - start;
      matchcount[capnum] = c + 1;
    };
    const rightchars = () => textend - textpos;
    const forwardchars = () => (rightToLeft ? textpos : textend - textpos);
    const forwardcharnext = () => (rightToLeft ? text[--textpos] : text[textpos++]);
    const bump = () => (rightToLeft ? -1 : 1);
    const backwardnext = () => { if (rightToLeft) textpos++; else textpos--; };
    const isBoundary = (index) => (index > 0 && isWordChar(text[index - 1])) !== (index < textend && isWordChar(text[index]));

    const runematch = (str) => {
      const c0 = str.length;
      let c = c0, pos;
      if (!rightToLeft) {
        if (textend - textpos < c) return false;
        pos = textpos + c;
      } else {
        if (textpos < c) return false;
        pos = textpos;
      }
      while (c !== 0) {
        c--; pos--;
        if (str[c] !== text[pos]) return false;
      }
      if (!rightToLeft) pos += c0;
      textpos = pos;
      return true;
    };
    const refmatch = (index, len) => {
      let c, pos;
      if (!rightToLeft) {
        if (textend - textpos < len) return false;
        pos = textpos + len;
      } else {
        if (textpos < len) return false;
        pos = textpos;
      }
      let cmpos = index + len;
      c = len;
      if (!caseInsensitive) {
        while (c !== 0) {
          c--; cmpos--; pos--;
          if (text[cmpos] !== text[pos]) return false;
        }
      } else {
        while (c !== 0) {
          c--; cmpos--; pos--;
          if (toLowerRune(text[cmpos]) !== toLowerRune(text[pos])) return false;
        }
      }
      if (!rightToLeft) pos += len;
      textpos = pos;
      return true;
    };
    const backtrack = () => {
      let newpos = track[--tp];
      if (newpos < 0) {
        newpos = -newpos;
        setOperator(codes[newpos] | Op.Back2);
      } else setOperator(codes[newpos] | Op.Back);
      codepos = newpos;
    };

    goTo(0);
    let steps = 0;
    for (;;) {
      if (++steps > MAX_STEPS) return null; // regexp2's match timeout (250 ms in chroma): no match
      sw:
      switch (operator) {
        case Op.Stop:
          return matchcount[0] > 0 ? { matches, matchcount } : null;
        case Op.Nothing:
          break;
        case Op.Goto:
          goTo(operand(0));
          continue;
        case Op.Testref:
          if (!isMatched(operand(0))) break;
          advance(1);
          continue;
        case Op.Lazybranch:
          trackPush1(textpos);
          advance(1);
          continue;
        case Op.Lazybranch | Op.Back:
          tp--;
          textpos = trackPeek();
          goTo(operand(0));
          continue;
        case Op.Setmark:
          stackPush(textpos);
          trackPush();
          advance(0);
          continue;
        case Op.Nullmark:
          stackPush(-1);
          trackPush();
          advance(0);
          continue;
        case Op.Setmark | Op.Back: case Op.Nullmark | Op.Back:
          sp--;
          break;
        case Op.Getmark:
          sp--;
          trackPush1(stackPeek());
          textpos = stackPeek();
          advance(0);
          continue;
        case Op.Getmark | Op.Back:
          tp--;
          stackPush(trackPeek());
          break;
        case Op.Capturemark:
          if (operand(1) !== -1) throw new RegexError('balancing groups are not supported');
          sp--;
          capture(operand(0), stackPeek(), textpos);
          trackPush1(stackPeek());
          advance(2);
          continue;
        case Op.Capturemark | Op.Back:
          tp--;
          stackPush(trackPeek());
          uncapture();
          break;
        case Op.Branchmark: {
          sp--;
          const matched = textpos - stackPeek();
          if (matched !== 0) { // Nonempty match -> loop now
            trackPush2(stackPeek(), textpos); // Save old mark, textpos
            stackPush(textpos); // Make new mark
            goTo(operand(0)); // Loop
          } else { // Empty match -> straight now
            trackPushNeg1(stackPeek()); // Save old mark
            advance(1); // Straight
          }
          continue;
        }
        case Op.Branchmark | Op.Back:
          tp -= 2;
          sp--;
          textpos = trackPeekN(1); // Recall position
          trackPushNeg1(trackPeek()); // Save old mark
          advance(1); // Straight
          continue;
        case Op.Branchmark | Op.Back2:
          tp--;
          stackPush(trackPeek()); // Recall old mark
          break; // Backtrack
        case Op.Lazybranchmark: {
          // We hit this the first time through a lazy loop and after each successful match of the inner expression. It simply continues on and doesn't loop.
          sp--;
          const oldMarkPos = stackPeek();
          if (textpos !== oldMarkPos) { // Nonempty match -> try to loop again by going to 'back' state
            if (oldMarkPos !== -1) trackPush2(oldMarkPos, textpos); // Save old mark, textpos
            else trackPush2(textpos, textpos);
          } else {
            // The inner expression found an empty match, so we'll go directly to 'back2' if we backtrack.
            trackPushNeg2(oldMarkPos, 0);
          }
          advance(1);
          continue;
        }
        case Op.Lazybranchmark | Op.Back: {
          // After the first time, this occurs with each iteration of the loop. We'll try to match the inner expression, then go back to Lazybranchmark if successful.
          tp -= 2;
          const pos = trackPeekN(1);
          trackPushNeg2(trackPeek(), 1); // Save old mark, note that we pushed a new mark
          stackPush(pos); // Make new mark
          textpos = pos; // Recall position
          goTo(operand(0)); // Loop
          continue;
        }
        case Op.Lazybranchmark | Op.Back2: {
          // The lazy loop has failed. We'll do a true backtrack and start over before the lazy loop.
          tp -= 2;
          const oldMark = trackPeek();
          const needsPop = trackPeekN(1);
          if (needsPop !== 0) sp--;
          stackPush(oldMark); // Recall old mark
          break;
        }
        case Op.Setcount:
          stackPush2(textpos, operand(0));
          trackPush();
          advance(1);
          continue;
        case Op.Nullcount:
          stackPush2(-1, operand(0));
          trackPush();
          advance(1);
          continue;
        case Op.Setcount | Op.Back: case Op.Nullcount | Op.Back:
          sp -= 2;
          break;
        case Op.Branchcount: {
          // stack: 0: Mark, 1: Count
          sp -= 2;
          const mark = stackPeek(), count = stackPeekN(1);
          const matched = textpos - mark;
          if (count >= operand(1) || (matched === 0 && count >= 0)) { // Max loops or empty match -> straight now
            trackPushNeg2(mark, count); // Save old mark, count
            advance(2); // Straight
          } else { // Nonempty match -> count+loop now
            trackPush1(mark); // remember mark
            stackPush2(textpos, count + 1); // Make new mark, incr count
            goTo(operand(0)); // Loop
          }
          continue;
        }
        case Op.Branchcount | Op.Back:
          // track: 0: Previous mark; stack: 0: Mark (= current pos, discarded), 1: Count
          tp--;
          sp -= 2;
          if (stackPeekN(1) > 0) { // Positive -> can go straight
            textpos = stackPeek(); // Zap to mark
            trackPushNeg2(trackPeek(), stackPeekN(1) - 1); // Save old mark, old count
            advance(2); // Straight
            continue;
          }
          stackPush2(trackPeek(), stackPeekN(1) - 1); // recall old mark, old count
          break;
        case Op.Branchcount | Op.Back2:
          // track: 0: Previous mark, 1: Previous count
          tp -= 2;
          stackPush2(trackPeek(), trackPeekN(1)); // Recall old mark, old count
          break;
        case Op.Lazybranchcount: {
          // stack: 0: Mark, 1: Count
          sp -= 2;
          const mark = stackPeek(), count = stackPeekN(1);
          if (count < 0) { // Negative count -> loop now
            trackPushNeg1(mark); // Save old mark
            stackPush2(textpos, count + 1); // Make new mark, incr count
            goTo(operand(0)); // Loop
          } else { // Nonneg count -> straight now
            trackPush3(mark, count, textpos); // Save mark, count, position
            advance(2); // Straight
          }
          continue;
        }
        case Op.Lazybranchcount | Op.Back: {
          // track: 0: Mark, 1: Count, 2: textpos
          tp -= 3;
          const mark = trackPeek();
          const pos = trackPeekN(2);
          if (trackPeekN(1) < operand(1) && pos !== mark) { // Under limit and not empty match -> loop
            textpos = pos; // Recall position
            stackPush2(pos, trackPeekN(1) + 1); // Make new mark, incr count
            trackPushNeg1(mark); // Save old mark
            goTo(operand(0)); // Loop
            continue;
          }
          // Max loops or empty match -> backtrack
          stackPush2(trackPeek(), trackPeekN(1)); // Recall old mark, count
          break;
        }
        case Op.Lazybranchcount | Op.Back2:
          // track: 0: Previous mark; stack: 0: Mark (== current pos, discarded), 1: Count
          tp--;
          sp -= 2;
          stackPush2(trackPeek(), stackPeekN(1) - 1); // Recall old mark, count
          break; // Backtrack
        case Op.Setjump:
          stackPush2(tp, cp);
          trackPush();
          advance(0);
          continue;
        case Op.Setjump | Op.Back:
          sp -= 2;
          break;
        case Op.Backjump:
          // stack: 0: Saved trackpos, 1: crawlpos
          sp -= 2;
          tp = stackPeek();
          while (cp !== stackPeekN(1)) uncapture();
          break;
        case Op.Forejump:
          // stack: 0: Saved trackpos, 1: crawlpos
          sp -= 2;
          tp = stackPeek();
          trackPush1(stackPeekN(1));
          advance(0);
          continue;
        case Op.Forejump | Op.Back:
          // track: 0: crawlpos
          tp--;
          while (cp !== trackPeek()) uncapture();
          break;
        case Op.Bol:
          if (textpos > 0 && text[textpos - 1] !== 0x0a) break;
          advance(0);
          continue;
        case Op.Eol:
          if (rightchars() > 0 && text[textpos] !== 0x0a) break;
          advance(0);
          continue;
        case Op.Boundary:
          if (!isBoundary(textpos)) break;
          advance(0);
          continue;
        case Op.Nonboundary:
          if (isBoundary(textpos)) break;
          advance(0);
          continue;
        case Op.Beginning:
          if (textpos > 0) break;
          advance(0);
          continue;
        case Op.Start:
          if (textpos !== textstart) break;
          advance(0);
          continue;
        case Op.EndZ: {
          const rchars = rightchars();
          if (rchars > 1) break;
          if (rchars === 1 && text[textpos] !== 0x0a) break; // "regular" mode
          advance(0);
          continue;
        }
        case Op.End:
          if (rightchars() > 0) break;
          advance(0);
          continue;
        case Op.One:
          if (forwardchars() < 1 || forwardcharnext() !== operand(0)) break;
          advance(1);
          continue;
        case Op.Notone:
          if (forwardchars() < 1 || forwardcharnext() === operand(0)) break;
          advance(1);
          continue;
        case Op.Set:
          if (forwardchars() < 1 || !sets[operand(0)].charIn(forwardcharnext())) break;
          advance(1);
          continue;
        case Op.Multi:
          if (!runematch(strings[operand(0)])) break;
          advance(1);
          continue;
        case Op.Ref: {
          const capnum = operand(0);
          if (isMatched(capnum)) {
            const c = matchcount[capnum];
            if (!refmatch(matches[capnum][c * 2 - 2], matches[capnum][c * 2 - 1])) break;
          } else break;
          advance(1);
          continue;
        }
        case Op.Onerep: {
          let c = operand(1);
          if (forwardchars() < c) break;
          const ch = operand(0);
          while (c > 0) {
            if (forwardcharnext() !== ch) break sw;
            c--;
          }
          advance(2);
          continue;
        }
        case Op.Notonerep: {
          let c = operand(1);
          if (forwardchars() < c) break;
          const ch = operand(0);
          while (c > 0) {
            if (forwardcharnext() === ch) break sw;
            c--;
          }
          advance(2);
          continue;
        }
        case Op.Setrep: {
          let c = operand(1);
          if (forwardchars() < c) break;
          const set = sets[operand(0)];
          while (c > 0) {
            if (!set.charIn(forwardcharnext())) break sw;
            c--;
          }
          advance(2);
          continue;
        }
        case Op.Oneloop: {
          let c = operand(1);
          if (c > forwardchars()) c = forwardchars();
          const ch = operand(0);
          let i = c;
          for (; i > 0; i--) {
            if (forwardcharnext() !== ch) { backwardnext(); break; }
          }
          if (c > i) trackPush2(c - i - 1, textpos - bump());
          advance(2);
          continue;
        }
        case Op.Notoneloop: {
          let c = operand(1);
          if (c > forwardchars()) c = forwardchars();
          const ch = operand(0);
          let i = c;
          for (; i > 0; i--) {
            if (forwardcharnext() === ch) { backwardnext(); break; }
          }
          if (c > i) trackPush2(c - i - 1, textpos - bump());
          advance(2);
          continue;
        }
        case Op.Setloop: {
          let c = operand(1);
          if (c > forwardchars()) c = forwardchars();
          const set = sets[operand(0)];
          let i = c;
          for (; i > 0; i--) {
            if (!set.charIn(forwardcharnext())) { backwardnext(); break; }
          }
          if (c > i) trackPush2(c - i - 1, textpos - bump());
          advance(2);
          continue;
        }
        case Op.Oneloop | Op.Back: case Op.Notoneloop | Op.Back: case Op.Setloop | Op.Back: {
          tp -= 2;
          const i = trackPeek();
          const pos = trackPeekN(1);
          textpos = pos;
          if (i > 0) trackPush2(i - 1, pos - bump());
          advance(2);
          continue;
        }
        case Op.Onelazy: case Op.Notonelazy: case Op.Setlazy: {
          let c = operand(1);
          if (c > forwardchars()) c = forwardchars();
          if (c > 0) trackPush2(c - 1, textpos);
          advance(2);
          continue;
        }
        case Op.Onelazy | Op.Back: {
          tp -= 2;
          const pos = trackPeekN(1);
          textpos = pos;
          if (forwardcharnext() !== operand(0)) break;
          const i = trackPeek();
          if (i > 0) trackPush2(i - 1, pos + bump());
          advance(2);
          continue;
        }
        case Op.Notonelazy | Op.Back: {
          tp -= 2;
          const pos = trackPeekN(1);
          textpos = pos;
          if (forwardcharnext() === operand(0)) break;
          const i = trackPeek();
          if (i > 0) trackPush2(i - 1, pos + bump());
          advance(2);
          continue;
        }
        case Op.Setlazy | Op.Back: {
          tp -= 2;
          const pos = trackPeekN(1);
          textpos = pos;
          if (!sets[operand(0)].charIn(forwardcharnext())) break;
          const i = trackPeek();
          if (i > 0) trackPush2(i - 1, pos + bump());
          advance(2);
          continue;
        }
        default:
          throw new RegexError(`unknown state in regex runner: ${operator}`);
      }
      // "break" comes here:
      backtrack();
    }
  }
}

/** A compiled regexp2 pattern (syntax: .NET, as regexp2.Compile with no options). */
export class Regexp {
  constructor(pattern) {
    const p = new Parser(pattern);
    p.countCaptures();
    p.reset(0);
    const root = p.scanRegex();
    this.code = writeCode(root, p);
    this.matcher = new Matcher(this.code);
    this.pattern = pattern;
  }

  /**
   * FindRunesMatchStartingAt for a pattern that starts with \G (chroma's rules): the groups of the match at `start`, as strings in group order
   * (group 0 is the whole match; a group that did not take part is ''), or null. `text` is an array of code points.
   */
  matchAt(text, start) {
    const m = this.matcher.run(text, start);
    if (m === null) return null;
    const out = new Array(this.code.capsize);
    for (let i = 0; i < out.length; i++) {
      const c = m.matchcount[i];
      out[i] = c === 0 ? '' : String.fromCodePoint(...text.slice(m.matches[i][c * 2 - 2], m.matches[i][c * 2 - 2] + m.matches[i][c * 2 - 1]));
    }
    return out;
  }
}
