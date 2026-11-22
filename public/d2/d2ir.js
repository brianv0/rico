// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2ir package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.): the tree
// that keeps track of the resolved value of D2 keys (globs, imports, vars, spreads, filters, boards).
//
// Same algorithm, same names (camelCase), same error messages as d2ir.go, compile.go, import.go, merge.go,
// pattern.go and query.go. Conventions that differ from Go because JavaScript has no typed interfaces:
//  - d2ast.String / d2ast.Scalar values (a Field's Name, a Scalar's Value) are kept as boxes (`{ unquoted_string: node }`,
//    see ast.js), since a bare node does not say what it is. The JSON output unboxes them like Go's does.
//  - Go's nil slices are `null`, so `"fields": null` and `"fields": []` serialise as Go's do. Go's slice aliasing is
//    not modelled except where noted.
//  - Go's `Primary()` method is `primary()` and the exported field `Primary_` is `primary_`; same for Map_, Context_.
//  - Go's `Map` is `IRMap` and `Array` is `IRArray`, to not shadow JavaScript's.
//
// Imports read from `opts.fs`, an object `{ 'path.d2': 'text' }` standing in for Go's fs.FS. Without it Go reads the
// disk; this port never does, and reports the files as missing with the same message Go's os.Open gives.

import {
  AstError, boxKind, unbox, scalarBox, scalarString, box, makeRange, rangeIsZero,
  ReservedKeywords, SimpleReservedKeywords, ReservedKeywordHolders, CompositeReservedKeywords, BoardKeywords,
  flatUnquotedString, rawString, makeKeyPathString, keyPathIDA, isDoubleGlob, isTripleGlob,
  keyPathHasGlob, keyPathHasMultiGlob, keyPathFirstGlob, keyPathLast,
  keyHasGlob, keyHasTripleGlob, keyHasMultiGlob, keySupportsGlobFilters, mapHasFilter, keyEquals,
  goLower, equalFold, pathJoin, pathDir, pathExt, pathClean, substitutionIDA, importIDA, importPathWithPre, importDir,
  coalesce,
} from './ast.js';
import { ParseError, parse, parseKey, parseMapKey } from './parser.js';
import { format } from './format.js';
import { ShapeClass, ShapeSQLTable } from './target.js';
import { themeExists } from './themes.js';
import { replaceSubstitutionsMarkdown } from './textmeasure.js';
import { parse as urlParse } from './url.js';
import { unescapeString as htmlUnescape } from './gohtml.js';

// ---- small Go-isms ----

const BoardLayer = 'layer', BoardScenario = 'scenario', BoardStep = 'step';

const ss = scalarString; // ScalarString() of a string/scalar box
const isUnquoted = (b) => !!b.unquoted_string; // IsUnquoted() of a string box
const same = (a, b) => (a ?? null) === (b ?? null); // Go pointer comparison
const cp = (a) => (a && a.length ? a.slice() : null); // append([]T(nil), a...)
const flat = (s) => box('unquoted_string', flatUnquotedString(s)); // d2ast.FlatUnquotedString as a string box
const fmtKP = (kp) => format('key_path', kp);
const fmtBox = (b) => format(boxKind(b), unbox(b));
const shallow = (o) => Object.assign(Object.create(Object.getPrototypeOf(o)), o); // tmp := *o

/** An error for the AST node n, like d2parser.Errorf. n may be a node or a box. */
function errorf(n, msg) {
  const nn = n.range ? n : unbox(n);
  return new AstError(nn.range, `${nn.range}: ${msg}`);
}

// Go's strconv.Quote.
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
function goQuote(s) {
  let o = '"';
  for (const c of s) {
    const cp = c.codePointAt(0);
    if (c === '"' || c === '\\') o += '\\' + c;
    else if (c === '\x07') o += '\\a';
    else if (c === '\b') o += '\\b';
    else if (c === '\f') o += '\\f';
    else if (c === '\n') o += '\\n';
    else if (c === '\r') o += '\\r';
    else if (c === '\t') o += '\\t';
    else if (c === '\v') o += '\\v';
    else if (printable.test(c)) o += c;
    else if (cp < 0x80 || (cp >= 0xD800 && cp < 0xE000)) o += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp < 0x10000) o += '\\u' + cp.toString(16).padStart(4, '0');
    else o += '\\U' + cp.toString(16).padStart(8, '0');
  }
  return o + '"';
}

// Go's fmt %q applied to a []d2ast.String, which prints each pointer's struct with %!q(...) around it. Go prints the
// *string and *Substitution pointers as addresses; here they are always 0xc000000000 (the diff normalises them).
function fmtPosition(p) { return `{${p.line} ${p.column} ${p.byte}}`; }
function fmtRange(r) { return `{${r.path} ${fmtPosition(r.start)} ${fmtPosition(r.end)}}`; }
function fmtInterp(boxes) {
  return '[' + (boxes || []).map((b) => `{${b.string !== undefined ? '0xc000000000' : '<nil>'} ${b.raw_string !== undefined ? '0xc000000000' : '<nil>'} ${b.substitution ? '0xc000000000' : '<nil>'}}`).join(' ') + ']';
}
function fmtQIDA(ida) {
  return '[' + (ida || []).map((sb) => {
    const k = boxKind(sb), n = unbox(sb);
    const t = { unquoted_string: 'UnquotedString', double_quoted_string: 'DoubleQuotedString', single_quoted_string: 'SingleQuotedString', block_string: 'BlockString' }[k];
    let body;
    if (k === 'unquoted_string') body = `{${fmtRange(n.range)} ${fmtInterp(n.value)} [${(n.pattern || []).join(' ')}]}`;
    else if (k === 'double_quoted_string') body = `{${fmtRange(n.range)} ${fmtInterp(n.value)}}`;
    else if (k === 'single_quoted_string') body = `{${fmtRange(n.range)} ${n.raw} ${n.value}}`;
    else body = `{${fmtRange(n.range)} ${n.quote} ${n.tag} ${n.value}}`;
    return `%!q(*d2ast.${t}=&${body})`;
  }).join(' ') + ']';
}

