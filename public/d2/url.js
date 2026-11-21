// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of Go's net/url package (Go 1.24, BSD-3-Clause, Copyright 2009 The Go Authors): the parts
// d2compiler and d2exporter use (Parse, ParseRequestURI, URL.String and the escaping they rely on).
//
// Go strings are byte sequences. Everything here runs on "binary strings" (one JS char per UTF-8 byte); the fields of
// a URL are converted back to JS strings at the end, with every byte that is not part of a valid UTF-8 sequence kept as a
// lone surrogate U+DC00+byte (what Python calls surrogateescape), so that `%ff` survives a round trip and
// toJSON() can print U+FFFD for it, as Go's encoding/json does.

// ---- bytes <-> strings ----

/** JS string -> binary string (UTF-8 bytes, one char each). Lone surrogates U+DC80..U+DCFF stand for raw bytes. */
export function enc(s) {
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) o += s[i];
    else if (c < 0x800) o += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) < 0xe000) {
      const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
      i++;
      o += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else if (c >= 0xdc80 && c <= 0xdcff) o += String.fromCharCode(c - 0xdc00);
    else if (c >= 0xd800 && c < 0xe000) o += '\xef\xbf\xbd'; // other lone surrogate: Go would have U+FFFD
    else o += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return o;
}

/** binary string -> JS string, invalid bytes become U+DC00+byte. */
export function dec(b) {
  let o = '';
  const n = b.length;
  for (let i = 0; i < n;) {
    const c = b.charCodeAt(i);
    if (c < 0x80) { o += b[i]; i++; continue; }
    let need = 0, min = 0, cp = 0;
    if (c >= 0xc2 && c <= 0xdf) { need = 1; min = 0x80; cp = c & 0x1f; }
    else if (c >= 0xe0 && c <= 0xef) { need = 2; min = 0x800; cp = c & 0x0f; }
    else if (c >= 0xf0 && c <= 0xf4) { need = 3; min = 0x10000; cp = c & 0x07; }
    let ok = need > 0 && i + need <= n - 1;
    if (ok) {
      for (let k = 1; k <= need; k++) {
        const cc = b.charCodeAt(i + k);
        if ((cc & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (cc & 0x3f);
      }
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000))) ok = false;
    if (ok) { o += String.fromCodePoint(cp); i += need + 1; } else { o += String.fromCharCode(0xdc00 + c); i++; }
  }
  return o;
}

/** What encoding/json prints for a Go string: invalid UTF-8 becomes U+FFFD. */
export const jsonStr = (s) => s.replace(/[\udc80-\udcff]/g, (m, off, all) => {
  // a lone low surrogate (not preceded by a high surrogate)
  const prev = off > 0 ? all.charCodeAt(off - 1) : 0;
  return prev >= 0xd800 && prev < 0xdc00 ? m : '�';
});

// ---- strconv.Quote on binary strings ----

const PRINT = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
/** Go's strconv.Quote of a JS string (invalid bytes, kept as U+DC00+byte, print as \xNN). */
export function quote(s) {
  let o = '"';
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) < 0xe000) { c = s.slice(i, i + 2); i++; }
    const cp = c.codePointAt(0);
    if (c === '"' || c === '\\') o += '\\' + c;
    else if (c === '\x07') o += '\\a';
    else if (c === '\b') o += '\\b';
    else if (c === '\f') o += '\\f';
    else if (c === '\n') o += '\\n';
    else if (c === '\r') o += '\\r';
    else if (c === '\t') o += '\\t';
    else if (c === '\v') o += '\\v';
    else if (cp >= 0xdc80 && cp <= 0xdcff) o += '\\x' + (cp - 0xdc00).toString(16);
    else if (cp >= 0xd800 && cp < 0xe000) o += '\ufffd';
    else if (PRINT.test(c)) o += c;
    else if (cp < 0x80) o += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp < 0x10000) o += '\\u' + cp.toString(16).padStart(4, '0');
    else o += '\\U' + cp.toString(16).padStart(8, '0');
  }
  return o + '"';
}

// ---- errors ----

