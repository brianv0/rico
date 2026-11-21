// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// A small HTML parser standing in for golang.org/x/net/html (as used through goquery in D2's lib/textmeasure
// markdown.go): it builds the same kind of tree (Node with Type, Data, Parent, FirstChild, LastChild, PrevSibling,
// NextSibling) from the HTML that a markdown renderer emits. It implements the parts of the HTML5 tree construction
// rules that matter for that input: void elements, implied end tags (p, li, dd/dt, table sections, rows, cells),
// tbody insertion, "any other end tag", entity decoding (the HTML 4 entity set), comments, and raw text elements.
// It is not a full HTML5 parser: no adoption agency algorithm, no foster parenting, no foreign content.

const ENTITIES = {AElig:198,Aacute:193,Acirc:194,Agrave:192,Alpha:913,Aring:197,Atilde:195,Auml:196,Beta:914,Ccedil:199,Chi:935,Dagger:8225,Delta:916,ETH:208,Eacute:201,Ecirc:202,Egrave:200,Epsilon:917,Eta:919,Euml:203,Gamma:915,Iacute:205,Icirc:206,Igrave:204,Iota:921,Iuml:207,Kappa:922,Lambda:923,Mu:924,Ntilde:209,Nu:925,OElig:338,Oacute:211,Ocirc:212,Ograve:210,Omega:937,Omicron:927,Oslash:216,Otilde:213,Ouml:214,Phi:934,Pi:928,Prime:8243,Psi:936,Rho:929,Scaron:352,Sigma:931,THORN:222,Tau:932,Theta:920,Uacute:218,Ucirc:219,Ugrave:217,Upsilon:933,Uuml:220,Xi:926,Yacute:221,Yuml:376,Zeta:918,aacute:225,acirc:226,acute:180,aelig:230,agrave:224,alefsym:8501,alpha:945,amp:38,and:8743,ang:8736,aring:229,asymp:8776,atilde:227,auml:228,bdquo:8222,beta:946,brvbar:166,bull:8226,cap:8745,ccedil:231,cedil:184,cent:162,chi:967,circ:710,clubs:9827,cong:8773,copy:169,crarr:8629,cup:8746,curren:164,dArr:8659,dagger:8224,darr:8595,deg:176,delta:948,diams:9830,divide:247,eacute:233,ecirc:234,egrave:232,empty:8709,emsp:8195,ensp:8194,epsilon:949,equiv:8801,eta:951,eth:240,euml:235,euro:8364,exist:8707,fnof:402,forall:8704,frac12:189,frac14:188,frac34:190,frasl:8260,gamma:947,ge:8805,gt:62,hArr:8660,harr:8596,hearts:9829,hellip:8230,iacute:237,icirc:238,iexcl:161,igrave:236,image:8465,infin:8734,int:8747,iota:953,iquest:191,isin:8712,iuml:239,kappa:954,lArr:8656,lambda:955,lang:9001,laquo:171,larr:8592,lceil:8968,ldquo:8220,le:8804,lfloor:8970,lowast:8727,loz:9674,lrm:8206,lsaquo:8249,lsquo:8216,lt:60,macr:175,mdash:8212,micro:181,middot:183,minus:8722,mu:956,nabla:8711,nbsp:160,ndash:8211,ne:8800,ni:8715,not:172,notin:8713,nsub:8836,ntilde:241,nu:957,oacute:243,ocirc:244,oelig:339,ograve:242,oline:8254,omega:969,omicron:959,oplus:8853,or:8744,ordf:170,ordm:186,oslash:248,otilde:245,otimes:8855,ouml:246,para:182,part:8706,permil:8240,perp:8869,phi:966,pi:960,piv:982,plusmn:177,pound:163,prime:8242,prod:8719,prop:8733,psi:968,quot:34,rArr:8658,radic:8730,rang:9002,raquo:187,rarr:8594,rceil:8969,rdquo:8221,real:8476,reg:174,rfloor:8971,rho:961,rlm:8207,rsaquo:8250,rsquo:8217,sbquo:8218,scaron:353,sdot:8901,sect:167,shy:173,sigma:963,sigmaf:962,sim:8764,spades:9824,sub:8834,sube:8838,sum:8721,sup:8835,sup1:185,sup2:178,sup3:179,supe:8839,szlig:223,tau:964,there4:8756,theta:952,thetasym:977,thinsp:8201,thorn:254,tilde:732,times:215,trade:8482,uArr:8657,uacute:250,uarr:8593,ucirc:251,ugrave:249,uml:168,upsih:978,upsilon:965,uuml:252,weierp:8472,xi:958,yacute:253,yen:165,yuml:255,zeta:950,zwj:8205,zwnj:8204,apos:39};
// entities the HTML5 spec also accepts without the trailing semicolon
const LEGACY = new Set('AElig Aacute Acirc Agrave Aring Atilde Auml Ccedil ETH Eacute Ecirc Egrave Euml Iacute Icirc Igrave Iuml Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml'.split(' '));
const MAX_ENTITY = 8;