// Go's strconv.Atoi and ParseBool.
function atoi(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const n = BigInt(s);
  if (n > 9223372036854775807n || n < -9223372036854775808n) return null;
  return Number(n);
}
const parseBool = (s) => (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(s) ? true : ['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(s) ? false : null);

// ---- Node types ----

/** Value of a Scalar: `value` is a scalar box. */
export class Scalar {
  constructor(o = {}) { this.parent = null; this.value = null; Object.assign(this, o); }
  copy(newParent) { const s = shallow(this); s.parent = newParent; s.value = cloneASTScalarBox(s.value); return s; }
  equal(n2) {
    const s2 = n2;
    if (isStringBox(this.value) && isStringBox(s2.value)) return ss(this.value) === ss(s2.value);
    return boxType(this.value) === boxType(s2.value) && ss(this.value) === ss(s2.value);
  }
  primary() { return this; }
  map() { return null; }
  ast() { return this.value; }
  toString() { return fmtBox(this.ast()); }
  lastRef() { return parentRef(this); }
  lastPrimaryRef() { return parentPrimaryRef(this); }
  lastPrimaryKey() { return parentPrimaryKey(this); }
  toJSON() { return { value: unbox(this.value) ?? null }; }
}
const isStringBox = (b) => { const k = boxKind(b); return k === 'unquoted_string' || k === 'double_quoted_string' || k === 'single_quoted_string' || k === 'block_string'; };
const TYPE = { null: 'null', suspension: 'suspension', boolean: 'boolean', number: 'number', unquoted_string: 'unquoted string', double_quoted_string: 'double quoted string', single_quoted_string: 'single quoted string' };
const boxType = (b) => { const k = boxKind(b); return k === 'block_string' ? b[k].tag + ' block string' : TYPE[k]; };

export class IRMap {
  constructor(o = {}) { this.parent = null; this.importAST = null; this.fields = null; this.edges = null; this.globs = null; this.structureVersion = 0; Object.assign(this, o); }

  initRoot() {
    this.parent = new Field({
      name: flat('root'),
      references: [new FieldReference({ context_: new RefContext({ scopeMap: this }) })],
    });
  }

  getImportAST() { return this.importAST; }
  setImportAST(node) {
    this.importAST = node;
    for (const f of this.fields || []) f.setImportAST(node);
    for (const e of this.edges || []) e.setImportAST(node);
  }

  copy(newParent) {
    const m = shallow(this);
    m.structureVersion = 0;
    m.parent = newParent;
    const pfields = m.fields || [];
    m.fields = [];
    for (const f of pfields) m.fields.push(f.copy(m));
    m.edges = cp(m.edges);
    for (let i = 0; i < (m.edges || []).length; i++) m.edges[i] = m.edges[i].copy(m);
    if (m.parent === null) m.initRoot();
    return m;
  }

  // Fields and Edges retain source order. structureVersion changes whenever a field or edge is added or removed in this map or
  // any descendant (lazy globs use it instead of recounting the whole IR around every compiled key). The Go lookup indexes
  // (fieldIndex, edgeIndex) are derived accelerators only and are not ported.
  markStructureChanged() {
    for (let current = this; current !== null; current = parentMap(current)) current.structureVersion++;
  }

  appendField(f) {
    this.fields = [...(this.fields || []), f];
    this.markStructureChanged();
  }

  insertField(index, f) {
    const fs = this.fields || [];
    this.fields = [...fs.slice(0, index), f, ...fs.slice(index)];
    this.markStructureChanged();
  }

  removeField(index) {
    const f = this.fields[index];
    this.fields.splice(index, 1);
    this.markStructureChanged();
    return f;
  }

  appendEdge(e) {
    this.edges = [...(this.edges || []), e];
    this.markStructureChanged();
  }

  removeEdge(index) {
    const e = this.edges[index];
    this.edges.splice(index, 1);
    this.markStructureChanged();
    return e;
  }

  /** Root reports whether the Map is the root of the D2 tree. */
  root() {
    const f = this.parent;
    if (!(f instanceof Field)) return false;
    return f.root();
  }

  primary() { return null; }
  map() { return this; }
  toString() { return fmtBox(this.ast()); }
  lastRef() { return parentRef(this); }
  lastPrimaryRef() { return parentPrimaryRef(this); }
  lastPrimaryKey() { return parentPrimaryKey(this); }
  toJSON() { return { fields: this.fields, edges: this.edges }; }

  fieldCountRecursive() {
    let acc = (this.fields || []).length;
    for (const f of this.fields || []) if (f.map()) acc += f.map().fieldCountRecursive();
    for (const e of this.edges || []) if (e.map_) acc += e.map_.fieldCountRecursive();
    return acc;
  }

  edgeCountRecursive() {
    let acc = (this.edges || []).length;
    for (const f of this.fields || []) if (f.map()) acc += f.map().edgeCountRecursive();
    for (const e of this.edges || []) if (e.map_) acc += e.map_.edgeCountRecursive();
    return acc;
  }

  getClassMap(name) {
    const root = rootMap(this);
    const classes = root.map().getField(flat('classes'));
    if (classes && classes.map()) {
      const cls = classes.map().getField(flat(name));
      if (cls && cls.map()) return cls.map();
    }
    return null;
  }

  getField(...ida) {
    let m = this;
    while (ida.length > 0 && ss(ida[0]) === '_' && isUnquoted(ida[0])) {
      m = parentMap(m);
      if (m === null) return null;
    }
    return m.getField_(ida);
  }

  getField_(ida) {
    if (ida.length === 0) return null;
    const s = ida[0];
    const rest = ida.slice(1);
    if (ss(s) === '_' && isUnquoted(s)) return null;
    for (const f of this.fields || []) {
      if (!f.name) continue;
      if (!equalFold(ss(f.name), ss(s))) continue;
      if (ReservedKeywords.has(goLower(ss(s)))) {
        if (isUnquoted(f.name) !== isUnquoted(s)) continue;
      }
      if (rest.length === 0) return f;
      if (f.map()) return f.map().getField_(rest);
    }
    return null;
  }

  /** EnsureField is a bit of a misnomer. It's more of a Query/Ensure combination function at this point. */
  ensureFieldTop(kp, refctx, create, c) {
    let m = this;
    let i = 0;
    while (ss(kp.path[i]) === '_' && isUnquoted(kp.path[i])) {
      m = parentMap(m);
      if (m === null) return [null, errorf(kp.path[i], 'invalid underscore: no parent')];
      if (i + 1 === kp.path.length) return [null, errorf(kp.path[i], 'field key must contain more than underscores')];
      i++;
    }

    let gctx = null;
    if (refctx && keyHasGlob(refctx.key) && c) gctx = c.getGlobContext(refctx);

    const fa = [];
    const created = [];
    const err = m.ensureField(i, kp, refctx, create, gctx, c, fa, created);
    if (c && c.applyingLazyWorklist && c.globRefContextStack.length > 0) {
      if (created.length > 0) c.enqueueLazyGlobFields(...fa);
    }
    if (fa.length > 0 && c && c.globRefContextStack.length === 0) {
      if (created.length > 0) {
        c.enqueueLazyPostTargets(...fa);
        c.applyLazyGlobs(fa);
      } else {
        c.applyLazyGlobs(null);
      }
    }
    return [fa, err];
  }

  ensureField(i, kp, refctx, create, gctx, c, fa, created) {
    const m = this;
    const filter = (f, passthrough) => {
      if (gctx) {
        let ks;
        if (keyHasTripleGlob(refctx.key)) ks = fmtKP(makeKeyPathString(IDA(f)));
        else ks = fmtKP(makeKeyPathString(BoardIDA(f)));
        if (!keyPathHasGlob(kp)) {
          if (!passthrough) gctx.appliedFields.add(ks);
          return true;
        }
        // For globs with edges, we only ignore duplicate fields if the glob is not at the terminal of the keypath, the glob is on the common key or the glob is on the edge key. And only for globs with edge indexes.
        const lastEl = kp.path[kp.path.length - 1];
        if ((refctx.key.edges || []).length === 0 || !lastEl.unquoted_string || !(lastEl.unquoted_string.pattern?.length > 0) || same(kp, refctx.key.key) || same(kp, refctx.key.edge_key)) {
          if (gctx.appliedFields.has(ks)) return false;
        }
        if (!passthrough) gctx.appliedFields.add(ks);
      }
      return true;
    };
    const faAppend = (...fa2) => {
      for (const f of fa2) if (filter(f, false)) fa.push(f);
    };

    const us = kp.path[i].unquoted_string;
    if (us && us.pattern !== undefined && us.pattern !== null) {
      let mg, multi;
      if (c && c.lazyGlobTarget !== null && gctx && (isDoubleGlob(us.pattern) || isTripleGlob(us.pattern))) {
        mg = m.multiGlobMatchesToward(c.lazyGlobTarget, us.pattern);
        multi = true;
      } else {
        mg = m.multiGlob(us.pattern);
        multi = mg !== null;
      }
      if (multi) {
        const fa2 = mg;
        if (i === kp.path.length - 1) faAppend(...fa2);
        else {
          for (const f of fa2) {
            if (!filter(f, true)) continue;
            if (!f.map()) f.composite = new IRMap({ parent: f });
            const err = f.map().ensureField(i + 1, kp, refctx, create, gctx, c, fa, created);
            if (err) return err;
          }
        }
        return null;
      }
      let fields = (m.fields || []).slice();
      if (c && c.lazyGlobTarget !== null && gctx) {
        const candidate = m.directChildToward(c.lazyGlobTarget);
        fields = candidate !== null ? [candidate] : [];
      }
      for (const f of fields) {
        if (!f.name) continue;
        if (matchPattern(ss(f.name), us.pattern)) {
          if (i === kp.path.length - 1) faAppend(f);
          else {
            if (!filter(f, true)) continue;
            if (!f.map()) f.composite = new IRMap({ parent: f });
            const err = f.map().ensureField(i + 1, kp, refctx, create, gctx, c, fa, created);
            if (err) return err;
          }
        }
      }
      return null;
    }

    const head = kp.path[i];
    let headString = ss(head);

    if (ReservedKeywords.has(goLower(ss(head))) && isUnquoted(head)) {
      headString = goLower(ss(head));
      if (!CompositeReservedKeywords.has(headString) && i < kp.path.length - 1) {
        return errorf(kp.path[i], `"${headString}" must be the last part of the key`);
      }
    }

    if (headString === '_' && isUnquoted(head)) {
      return errorf(kp.path[i], 'parent "_" can only be used in the beginning of paths, e.g. "_.x"');
    }

    if (headString === 'classes' && isUnquoted(head) && nodeBoardKind(m) === '') {
      return errorf(kp.path[i], `${headString} must be declared at a board root scope`);
    }

    if (findBoardKeyword(head) !== -1 && isUnquoted(head) && nodeBoardKind(m) === '') {
      return errorf(kp.path[i], `${headString} must be declared at a board root scope`);
    }

    for (const f of m.fields || []) {
      if (!(f.name && equalFold(ss(f.name), ss(head)))) continue;
      if (ReservedKeywords.has(goLower(ss(f.name)))) {
        if (isUnquoted(f.name) !== isUnquoted(head)) continue;
      }

      // Don't add references for fake common KeyPath from trimCommon in CreateEdge.
      if (refctx) {
        f.appendReference(new FieldReference({
          string: kp.path[i], keyPath: kp, context_: refctx,
          dueToGlob_: c.globRefContextStack.length > 0, dueToLazyGlob_: c.lazyGlobBeingApplied,
        }));
      }

      if (i + 1 === kp.path.length) {
        faAppend(f);
        return null;
      }
      if (!filter(f, true)) return null;
      if (f.composite instanceof IRArray) return errorf(kp.path[i], 'cannot index into array');
      if (!f.map()) f.composite = new IRMap({ parent: f });
      return f.map().ensureField(i + 1, kp, refctx, create, gctx, c, fa, created);
    }

    if (!create) return null;
    if (!(ReservedKeywords.has(goLower(ss(head))) && isUnquoted(head)) && c.globRefContextStack.length > 0) {
      const shape = parentShape(m);
      if (shape === ShapeClass || shape === ShapeSQLTable) return null;
    }
    const f = new Field({ parent: m, name: kp.path[i] });
    try {
      // Don't add references for fake common KeyPath from trimCommon in CreateEdge.
      if (refctx) {
        f.appendReference(new FieldReference({
          string: kp.path[i], keyPath: kp, context_: refctx,
          dueToGlob_: c.globRefContextStack.length > 0, dueToLazyGlob_: c.lazyGlobBeingApplied,
        }));
      }
      if (!filter(f, true)) return null;
      m.appendField(f);
      created.push(f);
      if (i + 1 === kp.path.length) {
        faAppend(f);
        return null;
      }
      if (!f.composite) f.composite = new IRMap({ parent: f });
      return f.map().ensureField(i + 1, kp, refctx, create, gctx, c, fa, created);
    } finally {
      if (!(i < keyPathFirstGlob(kp))) {
        for (const grefctx of c.globRefContextStack) {
          let ks;
          if (keyHasTripleGlob(grefctx.key)) ks = fmtKP(makeKeyPathString(IDA(f)));
          else ks = fmtKP(makeKeyPathString(BoardIDA(f)));
          const gctx2 = c.getGlobContext(grefctx);
          gctx2.appliedFields.add(ks);
        }
      }
    }
  }

  deleteEdge(eid) {
    if (!eid) return null;
    const [resolvedEID, resolvedM, common, err] = eid.resolve(this);
    if (err) return null;

    if (common.length > 0) {
      const f = resolvedM.getField(...common);
      if (!f) return null;
      if (!f.map()) return null;
      return f.map().deleteEdge(resolvedEID);
    }

    const edges = resolvedM.edges || [];
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.id.match(resolvedEID)) return resolvedM.removeEdge(i);
    }
    return null;
  }

  deleteEdgesForFieldReferences(f) {
    const m = this;
    for (const fr of f.references || []) {
      let currM = m;
      while (currM) {
        // Go ranges over a header whose backing array DeleteEdge shifts under it: elements after a deletion are
        // seen one place early, and the last one is seen again at the end.
        const arr = currM.edges || [];
        const n0 = arr.length, last = arr[n0 - 1];
        for (let k = 0; k < n0; k++) {
          const e = k < arr.length ? arr[k] : last;
          for (const er of e.references || []) {
            if (er.context_ === fr.context_) {
              currM.deleteEdge(e.id);
              break;
            }
          }
        }
        if (nodeBoardKind(currM) !== '') break;
        currM = parentMap(currM);
      }
    }
  }

  deleteField(...ida) {
    if (ida.length === 0) return null;
    const m = this;
    const s = ida[0];
    const rest = ida.slice(1);

    const fields = m.fields || [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!equalFold(ss(f.name), s)) continue;
      if (rest.length === 0) {
        m.deleteEdgesForFieldReferences(f);
        m.removeField(i);

        // If a field was deleted from a keyword-holder keyword and that holder is empty,
        // then that holder becomes meaningless and should be deleted too
        const parent = parentField(f);
        for (const keywordHolder of ReservedKeywordHolders) {
          if (parent && ss(parent.name) === keywordHolder && isUnquoted(parent.name) && (parent.map().fields || []).length === 0) {
            const keywordHolderParentMap = parentMap(parent);
            const kf = keywordHolderParentMap.fields || [];
            for (let j = 0; j < kf.length; j++) {
              if (ss(kf[j].name) === keywordHolder && isUnquoted(kf[j].name)) {
                keywordHolderParentMap.removeField(j);
                break;
              }
            }
          }
        }
        return f;
      }
      if (f.map()) return f.map().deleteField(...rest);
    }
    return null;
  }

  getEdges(eid, refctx, c) {
    let m = this;
    if (refctx) {
      let gctx = null;
      if (keyHasGlob(refctx.key) && c) gctx = c.ensureGlobContext(refctx);
      const ea = [];
      m.getEdges_(eid, refctx, gctx, ea);
      return ea;
    }

    let common, err;
    [eid, m, common, err] = eid.resolve(m);
    if (err) return null;
    if (common.length > 0) {
      const f = m.getField(...common);
      if (!f) return null;
      if (f.map()) return f.map().getEdges(eid, null, null);
      return null;
    }

    const ea = [];
    for (const e of m.edges || []) if (e.id.match(eid)) ea.push(e);
    return ea;
  }

  getEdges_(eid, refctx, gctx, ea) {
    let m = this;
    let common, err;
    [eid, m, common, err] = eid.resolve(m);
    if (err) return err;

    if (common.length > 0) {
      const commonKP = makeKeyPathString(common);
      let lastMatch = 0;
      commonKP.path.forEach((el, i) => {
        for (let j = lastMatch; j < refctx.edge.src.path.length; j++) {
          const realEl = refctx.edge.src.path[j];
          if (ss(el) === ss(realEl)) {
            commonKP.path[i] = realEl;
            lastMatch += j + 1;
          }
        }
      });
      const [fa, err2] = m.ensureFieldTop(commonKP, null, false, null);
      if (err2) return null;
      for (const f of fa) {
        if (f.composite instanceof IRArray) return errorf(refctx.edge.src, 'cannot index into array');
        if (!f.map()) f.composite = new IRMap({ parent: f });
        const err3 = f.map().getEdges_(eid, refctx, gctx, ea);
        if (err3) return err3;
      }
      return null;
    }

    const [srcFA, err4] = refctx.scopeMap.ensureFieldTop(refctx.edge.src, null, false, null);
    if (err4) return err4;
    const [dstFA, err5] = refctx.scopeMap.ensureFieldTop(refctx.edge.dst, null, false, null);
    if (err5) return err5;

    for (const src of srcFA) {
      for (const dst of dstFA) {
        const eid2 = eid.copy();
        eid2.srcPath = relIDA(m, src);
        eid2.dstPath = relIDA(m, dst);

        const ea2 = m.getEdges(eid2, null, null);
        for (const e of ea2 || []) {
          if (gctx) {
            let ks;
            if (keyHasTripleGlob(refctx.key)) ks = fmtKP(makeKeyPathString(IDA(e)));
            else ks = fmtKP(makeKeyPathString(BoardIDA(e)));
            if (gctx.appliedEdges.has(ks)) continue;
            gctx.appliedEdges.add(ks);
          }
          ea.push(e);
        }
      }
    }
    return null;
  }

  createEdge(eid, refctx, c) {
    const ea = [];
    let gctx = null;
    if (refctx && keyHasGlob(refctx.key) && c) gctx = c.ensureGlobContext(refctx);
    const err = this.createEdge_(eid, refctx, gctx, c, ea);
    if (ea.length > 0 && c && c.globRefContextStack.length === 0) {
      for (const gctx2 of c.globContexts()) {
        const old = c.lazyGlobBeingApplied;
        c.lazyGlobBeingApplied = true;
        c.compileKey(gctx2.refctx);
        c.lazyGlobBeingApplied = old;
      }
    }
    return [ea, err];
  }

  createEdge_(eid, refctx, gctx, c, ea) {
    let m = this;
    if (parentEdge(m)) return errorf(refctx.edge, 'cannot create edge inside edge');

    let common, err;
    [eid, m, common, err] = eid.resolve(m);
    if (err) return errorf(refctx.edge, err);
    if (common.length > 0) {
      const commonKP = makeKeyPathString(common);
      let lastMatch = 0;
      commonKP.path.forEach((el, i) => {
        for (let j = lastMatch; j < refctx.edge.src.path.length; j++) {
          const realEl = refctx.edge.src.path[j];
          if (ss(el) === ss(realEl)) {
            commonKP.path[i] = realEl;
            lastMatch += j + 1;
          }
        }
      });
      const [fa, err2] = m.ensureFieldTop(commonKP, null, true, c);
      if (err2) return err2;
      for (const f of fa) {
        if (f.composite instanceof IRArray) return errorf(refctx.edge.src, 'cannot index into array');
        if (!f.map()) f.composite = new IRMap({ parent: f });
        const err3 = f.map().createEdge_(eid, refctx, gctx, c, ea);
        if (err3) return err3;
      }
      return null;
    }

    let ij = findProhibitedEdgeKeyword(eid.srcPath);
    if (ij !== -1) return errorf(refctx.edge.src.path[ij], 'reserved keywords are prohibited in edges');
    ij = findBoardKeyword(...(eid.srcPath || []));
    if (ij === (eid.srcPath || []).length - 1) return errorf(refctx.edge.src.path[ij], "edge with board keyword alone doesn't make sense");

    ij = findProhibitedEdgeKeyword(eid.dstPath);
    if (ij !== -1) return errorf(refctx.edge.dst.path[ij], 'reserved keywords are prohibited in edges');
    ij = findBoardKeyword(...(eid.dstPath || []));
    if (ij === (eid.dstPath || []).length - 1) return errorf(refctx.edge.dst.path[ij], "edge with board keyword alone doesn't make sense");

    const [srcFA, err4] = refctx.scopeMap.ensureFieldTop(refctx.edge.src, refctx, true, c);
    if (err4) return err4;
    const [dstFA, err5] = refctx.scopeMap.ensureFieldTop(refctx.edge.dst, refctx, true, c);
    if (err5) return err5;

    for (const src of srcFA) {
      for (const dst of dstFA) {
        if (src === dst && (keyPathHasGlob(refctx.edge.src) || keyPathHasGlob(refctx.edge.dst))) {
          // Globs do not make self edges.
          continue;
        }

        if (keyPathHasMultiGlob(refctx.edge.src)) {
          // If src has a double glob we only select leafs, those without children.
          if (c.isContainer(src.map())) continue;
          if (nodeBoardKind(src) !== '' || parentBoard(src) !== parentBoard(dst)) continue;
        }
        if (keyPathHasMultiGlob(refctx.edge.dst)) {
          // If dst has a double glob we only select leafs, those without children.
          if (c.isContainer(dst.map())) continue;
          if (nodeBoardKind(dst) !== '' || parentBoard(src) !== parentBoard(dst)) continue;
        }

        const eid2 = eid.copy();
        eid2.srcPath = relIDA(m, src);
        eid2.dstPath = relIDA(m, dst);

        const [es, err6] = m.createEdge2(eid2, refctx, gctx, c, src, dst);
        if (err6) return err6;
        for (const e of es || []) ea.push(e);
      }
    }
    return null;
  }

  createEdge2(eid, refctx, gctx, c, src, dst) {
    let m = this;
    if (nodeBoardKind(src) !== '') return [null, errorf(refctx.edge.src, 'cannot create edges between boards')];
    if (nodeBoardKind(dst) !== '') return [null, errorf(refctx.edge.dst, 'cannot create edges between boards')];
    if (parentBoard(src) !== parentBoard(dst)) return [null, errorf(refctx.edge, 'cannot create edges between boards')];

    let common, err;
    [eid, m, common, err] = eid.resolve(m);
    if (err) return [null, errorf(refctx.edge, err)];
    if (common.length > 0) {
      const commonKP = makeKeyPathString(common);
      let lastMatch = 0;
      commonKP.path.forEach((el, i) => {
        for (let j = lastMatch; j < refctx.edge.src.path.length; j++) {
          const realEl = refctx.edge.src.path[j];
          if (ss(el) === ss(realEl)) {
            commonKP.path[i] = realEl;
            lastMatch += j + 1;
          }
        }
      });
      const [fa, err2] = m.ensureFieldTop(commonKP, null, true, c);
      if (err2) return [null, err2];
      let edges = null;
      for (const f of fa) {
        if (f.composite instanceof IRArray) return [null, errorf(refctx.edge.src, 'cannot index into array')];
        if (!f.map()) f.composite = new IRMap({ parent: f });
        const [edges2, err3] = f.map().createEdge2(eid, refctx, gctx, c, src, dst);
        if (err3) return [null, err3];
        edges = [...(edges || []), ...(edges2 || [])];
      }
      return [edges, null];
    }

    eid.index = null;
    eid.glob = true;
    const ea = m.getEdges(eid, null, null);
    const index = (ea || []).length;
    eid.index = index;
    eid.glob = false;
    const e = new Edge({
      parent: m,
      id: eid,
      references: [new EdgeReference({ context_: refctx, dueToGlob_: c.globRefContextStack.length > 0, dueToLazyGlob_: c.lazyGlobBeingApplied })],
    });

    if (gctx) {
      // We only ever want to create one of the edge per glob so we filter without the edge index.
      const e2 = e.copy(e.parent);
      e2.id = e2.id.copy();
      e2.id.index = null;
      let ks;
      if (keyHasTripleGlob(refctx.key)) ks = fmtKP(makeKeyPathString(IDA(e2)));
      else ks = fmtKP(makeKeyPathString(BoardIDA(e2)));
      if (gctx.appliedEdges.has(ks)) return [null, null];
      gctx.appliedEdges.add(ks);
    }

    m.appendEdge(e);
    return [[e], null];
  }

  ast() {
    const astMap = { range: makeRange(',0:0:0-1:0:0'), nodes: null };
    if (this.parent && nodeBoardKind(this) !== '') {
      const f = this.parent;
      if (f instanceof Field) astMap.range.path = unbox(f.name).range.path;
    }
    for (const f of this.fields || []) (astMap.nodes ||= []).push(f.ast());
    for (const e of this.edges || []) (astMap.nodes ||= []).push(e.ast());
    return { map: astMap };
  }

  appendFieldReferences(i, kp, refctx, c) {
    const sb = kp.path[i];
    const f = this.getField(sb);
    if (!f) return;

    f.appendReference(new FieldReference({
      string: sb, keyPath: kp, context_: refctx,
      dueToGlob_: c.globRefContextStack.length > 0, dueToLazyGlob_: c.lazyGlobBeingApplied,
    }));
    if (i + 1 === kp.path.length) return;
    if (f.map()) f.map().appendFieldReferences(i + 1, kp, refctx, c);
  }

  inClass(key) {
    const classes = this.map().getField(flat('classes'));
    if (!classes || !classes.map()) return false;

    for (const cls of classes.map().fields || []) {
      if (!cls.map()) continue;
      const classF = cls.map().getField(...(keyPathIDA(key.key) || []));
      if (!classF) continue;
      for (const ref of classF.references || []) if (ref.context_.key === key) return true;
    }
    return false;
  }

  isClass() {
    const pb = parentBoard(this);
    if (!pb.map()) return false;
    const classes = pb.map().getField(flat('classes'));
    if (!classes || !classes.map()) return false;
    for (const cls of classes.map().fields || []) if (cls.map() === this) return true;
    return false;
  }

  findBoardRoot(path) {
    const m = this;
    if (path.length === 0) return m;

    const layersf = m.getField(flat('layers'));
    const scenariosf = m.getField(flat('scenarios'));
    const stepsf = m.getField(flat('steps'));

    for (const holder of [layersf, scenariosf, stepsf]) {
      if (holder && holder.map()) {
        for (const f of holder.map().fields || []) {
          if (ss(f.name) === path[0]) {
            if (path.length === 1) return f.map();
            return f.map().findBoardRoot(path.slice(1));
          }
        }
      }
    }
    return null;
  }

  equal(n2) {
    const m2 = n2;
    if ((this.fields || []).length !== (m2.fields || []).length) return false;
    if ((this.edges || []).length !== (m2.edges || []).length) return false;
    for (let i = 0; i < (this.fields || []).length; i++) if (!this.fields[i].equal(m2.fields[i])) return false;
    for (let i = 0; i < (this.edges || []).length; i++) if (!this.edges[i].equal(m2.edges[i])) return false;
    return true;
  }

  // ---- pattern.go ----

  multiGlob(pattern) {
    if (isDoubleGlob(pattern)) { const fa = []; this._doubleGlob(fa); return fa; }
    if (isTripleGlob(pattern)) { const fa = []; this._tripleGlob(fa); return fa; }
    return null;
  }

  /**
   * pathToField returns the source-ordered field path from m to target. A null result means target is outside m's subtree.
   */
  pathToField(target) {
    const reverse = [];
    for (let current = target; current !== null;) {
      const parent = parentMap(current);
      if (parent === null) return null;
      reverse.push(current);
      if (parent === this) return reverse.reverse();
      current = parentField(parent);
    }
    return null;
  }

  directChildToward(target) {
    const path = this.pathToField(target);
    if (path === null || path.length === 0) return null;
    return path[0];
  }

  /**
   * multiGlobMatchesToward returns the fields in the changed top-level branch toward target that the existing recursive glob
   * traversal would append. A whole branch is replayed (rather than only the target path) so reference and filter ordering
   * remains identical within the affected branch.
   */
  multiGlobMatchesToward(target, pattern) {
    const path = this.pathToField(target);
    if (path === null || path.length === 0) return [];
    const matches = [];
    if (isDoubleGlob(pattern)) { _doubleGlobField(path[0], matches); return matches; }
    if (isTripleGlob(pattern)) { _tripleGlobField(path[0], matches); return matches; }
    return [];
  }

  _doubleGlob(fa) {
    for (const f of (this.fields || []).slice()) {
      if (!f.name) continue;
      const name = ss(f.name);
      if (ReservedKeywords.has(name) && isUnquoted(f.name)) {
        if (skipDoubleGlobSubtree(name)) continue;
        if (f.map()) f.map()._doubleGlob(fa);
        continue;
      }
      if (nodeBoardKind(f) === '') fa.push(f);
      if (f.map()) f.map()._doubleGlob(fa);
    }
  }

  _tripleGlob(fa) {
    for (const f of (this.fields || []).slice()) {
      if (ReservedKeywords.has(ss(f.name)) && isUnquoted(f.name)) {
        if (!BoardKeywords.has(ss(f.name))) continue;
        // We don't ever want to append layers, scenarios or steps directly.
        if (f.map()) f.map()._tripleGlob(fa);
        continue;
      }
      if (nodeBoardKind(f) === '') fa.push(f);
      if (f.map()) f.map()._tripleGlob(fa);
    }
  }

  // ---- query.go (tests and debugging only) ----

  queryAll(idStr) {
    let m = this;
    const k = parseMapKey(idStr);
    const na = [];
    if (k.key) {
      const [fa, err] = m.ensureFieldTop(k.key, null, false, null);
      if (err) throw err;
      if (fa.length === 0) return null;
      for (const f of fa) {
        if ((k.edges || []).length === 0) { na.push(f); return na; }
        m = f.map();
        if (!m) return null;
      }
    }
    const eida = newEdgeIDs(k);
    eida.forEach((eid, i) => {
      const refctx = new RefContext({ key: k, scopeMap: m, edge: k.edges[i] });
      for (const e of m.getEdges(eid, refctx, null) || []) {
        if (!k.edge_key) na.push(e);
        else if (e.map_) {
          const f = e.map_.getField(...(keyPathIDA(k.edge_key) || []));
          if (f) na.push(f);
        }
      }
    });
    return na;
  }

  query(idStr) {
    const na = this.queryAll(idStr);
    if (!na || na.length === 0) return null;
    if (na.length > 1) throw new Error('expected only one query result but got: ' + na.length);
    return na[0];
  }

  // ---- compile.go ----

  removeSuspendedFields() {
    const m = this;
    for (const f of m.fields || []) if (f.map()) f.map().removeSuspendedFields();

    for (let i = (m.fields || []).length - 1; i >= 0; i--) {
      if (!m.fields[i].name) continue;
      if (ReservedKeywords.has(ss(m.fields[i].name))) continue;
      if (m.fields[i].suspended) m.deleteField(ss(m.fields[i].name));
    }

    for (const e of m.edges || []) if (e.map()) e.map().removeSuspendedFields();
    for (let i = (m.edges || []).length - 1; i >= 0; i--) {
      if (m.edges[i].suspended) m.deleteEdge(m.edges[i].id);
    }
  }
}