/** *url.Error */
export class URLError extends Error {
  constructor(op, url, err) { super(`${op} ${quote(url)}: ${err.message}`); this.op = op; this.url = url; this.err = err; }
}

class GoError extends Error {}
const errorsNew = (msg) => new GoError(msg);
const escapeError = (s) => new GoError('invalid URL escape ' + quote(dec(s)));
const invalidHostError = (s) => new GoError('invalid character ' + quote(dec(s)) + ' in host name');

// ---- escaping ----

const upperhex = '0123456789ABCDEF';
const ishex = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
function unhex(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 97 + 10;
  if (c >= 65 && c <= 70) return c - 65 + 10;
  return 0;
}

const encodePath = 1, encodePathSegment = 2, encodeHost = 3, encodeZone = 4, encodeUserPassword = 5, encodeQueryComponent = 6, encodeFragment = 7;

/** shouldEscape reports whether the byte c (a number) should be escaped when appearing in a URL string. */
function shouldEscape(c, mode) {
  const ch = String.fromCharCode(c);
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) return false;

  if (mode === encodeHost || mode === encodeZone) {
    switch (ch) {
      case '!': case '$': case '&': case "'": case '(': case ')': case '*': case '+': case ',': case ';': case '=': case ':': case '[': case ']': case '<': case '>': case '"':
        return false;
    }
  }

  switch (ch) {
    case '-': case '_': case '.': case '~':
      return false;
    case '$': case '&': case '+': case ',': case '/': case ':': case ';': case '=': case '?': case '@':
      switch (mode) {
        case encodePath: return ch === '?';
        case encodePathSegment: return ch === '/' || ch === ';' || ch === ',' || ch === '?';
        case encodeUserPassword: return ch === '@' || ch === '/' || ch === '?' || ch === ':';
        case encodeQueryComponent: return true;
        case encodeFragment: return false;
      }
  }

  if (mode === encodeFragment) {
    switch (ch) {
      case '!': case '(': case ')': case '*':
        return false;
    }
  }
  return true;
}

/** unescape on a binary string; returns [binary string, error|null]. */
function unescape(s, mode) {
  let n = 0;
  let hasPlus = false;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    switch (s[i]) {
      case '%':
        n++;
        if (i + 2 >= s.length || !ishex(s.charCodeAt(i + 1)) || !ishex(s.charCodeAt(i + 2))) {
          let t = s.slice(i);
          if (t.length > 3) t = t.slice(0, 3);
          return ['', escapeError(t)];
        }
        if (mode === encodeHost && unhex(s.charCodeAt(i + 1)) < 8 && s.slice(i, i + 3) !== '%25') return ['', escapeError(s.slice(i, i + 3))];
        if (mode === encodeZone) {
          const v = (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2));
          if (s.slice(i, i + 3) !== '%25' && v !== 32 && shouldEscape(v, encodeHost)) return ['', escapeError(s.slice(i, i + 3))];
        }
        i += 3;
        break;
      case '+':
        hasPlus = mode === encodeQueryComponent;
        i++;
        break;
      default:
        if ((mode === encodeHost || mode === encodeZone) && c < 0x80 && shouldEscape(c, mode)) return ['', invalidHostError(s[i])];
        i++;
    }
  }

  if (n === 0 && !hasPlus) return [s, null];

  let t = '';
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case '%':
        t += String.fromCharCode((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
        i += 2;
        break;
      case '+':
        t += mode === encodeQueryComponent ? ' ' : '+';
        break;
      default:
        t += s[i];
    }
  }
  return [t, null];
}

function escape(s, mode) {
  let spaceCount = 0, hexCount = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (shouldEscape(c, mode)) {
      if (c === 32 && mode === encodeQueryComponent) spaceCount++;
      else hexCount++;
    }
  }
  if (spaceCount === 0 && hexCount === 0) return s;

  let t = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 && mode === encodeQueryComponent) t += '+';
    else if (shouldEscape(c, mode)) t += '%' + upperhex[c >> 4] + upperhex[c & 15];
    else t += s[i];
  }
  return t;
}

// ---- URL ----