const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '&') { out += c; continue; }
    const rest = s.slice(i + 1);
    let m;
    if ((m = /^#([xX])([0-9a-fA-F]+);?/.exec(rest)) || (m = /^#()([0-9]+);?/.exec(rest))) {
      let n = m[1] ? parseInt(m[2], 16) : parseInt(m[2], 10);
      if (CP1252[n] !== undefined) n = CP1252[n];
      else if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) n = 0xfffd;
      out += String.fromCodePoint(n);
      i += m[0].length;
    } else if ((m = /^([A-Za-z][A-Za-z0-9]*);/.exec(rest)) && ENTITIES[m[1]] !== undefined) {
      out += String.fromCodePoint(ENTITIES[m[1]]);
      i += m[0].length;
    } else {
      // longest legacy entity without semicolon
      let done = false;
      for (let len = Math.min(MAX_ENTITY, rest.length); len >= 2; len--) {
        const name = rest.slice(0, len);
        if (LEGACY.has(name)) { out += String.fromCodePoint(ENTITIES[name]); i += len; done = true; break; }
      }
      if (!done) out += '&';
    }
  }
  return out;
}

export class Node {
  constructor(type, data) {
    this.type = type; // 'text' | 'element' | 'comment' | 'document'
    this.data = data;
    this.parent = null;
    this.firstChild = null;
    this.lastChild = null;
    this.prevSibling = null;
    this.nextSibling = null;
  }
  removeChild(c) {
    if (c.prevSibling) c.prevSibling.nextSibling = c.nextSibling; else this.firstChild = c.nextSibling;
    if (c.nextSibling) c.nextSibling.prevSibling = c.prevSibling; else this.lastChild = c.prevSibling;
    c.parent = c.prevSibling = c.nextSibling = null;
  }
  insertBefore(c, ref) {
    c.parent = this;
    c.nextSibling = ref;
    c.prevSibling = ref.prevSibling;
    if (ref.prevSibling) ref.prevSibling.nextSibling = c; else this.firstChild = c;
    ref.prevSibling = c;
  }
  appendChild(c) {
    c.parent = this;
    c.prevSibling = this.lastChild;
    if (this.lastChild) this.lastChild.nextSibling = c; else this.firstChild = c;
    this.lastChild = c;
  }
}

