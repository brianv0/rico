// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the parts of D2's d2format package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.)
// that d2ir calls: Format and its escaping helpers. Nodes have the shape described in ast.js; because the
// Go printer takes an interface, `format` takes the node's kind ('map_key', 'key_path', 'map', ...) with it.

import {
  boxKind, unbox, rangeOneLine, rangeIsZero, makeRange, isFileMap, pathClean, goLower, equalFold, isSpace,
  ReservedKeywords, UnquotedKeySpecials, UnquotedValueSpecials, rawString, scalarString,
} from './ast.js';

/** Go's d2format.Format(n): n is a node of the given kind (the key of its box, e.g. 'map_key'). */
export function format(kind, n) {
  const p = new Printer();
  p.node(kind, n);
  return p.sb;
}

const goItoa = (n) => String(n);

class Printer {
  constructor() { this.sb = ''; this.indentStr = ''; this.inKey = false; }

  indent() { this.indentStr += '  '; }
  deindent() { this.indentStr = this.indentStr.slice(0, -2); }
  newline() { this.sb += '\n' + this.indentStr; }

  nodeBox(b) { this.node(boxKind(b), unbox(b)); }

  node(kind, n) {
    switch (kind) {
      case 'comment': return this.comment(n);
      case 'block_comment': return this.blockComment(n);
      case 'null': this.sb += 'null'; return;
      case 'suspension': this.sb += n.value ? 'suspend' : 'unsuspend'; return;
      case 'boolean': this.sb += String(n.value); return;
      case 'number': this.sb += n.raw; return;
      case 'unquoted_string': return this.interpolationBoxes(n.value, false);
      case 'double_quoted_string':
        this.sb += '"';
        this.interpolationBoxes(n.value, true);
        this.sb += '"';
        return;
      case 'single_quoted_string':
        this.sb += "'";
        if (n.raw === '') n.raw = escapeSingleQuotedValue(n.value);
        this.sb += escapeSingleQuotedValue(n.value);
        this.sb += "'";
        return;
      case 'block_string': return this.blockString(n);
      case 'substitution': return this.substitution(n);
      case 'import': return this._import(n);
      case 'array': return this.array(n);
      case 'map': return this._map(n);
      case 'map_key': return this.mapKey(n);
      case 'key_path': return this.key(n);
      case 'edge': return this.edge(n);
      case 'edge_index': return this.edgeIndex(n);
    }
  }

  comment(c) {
    const lines = c.value.split('\n');
    lines.forEach((line, i) => {
      this.sb += '#';
      if (line !== '') this.sb += ' ';
      this.sb += line;
      if (i < lines.length - 1) this.newline();
    });
  }

  blockComment(bc) {
    this.sb += '"""';
    if (rangeOneLine(bc.range)) this.sb += ' ';
    for (const l of bc.value.split('\n')) {
      if (!rangeOneLine(bc.range)) {
        if (l === '') this.sb += '\n'; else this.newline();
      }
      this.sb += l;
    }
    if (!rangeOneLine(bc.range)) this.newline(); else this.sb += ' ';
    this.sb += '"""';
  }

  interpolationBoxes(boxes, isDoubleString) {
    boxes = boxes || [];
    for (let i = 0; i < boxes.length; i++) {
      const b = { ...boxes[i] }; // Go ranges over copies: changes to b do not reach the AST
      if (b.substitution) { this.substitution(b.substitution); continue; }
      if (b.raw_string === undefined || b.raw_string === null) {
        b.raw_string = isDoubleString ? escapeDoubledQuotedValue(b.string, this.inKey) : escapeUnquotedValue(b.string, this.inKey);
      } else if (i > 0 && boxes[i - 1].substitution) {
        b.raw_string = b.string;
      }
      if (!isDoubleString && ReservedKeywords.has(goLower(b.raw_string))) b.raw_string = goLower(b.raw_string);
      this.sb += b.raw_string;
    }
  }