/** The Userinfo type: an immutable username and optional password. Marshals as `{}` (unexported fields). */
export class Userinfo {
  constructor(username, password, passwordSet) { this.username_ = username; this.password_ = password; this.passwordSet_ = passwordSet; }
  username() { return dec(this.username_); }
  password() { return [dec(this.password_), this.passwordSet_]; }
  toString() {
    let s = escape(this.username_, encodeUserPassword);
    if (this.passwordSet_) s += ':' + escape(this.password_, encodeUserPassword);
    return dec(s);
  }
  toJSON() { return {}; }
}

/**
 * A parsed URL. Property names are Go's field names, which is also what json.Marshal prints. The fields are JS strings
 * (see the header); the internal methods work on the binary form.
 */
export class URL {
  constructor() {
    this.Scheme = '';
    this.Opaque = '';
    this.User = null;
    this.Host = '';
    this.Path = '';
    this.RawPath = '';
    this.OmitHost = false;
    this.ForceQuery = false;
    this.RawQuery = '';
    this.Fragment = '';
    this.RawFragment = '';
  }

  isAbs() { return this.Scheme !== ''; }

  toJSON() {
    const o = {};
    for (const k of Object.keys(this)) o[k] = typeof this[k] === 'string' ? jsonStr(this[k]) : this[k];
    return o;
  }

  // internal: binary-string views
  get b() {
    const b = {};
    for (const k of ['Scheme', 'Opaque', 'Host', 'Path', 'RawPath', 'RawQuery', 'Fragment', 'RawFragment']) b[k] = enc(this[k]);
    return b;
  }

  /** @returns {string|null} error message */
  setPath(p) {
    const [path, err] = unescape(p, encodePath);
    if (err) return err;
    this.Path = dec(path);
    const escp = escape(path, encodePath);
    this.RawPath = p === escp ? '' : dec(p);
    return null;
  }

  escapedPath() {
    const b = this.b;
    if (b.RawPath !== '' && validEncoded(b.RawPath, encodePath)) {
      const [p, err] = unescape(b.RawPath, encodePath);
      if (!err && p === b.Path) return dec(b.RawPath);
    }
    if (this.Path === '*') return '*'; // don't escape (Issue 11202)
    return dec(escape(b.Path, encodePath));
  }

  setFragment(f) {
    const [frag, err] = unescape(f, encodeFragment);
    if (err) return err;
    this.Fragment = dec(frag);
    const escf = escape(frag, encodeFragment);
    this.RawFragment = f === escf ? '' : dec(f);
    return null;
  }

  escapedFragment() {
    const b = this.b;
    if (b.RawFragment !== '' && validEncoded(b.RawFragment, encodeFragment)) {
      const [f, err] = unescape(b.RawFragment, encodeFragment);
      if (!err && f === b.Fragment) return dec(b.RawFragment);
    }
    return dec(escape(b.Fragment, encodeFragment));
  }

  /** String reassembles the URL into a valid URL string. */
  toString() {
    const u = this;
    let buf = '';
    const b = this.b;
    if (u.Scheme !== '') { buf += b.Scheme; buf += ':'; }
    if (u.Opaque !== '') buf += b.Opaque;
    else {
      if (u.Scheme !== '' || u.Host !== '' || u.User !== null) {
        if (u.OmitHost && u.Host === '' && u.User === null) {
          // omit empty host
        } else {
          if (u.Host !== '' || u.Path !== '' || u.User !== null) buf += '//';
          if (u.User !== null) { buf += enc(u.User.toString()); buf += '@'; }
          if (b.Host !== '') buf += escape(b.Host, encodeHost);
        }
      }
      const path = enc(u.escapedPath());
      if (path !== '' && path[0] !== '/' && u.Host !== '') buf += '/';
      if (buf.length === 0) {
        // RFC 3986 §4.2
        const slash = path.indexOf('/');
        const segment = slash < 0 ? path : path.slice(0, slash);
        if (segment.includes(':')) buf += './';
      }
      buf += path;
    }
    if (u.ForceQuery || u.RawQuery !== '') { buf += '?'; buf += b.RawQuery; }
    if (u.Fragment !== '') { buf += '#'; buf += enc(u.escapedFragment()); }
    return dec(buf);
  }