export class Field {
  constructor(o = {}) {
    this.parent = null; this.importAST = null; this.suspended = false;
    this.name = null; this.primary_ = null; this.composite = null; this.references = null;
    Object.assign(this, o);
  }
  getImportAST() { return this.importAST; }
  setImportAST(node) { this.importAST = node; if (this.map()) this.map().setImportAST(node); }

  copy(newParent) {
    const f = shallow(this);
    f.parent = newParent;
    f.references = cp(f.references);
    if (f.primary_) f.primary_ = f.primary_.copy(f);
    if (f.composite) f.composite = f.composite.copy(f);
    return f;
  }

  /**
   * appendReference records a source reference once. Lazy glob rules are reevaluated as the IR grows, but replaying the same
   * rule against the same field does not create a new source location.
   */
  appendReference(ref) {
    if (ref.dueToLazyGlob_) {
      for (const existing of this.references || []) {
        if (sameReferenceContext(existing.context_, ref.context_) &&
          same(existing.keyPath, ref.keyPath) &&
          unbox(existing.string) === unbox(ref.string) &&
          existing.dueToGlob_ === ref.dueToGlob_ &&
          existing.dueToLazyGlob_ === ref.dueToLazyGlob_) return;
      }
    }
    this.references = [...(this.references || []), ref];
  }

  root() { return this.parent === null; }
  primary() { return this.primary_; }
  map() { return this.composite ? this.composite.map() : null; }
  toString() { return fmtBox(this.ast()); }
  lastRef() { return this.references[this.references.length - 1]; }
  lastPrimaryRef() {
    const refs = this.references || [];
    for (let i = refs.length - 1; i >= 0; i--) if (refs[i].primary()) return refs[i];
    return null;
  }
  lastPrimaryKey() {
    const fr = this.lastPrimaryRef();
    if (!fr) return null;
    return fr.context_.key;
  }
  toJSON() {
    const o = { name: unbox(this.name) ?? null };
    if (this.primary_) o.primary = this.primary_;
    if (this.composite) o.composite = this.composite;
    if (this.references && this.references.length) o.references = this.references;
    return o;
  }

  ast() {
    const k = { range: makeRange(',0:0:0-0:0:0'), key: { range: makeRange(',0:0:0-0:0:0'), path: [{ ...this.name }] }, primary: {}, value: {} };
    if (this.primary_) k.primary = scalarBox(this.primary_.ast());
    if (this.composite) {
      const value = this.composite.ast();
      if (value.map) {
        const m = value.map;
        const path = m.range.path;
        // Treat it as multi-line, but not file-map (line 0)
        m.range = makeRange(',1:0:0-2:0:0');
        m.range.path = path;
      }
      k.value = value;
    }
    return { map_key: k };
  }

  equal(n2) {
    const f2 = n2;
    if (unbox(this.name) !== unbox(f2.name)) return false;
    if (!this.primary_.equal(f2.primary_)) return false;
    if (!this.composite.equal(f2.composite)) return false;
    return true;
  }
}

export class EdgeID {
  constructor(o = {}) {
    this.srcPath = null; this.srcArrow = false; this.dstPath = null; this.dstArrow = false; this.index = null; this.glob = false;
    Object.assign(this, o);
  }

  copy() {
    const eid = shallow(this);
    eid.srcPath = cp(eid.srcPath);
    eid.dstPath = cp(eid.dstPath);
    return eid;
  }

  match(eid2) {
    if (this.index !== null && eid2.index !== null) {
      if (this.index !== eid2.index) return false;
    }

    const direct = edgePathEqual(this.srcPath, eid2.srcPath) &&
      this.srcArrow === eid2.srcArrow &&
      edgePathEqual(this.dstPath, eid2.dstPath) &&
      this.dstArrow === eid2.dstArrow;
    if (direct) return true;

    return edgePathEqual(this.srcPath, eid2.dstPath) &&
      this.srcArrow === eid2.dstArrow &&
      edgePathEqual(this.dstPath, eid2.srcPath) &&
      this.dstArrow === eid2.srcArrow;
  }

  /**
   * resolve resolves both underscores and commons in eid.
   * It returns the new eid, containing map adjusted for underscores and common ida. The last element is an error message or null.
   */
  resolve(m) {
    const eid = this.copy();
    let common = [];
    const maxUnderscores = Math.max(countUnderscores(eid.srcPath), countUnderscores(eid.dstPath));
    for (let i = 0; i < maxUnderscores; i++) {
      if (ss(eid.srcPath[0]) === '_' && isUnquoted(eid.srcPath[0])) eid.srcPath = eid.srcPath.slice(1);
      else {
        const mf = parentField(m);
        eid.srcPath = [mf.name, ...(eid.srcPath || [])];
      }
      if (ss(eid.dstPath[0]) === '_' && isUnquoted(eid.dstPath[0])) eid.dstPath = eid.dstPath.slice(1);
      else {
        const mf = parentField(m);
        eid.dstPath = [mf.name, ...(eid.dstPath || [])];
      }
      m = parentMap(m);
      if (m === null) return [null, null, null, 'invalid underscore'];
    }

    while ((eid.srcPath || []).length > 1 && (eid.dstPath || []).length > 1) {
      if (!equalFold(ss(eid.srcPath[0]), ss(eid.dstPath[0])) || ss(eid.srcPath[0]).includes('*')) return [eid, m, common, null];
      common = [...common, eid.srcPath[0]];
      eid.srcPath = eid.srcPath.slice(1);
      eid.dstPath = eid.dstPath.slice(1);
    }
    return [eid, m, common, null];
  }

  toJSON() {
    return {
      src_path: this.srcPath ? this.srcPath.map((s) => unbox(s)) : null,
      src_arrow: this.srcArrow,
      dst_path: this.dstPath ? this.dstPath.map((s) => unbox(s)) : null,
      dst_arrow: this.dstArrow,
      index: this.index,
      glob: this.glob,
    };
  }
}

function edgePathEqual(p1, p2) {
  const a = p1 || [], b = p2 || [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!equalFold(ss(a[i]), ss(b[i]))) return false;
  return true;
}

export function newEdgeIDs(k) {
  const eida = [];
  for (const ke of k.edges || []) {
    const eid = new EdgeID({
      srcPath: keyPathIDA(ke.src), srcArrow: ke.src_arrow === '<',
      dstPath: keyPathIDA(ke.dst), dstArrow: ke.dst_arrow === '>',
    });
    if (k.edge_index) {
      eid.index = k.edge_index.int ?? null;
      eid.glob = k.edge_index.glob;
    }
    eida.push(eid);
  }
  return eida.length ? eida : null;
}

export class Edge {
  constructor(o = {}) {
    this.parent = null; this.importAST = null; this.suspended = false;
    this.id = null; this.primary_ = null; this.map_ = null; this.references = null;
    Object.assign(this, o);
  }
  getImportAST() { return this.importAST; }
  setImportAST(node) { this.importAST = node; if (this.map()) this.map().setImportAST(node); }

  copy(newParent) {
    const e = shallow(this);
    e.parent = newParent;
    if (e.id) e.id = e.id.copy();
    e.references = cp(e.references);
    if (e.primary_) e.primary_ = e.primary_.copy(e);
    if (e.map_) e.map_ = e.map_.copy(e);
    return e;
  }

  appendReference(ref) {
    if (ref.dueToLazyGlob_) {
      for (const existing of this.references || []) {
        if (sameReferenceContext(existing.context_, ref.context_) &&
          existing.dueToGlob_ === ref.dueToGlob_ &&
          existing.dueToLazyGlob_ === ref.dueToLazyGlob_) return;
      }
    }
    this.references = [...(this.references || []), ref];
  }

  primary() { return this.primary_; }
  map() { return this.map_; }
  toString() { return fmtBox(this.ast()); }
  lastRef() { return this.references[this.references.length - 1]; }
  lastPrimaryRef() {
    const refs = this.references || [];
    for (let i = refs.length - 1; i >= 0; i--) {
      const fr = refs[i];
      if (!fr.context_.key.edge_key && !fr.dueToLazyGlob()) return fr;
    }
    return null;
  }
  lastPrimaryKey() {
    const er = this.lastPrimaryRef();
    if (!er) return null;
    return er.context_.key;
  }
  toJSON() {
    const o = { edge_id: this.id };
    if (this.primary_) o.primary = this.primary_;
    if (this.map_) o.map = this.map_;
    if (this.references && this.references.length) o.references = this.references;
    return o;
  }

  ast() {
    const astEdge = { range: makeRange(',0:0:0-0:0:0'), src: null, src_arrow: '', dst: null, dst_arrow: '' };
    astEdge.src = makeKeyPathString(this.id.srcPath || []);
    if (this.id.srcArrow) astEdge.src_arrow = '<';
    astEdge.dst = makeKeyPathString(this.id.dstPath || []);
    if (this.id.dstArrow) astEdge.dst_arrow = '>';

    const k = { range: makeRange(',0:0:0-0:0:0'), edges: [astEdge], primary: {}, value: {} };
    if (this.primary_) k.primary = scalarBox(this.primary_.ast());
    if (this.map_) k.value = this.map_.ast();
    return { map_key: k };
  }

  idString() {
    const k = this.ast().map_key;
    if (this.id.index !== null) k.edge_index = { range: makeRange(',0:0:0-0:0:0'), int: this.id.index, glob: false };
    k.primary = {};
    k.value = {};
    return flat(format('map_key', k));
  }

  equal(n2) {
    const e2 = n2;
    if (!this.id.match(e2.id)) return false;
    if (!this.primary_.equal(e2.primary_)) return false;
    if (!this.map_.equal(e2.map_)) return false;
    return true;
  }
}

export class IRArray {
  constructor(o = {}) { this.parent = null; this.values = null; Object.assign(this, o); }
  copy(newParent) {
    const a = shallow(this);
    a.parent = newParent;
    a.values = goCopySlice(a.values);
    for (let i = 0; i < (a.values || []).length; i++) a.values[i] = a.values[i].copy(a);
    return a;
  }
  primary() { return null; }
  map() { return null; }
  toString() { return fmtBox(this.ast()); }
  lastRef() { return parentRef(this); }
  lastPrimaryRef() { return parentPrimaryRef(this); }
  lastPrimaryKey() { return parentPrimaryKey(this); }
  toJSON() { return { values: this.values }; }
  ast() {
    const astArray = { range: makeRange(',0:0:0-0:0:0'), nodes: null };
    for (const av of this.values || []) (astArray.nodes ||= []).push(av.ast());
    return { array: astArray };
  }
  equal(n2) {
    const a2 = n2;
    if ((this.values || []).length !== (a2.values || []).length) return false;
    for (let i = 0; i < (this.values || []).length; i++) if (!this.values[i].equal(a2.values[i])) return false;
    return true;
  }
}

