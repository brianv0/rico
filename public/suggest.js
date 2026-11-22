// Autocomplete for the Load PR box. Parsing and ranking are pure functions in lib.js; this file only fetches
// candidates (/api/suggest, one GraphQL request on the server), remembers recently opened PRs, and drives the dropdown.
import { rankSuggestions, suggestLookup, shortAge } from './lib.js';
import { icon } from './icons.js';

const RECENT_KEY = 'rico:recent-prs';
const RECENT_MAX = 15;
const POOL_TTL = 60_000;

export function loadRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((p) => p && p.owner && p.repo && p.number) : [];
  } catch { return []; }
}

/** Remember a PR that was opened, newest first, so it is the first suggestion next time. */
export function rememberPr(pr) {
  const item = { owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, state: pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN', draft: !!pr.draft, updatedAt: new Date().toISOString() };
  const rest = loadRecent().filter((p) => !(p.owner.toLowerCase() === item.owner.toLowerCase() && p.repo.toLowerCase() === item.repo.toLowerCase() && p.number === item.number));
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...rest].slice(0, RECENT_MAX))); } catch { /* private mode */ }
}

const stateOf = (p) => (p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.draft ? 'draft' : 'open');
const ICON = { open: 'git-pull-request', merged: 'git-merge', closed: 'git-pull-request-closed', draft: 'git-pull-request-draft' };
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {{input: HTMLInputElement, list: HTMLElement, onPick: (ref: string) => void, fetchJson?: (url: string, signal?: AbortSignal) => Promise<any>}} o
 */
export function initSuggest({ input, list, onPick, fetchJson }) {
  const getJson = fetchJson || (async (url, signal) => {
    const res = await fetch(url, { signal }); // not api(): a signed-out 401 here must not flip the app into "needs sign-in"
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  });
  let pool = null; // {at, items} | {at, items: [], failed: true}
  let poolReq = null;
  const lookups = new Map(); // "repo=o/r&text=…" -> items (this page view only)
  let shown = []; // what the list currently displays
  let active = -1;
  let abort = null;
  let timer = 0;

  function ensurePool() {
    if (pool && Date.now() - pool.at < POOL_TTL) return Promise.resolve(pool.items);
    poolReq ||= getJson('/api/suggest')
      .then((d) => (pool = { at: Date.now(), items: d.items || [] }).items)
      .catch(() => (pool = { at: Date.now(), items: [] }).items)
      .finally(() => { poolReq = null; });
    return poolReq;
  }

  const known = () => [...loadRecent(), ...(pool?.items || [])];
  const lookupKey = (l) => new URLSearchParams(l).toString();

  function render() {
    const lookup = suggestLookup(input.value, known());
    const sources = [
      { items: loadRecent(), boost: 25 },
      { items: pool?.items || [], boost: 10 },
      { items: (lookup && lookups.get(lookupKey(lookup))) || [], boost: 0 },
    ];
    shown = rankSuggestions(input.value, sources);
    active = Math.min(active, shown.length - 1);
    list.innerHTML = '';
    shown.forEach((p, i) => {
      const li = document.createElement('li');
      li.id = `pr-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === active ? 'true' : 'false');
      const st = stateOf(p);
      const ref = `${esc(p.owner)}/${esc(p.repo)}#${p.number}`;
      li.innerHTML = p.title
        ? `<span class="sg-ic sg-${st}">${icon(ICON[st])}</span><span class="sg-main"><span class="sg-title">${esc(p.title)}</span><span class="sg-meta">${ref}${p.author ? ' · ' + esc(p.author) : ''}${p.updatedAt ? ' · ' + shortAge(p.updatedAt) : ''}</span></span>`
        : `<span class="sg-ic sg-open">${icon('git-pull-request')}</span><span class="sg-main"><span class="sg-title">Open ${ref}</span></span>`;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(p); }); // before blur, so the list is still there
      list.appendChild(li);
    });
    const open = shown.length > 0 && document.activeElement === input;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', `pr-opt-${active}`); else input.removeAttribute('aria-activedescendant');
  }

  function pick(p) {
    input.value = `${p.owner}/${p.repo}#${p.number}`;
    close();
    onPick(input.value);
  }
  function close() { active = -1; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }

  function refresh() {
    active = -1;
    render();
    ensurePool().then(render);
    clearTimeout(timer);
    abort?.abort();
    if (!suggestLookup(input.value)) return; // the cached pool is enough
    timer = setTimeout(async () => {
      await ensurePool(); // "name#47" needs the pool to know which owners have that repo
      const lookup = suggestLookup(input.value, known());
      if (!lookup) return;
      const k = lookupKey(lookup);
      if (lookups.has(k)) return render();
      abort = new AbortController();
      getJson('/api/suggest?' + k, abort.signal).then((d) => { lookups.set(k, d.items || []); render(); }).catch(() => {});
    }, 180);
  }

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return;
      e.preventDefault();
      if (list.hidden) { render(); return; }
      active = ((active + 1 + (e.key === 'ArrowDown' ? 1 : -1) + shown.length + 1) % (shown.length + 1)) - 1; // -1 = back to what was typed
      render();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0 && !list.hidden) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();
      close();
    }
  });
}