  blockString(bs) {
    let quote = bs.quote;
    while (bs.value.includes('|' + quote)) {
      if (quote === '') quote += '|'; else quote += quote[quote.length - 1];
    }
    while (bs.value.includes(quote + '|')) quote += quote[quote.length - 1];

    if (rangeIsZero(bs.range)) {
      if (bs.value.indexOf('\n') > -1) bs.range = makeRange(',1:0:0-2:0:0');
      bs.value = goTrimSpace(bs.value);
    }

    this.sb += '|' + quote;
    this.sb += bs.tag;
    if (!rangeOneLine(bs.range)) this.indent(); else this.sb += ' ';

    for (const l of bs.value.split('\n')) {
      if (!rangeOneLine(bs.range)) {
        if (l === '') this.sb += '\n'; else this.newline();
      }
      this.sb += l;
    }

    if (!rangeOneLine(bs.range)) { this.deindent(); this.newline(); } else if (bs.value !== '') this.sb += ' ';
    this.sb += quote + '|';
  }

  path(els) {
    els = els || [];
    els.forEach((s, i) => {
      this.nodeBox(s);
      if (i < els.length - 1) this.sb += '.';
    });
  }

  substitution(s) {
    if (s.spread) this.sb += '...';
    this.sb += '${';
    this.path(s.path);
    this.sb += '}';
  }

  _import(i) {
    if (i.spread) this.sb += '...';
    this.sb += '@';
    const pre = pathClean(i.pre);
    if (pre !== '.') { this.sb += pre; this.sb += '/'; }
    if (i.path && i.path.length > 0) {
      i = { ...i, path: [...i.path] };
      i.path[0] = rawString(pathClean(scalarString(i.path[0])), true);
    }
    this.path(i.path);
  }

  array(a) {
    this.sb += '[';
    if (!rangeOneLine(a.range)) this.indent();
    const nodes = a.nodes || [];
    let prev = a;
    for (let i = 0; i < nodes.length; i++) {
      const nb = nodes[i];
      const kind = boxKind(nb), n = unbox(nb);
      if (i > 0 && (nb.comment || nb.block_comment)) {
        if (n.range.start.line === prev.range.end.line && rangeOneLine(n.range)) {
          this.sb += ' ';
          this.node(kind, n);
          continue;
        }
      }
      if (!rangeOneLine(a.range)) {
        if (prev !== a) {
          if (n.range.start.line - prev.range.end.line > 1) this.sb += '\n';
        }
        this.newline();
      } else if (i > 0) this.sb += '; ';
      this.node(kind, n);
      prev = n;
    }
    if (!rangeOneLine(a.range)) { this.deindent(); this.newline(); }
    this.sb += ']';
  }

  _map(m) {
    const fileMap = isFileMap(m);
    if (!fileMap) {
      this.sb += '{';
      if (!rangeOneLine(m.range)) this.indent();
    }
    const nodes = m.nodes || [];
    const boardNodes = [];
    let prev = m;
    for (let i = 0; i < nodes.length; i++) {
      const nb = nodes[i];
      const kind = boxKind(nb), n = unbox(nb);
      if (isBoardNode(nb)) {
        const boardType = scalarString(nb.map_key.key.path[0]);
        if ((boardType === 'layers' || boardType === 'scenarios' || boardType === 'steps') && nb.map_key.value.map && nb.map_key.value.map.nodes?.length > 0) boardNodes.push(nb);
        prev = n;
        continue;
      }
      if (i > 0 && (nb.comment || nb.block_comment)) {
        if (n.range.start.line === prev.range.end.line && rangeOneLine(n.range)) {
          this.sb += ' ';
          this.node(kind, n);
          continue;
        }
      }
      if (!rangeOneLine(m.range)) {
        if (prev !== m) {
          if (n.range.start.line - prev.range.end.line > 1) this.sb += '\n';
        }
        if (!fileMap || i > 0) this.newline();
      } else if (i > 0) this.sb += '; ';
      this.node(kind, n);
      prev = n;
    }

    for (let i = 0; i < boardNodes.length; i++) {
      const n = unbox(boardNodes[i]);
      if (n.range.start.line !== 0) this.sb += '\n';
      if (i !== 0 || nodes.length > boardNodes.length) this.sb += '\n';
      this.sb += this.indentStr;
      this.node(boxKind(boardNodes[i]), n);
      prev = n;
    }

    if (!fileMap) {
      if (!rangeOneLine(m.range)) { this.deindent(); this.newline(); }
      this.sb += '}';
    } else if (nodes.length > 0) this.sb += '\n';
  }