export class FieldReference {
  constructor(o = {}) {
    this.string = null; this.keyPath = null; this.context_ = null; this.dueToGlob_ = false; this.dueToLazyGlob_ = false;
    Object.assign(this, o);
  }
  /** Primary returns true if the Value in Context.Key.Value corresponds to the Field represented by String. */
  primary() {
    const key = this.context_.key;
    if (same(this.keyPath, key.key)) {
      return (key.edges || []).length === 0 && this.keyPathIndex() === this.keyPath.path.length - 1;
    } else if (same(this.keyPath, key.edge_key)) {
      return (key.edges || []).length === 1 && this.keyPathIndex() === this.keyPath.path.length - 1;
    }
    return false;
  }
  keyPathIndex() {
    for (let i = 0; i < this.keyPath.path.length; i++) if (unbox(this.keyPath.path[i]) === unbox(this.string)) return i;
    throw new Error('d2ir.KeyReference.KeyPathIndex: String not in KeyPath?');
  }
  edgeDest() { return same(this.keyPath, this.context_.edge.dst); }
  inEdge() { return !!this.context_.edge; }
  /** Most specific AST node for the reference. */
  ast() {
    if (!this.string) return this.context_.scope; // Root map.
    return unbox(this.string);
  }
  context() { return this.context_; }
  dueToGlob() { return this.dueToGlob_; }
  dueToLazyGlob() { return this.dueToLazyGlob_; }
  toJSON() {
    return { string: unbox(this.string) ?? null, key_path: this.keyPath ?? null, context: this.context_, due_to_glob: this.dueToGlob_, due_to_lazy_glob: this.dueToLazyGlob_ };
  }
}

function sameReferenceContext(a, b) {
  return a === b || (a != null && b != null &&
    same(a.key, b.key) && same(a.edge, b.edge) &&
    same(a.scope, b.scope) && same(a.scopeMap, b.scopeMap) && same(a.scopeAST, b.scopeAST));
}

export class EdgeReference {
  constructor(o = {}) { this.context_ = null; this.dueToGlob_ = false; this.dueToLazyGlob_ = false; Object.assign(this, o); }
  ast() { return this.context_.edge; }
  /** Primary returns true if the Value in Context.Key.Value corresponds to the *Edge represented by Context.Edge */
  primary() { return (this.context_.key.edges || []).length === 1 && !this.context_.key.edge_key; }
  context() { return this.context_; }
  dueToGlob() { return this.dueToGlob_; }
  dueToLazyGlob() { return this.dueToLazyGlob_; }
  toJSON() { return { context: this.context_, due_to_glob: this.dueToGlob_, due_to_lazy_glob: this.dueToLazyGlob_ }; }
}

export class RefContext {
  constructor(o = {}) { this.edge = null; this.key = null; this.scope = null; this.scopeMap = null; this.scopeAST = null; Object.assign(this, o); }
  copy() { return shallow(this); }
  edgeIndex() {
    const edges = this.key.edges || [];
    for (let i = 0; i < edges.length; i++) if (edges[i] === this.edge) return i;
    return -1;
  }
  equal(rc2) {
    // We intentionally ignore edges here because the same glob can produce multiple RefContexts that should be treated  the same with only the edge as the difference.
    // Same with ScopeMap.
    if (!(keyEquals(this.key, rc2.key) && same(this.scope, rc2.scope) && same(this.scopeAST, rc2.scopeAST))) return false;

    // Check if suspension values match for suspension operations
    // We don't want these two to equal
    // 1. *: suspend
    // 2. *: unsuspend
    const hasSuspension1 = !!(this.key.primary.suspension || this.key.value.suspension);
    const hasSuspension2 = !!(rc2.key.primary.suspension || rc2.key.value.suspension);

    if (hasSuspension1 || hasSuspension2) {
      let val1 = false, val2 = false;
      if (this.key.primary.suspension) val1 = this.key.primary.suspension.value;
      else if (this.key.value.suspension) val1 = this.key.value.suspension.value;

      if (rc2.key.primary.suspension) val2 = rc2.key.primary.suspension.value;
      else if (rc2.key.value.suspension) val2 = rc2.key.value.suspension.value;

      if (hasSuspension1 && hasSuspension2 && val1 !== val2) return false;
      if (hasSuspension1 !== hasSuspension2) return false;
    }
    return true;
  }
  toJSON() { return { edge: this.edge ?? null, key: this.key ?? null }; }
}

// ---- tree helpers ----

/** NodeBoardKind reports whether n represents the root of a board. n should be a Field or an IRMap. */
export function nodeBoardKind(n) {
  let f = null;
  if (n instanceof Field) {
    if (n.parent === null) return BoardLayer;
    f = parentField(n);
  } else if (n instanceof IRMap) {
    if (!(n.parent instanceof Field)) return '';
    f = n.parent;
    if (f.root()) return BoardLayer;
    f = parentField(f);
  }
  if (!f) return '';
  switch (ss(f.name)) {
    case 'layers': return BoardLayer;
    case 'scenarios': return BoardScenario;
    case 'steps': return BoardStep;
    default: return '';
  }
}

export function rootMap(m) {
  if (m.root()) return m;
  return rootMap(parentMap(m));
}

export function parentMap(n) {
  for (;;) {
    n = n.parent;
    if (n === null || n === undefined) return null;
    if (n instanceof IRMap) return n;
  }
}

export function parentField(n) {
  for (;;) {
    n = n.parent;
    if (n === null || n === undefined) return null;
    if (n instanceof Field) return n;
  }
}

export function isVar(n) {
  for (;;) {
    if (n === null || n === undefined) return false;
    if (nodeBoardKind(n) !== '') return false;
    if (n instanceof Field && ss(n.name) === 'vars' && isUnquoted(n.name)) return true;
    n = n.parent;
  }
}

export function parentBoard(n) {
  for (;;) {
    n = n.parent;
    if (n === null || n === undefined) return null;
    if (nodeBoardKind(n) !== '') return n;
  }
}

export function parentEdge(n) {
  for (;;) {
    n = n.parent;
    if (n === null || n === undefined) return null;
    if (n instanceof Edge) return n;
  }
}

export function parentShape(n) {
  for (;;) {
    if (n instanceof Field) {
      if (n.map()) {
        const shapef = n.map().getField(flat('shape'));
        if (shapef && shapef.primary()) return ss(shapef.primary().value);
      }
    }
    n = n.parent;
    if (n === null || n === undefined) return '';
  }
}

function countUnderscores(p) {
  p = p || [];
  for (let i = 0; i < p.length; i++) if (ss(p[i]) !== '_' || !isUnquoted(p[i])) return i;
  return 0;
}

function findBoardKeyword(...ida) {
  for (let i = 0; i < ida.length; i++) if (BoardKeywords.has(goLower(ss(ida[i]))) && isUnquoted(ida[i])) return i;
  return -1;
}

function findProhibitedEdgeKeyword(ida) {
  ida = ida || [];
  for (let i = 0; i < ida.length; i++) {
    if (SimpleReservedKeywords.has(ss(ida[i])) && isUnquoted(ida[i])) return i;
    if (ReservedKeywordHolders.has(ss(ida[i])) && isUnquoted(ida[i])) return i;
  }
  return -1;
}

function parentRef(n) {
  const f = parentField(n);
  if (f) return f.lastRef();
  const e = parentEdge(n);
  if (e) return e.lastRef();
  return null;
}

function parentPrimaryRef(n) {
  const f = parentField(n);
  if (f) return f.lastPrimaryRef();
  const e = parentEdge(n);
  if (e) return e.lastPrimaryRef();
  return null;
}

function parentPrimaryKey(n) {
  const f = parentField(n);
  if (f) return f.lastPrimaryKey();
  const e = parentEdge(n);
  if (e) return e.lastPrimaryKey();
  return null;
}

/** BoardIDA returns the absolute path to n from the nearest board root. */
export function BoardIDA(n) {
  let ida = null;
  for (;;) {
    if (n instanceof Field) {
      if (n.root() || nodeBoardKind(n) !== '') return reverseIDA(ida);
      ida = [...(ida || []), n.name];
    } else if (n instanceof Edge) {
      ida = [...(ida || []), n.idString()];
    }
    n = n.parent;
    if (n === null || n === undefined) return reverseIDA(ida);
  }
}

/** IDA returns the absolute path to n. */
export function IDA(n) {
  let ida = null;
  for (;;) {
    if (n instanceof Field) {
      ida = [...(ida || []), n.name];
      if (n.root()) return reverseIDA(ida);
    } else if (n instanceof Edge) {
      ida = [...(ida || []), n.idString()];
    }
    n = n.parent;
    if (n === null || n === undefined) return reverseIDA(ida);
  }
}

/** RelIDA returns the path to n relative to p. */
export function relIDA(p, n) {
  let ida = null;
  for (;;) {
    if (n instanceof Field) {
      ida = [...(ida || []), n.name];
      if (n.root()) return reverseIDA(ida);
    } else if (n instanceof Edge) {
      ida = [...(ida || []), flat(n.toString())];
    }
    n = n.parent;
    const fok = n instanceof Field, eok = n instanceof Edge;
    if (n === null || n === undefined || (fok && (n.root() || n === p || n.composite === p)) || (eok && (n === p || n.map_ === p))) return reverseIDA(ida);
  }
}

function reverseIDA(slice) {
  if (slice) slice.reverse();
  return slice;
}

/** CopyBase copies the map m (which may be null) without layers/scenarios/steps. */
export function copyBase(m, newParent) {
  if (m === null) return new IRMap().copy(newParent);

  // The historical delete-and-restore implementation also canonicalized board fields to layers, scenarios, steps at the end
  // of the source map. Preserve that observable ordering without reporting a structural mutation: the field set is
  // unchanged, and compile generations are for glob membership.
  const baseFields = [];
  let layers = null, scenarios = null, steps = null;
  for (const field of m.fields || []) {
    if (field.name) {
      if (layers === null && equalFold(ss(field.name), 'layers')) { layers = field; continue; }
      if (scenarios === null && equalFold(ss(field.name), 'scenarios')) { scenarios = field; continue; }
      if (steps === null && equalFold(ss(field.name), 'steps')) { steps = field; continue; }
    }
    baseFields.push(field);
  }
  for (const board of [layers, scenarios, steps]) {
    if (board !== null) m.deleteEdgesForFieldReferences(board);
  }
  const base = shallow(m);
  base.fields = baseFields;
  const copy = base.copy(newParent);
  if (m.fields !== null) {
    m.fields = [...baseFields];
    for (const board of [layers, scenarios, steps]) {
      if (board !== null) m.fields.push(board);
    }
  }
  return copy;
}

// ---- merge.go ----

function structureCounts(m) {
  if (m === null) return [0, 0];
  return [m.fieldCountRecursive(), m.edgeCountRecursive()];
}

function markStructureCountDelta(parent, beforeFields, beforeEdges, after) {
  const [afterFields, afterEdges] = structureCounts(after);
  if ((beforeFields !== afterFields || beforeEdges !== afterEdges) && parent !== null) parent.markStructureChanged();
}

export function overlayMap(base, overlay) {
  for (const of of (overlay.fields || []).slice()) {
    const bf = base.getField(of.name);
    if (!bf) {
      base.appendField(of.copy(base));
      continue;
    }
    overlayField(bf, of);
  }

  for (const oe of (overlay.edges || []).slice()) {
    const bea = base.getEdges(oe.id, null, null);
    if (!bea || bea.length === 0) {
      base.appendEdge(oe.copy(base));
      continue;
    }
    overlayEdge(bea[0], oe);
  }
}

export function expandSubstitution(m, resolved, placeholder) {
  let fi = -1;
  for (let i = 0; i < (m.fields || []).length; i++) {
    if (m.fields[i] === placeholder) { fi = i; break; }
  }

  for (const of of (resolved.fields || []).slice()) {
    const bf = m.getField(of.name);
    if (!bf) {
      m.insertField(fi, of.copy(m));
      fi++;
      continue;
    }
    overlayField(bf, of);
  }

  // NOTE this doesn't expand edges in place, and just appends
  // I suppose to do this, there needs to be an edge placeholder too on top of the field placeholder
  // Will wait to see if a problem
  for (const oe of (resolved.edges || []).slice()) {
    const bea = m.getEdges(oe.id, null, null);
    if (!bea || bea.length === 0) {
      m.appendEdge(oe.copy(m));
      continue;
    }
    overlayEdge(bea[0], oe);
  }
}

export function overlayField(bf, of) {
  if (of.primary_) bf.primary_ = of.primary_.copy(bf);

  if (of.composite) {
    if (bf.map() && of.map()) overlayMap(bf.map(), of.map());
    else {
      const [beforeFields, beforeEdges] = structureCounts(bf.map());
      bf.composite = of.composite.copy(bf);
      markStructureCountDelta(parentMap(bf), beforeFields, beforeEdges, bf.map());
    }
  }

  bf.references = [...(bf.references || []), ...(of.references || [])];
  if (bf.references.length === 0) bf.references = null;
}

export function overlayEdge(be, oe) {
  if (oe.primary_) be.primary_ = oe.primary_.copy(be);
  if (oe.map_) {
    if (be.map_) overlayMap(be.map(), oe.map_);
    else {
      const [beforeFields, beforeEdges] = structureCounts(be.map());
      be.map_ = oe.map_.copy(be);
      markStructureCountDelta(parentMap(be), beforeFields, beforeEdges, be.map());
    }
  }
  be.references = [...(be.references || []), ...(oe.references || [])];
  if (be.references.length === 0) be.references = null;
}

// ---- pattern.go ----

// Go indexes strings by byte; matchPattern slices with offsets found in the lowercased string, so it works on UTF-8
// "binary strings" (one char per byte) to behave the same way when lowercasing changes a character's length.
const enc = new TextEncoder(), dec = new TextDecoder();
const toBin = (s) => String.fromCharCode(...enc.encode(s));
const fromBin = (b) => dec.decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
const lowerBin = (b) => toBin(goLower(fromBin(b)));

function _doubleGlobField(f, matches) {
  if (f === null || !f.name) return;
  const name = ss(f.name);
  if (ReservedKeywords.has(name) && isUnquoted(f.name)) {
    if (skipDoubleGlobSubtree(name)) return;
    if (f.map()) f.map()._doubleGlob(matches);
    return;
  }
  if (nodeBoardKind(f) === '') matches.push(f);
  if (f.map()) f.map()._doubleGlob(matches);
}

function skipDoubleGlobSubtree(name) {
  if (BoardKeywords.has(name)) return true;
  // Classes and variables are definitions, not diagram objects. Applying recursive globs inside either map can mutate
  // definitions before use.
  return name === 'classes' || name === 'vars';
}

function _tripleGlobField(f, matches) {
  if (f === null || !f.name) return;
  const name = ss(f.name);
  if (ReservedKeywords.has(name) && isUnquoted(f.name)) {
    if (!BoardKeywords.has(name)) return;
    if (f.map()) f.map()._tripleGlob(matches);
    return;
  }
  if (nodeBoardKind(f) === '') matches.push(f);
  if (f.map()) f.map()._tripleGlob(matches);
}

export function matchPattern(s, pattern) {
  if (pattern.length === 0) return true;
  if (ReservedKeywords.has(s)) return false;

  s = toBin(s);
  pattern = pattern.map(toBin);
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') {
      if (i === pattern.length - 1) return true;

      const next = lowerBin(pattern[i + 1]);
      const lowerS = lowerBin(s);
      if (i + 1 === pattern.length - 1) return lowerS.endsWith(next);

      // Match the earliest occurrence so the remaining wildcards have the largest possible suffix to search.
      const j = lowerS.indexOf(next);
      if (j === -1) return false;
      s = s.slice(j + pattern[i + 1].length);
      i++;
    } else {
      if (!lowerBin(s).startsWith(lowerBin(pattern[i]))) return false;
      s = s.slice(pattern[i].length);
    }
  }
  return s === '';
}