const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HEAD_ONLY = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'title', 'style', 'script', 'noframes']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
const SPECIAL = new Set('address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp'.split(' '));
const P_CLOSERS = new Set('address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer header hgroup main menu nav ol p search section summary ul pre listing form table hr h1 h2 h3 h4 h5 h6 xmp plaintext'.split(' '));
const BUTTON_SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', 'button']);
const TABLE_SECTIONS = new Set(['tbody', 'thead', 'tfoot']);
const IMPLIED_END = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc']);
const TABLE_STRUCT = new Set(['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
const NO_RECON = new Set([...P_CLOSERS, 'li', 'dd', 'dt', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption', 'colgroup', 'col', 'param', 'source', 'track', 'option', 'optgroup', 'rb', 'rtc', 'rp', 'rt']);
const BLOCK_END = new Set('address article aside blockquote button center details dialog dir div dl fieldset figcaption figure footer header hgroup listing main menu nav ol pre search section summary ul'.split(' '));
const isHeading = (n) => /^h[1-6]$/.test(n);

/** tokenizes and builds a tree; returns the body Node (children of the parsed fragment). */
export function parseBody(src) {
  src = src.replace(/\r\n?/g, '\n');
  const body = new Node('element', 'body');
  const stack = [body];
  const cur = () => stack[stack.length - 1];

  // formatting elements: the list of active formatting elements holds nodes and null markers (HTML5 spec 13.2.4.3)
  const afl = [];
  const FORMATTING = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);
  const TABLE_CTX = new Set(['table', 'tbody', 'tfoot', 'thead', 'tr']);

  const lastTable = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].data === 'table') return i; return -1; };
  /** the node a new child goes into, and the sibling to insert before (foster parenting when in table context) */
  const insertionPoint = (target = cur()) => {
    if (!TABLE_CTX.has(target.data)) return [target, null];
    const ti = lastTable();
    if (ti < 0) return [stack[0], null];
    const table = stack[ti];
    if (table.parent) return [table.parent, table];
    return [stack[ti - 1] ?? stack[0], null];
  };
  const place = (n, target) => {
    const [parent, before] = insertionPoint(target);
    if (before) parent.insertBefore(n, before); else parent.appendChild(n);
  };
  const appendText = (text) => {
    if (text === '') return;
    const [parent, before] = insertionPoint();
    const prev = before ? before.prevSibling : parent.lastChild;
    if (prev && prev.type === 'text') prev.data += text;
    else { const t = new Node('text', text); if (before) parent.insertBefore(t, before); else parent.appendChild(t); }
  };
  const hasInScope = (name, scope = BUTTON_SCOPE) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].data === name) return true;
      if (scope.has(stack[i].data)) return false;
    }
    return false;
  };
  const popUntil = (name) => {
    while (stack.length > 1) { const n = stack.pop(); if (n.data === name) return; }
  };
  const generateImplied = (except) => {
    while (stack.length > 1 && IMPLIED_END.has(cur().data) && cur().data !== except) stack.pop();
  };
  const closeP = () => { if (hasInScope('p')) { generateImplied('p'); popUntil('p'); } };
  const inTableScope = (name) => hasInScope(name, new Set(['html', 'table', 'template']));
  const insert = (name, attrs = '') => {
    const n = new Node('element', name);
    n.attrs = attrs;
    if (TABLE_STRUCT.has(name)) cur().appendChild(n); // table structure is never foster parented
    else place(n);
    stack.push(n);
    return n;
  };
  const clearToTableContext = (names) => { while (stack.length > 1 && !names.has(cur().data)) stack.pop(); };

  const reconstruct = () => {
    if (afl.length === 0) return;
    let i = afl.length - 1;
    if (afl[i] === null || stack.includes(afl[i])) return;
    while (i > 0) {
      i--;
      if (afl[i] === null || stack.includes(afl[i])) { i++; break; }
    }
    for (; i < afl.length; i++) {
      const e = afl[i];
      const n = insert(e.data, e.attrs);
      afl[i] = n;
    }
  };
  const pushFormatting = (n) => {
    // Noah's Ark clause: at most three identical entries after the last marker
    let count = 0, first = -1;
    for (let i = afl.length - 1; i >= 0 && afl[i] !== null; i--) {
      if (afl[i].data === n.data && afl[i].attrs === n.attrs) { count++; first = i; }
    }
    if (count >= 3) afl.splice(first, 1);
    afl.push(n);
  };
  const removeFromList = (n) => { const i = afl.indexOf(n); if (i >= 0) afl.splice(i, 1); };
  const removeFromStack = (n) => { const i = stack.indexOf(n); if (i >= 0) stack.splice(i, 1); };
  const clearToMarker = () => { while (afl.length) { if (afl.pop() === null) break; } };

  /** the adoption agency algorithm; returns false when the caller should run "any other end tag" */
  const adopt = (subject) => {
    if (cur().data === subject && !afl.includes(cur())) { stack.pop(); return true; }
    for (let outer = 0; outer < 8; outer++) {
      let fe = null;
      for (let i = afl.length - 1; i >= 0 && afl[i] !== null; i--) if (afl[i].data === subject) { fe = afl[i]; break; }
      if (!fe) return false;
      const fi = stack.indexOf(fe);
      if (fi < 0) { removeFromList(fe); return true; }
      if (!hasInScope(subject)) return true;
      let furthest = null;
      for (let i = fi + 1; i < stack.length; i++) if (SPECIAL.has(stack[i].data)) { furthest = stack[i]; break; }
      if (!furthest) {
        while (stack.length > fi) stack.pop();
        removeFromList(fe);
        return true;
      }
      const common = stack[fi - 1];
      let bookmark = afl.indexOf(fe);
      let node = furthest, last = furthest;
      let inner = 0;
      let ni = stack.indexOf(furthest);
      for (;;) {
        inner++;
        ni--;
        node = stack[ni];
        if (node === fe) break;
        if (inner > 3 && afl.includes(node)) removeFromList(node);
        if (!afl.includes(node)) { stack.splice(ni, 1); continue; }
        const clone = new Node('element', node.data);
        clone.attrs = node.attrs;
        afl[afl.indexOf(node)] = clone;
        stack[ni] = clone;
        node = clone;
        if (last === furthest) bookmark = afl.indexOf(node) + 1;
        if (last.parent) last.parent.removeChild(last);
        node.appendChild(last);
        last = node;
      }
      if (last.parent) last.parent.removeChild(last);
      place(last, common);
      const nn = new Node('element', fe.data);
      nn.attrs = fe.attrs;
      while (furthest.firstChild) { const c = furthest.firstChild; furthest.removeChild(c); nn.appendChild(c); }
      furthest.appendChild(nn);
      const old = afl.indexOf(fe);
      afl.splice(bookmark, 0, nn);
      afl.splice(old < bookmark ? old : old + 1, 1);
      removeFromStack(fe);
      stack.splice(stack.indexOf(furthest) + 1, 0, nn);
    }
    return true;
  };

  // The insertion modes before <body> (initial, before html, before head, in head, after head): whitespace, comments and
  // ignorable end tags are dropped (or go to <head>/<html>, which are outside the body), head-only elements (title, style, ...)
  // go to <head>, and the first body content ends the phase. Everything the caller sees is the body's subtree.
  let pre = true;
  const startTag = (name, attrs = '') => {
    if (pre && name === 'body') pre = false;
    if (name === 'html' || name === 'head' || name === 'body') return; // merged into the existing elements
    pre = false;
    // no doctype: quirks mode, where <table> does not close an open <p>
    if (P_CLOSERS.has(name) && name !== 'table') closeP();
    if (isHeading(name) && isHeading(cur().data)) stack.pop();
    switch (name) {
      case 'li':
        for (let i = stack.length - 1; i >= 0; i--) {
          const n = stack[i].data;
          if (n === 'li') { generateImplied('li'); popUntil('li'); break; }
          if (SPECIAL.has(n) && n !== 'address' && n !== 'div' && n !== 'p') break;
        }
        closeP();
        break;
      case 'dd': case 'dt':
        for (let i = stack.length - 1; i >= 0; i--) {
          const n = stack[i].data;
          if (n === 'dd' || n === 'dt') { generateImplied(n); popUntil(n); break; }
          if (SPECIAL.has(n) && n !== 'address' && n !== 'div' && n !== 'p') break;
        }
        closeP();
        break;
      case 'button':
        if (hasInScope('button')) { generateImplied(); popUntil('button'); }
        reconstruct();
        break;
      case 'caption': case 'colgroup': case 'thead': case 'tbody': case 'tfoot': case 'tr': case 'td': case 'th': case 'col': {
        if (!stack.some((n) => n.data === 'table')) return; // ignored outside a table
        if (name === 'thead' || name === 'tbody' || name === 'tfoot' || name === 'caption' || name === 'colgroup') {
          clearToTableContext(new Set(['table']));
        } else if (name === 'tr') {
          if (cur().data === 'table') insert('tbody');
          else clearToTableContext(new Set(['tbody', 'thead', 'tfoot', 'table']));
          if (cur().data === 'table') insert('tbody');
        } else if (name === 'td' || name === 'th') {
          if (cur().data === 'table') insert('tbody');
          if (TABLE_SECTIONS.has(cur().data)) insert('tr');
          else clearToTableContext(new Set(['tr', 'tbody', 'thead', 'tfoot', 'table']));
          if (TABLE_SECTIONS.has(cur().data)) insert('tr');
        } else if (name === 'col') {
          if (cur().data === 'table') insert('colgroup');
        }
        if (name === 'td' || name === 'th' || name === 'caption') { insert(name, attrs); afl.push(null); return; }
        break;
      }
      default:
        if (FORMATTING.has(name)) {
          if (name === 'a') {
            for (let i = afl.length - 1; i >= 0 && afl[i] !== null; i--) {
              if (afl[i].data === 'a') {
                const a = afl[i];
                adopt('a');
                removeFromList(a);
                removeFromStack(a);
                break;
              }
            }
          }
          if (name === 'nobr' && hasInScope('nobr')) { adopt('nobr'); }
          reconstruct();
          const n = insert(name, attrs);
          pushFormatting(n);
          return;
        }
        if (!NO_RECON.has(name) && !isHeading(name)) reconstruct();
    }
    insert(name, attrs);
    if (VOID.has(name)) stack.pop();
  };

  const endTag = (name) => {
    if (pre) {
      if (name !== 'html' && name !== 'body' && name !== 'br') return;
      pre = false;
    }
    switch (name) {
      case 'html': case 'body': case 'head': return;
      case 'br': startTag('br'); return;
      case 'p':
        if (!hasInScope('p')) startTag('p');
        closeP();
        return;
      case 'li':
        if (hasInScope('li', new Set([...BUTTON_SCOPE, 'ol', 'ul']))) { generateImplied('li'); popUntil('li'); }
        return;
      case 'dd': case 'dt':
        if (hasInScope(name)) { generateImplied(name); popUntil(name); }
        return;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
          if (hasInScope(h)) { generateImplied(); while (stack.length > 1) { const n = stack.pop(); if (isHeading(n.data)) break; } return; }
        }
        return;
      case 'td': case 'th': case 'caption':
        if (inTableScope(name)) { generateImplied(); popUntil(name); clearToMarker(); }
        return;
      case 'table': case 'colgroup': case 'thead': case 'tbody': case 'tfoot': case 'tr':
        if (inTableScope(name)) { generateImplied(); popUntil(name); }
        return;
    }
    if (FORMATTING.has(name)) {
      if (adopt(name)) return;
    } else if (BLOCK_END.has(name)) {
      if (hasInScope(name)) { generateImplied(); popUntil(name); }
      return;
    }
    for (let i = stack.length - 1; i > 0; i--) {
      const n = stack[i];
      if (n.data === name) {
        generateImplied(name);
        while (stack.length > i) stack.pop();
        return;
      }
      if (SPECIAL.has(n.data)) return;
    }
  };

  const n = src.length;
  let i = 0;
  let textStart = 0;
  let pendingPreNewline = false;
  const flushText = (end) => {
    if (end > textStart) {
      let t = decodeEntities(src.slice(textStart, end));
      if (pre) {
        t = t.replace(/^[\t\n\f\r ]+/, '');
        if (t === '') return;
        pre = false;
      }
      if (pendingPreNewline) { if (t[0] === '\n') t = t.slice(1); pendingPreNewline = false; }
      if (TABLE_CTX.has(cur().data) && /^[\t\n\f\r ]*$/.test(t)) appendText(t);
      else { reconstruct(); appendText(t); }
    }
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const c = src[lt + 1];
    if (c === '!' || c === '?' || c === '/' || (c !== undefined && /[A-Za-z]/.test(c))) {
      flushText(lt);
      pendingPreNewline = pendingPreNewline && false;
      if (src.startsWith('<!--', lt)) {
        let end = src.indexOf('-->', lt + 4);
        let data;
        if (src.startsWith('<!-->', lt)) { data = ''; i = lt + 5; }
        else if (src.startsWith('<!--->', lt)) { data = ''; i = lt + 6; }
        else if (end < 0) { data = src.slice(lt + 4); i = n; }
        else { data = src.slice(lt + 4, end); i = end + 3; }
        if (!pre) cur().appendChild(new Node('comment', data));
      } else if (c === '!' || c === '?') {
        // doctype (ignored in body) / CDATA / bogus comment: ends at the next '>'
        const end = src.indexOf('>', lt + 2);
        const data = end < 0 ? src.slice(lt + 2) : src.slice(lt + 2, end);
        i = end < 0 ? n : end + 1;
        if (!pre && !/^doctype/i.test(data)) cur().appendChild(new Node('comment', c === '?' ? '?' + data : data));
      } else if (c === '/') {
        const m = /^<\/([A-Za-z][^\t\n\f \/>]*)[^>]*>?/.exec(src.slice(lt));
        if (m) { endTag(m[1].toLowerCase()); i = lt + m[0].length; }
        else if (src[lt + 2] === '>') i = lt + 3;
        else if (lt + 2 >= n) { appendText('</'); i = n; }
        else { const end = src.indexOf('>', lt + 2); cur().appendChild(new Node('comment', src.slice(lt + 2, end < 0 ? n : end))); i = end < 0 ? n : end + 1; }
      } else {
        // start tag: name, then attributes up to '>' (quoted values may contain '>')
        const nm = /^<([A-Za-z][^\t\n\f \/>]*)/.exec(src.slice(lt, lt + 200));
        const name = nm[1].toLowerCase();
        let j = lt + nm[0].length;
        let quote = null;
        for (; j < n; j++) {
          const ch = src[j];
          if (quote) { if (ch === quote) quote = null; continue; }
          if (ch === '"' || ch === "'") {
            // a quote only opens a value right after '='
            let k = j - 1;
            while (k > lt && /[\t\n\f ]/.test(src[k])) k--;
            if (src[k] === '=') quote = ch;
            continue;
          }
          if (ch === '>') break;
        }
        i = j + 1;
        const inHead = pre && HEAD_ONLY.has(name);
        if (!inHead) startTag(name, src.slice(lt + nm[0].length, j).trim());
        if (RAW.has(name) && !VOID.has(name)) {
          const close = new RegExp('</' + name + '[\\t\\n\\f />]', 'i');
          const rest = src.slice(i);
          const m = close.exec(rest);
          const body_ = m ? rest.slice(0, m.index) : rest;
          let t = name === 'textarea' || name === 'title' ? decodeEntities(body_) : body_;
          if (name === 'textarea' && t[0] === '\n') t = t.slice(1);
          if (!inHead) appendText(t);
          i += body_.length;
          // the end tag is processed by the loop
        } else if (name === 'pre' || name === 'listing') pendingPreNewline = true;
      }
      textStart = i;
      continue;
    }
    i = lt + 1; // a '<' that does not start a tag is text
  }
  flushText(n);
  return body;
}
