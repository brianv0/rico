#!/usr/bin/env node
// Distinct signed-in GitHub users of the hosted Rico (DAU, WAU, MAU and their recent history) and the comments each one
// posted through Rico, from the Workers Analytics Engine dataset the Worker writes (see record() in src/worker.js).
// Users are pseudonymous ids (an HMAC of the login): the dataset never holds logins.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run usage            # production (active_users)
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run usage -- --stage # stage (active_users_stage)
//
// The token needs the "Account Analytics: Read" permission. Analytics Engine keeps data for 3 months.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (with Account Analytics: Read).');
  process.exit(1);
}
const table = process.argv.includes('--stage') ? 'active_users_stage' : 'active_users';

async function sql(query) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: `${query} FORMAT JSON`,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Analytics Engine SQL ${r.status}: ${text.trim()}`);
  return JSON.parse(text).data;
}

const distinct = (days) => sql(`SELECT count(DISTINCT index1) AS users FROM ${table} WHERE timestamp > NOW() - INTERVAL '${days}' DAY`).then((d) => Number(d[0]?.users || 0));

const KINDS = ['line', 'general', 'reply', 'pending'];
// counts use _sample_interval: Analytics Engine may sample busy datasets, and each kept point then stands for that many
const [dau, wau, mau, daily, weekly, byKind, byUser, seen] = await Promise.all([
  distinct(1),
  distinct(7),
  distinct(30),
  sql(`SELECT toStartOfDay(timestamp) AS day, count(DISTINCT index1) AS users FROM ${table} WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`),
  sql(`SELECT toStartOfWeek(timestamp) AS week, count(DISTINCT index1) AS users FROM ${table} WHERE timestamp > NOW() - INTERVAL '90' DAY GROUP BY week ORDER BY week`),
  sql(`SELECT blob3 AS kind, SUM(_sample_interval) AS n FROM ${table} WHERE blob2 = 'comment' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY kind`),
  sql(`SELECT index1 AS user, blob3 AS kind, SUM(_sample_interval) AS n FROM ${table} WHERE blob2 = 'comment' AND timestamp > NOW() - INTERVAL '90' DAY GROUP BY user, kind`),
  sql(`SELECT index1 AS user, MAX(timestamp) AS last FROM ${table} WHERE timestamp > NOW() - INTERVAL '90' DAY GROUP BY user`),
]);

console.log(`${table}: distinct signed-in GitHub users`);
console.log(`  DAU (last 24h)  ${dau}`);
console.log(`  WAU (last 7d)   ${wau}`);
console.log(`  MAU (last 30d)  ${mau}`);
console.log(`  DAU/MAU         ${mau ? ((dau / mau) * 100).toFixed(0) + '%' : '-'}`);
console.log('\nPer calendar week (UTC, starts Sunday):');
for (const w of weekly) console.log(`  ${String(w.week).slice(0, 10)}  ${w.users}`);
console.log('\nPer day (UTC):');
for (const d of daily) console.log(`  ${String(d.day).slice(0, 10)}  ${d.users}`);

const kindCount = Object.fromEntries(byKind.map((r) => [r.kind, Number(r.n)]));
const comments30 = Object.values(kindCount).reduce((a, b) => a + b, 0);
console.log(`\nComments posted through Rico, last 30 days: ${comments30}`);
for (const k of KINDS) console.log(`  ${k.padEnd(8)} ${kindCount[k] || 0}`);

// every user seen in the last 90 days, with their comments by kind (0 if they only read)
const users = new Map(seen.map((r) => [r.user, { last: String(r.last).slice(0, 10), total: 0, ...Object.fromEntries(KINDS.map((k) => [k, 0])) }]));
for (const r of byUser) {
  const u = users.get(r.user) || users.set(r.user, { last: '', total: 0, ...Object.fromEntries(KINDS.map((k) => [k, 0])) }).get(r.user);
  u[r.kind] = (u[r.kind] || 0) + Number(r.n);
  u.total += Number(r.n);
}
const rows = [...users].sort((a, b) => b[1].total - a[1].total || b[1].last.localeCompare(a[1].last));
console.log(`\nPer user, last 90 days (${rows.length} users; ids are pseudonymous):`);
console.log(`  ${'user'.padEnd(12)} ${'comments'.padStart(8)} ${KINDS.map((k) => k.padStart(8)).join(' ')}  last seen`);
for (const [id, u] of rows) console.log(`  ${id.slice(0, 12)} ${String(u.total).padStart(8)} ${KINDS.map((k) => String(u[k]).padStart(8)).join(' ')}  ${u.last}`);