// ---- compile.go ----

class GlobContext {
  constructor(o = {}) { this.root = null; this.refctx = null; this.appliedFields = null; this.appliedEdges = null; Object.assign(this, o); }
  copy() {
    const g2 = shallow(this);
    g2.refctx = this.root.refctx.copy();
    return g2;
  }
  copyApplied(from) {
    this.appliedFields = new Set(from.appliedFields);
    this.appliedEdges = new Set(from.appliedEdges);
  }
}

/** Compile builds the IR for ast. opts: { utf16, fs }. Returns { m, imports, err }; m is null if err is not. */
export function compile(ast, opts) {
  opts = opts || {};
  const c = new Compiler(opts);
  const m = new IRMap();
  m.initRoot();
  m.parent.references[0].context_.scope = ast;
  m.parent.references[0].context_.scopeAST = ast;

  c.pushImportStack({ range: makeRange(',0:0:0-0:0:0'), spread: false, pre: '', path: [rawString(ast.range.path, true)] });
  try {
    c.compileMap(m, ast, ast);
    c.compileSubstitutions(m, null);
    c.overlayClasses(m);
    m.removeSuspendedFields();
  } finally {
    c.popImportStack();
  }
  if (!c.err.empty()) return { m: null, imports: null, err: c.err };
  return { m, imports: c.imports, err: null };
}

class Compiler {
  constructor(opts) {
    this.err = new ParseError();
    // `fs` maps cleaned paths to file text; null means "no fs given": Go would read the disk.
    this.fs = null;
    if (opts.fs) { this.fs = new Map(); for (const [k, v] of Object.entries(opts.fs)) this.fs.set(pathClean(k), v); }
    this.imports = null;
    this.importStack = []; // used to detect cyclic imports
    this.seenImports = new Set();
    this.utf16Pos = !!opts.utf16;
    this.globContextStack = []; // Stack of globs that must be recomputed at each new object in and below the current scope.
    this.globRefContextStack = []; // Used to prevent field globs causing infinite loops.
    this.mapRefContextStack = []; // Used to check whether ampersands are allowed in the current map.
    this.lazyGlobBeingApplied = false;
    // Lazy field globs are evaluated against newly created fields through a deterministic worklist. This avoids rescanning
    // the entire IR after each insertion while retaining source-order rule application.
    this.lazyGlobTarget = null;
    this.lazyGlobWorklist = [];
    this.lazyGlobQueued = null;
    this.applyingLazyWorklist = false;
    this.lazySettledVersions = null;
    this.lazyPostTargets = [];
    this.lazyPostQueued = null;
    // parsedImports is an immutable per-compilation cache of parsed import ASTs; callers always receive deep copies.
    this.parsedImports = new Map();
  }

  errorf(n, msg) { this.err.errs.push(errorf(n, msg)); }

  overlayClasses(m) {
    const classes = m.getField(flat('classes'));
    if (!classes || !classes.map()) return;

    const layersField = m.getField(flat('layers'));
    if (!layersField) return;
    const layers = layersField.map();
    if (!layers) return;

    for (const lf of (layers.fields || []).slice()) {
      if (!lf.map() || lf.primary()) continue;
      const l = lf.map();
      let lClasses = l.getField(flat('classes'));

      if (!lClasses) {
        lClasses = classes.copy(l);
        l.appendField(lClasses);
      } else if (lClasses.map()) {
        const base = classes.copy(l);
        overlayMap(base.map(), lClasses.map());
        l.deleteField('classes');
        l.appendField(base);
      }

      this.overlayClasses(l);
    }
  }

  compileSubstitutions(m, varsStack) {
    for (const f of m.fields || []) {
      if (!f.name) continue;
      if (ss(f.name) === 'vars' && isUnquoted(f.name) && f.map()) varsStack = [f.map(), ...(varsStack || [])];
    }
    for (let i = 0; i < (m.fields || []).length; i++) {
      const f = m.fields[i];
      if (f.primary()) {
        const removed = this.resolveSubstitutions(varsStack, f);
        if (removed) i--;
      }
      if (f.composite instanceof IRArray) {
        const arr = f.composite;
        // Go ranges over the slice header it has now; a spread can overwrite the elements behind it.
        const vals0 = arr.values || [];
        const n0 = vals0.length;
        for (let k = 0; k < n0; k++) {
          const val = vals0[k];
          if (val instanceof Scalar) {
            const removed = this.resolveSubstitutions(varsStack, val);
            if (removed) i--;
          }
        }
      } else if (f.map()) {
        if (f.name && ss(f.name) === 'vars' && isUnquoted(f.name)) {
          this.compileSubstitutions(f.map(), varsStack);
          this.validateConfigs(f.map().getField(flat('d2-config')));
        } else {
          this.compileSubstitutions(f.map(), varsStack);
        }
      }
    }
    for (const e of m.edges || []) {
      if (e.primary()) this.resolveSubstitutions(varsStack, e);
      if (e.map()) this.compileSubstitutions(e.map(), varsStack);
    }
  }

  validateConfigs(configs) {
    if (!configs || !configs.map()) return;

    if (nodeBoardKind(parentMap(parentMap(configs))) === '') {
      this.errorf(configs.lastRef().ast(), `"${ss(configs.name)}" can only appear at root vars`);
      return;
    }

    for (const f of configs.map().fields || []) {
      let val = '';
      if (!f.primary()) {
        if (ss(f.name) !== 'theme-overrides' && ss(f.name) !== 'dark-theme-overrides' && ss(f.name) !== 'data') {
          this.errorf(f.lastRef().ast(), `"${ss(f.name)}" needs a value`);
          continue;
        }
      } else {
        val = ss(f.primary().value);
      }

      switch (ss(f.name)) {
        case 'sketch': case 'center':
          if (parseBool(val) === null) {
            this.errorf(f.lastRef().ast(), `expected a boolean for "${ss(f.name)}", got "${val}"`);
            continue;
          }
          break;
        case 'theme-overrides': case 'dark-theme-overrides': case 'data':
          if (!f.map()) {
            this.errorf(f.lastRef().ast(), `"${ss(f.name)}" needs a map`);
            continue;
          }
          break;
        case 'theme-id': case 'dark-theme-id': {
          const valInt = atoi(val);
          if (valInt === null) {
            this.errorf(f.lastRef().ast(), `expected an integer for "${ss(f.name)}", got "${val}"`);
            continue;
          }
          if (!themeExists(valInt)) {
            this.errorf(f.lastRef().ast(), `${valInt} is not a valid theme ID`);
            continue;
          }
          break;
        }
        case 'pad':
          if (atoi(val) === null) {
            this.errorf(f.lastRef().ast(), `expected an integer for "${ss(f.name)}", got "${val}"`);
            continue;
          }
          break;
        case 'layout-engine':
          break;
        default:
          this.errorf(f.lastRef().ast(), `"${ss(f.name)}" is not a valid config`);
      }
    }
  }

  resolveSubstitutions(varsStack, node) {
    let subbed = false;
    let resolvedField = null;
    let removedField = false;
    varsStack = varsStack || [];

    const pv = node.primary().value;
    const kind = boxKind(pv);
    if (kind === 'unquoted_string') {
      const s = pv.unquoted_string;
      const sv = s.value || [];
      for (let bi = 0; bi < sv.length; bi++) {
        const bx = sv[bi];
        if (bx.substitution) {
          for (let vi = 0; vi < varsStack.length; vi++) {
            resolvedField = this.resolveSubstitution(varsStack[vi], node, bx.substitution, vi === 0);
            if (resolvedField) {
              if (resolvedField.primary()) {
                if (resolvedField.primary().value.null) resolvedField = null;
              }
              break;
            }
          }
          if (!resolvedField) {
            this.errorf(node.lastRef().ast(), `could not resolve variable "${substitutionIDA(bx.substitution).join('.')}"`);
            return removedField;
          }
          if (bx.substitution.spread) {
            if (!resolvedField.composite) {
              this.errorf(bx.substitution, 'cannot spread non-composite');
              continue;
            }
            if (node instanceof Scalar) { // Array value
              const resolvedArr = resolvedField.composite;
              if (!(resolvedArr instanceof IRArray)) {
                this.errorf(bx.substitution, 'cannot spread non-array into array');
                continue;
              }
              const arr = node.parent;
              const vals = arr.values || [];
              for (let k = 0; k < vals.length; k++) {
                if (vals[k] === node) {
                  arr.values = goSpliceSpread(vals, k, resolvedArr.values || []);
                  break;
                }
              }
            } else if (node instanceof Field) {
              const m = parentMap(node);
              if (resolvedField.map()) expandSubstitution(m, resolvedField.map(), node);
              // Remove the placeholder field
              const mf = m.fields || [];
              for (let k = 0; k < mf.length; k++) {
                if (node === mf[k]) {
                  m.removeField(k);
                  removedField = true;
                  break;
                }
              }

              if (removedField && (m.globs || []).length > 0 && !this.lazyGlobBeingApplied) {
                const origGlobStack = this.globContextStack;
                this.globContextStack = [...this.globContextStack, m.globs];
                for (const gctx of m.globs) {
                  const old = this.lazyGlobBeingApplied;
                  this.lazyGlobBeingApplied = true;
                  this.compileKey(gctx.refctx);
                  this.lazyGlobBeingApplied = old;
                }
                this.globContextStack = origGlobStack;
              }
            }
          }
          if (!resolvedField.primary()) {
            if (!resolvedField.composite) {
              this.errorf(node.lastRef().ast(), `cannot substitute variable without value: "${substitutionIDA(bx.substitution).join('.')}"`);
              return removedField;
            }
            if (sv.length > 1) {
              this.errorf(node.lastRef().ast(), `cannot substitute composite variable "${substitutionIDA(bx.substitution).join('.')}" as part of a string`);
              return removedField;
            }
            if (node instanceof Field) node.primary_ = null;
            else if (node instanceof Edge) node.primary_ = null;
          } else if (bi === 0 && sv.length === 1) {
            node.primary().value = resolvedField.primary().value;
          } else {
            sv[bi].string = ss(resolvedField.primary().value);
            subbed = true;
          }
          if (resolvedField.composite) {
            if (node instanceof Field) node.composite = resolvedField.composite;
            else if (node instanceof Edge) {
              if (!resolvedField.composite.map()) {
                this.errorf(node.lastRef().ast(), `cannot substitute array variable "${substitutionIDA(bx.substitution).join('.')}" to an edge`);
                return removedField;
              }
              node.map_ = resolvedField.composite.map();
            }
          }
        }
      }
      if (subbed) coalesce(s);
    } else if (kind === 'double_quoted_string') {
      const s = pv.double_quoted_string;
      const sv = s.value || [];
      for (let bi = 0; bi < sv.length; bi++) {
        const bx = sv[bi];
        if (bx.substitution) {
          for (let vi = 0; vi < varsStack.length; vi++) {
            resolvedField = this.resolveSubstitution(varsStack[vi], node, bx.substitution, vi === 0);
            if (resolvedField) break;
          }
          if (!resolvedField) {
            this.errorf(node.lastRef().ast(), `could not resolve variable "${substitutionIDA(bx.substitution).join('.')}"`);
            return removedField;
          }
          if (!resolvedField.primary() && resolvedField.composite) {
            this.errorf(node.lastRef().ast(), `cannot substitute map variable "${substitutionIDA(bx.substitution).join('.')}" in quotes`);
            return removedField;
          }
          sv[bi].string = ss(resolvedField.primary().value);
          subbed = true;
        }
      }
      if (subbed) coalesce(s);
    } else if (kind === 'block_string') {
      const s = pv.block_string;
      const variables = new Map();
      for (const vars of varsStack) this.collectVariables(vars, variables);
      const preprocessedValue = replaceSubstitutionsMarkdown(s.value, variables);

      // Update the block string value
      s.value = preprocessedValue;
    }
    return removedField;
  }

  collectVariables(vars, variables) {
    if (!vars) return;
    for (const f of vars.fields || []) {
      if (f.primary()) {
        variables.set(ss(f.name), ss(f.primary().value));
      } else if (f.map()) {
        const nestedVars = new Map();
        this.collectVariables(f.map(), nestedVars);
        for (const [k, v] of nestedVars) variables.set(ss(f.name) + '.' + k, v);
        this.collectVariables(f.map(), variables);
      }
    }
  }

  resolveSubstitution(vars, node, substitution, isCurrentScopeVars) {
    if (!vars) return null;

    const fok = node instanceof Field;
    const fieldNode = node;
    const parent = parentField(node);

    const path = substitution.path || [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const f = vars.getField(p);
      if (!f) return null;
      // Consider this case:
      //
      // ```
      // vars: {
      //   x: a
      // }
      // hi: {
      //   vars: {
      //     x: ${x}-b
      //   }
      //   yo: ${x}
      // }
      // ```
      //
      // When resolving hi.vars.x, the vars stack includes itself.
      // So this next if clause says, "ignore if we're using the current scope's vars to try to resolve a substitution that requires a var from further in the stack"
      if (fok && fieldNode.name && ss(fieldNode.name) === ss(p) && isCurrentScopeVars && ss(parent.name) === 'vars' && isUnquoted(parent.name)) return null;

      if (i === path.length - 1) return f;
      vars = f.map();
    }
    return null;
  }

  overlay(base, f) {
    if (!f.map()) {
      this.errorf(f.references[0].context_.key, `invalid ${nodeBoardKind(f)}`);
      return;
    }

    base = copyBase(base, f);
    // Certain fields should never carry forward.
    // If you give your scenario a label, you don't want all steps in a scenario to be labeled the same.
    base.deleteField('label');
    overlayMap(base, f.map());
    f.composite = base;
  }

  ampersandFilterMap(dst, ast, scopeAST) {
    for (const n of ast.nodes || []) {
      if (n.map_key) {
        let ok = this.ampersandFilter(new RefContext({ key: n.map_key, scope: ast, scopeMap: dst, scopeAST }));
        if (n.map_key.not_ampersand) ok = !ok;
        if (!ok) {
          if (this.mapRefContextStack.length === 0) return false;
          // Unapply glob if appropriate.
          const gctx = this.getGlobContext(this.mapRefContextStack[this.mapRefContextStack.length - 1]);
          if (!gctx) return false;
          let ks;
          if (keyHasTripleGlob(gctx.refctx.key)) ks = fmtKP(makeKeyPathString(IDA(dst)));
          else ks = fmtKP(makeKeyPathString(BoardIDA(dst)));
          gctx.appliedFields.delete(ks);
          gctx.appliedEdges.delete(ks);
          return false;
        }
      }
    }
    return true;
  }

