// Sealed (encrypted + authenticated) cookie values for the Worker, using WebCrypto AES-GCM.
// The GitHub token lives only inside such a cookie: the browser can carry it but never read it,
// and nothing is stored on the server.
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function keyFor(secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('rico-session-v1:' + secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt a JSON payload; `ttlMs` is enforced on open. */
export async function seal(secret, payload, ttlMs) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(secret), data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}

/** Decrypt; null when tampered with, malformed or expired. */
export async function open(secret, sealed) {
  try {
    const all = unb64u(sealed);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await keyFor(secret), all.slice(12));
    const v = JSON.parse(dec.decode(pt));
    return v && v.exp > Date.now() ? v : null;
  } catch {
    return null;
  }
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export function setCookie(name, value, { maxAge, secure }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
