#!/usr/bin/env node
// Distinct signed-in GitHub users of the hosted Rico: DAU, WAU, MAU and their recent history, from the Workers Analytics
// Engine dataset the Worker writes on every signed-in app load (see recordActive in src/worker.js).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run usage            # production (rico_usage)
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run usage -- --stage # stage (rico_usage_stage)
//
// The token needs the "Account Analytics: Read" permission. Analytics Engine keeps data for 3 months.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (with Account Analytics: Read).');
  process.exit(1);
}
const table = process.argv.includes('--stage') ? 'rico_usage_stage' : 'rico_usage';

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

const [dau, wau, mau, daily, weekly] = await Promise.all([
  distinct(1),
  distinct(7),
  distinct(30),
  sql(`SELECT toStartOfDay(timestamp) AS day, count(DISTINCT index1) AS users FROM ${table} WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`),
  sql(`SELECT toStartOfWeek(timestamp) AS week, count(DISTINCT index1) AS users FROM ${table} WHERE timestamp > NOW() - INTERVAL '90' DAY GROUP BY week ORDER BY week`),
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