  compileMap(dst, ast, scopeAST) {
    let globs = [];
    if (this.globContextStack.length > 0) {
      const previousGlobs = this.globContexts();
      // A root layer with existing glob context stack implies it's an import
      // In which case, the previous globs should be inherited (the else block)
      if (nodeBoardKind(dst) === BoardLayer && !dst.root()) {
        for (const g of previousGlobs) {
          if (keyHasTripleGlob(g.refctx.key)) {
            const gctx2 = g.copy();
            gctx2.refctx.scopeMap = dst;
            globs.push(gctx2);
          }
        }
      } else if (nodeBoardKind(dst) === BoardScenario) {
        for (const g of previousGlobs) {
          const gctx2 = g.copy();
          gctx2.refctx.scopeMap = dst;
          if (!keyHasTripleGlob(g.refctx.key)) {
            // Triple globs already apply independently to each board
            gctx2.copyApplied(g);
          }
          globs.push(gctx2);
        }
        for (const g of previousGlobs) {
          const g2 = g.copy();
          g2.refctx.scopeMap = dst;
          // We don't want globs applied in a given scenario to affect future boards
          // Copying the applied fields and edges keeps the applications scoped to this board
          // Note that this is different from steps, where applications carry over
          if (!keyHasTripleGlob(g.refctx.key)) {
            // Triple globs already apply independently to each board
            g2.copyApplied(g);
          }
          globs.push(g2);
        }
      } else if (nodeBoardKind(dst) === BoardStep) {
        for (const g of previousGlobs) {
          const gctx2 = g.copy();
          gctx2.refctx.scopeMap = dst;
          globs.push(gctx2);
        }
      } else {
        globs = [...globs, ...previousGlobs];
      }
    }
    this.globContextStack = [...this.globContextStack, globs];
    try {
      const ok = this.ampersandFilterMap(dst, ast, scopeAST);
      if (!ok) return;

      for (const n of ast.nodes || []) {
        if (n.map_key) {
          this.compileKey(new RefContext({ key: n.map_key, scope: ast, scopeMap: dst, scopeAST }));
        } else if (n.substitution) {
          // placeholder field to be resolved at the end
          const f = new Field({
            parent: dst,
            primary_: new Scalar({ value: { unquoted_string: { range: makeRange(',0:0:0-0:0:0'), value: [{ substitution: n.substitution }] } } }),
            references: [new FieldReference({ context_: new RefContext({ scope: ast, scopeMap: dst, scopeAST }) })],
          });
          dst.appendField(f);
        } else if (n.import) {
          // Spread import
          const [impn, ok2] = this._import(n.import, dst);
          if (!ok2) continue;
          if (!impn.map()) {
            this.errorf(n.import, 'cannot spread import non map into map');
            continue;
          }
          impn.setImportAST(n.import);

          for (const gctx of impn.map().globs || []) {
            if (!keyHasTripleGlob(gctx.refctx.key)) continue;
            const gctx2 = gctx.copy();
            gctx2.refctx.scopeMap = dst;
            this.compileKey(gctx2.refctx);
            this.ensureGlobContext(gctx2.refctx);
          }

          const scenariosField = impn.map().getField(flat('scenarios'));
          if (scenariosField && scenariosField.map()) {
            for (const sf of (scenariosField.map().fields || []).slice()) this.overlay(dst, sf);
          }

          const stepsField = impn.map().getField(flat('steps'));
          if (stepsField && stepsField.map()) {
            for (const sf of (stepsField.map().fields || []).slice()) this.overlay(dst, sf);
          }

          overlayMap(dst, impn.map());
          const impDir = importDir(n.import);
          this.extendLinks(dst, parentField(dst), impDir);

          if (impn instanceof Field) {
            if (impn.primary_) {
              const dstf = parentField(dst);
              if (dstf) dstf.primary_ = impn.primary_;
            }
          }
        }
      }
    } finally {
      dst.globs = this.globContexts();
      this.globContextStack = this.globContextStack.slice(0, -1);
    }
  }

  globContexts() { return this.globContextStack[this.globContextStack.length - 1]; }

  getGlobContext(refctx) {
    for (const gctx of this.globContexts()) if (gctx.refctx.equal(refctx)) return gctx;
    return null;
  }

  ensureGlobContext(refctx) {
    let gctx = this.getGlobContext(refctx);
    if (gctx) return gctx;
    gctx = new GlobContext({ refctx, appliedFields: new Set(), appliedEdges: new Set() });
    gctx.root = gctx;
    this.globContextStack[this.globContextStack.length - 1] = [...this.globContexts(), gctx];
    return gctx;
  }

  compileKey(refctx) {
    const postTargetStart = this.lazyPostTargets.length;
    let pushed = false;
    try {
      if (keyHasGlob(refctx.key)) {
        for (const refctx2 of this.globRefContextStack) {
          if (refctx.equal(refctx2)) {
            // Break the infinite loop.
            return;
          }
        }
        this.globRefContextStack = [...this.globRefContextStack, refctx];
        pushed = true;
        this.ensureGlobContext(refctx);
      }
      const oldVersion = refctx.scopeMap.structureVersion;
      if ((refctx.key.edges || []).length === 0) this.compileField(refctx.scopeMap, refctx.key.key, refctx);
      else this.compileEdges(refctx);
      const root = rootMap(refctx.scopeMap);
      let settled = this.lazySettledVersions !== null && this.lazySettledVersions.get(root) === root.structureVersion;
      if (oldVersion !== refctx.scopeMap.structureVersion && !this.applyingLazyWorklist && this.lazyPostTargets.length > postTargetStart) {
        const targets = this.takeLazyPostTargets(postTargetStart);
        this.applyLazyGlobs(targets);
        settled = true;
      }
      if (oldVersion !== refctx.scopeMap.structureVersion && !this.applyingLazyWorklist && !settled) {
        for (const gctx2 of this.globContexts()) {
          const old = this.lazyGlobBeingApplied;
          this.lazyGlobBeingApplied = true;
          this.compileKey(gctx2.refctx);
          this.lazyGlobBeingApplied = old;
        }
      }
    } finally {
      if (pushed) this.globRefContextStack = this.globRefContextStack.slice(0, -1);
    }
  }

  takeLazyPostTargets(start) {
    const targets = this.lazyPostTargets.slice(start);
    this.lazyPostTargets = this.lazyPostTargets.slice(0, start);
    if (this.lazyPostQueued !== null) {
      for (const target of targets) this.lazyPostQueued.delete(target);
      if (this.lazyPostQueued.size === 0) this.lazyPostQueued = null;
    }
    return targets;
  }

  enqueueLazyPostTargets(...fields) {
    if (this.lazyPostQueued === null) this.lazyPostQueued = new Set();
    for (const f of fields) {
      if (f === null) continue;
      if (this.lazyPostQueued.has(f)) continue;
      this.lazyPostQueued.add(f);
      this.lazyPostTargets.push(f);
    }
  }

  enqueueLazyGlobFields(...fields) {
    if (fields.length === 0) return;
    if (this.lazyGlobQueued === null) this.lazyGlobQueued = new Set();
    for (const f of fields) {
      if (f === null) continue;
      if (this.lazyGlobQueued.has(f)) continue;
      this.lazyGlobQueued.add(f);
      this.lazyGlobWorklist.push(f);
    }
  }

  applyLazyGlobs(created) {
    if (created === null || created.length === 0) {
      for (const gctx of this.globContexts()) {
        const old = this.lazyGlobBeingApplied;
        this.lazyGlobBeingApplied = true;
        this.compileKey(gctx.refctx);
        this.lazyGlobBeingApplied = old;
      }
      return;
    }

    if (this.applyingLazyWorklist) {
      this.enqueueLazyGlobFields(...created);
      return;
    }
    const root = rootMap(parentMap(created[0]));
    if (this.globContexts().length === 0) {
      // Preserve the settled version and pending post-targets: a later key or nested value can introduce globs. There is no
      // worklist to run yet.
      if (this.lazySettledVersions === null) this.lazySettledVersions = new Map();
      this.lazySettledVersions.set(root, root.structureVersion);
      return;
    }

    this.applyingLazyWorklist = true;
    try {
      this.enqueueLazyGlobFields(...created);

      while (this.lazyGlobWorklist.length > 0) {
        const target = this.lazyGlobWorklist.shift();

        const edgeGlobs = [];
        for (const gctx of this.globContexts()) {
          if ((gctx.refctx.key.edges || []).length > 0) {
            edgeGlobs.push(gctx);
            continue;
          }
          this.lazyGlobTarget = target;
          const old = this.lazyGlobBeingApplied;
          this.lazyGlobBeingApplied = true;
          this.compileKey(gctx.refctx);
          this.lazyGlobBeingApplied = old;
        }
        this.lazyGlobTarget = null;

        // Edge globs can depend on edges emitted by earlier glob rules. Preserve the old fixed-point behavior, but only for
        // edge rules; field rules have already been applied to the precise changed fields above.
        const root2 = rootMap(parentMap(target));
        while (edgeGlobs.length > 0) {
          const before = root2.structureVersion;
          for (const gctx of edgeGlobs) {
            const old = this.lazyGlobBeingApplied;
            this.lazyGlobBeingApplied = true;
            this.compileKey(gctx.refctx);
            this.lazyGlobBeingApplied = old;
          }
          if (before === root2.structureVersion) break;
        }
      }
    } finally {
      if (this.lazySettledVersions === null) this.lazySettledVersions = new Map();
      this.lazySettledVersions.set(root, root.structureVersion);
      this.applyingLazyWorklist = false;
      this.lazyGlobTarget = null;
      this.lazyGlobWorklist = [];
      this.lazyGlobQueued = null;
    }
  }

  compileField(dst, kp, refctx) {
    if (refctx.key.ampersand || refctx.key.not_ampersand) return;

    const [fa, err] = dst.ensureFieldTop(kp, refctx, true, this);
    if (err) {
      this.err.errs.push(err);
      return;
    }
    for (const f of fa) this._compileField(f, refctx);
  }

  ampersandFilter(refctx) {
    if (!refctx.key.ampersand && !refctx.key.not_ampersand) return true;
    if (this.mapRefContextStack.length === 0 || !keySupportsGlobFilters(this.mapRefContextStack[this.mapRefContextStack.length - 1].key)) {
      this.errorf(refctx.key, 'glob filters cannot be used outside globs');
      return false;
    }
    if ((refctx.key.edges || []).length > 0) return true;

    const keyPath = refctx.key.key;
    if (!keyPath || !keyPath.path || keyPath.path.length === 0) return false;

    const firstPart = ss(keyPath.path[0]);
    if ((firstPart === 'src' || firstPart === 'dst') && keyPath.path.length > 1) {
      if (this.mapRefContextStack.length === 0) return false;

      const edge = parentEdge(refctx.scopeMap);
      if (!edge) return false;

      const nodePath = firstPart === 'src' ? edge.id.srcPath : edge.id.dstPath;

      const root = rootMap(refctx.scopeMap);
      const node = root.getField(...(nodePath || []));
      if (!node || !node.map()) return false;

      const secondPart = ss(keyPath.path[1]);
      const value = ss(scalarBox(refctx.key.value));

      if (keyPath.path.length === 2 && this._ampersandPropertyFilter(secondPart, value, node, refctx.key)) return true;

      const propKeyPath = { range: makeRange(',0:0:0-0:0:0'), path: keyPath.path.slice(1) };
      const propKey = { range: makeRange(',0:0:0-0:0:0'), key: propKeyPath, primary: {}, value: refctx.key.value };
      const propRefCtx = new RefContext({ key: propKey, scopeMap: node.map(), scopeAST: refctx.scopeAST });

      const [fa, err] = node.map().ensureFieldTop(propKeyPath, propRefCtx, false, this);
      if (err || fa.length === 0) return false;

      for (const f of fa) if (this._ampersandFilter(f, propRefCtx)) return true;
      return false;
    }

    const [fa, err] = refctx.scopeMap.ensureFieldTop(refctx.key.key, refctx, false, this);
    if (err) {
      this.err.errs.push(err);
      return false;
    }
    if (fa.length === 0) {
      const sbv = unbox(scalarBox(refctx.key.value));
      if (sbv && scalarString(scalarBox(refctx.key.value)) === '*') return false;
      // The field/edge has no value for this filter
      // But the filter might still match default, e.g. opacity 1
      // So we make a fake field for the default
      // NOTE: this does not apply to things that themes control, like stroke and fill
      // Nor does it apply to layout things like width and height
      const withValue = (s) => new Field({ primary_: new Scalar({ value: flat(s) }) });
      switch (ss(keyPathLast(refctx.key.key))) {
        case 'shape': return this._ampersandFilter(withValue('rectangle'), refctx);
        case 'border-radius': case 'stroke-dash': return this._ampersandFilter(withValue('0'), refctx);
        case 'opacity': return this._ampersandFilter(withValue('1'), refctx);
        case 'stroke-width': return this._ampersandFilter(withValue('2'), refctx);
        case 'icon': case 'tooltip': case 'link': return this._ampersandFilter(withValue(''), refctx);
        case 'shadow': case 'multiple': case '3d': case 'animated': case 'filled': return this._ampersandFilter(withValue('false'), refctx);
        case 'label': {
          const f = new Field();
          const n = refctx.scopeMap.parent;
          if (!n.primary()) {
            if (n instanceof Field) {
              // The label value for fields is their key value
              f.primary_ = new Scalar({ value: n.name });
            } else if (n instanceof Edge) {
              // But for edges, it's nothing
              return false;
            }
          } else {
            f.primary_ = n.primary();
          }
          return this._ampersandFilter(f, refctx);
        }
        case 'src': {
          if (this.mapRefContextStack.length === 0) return false;

          const edge = parentEdge(refctx.scopeMap);
          if (!edge) return false;

          const filterValue = ss(scalarBox(refctx.key.value));

          let srcParts = [];
          for (const part of edge.id.srcPath || []) srcParts.push(ss(part));

          const container = parentField(edge);
          if (container && ss(container.name) !== 'root') {
            let containerPath = [];
            let curr = container;
            while (curr && ss(curr.name) !== 'root') {
              containerPath = [ss(curr.name), ...containerPath];
              curr = parentField(curr);
            }
            const srcStart = srcParts[0];
            if (!equalFold(srcStart, containerPath[0])) srcParts = [...containerPath, ...srcParts];
          }
          return srcParts.join('.') === filterValue;
        }
        case 'dst': {
          if (this.mapRefContextStack.length === 0) return false;

          const edge = parentEdge(refctx.scopeMap);
          if (!edge) return false;

          const filterValue = ss(scalarBox(refctx.key.value));

          let dstParts = [];
          for (const part of edge.id.dstPath || []) dstParts.push(ss(part));

          // Find the container that holds this edge
          // Build the absolute path by prepending the container's path
          const container = parentField(edge);
          if (container && ss(container.name) !== 'root') {
            let containerPath = [];
            let curr = container;
            while (curr && ss(curr.name) !== 'root') {
              containerPath = [ss(curr.name), ...containerPath];
              curr = parentField(curr);
            }
            const dstStart = dstParts[0];
            if (!equalFold(dstStart, containerPath[0])) dstParts = [...containerPath, ...dstParts];
          }
          return dstParts.join('.') === filterValue;
        }
        default: {
          const parent = refctx.scopeMap.parent;
          if (parent instanceof Field) {
            const propName = ss(keyPathLast(refctx.key.key));
            const value = ss(scalarBox(refctx.key.value));
            return this._ampersandPropertyFilter(propName, value, parent, refctx.key);
          }
          return false;
        }
      }
    }
    for (const f of fa) {
      if (!this._ampersandFilter(f, refctx)) return false;
    }
    return true;
  }

  // handles filters that are not based on fields
  _ampersandPropertyFilter(propName, value, node, key) {
    switch (propName) {
      case 'level': {
        const levelVal = atoi(value);
        if (levelVal === null) {
          this.errorf(key, `&level must be a non-negative integer, got ${goQuote(value)}`);
          return false;
        }
        if (levelVal < 0) {
          this.errorf(key, `&level must be a non-negative integer, got ${levelVal}`);
          return false;
        }

        let level = 0;
        let parent = parentField(node);
        while (parent && ss(parent.name) !== 'root' && nodeBoardKind(parent) === '') {
          level++;
          parent = parentField(parent);
        }
        return level === levelVal;
      }
      case 'leaf': {
        const boolVal = parseBool(value);
        if (boolVal === null) {
          this.errorf(key, `&leaf must be "true" or "false", got ${goQuote(value)}`);
          return false;
        }
        const isLeaf = !node.map() || !this.isContainer(node.map());
        return isLeaf === boolVal;
      }
      case 'connected': {
        const boolVal = parseBool(value);
        if (boolVal === null) {
          this.errorf(key, `&connected must be "true" or "false", got ${goQuote(value)}`);
          return false;
        }
        let isConnected = false;
        for (const r of node.references || []) {
          if (r.inEdge()) { isConnected = true; break; }
        }
        return isConnected === boolVal;
      }
      case 'label': {
        const f = new Field();
        if (!node.primary()) f.primary_ = new Scalar({ value: node.name });
        else f.primary_ = node.primary();
        const propKey = { range: makeRange(',0:0:0-0:0:0'), key: key.key, primary: {}, value: key.value };
        const propRefCtx = new RefContext({ key: propKey });
        return this._ampersandFilter(f, propRefCtx);
      }
    }
    return false;
  }

