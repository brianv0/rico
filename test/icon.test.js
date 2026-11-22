// D2 icons: Rico fetches them for the sandboxed diagram, from one host only, within limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { iconUrl, fetchIcon, ICON_MAX_BYTES } from '../src/icon.js';

const URL_OK = 'https://icons.terrastruct.com/essentials%2F092-graph%20bar.svg';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const reply = (body, init = {}) => async () => new Response(body, { status: 200, headers: { 'Content-Type': 'image/svg+xml' }, ...init });

test('iconUrl: only https on the icon host; the path (with its %2F) is kept as D2 wrote it', () => {
  assert.equal(iconUrl(URL_OK).toString(), URL_OK);
  for (const bad of ['http://icons.terrastruct.com/a.svg', 'https://evil.example/a.svg', 'https://icons.terrastruct.com.evil.example/a.svg',
    'https://icons.terrastruct.com:8443/a.svg', 'https://user:pw@icons.terrastruct.com/a.svg', 'https://169.254.169.254/latest', 'file:///etc/passwd', 'javascript:alert(1)', '', null]) {
    assert.throws(() => iconUrl(bad), (e) => e.status === 400, String(bad));
  }
});

test('fetchIcon returns the image bytes and type, and asks for the exact URL without following redirects', async () => {
  let seen;
  const out = await fetchIcon(URL_OK, async (u, o) => { seen = { u, redirect: o.redirect }; return new Response(SVG, { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } }); });
  assert.equal(out.type, 'image/svg+xml');
  assert.equal(new TextDecoder().decode(out.data), SVG);
  assert.deepEqual(seen, { u: URL_OK, redirect: 'manual' });
});

test('fetchIcon refuses redirects, non-images, oversize bodies and upstream errors', async () => {
  await assert.rejects(fetchIcon(URL_OK, async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/x.svg' } })), (e) => e.status === 502);
  await assert.rejects(fetchIcon(URL_OK, reply('<html>', { headers: { 'Content-Type': 'text/html' } })), (e) => e.status === 415);
  await assert.rejects(fetchIcon(URL_OK, reply(new Uint8Array(ICON_MAX_BYTES + 1))), (e) => e.status === 413);
  await assert.rejects(fetchIcon(URL_OK, reply(SVG, { status: 404 })), (e) => e.status === 404);
  await assert.rejects(fetchIcon(URL_OK, async () => { throw new Error('down'); }), (e) => e.status === 502);
  await assert.rejects(fetchIcon('https://evil.example/a.svg', reply(SVG)), (e) => e.status === 400); // never even asked
});
