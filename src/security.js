// Response headers shared by the local Node server and the Cloudflare Worker.
// Web-standard APIs only: no Node built-ins.

// Backstop headers for every response: the page renders untrusted PR content through DOMPurify, and
// this CSP contains any future sanitizer regression. 'wasm-unsafe-eval' is D2's WASM renderer and
// 'unsafe-eval' its ELK layout engine (evaluated inside D2's blob: worker — inline script injection
// stays blocked). The srcdoc diagram frames inherit this policy, so style/img/font-src cover what
// frameDoc uses. 'self' (not 'none') in frame-ancestors keeps our own frames working while blocking
// cross-origin clickjacking. Cloudflare Web Analytics (the beacon Cloudflare injects on ricorico.dev) may load its script
// from static.cloudflareinsights.com and report to cloudflareinsights.com; nothing else from outside.
export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' https://static.cloudflareinsights.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https: data:; font-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'";
export const SEC = { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' };

/** A copy of `res` with the security headers added; headers the response already set (e.g. /api/raw's CSP) win. */
export function secure(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SEC)) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