  _ampersandFilter(f, refctx) {
    const sbv = scalarBox(refctx.key.value);
    if (!unbox(sbv)) {
      this.errorf(refctx.key, 'glob filters cannot be composites');
      return false;
    }

    if (f.composite instanceof IRArray) {
      for (const v of f.composite.values || []) {
        if (v instanceof Scalar) {
          if (ss(sbv) === ss(v.value)) return true;
        }
      }
    }

    if (!f.primary_) return false;

    const us = sbv.unquoted_string;
    if (us && us.pattern !== undefined && us.pattern !== null) {
      return matchPattern(ss(f.primary_.value), us.pattern);
    } else if (ss(sbv) !== ss(f.primary_.value)) {
      return false;
    }
    return true;
  }

  _compileField(f, refctx) {
    // In case of filters, we need to pass filters before continuing
    if (refctx.key.value.map && mapHasFilter(refctx.key.value.map)) {
      if (!f.map()) f.composite = new IRMap({ parent: f });
      this.mapRefContextStack = [...this.mapRefContextStack, refctx];
      const ok = this.ampersandFilterMap(f.map(), refctx.key.value.map, refctx.scopeAST);
      this.mapRefContextStack = this.mapRefContextStack.slice(0, -1);
      if (!ok) return;
    }

    if ((refctx.key.edges || []).length === 0 && (refctx.key.primary.null || refctx.key.value.null)) {
      // For vars, if we delete the field, it may just resolve to an outer scope var of the same name
      // Instead we keep it around, so that resolveSubstitutions can find it
      if (!isVar(parentMap(f))) {
        parentMap(f).deleteField(ss(f.name));
        return;
      }
    }

    if ((refctx.key.edges || []).length === 0 && (refctx.key.primary.suspension || refctx.key.value.suspension)) {
      if (!this.lazyGlobBeingApplied) {
        if (refctx.key.primary.suspension) f.suspended = refctx.key.primary.suspension.value;
        else f.suspended = refctx.key.value.suspension.value;
      }
      return;
    }

    if (unbox(refctx.key.primary)) {
      if (this.ignoreLazyGlob(f)) return;
      f.primary_ = new Scalar({ parent: f, value: refctx.key.primary });
    }

    if (refctx.key.value.array) {
      const a = new IRArray({ parent: f });
      this.compileArray(a, refctx.key.value.array, refctx.scopeAST);
      f.composite = a;
    } else if (refctx.key.value.map) {
      let scopeAST = refctx.key.value.map;
      if (!f.map()) {
        f.composite = new IRMap({ parent: f });
        switch (nodeBoardKind(f)) {
          case BoardScenario:
            this.overlay(parentBoard(f).map(), f);
            break;
          case BoardStep: {
            const stepsMap = parentMap(f);
            const sf = stepsMap.fields || [];
            for (let i = 0; i < sf.length; i++) {
              if (sf[i] === f) {
                if (i === 0) this.overlay(parentBoard(f).map(), f);
                else this.overlay(sf[i - 1].map(), f);
                break;
              }
            }
            break;
          }
          case BoardLayer:
            break;
          default:
            // If new board type, use that as the new scope AST, otherwise, carry on
            scopeAST = refctx.scopeAST;
        }
      } else {
        scopeAST = refctx.scopeAST;
      }
      this.mapRefContextStack = [...this.mapRefContextStack, refctx];
      this.compileMap(f.map(), refctx.key.value.map, scopeAST);
      this.mapRefContextStack = this.mapRefContextStack.slice(0, -1);
      switch (nodeBoardKind(f)) {
        case BoardScenario: case BoardStep:
          this.overlayClasses(f.map());
      }
    } else if (refctx.key.value.import) {
      // Non-spread import
      const [n, ok] = this._import(refctx.key.value.import, f);
      if (!ok) return;
      n.setImportAST(refctx.key.value.import);
      let existingEdges = null;
      if (f.map()) existingEdges = f.map().edges;
      const originalF = f.copy(refctx.scopeMap);
      if (n instanceof Field) {
        if (n.primary_) f.primary_ = n.primary_.copy(f);
        if (n.composite) {
          const [beforeFields, beforeEdges] = structureCounts(f.map());
          f.composite = n.composite.copy(f);
          markStructureCountDelta(parentMap(f), beforeFields, beforeEdges, f.map());
        }
      } else if (n instanceof IRMap) {
        f.composite = new IRMap({ parent: f });
        switch (nodeBoardKind(f)) {
          case BoardScenario:
            this.overlay(parentBoard(f).map(), f);
            break;
          case BoardStep: {
            const stepsMap = parentMap(f);
            const sf = stepsMap.fields || [];
            for (let i = 0; i < sf.length; i++) {
              if (sf[i] === f) {
                if (i === 0) this.overlay(parentBoard(f).map(), f);
                else this.overlay(sf[i - 1].map(), f);
                break;
              }
            }
            break;
          }
        }
        overlayMap(f.map(), n);
        const impDir = importDir(refctx.key.value.import);
        this.extendLinks(f.map(), f, impDir);
        switch (nodeBoardKind(f)) {
          case BoardScenario: case BoardStep:
            this.overlayClasses(f.map());
        }
      }
      overlayField(f, originalF);
      if (existingEdges !== null && f.map()) {
        for (const edge of existingEdges) {
          let exists = false;
          for (const currentEdge of f.map().edges || []) {
            if (currentEdge.id.match(edge.id)) { exists = true; break; }
          }
          if (!exists) f.map().appendEdge(edge);
        }
      }
    } else if (unbox(scalarBox(refctx.key.value))) {
      if (this.ignoreLazyGlob(f)) return;
      f.primary_ = new Scalar({ parent: f, value: scalarBox(refctx.key.value) });
      // If the link is a board, we need to transform it into an absolute path.
      if (ss(f.name) === 'link' && isUnquoted(f.name)) this.compileLink(f, refctx);
    }
  }

  /**
   * Whether the current lazy glob being applied should not override the field
   * if already set by a non glob key.
   */
  ignoreLazyGlob(n) {
    if (this.lazyGlobBeingApplied && n.primary()) {
      const lastPrimaryRef = n.lastPrimaryRef();
      if (lastPrimaryRef && !lastPrimaryRef.dueToLazyGlob()) return true;
    }
    return false;
  }

  /** When importing a file, all of its board and icon links need to be extended to reflect their new path */
  extendLinks(m, importF, importDirectory) {
    const board = nodeBoardKind(m);
    let importIDA_ = IDA(importF);
    for (const f of m.fields || []) {
      // A substitute or such
      if (!f.name) continue;
      if (ss(f.name) === 'link' && isUnquoted(f.name)) {
        if (board !== '') {
          this.errorf(f.lastRef().ast(), 'a board itself cannot be linked; only objects within a board can be linked');
          continue;
        }
        const val = ss(f.primary().value);

        const { url: u } = urlParse(htmlUnescape(val));
        const isRemote = u !== null && (u.Scheme !== '' || u.Path.startsWith('/'));
        if (isRemote) continue;

        let link;
        try { link = parseKey(val); } catch { continue; }
        let linkIDA = keyPathIDA(link);
        if (!linkIDA || linkIDA.length === 0) continue;

        for (const id of linkIDA.slice(1)) {
          if (ss(id) === '_' && isUnquoted(id)) {
            if (linkIDA.length < 2 || importIDA_.length < 2) break;
            linkIDA = [linkIDA[0], ...linkIDA.slice(2)];
            importIDA_ = importIDA_.slice(0, -2);
          } else break;
        }

        const extendedIDA = [...importIDA_, ...linkIDA.slice(1)];
        const kp = makeKeyPathString(extendedIDA);
        const s = fmtKP(kp);
        f.primary_.value = flat(s);
      }
      if (ss(f.name) === 'icon' && isUnquoted(f.name) && f.primary()) {
        let val = ss(f.primary().value);
        // It's likely a substitution
        if (val === '') continue;
        const { url: u } = urlParse(htmlUnescape(val));
        const isRemoteImg = u !== null && (u.Scheme !== '' || u.Path.startsWith('/'));
        if (isRemoteImg) continue;
        val = pathJoin(importDirectory, val);
        f.primary_.value = flat(val);
      }
      if (f.map()) this.extendLinks(f.map(), importF, importDirectory);
    }
  }

  compileLink(f, refctx) {
    const val = ss(scalarBox(refctx.key.value));
    let link;
    try { link = parseKey(val); } catch { return; }

    let scopeIDA = IDA(refctx.scopeMap);
    if (!scopeIDA || scopeIDA.length === 0) return;

    let linkIDA = keyPathIDA(link);
    if (!linkIDA || linkIDA.length === 0) return;

    if (!isUnquoted(linkIDA[0])) return;

    // If it doesn't start with one of these reserved words, the link is definitely not a board link.
    if (!equalFold(ss(linkIDA[0]), 'layers') && !equalFold(ss(linkIDA[0]), 'scenarios') && !equalFold(ss(linkIDA[0]), 'steps') && ss(linkIDA[0]) !== '_') return;

    // Chop off the non-board portion of the scope, like if this is being defined on a nested object (e.g. `x.y.z`)
    for (let i = scopeIDA.length - 1; i > 0; i--) {
      if (isUnquoted(scopeIDA[i - 1]) && (equalFold(ss(scopeIDA[i - 1]), 'layers') || equalFold(ss(scopeIDA[i - 1]), 'scenarios') || equalFold(ss(scopeIDA[i - 1]), 'steps'))) {
        scopeIDA = scopeIDA.slice(0, i + 1);
        break;
      }
      if (ss(scopeIDA[i - 1]) === 'root' && isUnquoted(scopeIDA[i - 1])) {
        scopeIDA = scopeIDA.slice(0, i);
        break;
      }
    }

    // Resolve underscores
    while (linkIDA.length > 0 && ss(linkIDA[0]) === '_' && isUnquoted(linkIDA[0])) {
      if (scopeIDA.length < 2) {
        // Leave the underscore. It will fail in compiler as a standalone board,
        // but if imported, will get further resolved in extendLinks
        break;
      }
      // pop 2 off path per one underscore
      scopeIDA = scopeIDA.slice(0, -2);
      linkIDA = linkIDA.slice(1);
    }
    if (scopeIDA.length === 0) scopeIDA = [flat('root')];

    // Create the absolute path by appending scope path with value specified
    scopeIDA = [...scopeIDA, ...linkIDA];
    const kp = makeKeyPathString(scopeIDA);
    f.primary_.value = flat(fmtKP(kp));
  }

  compileEdges(refctx) {
    if (!refctx.key.key) {
      this._compileEdges(refctx);
      return;
    }

    const [fa, err] = refctx.scopeMap.ensureFieldTop(refctx.key.key, refctx, true, this);
    if (err) {
      this.err.errs.push(err);
      return;
    }
    for (const f of fa) {
      if (f.composite instanceof IRArray) {
        this.errorf(refctx.key.key, 'cannot index into array');
        return;
      }
      if (!f.map()) f.composite = new IRMap({ parent: f });
      const refctx2 = refctx.copy();
      refctx2.scopeMap = f.map();
      this._compileEdges(refctx2);
    }
  }

  _compileEdges(refctx) {
    const eida = newEdgeIDs(refctx.key) || [];
    for (let i = 0; i < eida.length; i++) {
      const eid = eida[i];
      if (!eid.glob && (refctx.key.primary.null || refctx.key.value.null)) {
        refctx.scopeMap.deleteEdge(eid);
        continue;
      }

      refctx = refctx.copy();
      refctx.edge = refctx.key.edges[i];

      let ea;
      if (eid.index !== null || eid.glob) {
        ea = refctx.scopeMap.getEdges(eid, refctx, this) || [];
        if (ea.length === 0) {
          if (!eid.glob) this.errorf(refctx.edge, 'indexed edge does not exist');
          continue;
        }
        for (const e of ea) {
          if (refctx.key.primary.null || refctx.key.value.null) {
            refctx.scopeMap.deleteEdge(e.id);
            continue;
          }

          if (refctx.key.value.map && mapHasFilter(refctx.key.value.map)) {
            if (!e.map_) e.map_ = new IRMap({ parent: e });
            this.mapRefContextStack = [...this.mapRefContextStack, refctx];
            const ok = this.ampersandFilterMap(e.map_, refctx.key.value.map, refctx.scopeAST);
            this.mapRefContextStack = this.mapRefContextStack.slice(0, -1);
            if (!ok) continue;
          }

          if (refctx.key.primary.suspension || refctx.key.value.suspension) {
            if (!this.lazyGlobBeingApplied) {
              // Check if edge passes filter before applying suspension
              if (refctx.key.value.map && mapHasFilter(refctx.key.value.map)) {
                if (!e.map_) e.map_ = new IRMap({ parent: e });
                this.mapRefContextStack = [...this.mapRefContextStack, refctx];
                const ok = this.ampersandFilterMap(e.map_, refctx.key.value.map, refctx.scopeAST);
                this.mapRefContextStack = this.mapRefContextStack.slice(0, -1);
                if (!ok) continue;
              }

              let suspensionValue;
              if (refctx.key.primary.suspension) suspensionValue = refctx.key.primary.suspension.value;
              else suspensionValue = refctx.key.value.suspension.value;
              e.suspended = suspensionValue;

              // If we're unsuspending an edge, we should also unsuspend its src and dst objects
              // And their ancestors
              if (!suspensionValue) {
                let srcPath = e.id.srcPath, dstPath = e.id.dstPath;

                // Make paths absolute if they're relative
                const container = parentField(e);
                if (container && ss(container.name) !== 'root') {
                  let containerPath = [];
                  let curr = container;
                  while (curr && ss(curr.name) !== 'root') {
                    containerPath = [curr.name, ...containerPath];
                    curr = parentField(curr);
                  }

                  if (srcPath && srcPath.length > 0 && !equalFold(ss(srcPath[0]), ss(containerPath[0]))) srcPath = [...containerPath, ...srcPath];
                  if (dstPath && dstPath.length > 0 && !equalFold(ss(dstPath[0]), ss(containerPath[0]))) dstPath = [...containerPath, ...dstPath];
                }

                const root = rootMap(refctx.scopeMap);
                const srcObj = root.getField(...(srcPath || []));
                const dstObj = root.getField(...(dstPath || []));

                // Unsuspend source node and all its ancestors
                if (srcObj) {
                  srcObj.suspended = false;
                  let parent = parentField(srcObj);
                  while (parent && ss(parent.name) !== 'root') {
                    parent.suspended = false;
                    parent = parentField(parent);
                  }
                }

                // Unsuspend destination node and all its ancestors
                if (dstObj) {
                  dstObj.suspended = false;
                  let parent = parentField(dstObj);
                  while (parent && ss(parent.name) !== 'root') {
                    parent.suspended = false;
                    parent = parentField(parent);
                  }
                }
              }
            }
          }

          e.appendReference(new EdgeReference({ context_: refctx, dueToGlob_: this.globRefContextStack.length > 0, dueToLazyGlob_: this.lazyGlobBeingApplied }));
          refctx.scopeMap.appendFieldReferences(0, refctx.edge.src, refctx, this);
          refctx.scopeMap.appendFieldReferences(0, refctx.edge.dst, refctx, this);
        }
      } else {
        const [ea2, err] = refctx.scopeMap.createEdge(eid, refctx, this);
        ea = ea2;
        if (err) {
          this.err.errs.push(err);
          continue;
        }
      }

      for (const e of ea) {
        if (refctx.key.edge_key) {
          if (!e.map_) e.map_ = new IRMap({ parent: e });
          this.compileField(e.map_, refctx.key.edge_key, refctx);
        } else {
          if (unbox(refctx.key.primary) && !refctx.key.primary.suspension) {
            if (this.ignoreLazyGlob(e)) return;
            e.primary_ = new Scalar({ parent: e, value: refctx.key.primary });
          }
          if (refctx.key.value.array) {
            this.errorf(unbox(refctx.key.value), 'edges cannot be assigned arrays');
            continue;
          } else if (refctx.key.value.map) {
            if (!e.map_) e.map_ = new IRMap({ parent: e });
            this.mapRefContextStack = [...this.mapRefContextStack, refctx];
            this.compileMap(e.map_, refctx.key.value.map, refctx.scopeAST);
            this.mapRefContextStack = this.mapRefContextStack.slice(0, -1);
          } else if (unbox(scalarBox(refctx.key.value)) && !refctx.key.value.suspension) {
            if (this.ignoreLazyGlob(e)) return;
            e.primary_ = new Scalar({ parent: e, value: scalarBox(refctx.key.value) });
          }
        }
      }
    }
  }