  hostname() { return dec(splitHostPort(enc(this.Host))[0]); }
  port() { return dec(splitHostPort(enc(this.Host))[1]); }
}

function splitHostPort(hostPort) {
  let host = hostPort, port = '';
  const colon = host.lastIndexOf(':');
  if (colon !== -1 && validOptionalPort(host.slice(colon))) { port = host.slice(colon + 1); host = host.slice(0, colon); }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return [host, port];
}

function validEncoded(s, mode) {
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case '!': case '$': case '&': case "'": case '(': case ')': case '*': case '+': case ',': case ';': case '=': case ':': case '@':
      case '[': case ']':
      case '%':
        break;
      default:
        if (shouldEscape(s.charCodeAt(i), mode)) return false;
    }
  }
  return true;
}

/** @returns {[string, string, Error|null]} scheme, path */
function getScheme(rawURL) {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) continue;
    if ((c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.') {
      if (i === 0) return ['', rawURL, null];
    } else if (c === ':') {
      if (i === 0) return ['', '', errorsNew('missing protocol scheme')];
      return [rawURL.slice(0, i), rawURL.slice(i + 1), null];
    } else return ['', rawURL, null];
  }
  return ['', rawURL, null];
}

const cut = (s, sep) => { const i = s.indexOf(sep); return i < 0 ? [s, '', false] : [s.slice(0, i), s.slice(i + sep.length), true]; };
const count = (s, c) => s.split(c).length - 1;

/**
 * Parse parses a raw url into a URL. Returns {url, err}: exactly one is non-null.
 * @returns {{url: URL|null, err: URLError|null}}
 */
export function parse(rawURL) {
  const raw = enc(rawURL);
  const [u, frag] = cut(raw, '#');
  const r = parse_(u, false);
  if (r.err) return { url: null, err: new URLError('parse', dec(u), r.err) };
  if (frag === '') return { url: r.url, err: null };
  const err = r.url.setFragment(frag);
  if (err) return { url: null, err: new URLError('parse', rawURL, err) };
  return { url: r.url, err: null };
}

/** ParseRequestURI parses a raw url into a URL structure, assuming it was received in an HTTP request. */
export function parseRequestURI(rawURL) {
  const r = parse_(enc(rawURL), true);
  if (r.err) return { url: null, err: new URLError('parse', rawURL, r.err) };
  return { url: r.url, err: null };
}

function stringContainsCTLByte(s) {
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i);
    if (b < 32 || b === 0x7f) return true;
  }
  return false;
}

function parse_(rawURL, viaRequest) {
  let rest;
  let err;

  if (stringContainsCTLByte(rawURL)) return { url: null, err: errorsNew('net/url: invalid control character in URL') };
  if (rawURL === '' && viaRequest) return { url: null, err: errorsNew('empty url') };
  const url = new URL();

  if (rawURL === '*') { url.Path = '*'; return { url, err: null }; }

  let scheme;
  [scheme, rest, err] = getScheme(rawURL);
  if (err) return { url: null, err };
  url.Scheme = scheme.toLowerCase(); // ASCII letters, digits, + - .

  if (rest.endsWith('?') && count(rest, '?') === 1) {
    url.ForceQuery = true;
    rest = rest.slice(0, -1);
  } else {
    let q;
    [rest, q] = cut(rest, '?');
    url.RawQuery = dec(q);
  }

  if (!rest.startsWith('/')) {
    if (url.Scheme !== '') {
      // We consider rootless paths per RFC 3986 as opaque.
      url.Opaque = dec(rest);
      return { url, err: null };
    }
    if (viaRequest) return { url: null, err: errorsNew('invalid URI for request') };
    // Avoid confusion with malformed schemes, like cache_object:foo/bar.
    const [segment] = cut(rest, '/');
    if (segment.includes(':')) return { url: null, err: errorsNew('first path segment in URL cannot contain colon') };
  }

  if ((url.Scheme !== '' || (!viaRequest && !rest.startsWith('///'))) && rest.startsWith('//')) {
    let authority;
    authority = rest.slice(2); rest = '';
    const i = authority.indexOf('/');
    if (i >= 0) { rest = authority.slice(i); authority = authority.slice(0, i); }
    const pa = parseAuthority(authority);
    if (pa.err) return { url: null, err: pa.err };
    url.User = pa.user;
    url.Host = dec(pa.host);
  } else if (url.Scheme !== '' && rest.startsWith('/')) {
    // OmitHost is set to true when rawURL has an empty host (authority).
    url.OmitHost = true;
  }

  // Set Path and, optionally, RawPath.
  const perr = url.setPath(rest);
  if (perr) return { url: null, err: perr };
  return { url, err: null };
}