  mapKey(mk) {
    if (mk.ampersand) this.sb += '&';
    else if (mk.not_ampersand) this.sb += '!&';
    if (mk.key) this.key(mk.key);
    const edges = mk.edges || [];
    if (edges.length > 0) {
      if (mk.key) this.sb += '.';
      const paren = mk.key || mk.edge_index || mk.edge_key;
      if (paren) this.sb += '(';
      if (edges[0].src) { this.key(edges[0].src); this.sb += ' '; }
      edges.forEach((e, i) => {
        this.edgeArrowAndDst(e);
        if (i < edges.length - 1) this.sb += ' ';
      });
      if (paren) this.sb += ')';
      if (mk.edge_index) this.edgeIndex(mk.edge_index);
      if (mk.edge_key) { this.sb += '.'; this.key(mk.edge_key); }
    }
    if (unbox(mk.primary)) {
      this.sb += ': ';
      this.nodeBox(mk.primary);
    }
    if (mk.value.map && !(mk.value.map.nodes?.length > 0)) return;
    if (unbox(mk.value)) {
      if (!unbox(mk.primary)) this.sb += ': '; else this.sb += ' ';
      this.nodeBox(mk.value);
    }
  }

  key(k) {
    this.inKey = true;
    if (k) this.path(k.path);
    this.inKey = false;
  }

  edge(e) {
    if (e.src) { this.key(e.src); this.sb += ' '; }
    this.edgeArrowAndDst(e);
  }

  edgeArrowAndDst(e) {
    if (e.src_arrow === '') this.sb += '-'; else this.sb += e.src_arrow;
    if (e.dst_arrow === '') this.sb += '-';
    else {
      if (e.src_arrow !== '') this.sb += '-';
      this.sb += e.dst_arrow;
    }
    if (e.dst) { this.sb += ' '; this.key(e.dst); }
  }

  edgeIndex(ei) {
    this.sb += '[';
    if (ei.glob) this.sb += '*'; else this.sb += goItoa(ei.int);
    this.sb += ']';
  }
}

// Go's MapNodeBox.IsBoardNode.
function isBoardNode(mb) {
  if (!mb.map_key || !mb.map_key.key || mb.map_key.key.path?.length !== 1) return false;
  const s = scalarString(mb.map_key.key.path[0]);
  return s === 'layers' || s === 'scenarios' || s === 'steps';
}

// Go's strings.TrimSpace.
function goTrimSpace(s) {
  const a = Array.from(s);
  let i = 0, j = a.length;
  while (i < j && isSpace(a[i])) i++;
  while (j > i && isSpace(a[j - 1])) j--;
  return a.slice(i, j).join('');
}

function escapeSingleQuotedValue(s) {
  let b = '';
  for (const r of s) {
    if (r === "'") b += "'";
    else if (r === '\n') { b += '\\n'; continue; }
    b += r;
  }
  return b;
}

function escapeDoubledQuotedValue(s, inKey) {
  let b = '';
  for (const r of s) {
    if (r === '"' || r === '\\') b += '\\';
    else if (r === '\n') { b += '\\n'; continue; }
    if (!inKey && r === '$') b += '\\';
    b += r;
  }
  return b;
}

function escapeUnquotedValue(s, inKey) {
  if (s.length === 0) return '""';
  if (equalFold(s, 'null')) return "'null'";
  let b = '';
  let i = 0; // index of r in s as Go sees it (bytes); only compared with 0 and ASCII neighbours below
  for (const r of s) {
    switch (r) {
      case "'": case '"': case '|':
        if (i === 0) b += '\\';
        break;
      case '\n':
        b += '\\n';
        i += 1;
        continue;
      default:
        if (inKey) {
          if (r === '-') {
            if (i + 1 < s.length && s[i + 1] === '-') b += '\\';
          } else if (r === '&') {
            if (i === 0) b += '\\';
          } else if (UnquotedKeySpecials.includes(r)) b += '\\';
        } else if (UnquotedValueSpecials.includes(r)) b += '\\';
    }
    b += r;
    i += r.length;
  }
  return b;
}