  compileArray(dst, a, scopeAST) {
    for (const an of a.nodes || []) {
      let irv = null;
      const k = boxKind(an);
      if (k === 'array') {
        const ira = new IRArray({ parent: dst });
        this.compileArray(ira, an.array, scopeAST);
        irv = ira;
      } else if (k === 'map') {
        const irm = new IRMap({ parent: dst });
        this.compileMap(irm, an.map, scopeAST);
        irv = irm;
      } else if (k === 'null' || k === 'boolean' || k === 'number' || k === 'unquoted_string' || k === 'double_quoted_string' || k === 'single_quoted_string' || k === 'block_string') {
        irv = new Scalar({ parent: dst, value: scalarBox(an) });
      } else if (k === 'import') {
        const v = an.import;
        const [n, ok] = this._import(v, dst);
        if (!ok) continue;
        n.setImportAST(v);
        if (n instanceof Field) {
          if (v.spread) {
            const arr = n.composite;
            if (!(arr instanceof IRArray)) {
              this.errorf(v, 'can only spread import array into array');
              continue;
            }
            dst.values = goAppend(dst.values, arr.values || []);
            continue;
          }
          if (n.composite) irv = n.composite;
          else irv = n.primary_;
        } else if (n instanceof IRMap) {
          if (v.spread) {
            this.errorf(v, 'can only spread import array into array');
            continue;
          }
          irv = n;
        }
      } else if (k === 'substitution') {
        irv = new Scalar({ parent: dst, value: { unquoted_string: { range: makeRange(',0:0:0-0:0:0'), value: [{ substitution: an.substitution }] } } });
      } else if (k === 'comment') {
        continue;
      }

      dst.values = goAppend(dst.values, [irv]);
    }
  }

  // ---- import.go ----

  pushImportStack(imp) {
    let impPath = importPathWithPre(imp);
    if (impPath === '' && !rangeIsZero(imp.range)) {
      this.errorf(imp, 'imports must specify a path to import');
      return ['', false];
    }
    if (this.importStack.length > 0) {
      if (pathExt(impPath) !== '.d2') impPath += '.d2';

      if (!impPath.startsWith('/')) impPath = pathJoin(pathDir(this.importStack[this.importStack.length - 1]), impPath);
    }

    for (let i = 0; i < this.importStack.length; i++) {
      if (impPath === this.importStack[i]) {
        this.errorf(imp, `detected cyclic import chain: ${formatCyclicChain(this.importStack.slice(i))}`);
        return ['', false];
      }
    }

    this.importStack.push(impPath);
    return [impPath, true];
  }

  popImportStack() { this.importStack.pop(); }

  /** Returns either an IRMap or a Field. */
  // Returns either IRMap or Field. importer (the node the import is attached to) only decides whether Go may reuse a cached IR
  // template of the imported file; this port compiles the file every time, which gives the same IR.
  _import(imp, importer) {
    const [ir, ok] = this.__import(imp);
    if (!ok) return [null, false];
    return this.selectImport(ir, imp);
  }

  selectImport(ir, imp) {
    nilScopeMap(ir);
    const ida = importIDA(imp);
    if (ida && ida.length > 0) {
      const f = ir.getField(...ida);
      if (!f) {
        this.errorf(imp, `import key ${fmtQIDA(ida)} doesn't exist inside import`);
        return [null, false];
      }
      return [f, true];
    }
    return [ir, true];
  }

  // Go's fs.Open + read: the file's text, or the error message Go would print.
  readFile(impPath) {
    if (this.fs === null) return [null, `open ${impPath}: no such file or directory`];
    const text = this.fs.get(pathClean(impPath));
    if (text === undefined) return [null, 'file does not exist'];
    return [text, null];
  }

  __import(imp) {
    const [impPath, ok] = this.pushImportStack(imp);
    if (!ok) return [null, false];
    try {
      // Only get immediate imports.
      if (this.importStack.length === 2) {
        if (!this.seenImports.has(impPath)) this.imports = [...(this.imports || []), importPathWithPre(imp)];
      }

      const [ast, openErr, ok2] = this.loadImportAST(impPath, this.err);
      if (!ok2) {
        if (openErr !== null) this.errorf(imp, `failed to import ${goQuote(impPath)}: ${openErr}`);
        return [null, false];
      }

      const ir = new IRMap();
      ir.initRoot();
      ir.parent.references[0].context_.scope = ast;

      this.compileMap(ir, ast, ast);

      // We attempt to resolve variables in the imported file scope first
      // But ignore errors, in case the variable is meant to be resolved at the
      // importer
      const savedErrors = this.err.errs.slice();
      this.compileSubstitutions(ir, null);
      this.err.errs = savedErrors;

      this.seenImports.add(impPath);

      return [ir, true];
    } finally {
      this.popImportStack();
    }
  }

  peekImport(imp) {
    let impPath = importPathWithPre(imp);
    if (impPath === '' && !rangeIsZero(imp.range)) return [null, false];

    if (this.importStack.length > 0) {
      if (pathExt(impPath) !== '.d2') impPath += '.d2';

      if (!impPath.startsWith('/')) impPath = pathJoin(pathDir(this.importStack[this.importStack.length - 1]), impPath);
    }

    // Use a separate parse error to avoid polluting the main one
    const localErr = new ParseError();
    const [ast, , ok] = this.loadImportAST(impPath, localErr);
    if (!ok) return [null, false];

    const ir = new IRMap();
    ir.initRoot();
    ir.parent.references[0].context_.scope = ast;

    this.compileMap(ir, ast, ast);

    return [ir, true];
  }

  // Returns [ast, openErr, ok]. The parsed AST is cached per compilation and every caller gets a deep copy: substitution
  // resolution coalesces strings in place.
  loadImportAST(impPath, parseErr) {
    const cached = this.parsedImports.get(impPath);
    if (cached) return [cloneASTMap(cached), null, true];

    const [text, err] = this.readFile(impPath);
    if (err !== null) return [null, err, false];

    const { ast, err: perr } = parse(impPath, text, { utf16: this.utf16Pos, parseError: parseErr });
    if (perr) return [null, null, false];
    this.parsedImports.set(impPath, ast);
    return [cloneASTMap(ast), null, true];
  }

  isContainer(m) {
    if (!m) return false;
    // Check references as the fields and edges may not be compiled yet
    const f = m.parent;
    if (!(f instanceof Field)) throw new Error('interface conversion: d2ir.Node is not *d2ir.Field');
    for (const ref of f.references || []) {
      if (ref.primary() && ref.context_.key && ref.context_.key.value.map) {
        for (const n of ref.context_.key.value.map.nodes || []) {
          if (!n.map_key) {
            if (n.import) {
              const [impn, ok] = this.peekImport(n.import);
              if (ok) {
                for (const f2 of impn.fields || []) {
                  const isReserved = ReservedKeywords.has(ss(f2.name));
                  if (!(isReserved && isUnquoted(f2.name))) return true;
                }
              }
            }
            continue;
          }
          if ((n.map_key.edges || []).length > 0) return true;
          if (n.map_key.key) {
            const isReserved = ReservedKeywords.has(ss(n.map_key.key.path[0]));
            if (!(isReserved && isUnquoted(f.name))) return true;
          }
        }
      }
    }
    for (const f2 of m.fields || []) {
      const isReserved = ReservedKeywords.has(ss(f2.name));
      if (!(isReserved && isUnquoted(f2.name))) return true;
    }
    return false;
  }
}

// ---- Go slice capacity, for the one place where d2ir depends on it ----
//
// resolveSubstitutions spreads an array into an array with `append(append(vals[:i], spread...), vals[i+1:]...)`. When
// vals has spare capacity, the inner append overwrites the elements after i and the outer one then copies the
// overwritten ones back (and a `range` over the old slice sees them too). To reproduce that, the arrays in
// IRArray.values carry the capacity Go's allocator would have given them in `$cap`.

// Go's malloc size classes (runtime/sizeclasses.go).
const SIZE_CLASSES = [8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704, 768, 896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864, 5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568, 14336, 16384, 18432, 19072, 20480, 21760, 24576, 27264, 28672, 32768];
// runtime.roundupsize for a pointerful allocation (an Value slice is 16-byte interfaces).
function roundupsize(size) {
  let req = size;
  if (req <= 32768 - 8) {
    if (req > 512) req += 8; // malloc header
    for (const c of SIZE_CLASSES) if (c >= req) return c - (req - size);
  }
  return Math.ceil(size / 8192) * 8192;
}
// runtime.growslice's capacity for 16-byte elements.
function growCap(oldCap, newLen) {
  let newcap = oldCap;
  const doublecap = newcap + newcap;
  if (newLen > doublecap) newcap = newLen;
  else if (oldCap < 256) newcap = doublecap;
  else { for (;;) { newcap += (newcap + 3 * 256) >> 2; if (newcap >= newLen) break; } }
  return Math.floor(roundupsize(newcap * 16) / 16);
}
const capOf = (a) => (a ? a.$cap ?? a.length : 0);
/** Go's append(a, items...) for a Values slice: a new array carrying the capacity Go would have. */
function goAppend(a, items) {
  if (items.length === 0) return a;
  const n = a ? a.length : 0, c = capOf(a);
  const res = [...(a || []), ...items];
  res.$cap = n + items.length <= c ? c : growCap(c, n + items.length);
  return res;
}
/** Go's append([]Value(nil), a...). */
function goCopySlice(a) {
  if (!a || a.length === 0) return null;
  const res = a.slice();
  res.$cap = growCap(0, a.length);
  return res;
}

// Go's `append(append(vals[:i], spread...), vals[i+1:]...)`. vals itself is overwritten in place where Go's backing
// array would be.
function goSpliceSpread(vals, i, spread) {
  const n = vals.length, s = spread.length, c = capOf(vals);
  let first, firstCap, shared;
  if (i + s <= c) {
    for (let k = 0; k < s; k++) vals[i + k] = spread[k];
    first = vals.slice(0, i + s);
    firstCap = c;
    shared = true;
  } else {
    first = [...vals.slice(0, i), ...spread];
    firstCap = growCap(c, i + s);
    shared = false;
  }
  const tail = vals.slice(i + 1, n); // read after the first append, so from the overwritten backing array
  const res = [...first, ...tail];
  if (res.length <= firstCap) {
    res.$cap = firstCap;
    if (shared) for (let k = 0; k < tail.length; k++) vals[first.length + k] = tail[k];
  } else res.$cap = growCap(firstCap, res.length);
  vals.length = n;
  return res;
}

function formatCyclicChain(cyclicChain) {
  return cyclicChain.map((p) => p + ' -> ').join('') + cyclicChain[0];
}

// ---- import_cache.go: deep copies of parsed ASTs ----
// Go's copies turn nil slices into empty ones ("value": [] instead of null), which shows in the JSON.

function cloneASTMap(src) {
  if (!src) return null;
  const dst = shallow(src);
  dst.nodes = [];
  for (const bx of src.nodes || []) {
    switch (boxKind(bx)) {
      case 'comment': dst.nodes.push({ comment: shallow(bx.comment) }); break;
      case 'block_comment': dst.nodes.push({ block_comment: shallow(bx.block_comment) }); break;
      case 'substitution': dst.nodes.push({ substitution: cloneASTSubstitution(bx.substitution) }); break;
      case 'import': dst.nodes.push({ import: cloneASTImport(bx.import) }); break;
      case 'map_key': dst.nodes.push({ map_key: cloneASTKey(bx.map_key) }); break;
    }
  }
  return dst;
}

function cloneASTArray(src) {
  if (!src) return null;
  const dst = shallow(src);
  dst.nodes = [];
  for (const bx of src.nodes || []) {
    switch (boxKind(bx)) {
      case 'comment': dst.nodes.push({ comment: shallow(bx.comment) }); break;
      case 'block_comment': dst.nodes.push({ block_comment: shallow(bx.block_comment) }); break;
      case 'substitution': dst.nodes.push({ substitution: cloneASTSubstitution(bx.substitution) }); break;
      case 'import': dst.nodes.push({ import: cloneASTImport(bx.import) }); break;
      case 'array': dst.nodes.push({ array: cloneASTArray(bx.array) }); break;
      case 'map': dst.nodes.push({ map: cloneASTMap(bx.map) }); break;
      default: dst.nodes.push(cloneASTScalarBox(bx));
    }
  }
  return dst;
}

function cloneASTKey(src) {
  if (!src) return null;
  const dst = shallow(src);
  if (src.key) dst.key = cloneASTKeyPath(src.key);
  if (src.edge_key) dst.edge_key = cloneASTKeyPath(src.edge_key);
  dst.primary = cloneASTScalarBox(src.primary);
  dst.value = cloneASTValueBox(src.value);
  if (src.edge_index) dst.edge_index = shallow(src.edge_index);
  if (src.edges !== undefined) {
    dst.edges = (src.edges || []).map((edge) => {
      const e = shallow(edge);
      e.src = cloneASTKeyPath(edge.src);
      e.dst = cloneASTKeyPath(edge.dst);
      return e;
    });
  }
  return dst;
}

function cloneASTKeyPath(src) {
  if (!src) return null;
  const dst = shallow(src);
  dst.path = (src.path || []).map(cloneASTStringBox);
  return dst;
}

function cloneASTStringBox(src) {
  if (!src || !unbox(src)) return null;
  return cloneASTScalarBox(src);
}

function cloneASTSubstitution(src) {
  if (!src) return null;
  const dst = shallow(src);
  dst.path = (src.path || []).map(cloneASTStringBox);
  return dst;
}

function cloneASTImport(src) {
  if (!src) return null;
  const dst = shallow(src);
  dst.path = (src.path || []).map(cloneASTStringBox);
  return dst;
}

function cloneASTValueBox(src) {
  switch (boxKind(src)) {
    case null: return {};
    case 'map': return { map: cloneASTMap(src.map) };
    case 'array': return { array: cloneASTArray(src.array) };
    case 'import': return { import: cloneASTImport(src.import) };
    default: return cloneASTScalarBox(src);
  }
}

function cloneASTScalarBox(src) {
  const k = boxKind(src);
  if (k === null) return src === null || src === undefined ? src : {};
  const n = src[k];
  const copy = shallow(n);
  switch (k) {
    case 'unquoted_string':
      if (n.pattern !== undefined) copy.pattern = n.pattern === null ? null : n.pattern.slice();
      copy.value = cloneASTInterpolation(n.value);
      break;
    case 'double_quoted_string':
      copy.value = cloneASTInterpolation(n.value);
      break;
  }
  return { [k]: copy };
}

function cloneASTInterpolation(src) {
  return (src || []).map((bx) => {
    const o = {};
    if (bx.string !== undefined) o.string = bx.string;
    if (bx.raw_string !== undefined) o.raw_string = bx.raw_string;
    if (bx.substitution) o.substitution = cloneASTSubstitution(bx.substitution);
    return o;
  });
}

function nilScopeMap(n) {
  if (n instanceof IRMap) {
    for (const f of n.fields || []) nilScopeMap(f);
    for (const e of n.edges || []) nilScopeMap(e);
  } else if (n instanceof Edge) {
    for (const r of n.references || []) r.context_.scopeMap = null;
    if (n.map()) nilScopeMap(n.map());
  } else if (n instanceof Field) {
    for (const r of n.references || []) r.context_.scopeMap = null;
    if (n.map()) nilScopeMap(n.map());
  }
}
