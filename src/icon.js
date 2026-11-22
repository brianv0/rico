// D2 icons (`icon: https://icons.terrastruct.com/...`). Diagrams are drawn in a sandboxed frame that may make no network
// requests at all (see frameDoc in public/diagrams.js), so the page asks Rico for the icon instead, and inlines the bytes
// as a data: URI. This is the only place that fetches on a diagram's behalf, so it is narrow on purpose: one https host,
// no redirects, a size and time limit, and only image types back. The diagram source is untrusted; it can pick the path
// on that one host and nothing else (no other host, port, scheme or credentials: a PR cannot aim this at an internal URL).
import { HttpError } from './github.js';

export const ICON_HOSTS = new Set(['icons.terrastruct.com']);
export const ICON_MAX_BYTES = 512 * 1024;
const ICON_TYPES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The URL to fetch for an icon, or throws HttpError 400. Only https://<allowed host>/<path>. */
export function iconUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { throw new HttpError(400, 'bad icon url'); }
  if (u.protocol !== 'https:' || !ICON_HOSTS.has(u.hostname) || u.port || u.username || u.password) throw new HttpError(400, 'icon host not allowed');
  u.hash = '';
  return u;
}

/** -> { type, data } for the icon, from `fetchImpl` (injectable for tests). */
export async function fetchIcon(raw, fetchImpl = fetch) {
  const u = iconUrl(raw);
  let res;
  try {
    res = await fetchImpl(u.toString(), { redirect: 'manual', headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(8000) });
  } catch { throw new HttpError(502, 'could not reach the icon host'); }
  if (res.status !== 200) throw new HttpError(res.status === 404 ? 404 : 502, `icon host answered ${res.status}`); // a redirect (3xx) is refused, not followed
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ICON_TYPES.has(type)) throw new HttpError(415, 'not an image');
  if (Number(res.headers.get('content-length')) > ICON_MAX_BYTES) throw new HttpError(413, 'icon too large');
  const chunks = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > ICON_MAX_BYTES) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'icon too large'); }
    chunks.push(value);
  }
  const data = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { data.set(c, o); o += c.length; }
  return { type, data };
}