function parseAuthority(authority) {
  const i = authority.lastIndexOf('@');
  let host, err;
  if (i < 0) [host, err] = parseHost(authority);
  else [host, err] = parseHost(authority.slice(i + 1));
  if (err) return { user: null, host: '', err };
  if (i < 0) return { user: null, host, err: null };
  let userinfo = authority.slice(0, i);
  if (!validUserinfo(userinfo)) return { user: null, host: '', err: errorsNew('net/url: invalid userinfo') };
  let user;
  if (!userinfo.includes(':')) {
    [userinfo, err] = unescape(userinfo, encodeUserPassword);
    if (err) return { user: null, host: '', err };
    user = new Userinfo(userinfo, '', false);
  } else {
    let [username, password] = cut(userinfo, ':');
    [username, err] = unescape(username, encodeUserPassword);
    if (err) return { user: null, host: '', err };
    [password, err] = unescape(password, encodeUserPassword);
    if (err) return { user: null, host: '', err };
    user = new Userinfo(username, password, true);
  }
  return { user, host, err: null };
}

// parseHost parses host as an authority without user information. That is, as host[:port].
function parseHost(host) {
  if (host.startsWith('[')) {
    // Parse an IP-Literal in RFC 3986 and RFC 6874.
    // E.g., "[fe80::1]", "[fe80::1%25en0]", "[fe80::1]:80".
    const i = host.lastIndexOf(']');
    if (i < 0) return ['', errorsNew("missing ']' in host")];
    const colonPort = host.slice(i + 1);
    if (!validOptionalPort(colonPort)) return ['', errorsNew(`invalid port ${quote(dec(colonPort))} after host`)];

    // RFC 6874 defines that %25 (%-encoded percent) introduces the zone identifier, and the zone identifier can use basically
    // any %-encoding it likes.
    const zone = host.slice(0, i).indexOf('%25');
    if (zone >= 0) {
      const [host1, e1] = unescape(host.slice(0, zone), encodeHost);
      if (e1) return ['', e1];
      const [host2, e2] = unescape(host.slice(zone, i), encodeZone);
      if (e2) return ['', e2];
      const [host3, e3] = unescape(host.slice(i), encodeHost);
      if (e3) return ['', e3];
      return [host1 + host2 + host3, null];
    }
  } else {
    const i = host.lastIndexOf(':');
    if (i !== -1) {
      const colonPort = host.slice(i);
      if (!validOptionalPort(colonPort)) return ['', errorsNew(`invalid port ${quote(dec(colonPort))} after host`)];
    }
  }
  const [h, err] = unescape(host, encodeHost);
  if (err) return ['', err];
  return [h, null];
}

function validOptionalPort(port) {
  if (port === '') return true;
  if (port[0] !== ':') return false;
  for (let i = 1; i < port.length; i++) if (port[i] < '0' || port[i] > '9') return false;
  return true;
}

// validUserinfo reports whether s is a valid userinfo string per RFC 3986 Section 3.2.1. It ranges over runes.
function validUserinfo(s) {
  for (const r of dec(s)) {
    if ((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) continue;
    switch (r) {
      case '-': case '.': case '_': case ':': case '~': case '!': case '$': case '&': case "'":
      case '(': case ')': case '*': case '+': case ',': case ';': case '=': case '%': case '@':
        continue;
      default:
        return false;
    }
  }
  return true;
}
