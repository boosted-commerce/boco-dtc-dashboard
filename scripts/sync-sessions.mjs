// Daily sync: ShopifyQL sessions-by-landing-page -> Snowflake
// BOCO_DASHBOARD.SESSIONS.DAILY_SESSIONS.
//
// One row per (brand, activity_date, landing_path). Idempotent MERGE so
// re-running a day is safe. Sessions/conversion come from ShopifyQL (the
// only place Shopify exposes them); per-brand OAuth tokens are read from
// the same Upstash Redis the app uses.
//
// Default: yesterday only. Pass SESSIONS_SYNC_DAYS_BACK=N to backfill N
// days (queried one day at a time to stay under ShopifyQL row limits).

import snowflake from 'snowflake-sdk';
import { Redis } from '@upstash/redis';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};

const BRANDS = ['ASN', 'HHH', 'VIV', 'PRL'];
const SHOPIFY_API_VERSION = '2026-04';
const redis = Redis.fromEnv(); // UPSTASH_REDIS_REST_URL / _TOKEN

// ---------------------------------------------------------------------
// ShopifyQL
// ---------------------------------------------------------------------

async function shopCreds(brand) {
  const [shop, token] = await Promise.all([
    redis.get(`shopify:${brand}:shop`),
    redis.get(`shopify:${brand}:token`),
  ]);
  if (!shop || !token) return null;
  return { shop: String(shop), token: String(token) };
}

function normalizePath(raw) {
  if (!raw) return '/';
  let p = String(raw).split('?')[0].split('#')[0];
  const m = p.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (m) p = m[1] || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p;
}

// One day's sessions per landing page. offset=1 → yesterday.
async function fetchDay(creds, brand, offset) {
  const query =
    `FROM sessions SHOW sessions, conversion_rate ` +
    `GROUP BY landing_page_path ` +
    `SINCE -${offset}d UNTIL -${offset - 1}d ORDER BY sessions DESC LIMIT 1000`;
  const res = await fetch(
    `https://${creds.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': creds.token },
      body: JSON.stringify({
        query: `query { shopifyqlQuery(query: ${JSON.stringify(query)}) {
          parseErrors
          tableData { rows }
        } }`,
      }),
    },
  );
  if (!res.ok) {
    console.error(`  ShopifyQL ${brand} HTTP ${res.status}`);
    return [];
  }
  const json = await res.json();
  const r = json?.data?.shopifyqlQuery;
  if (!r || (Array.isArray(r.parseErrors) && r.parseErrors.length)) {
    console.error(`  ShopifyQL ${brand} parseErrors:`, r?.parseErrors ?? json?.errors);
    return [];
  }
  const rows = r.tableData?.rows ?? [];
  // Collapse path variants (srsltid/utm collapse to the same path) by summing.
  const byPath = new Map();
  for (const row of rows) {
    const path = normalizePath(row.landing_page_path);
    const sessions = Number(row.sessions) || 0;
    const conv = Number(row.conversion_rate) || 0;
    if (sessions <= 0) continue;
    const cur = byPath.get(path) ?? { sessions: 0, orders: 0 };
    cur.sessions += sessions;
    cur.orders += sessions * conv; // implied orders, to re-weight conv
    byPath.set(path, cur);
  }
  return [...byPath].map(([path, v]) => ({
    path,
    sessions: v.sessions,
    conv: v.sessions > 0 ? v.orders / v.sessions : 0,
  }));
}

// ---------------------------------------------------------------------
// Snowflake MERGE
// ---------------------------------------------------------------------

function connectSnowflake() {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: env('SNOWFLAKE_ACCOUNT'),
      username: env('SNOWFLAKE_USER'),
      password: env('SNOWFLAKE_PASSWORD'),
      role: process.env.SNOWFLAKE_ROLE || 'SYSADMIN',
      warehouse: env('SNOWFLAKE_WAREHOUSE'),
      database: env('SNOWFLAKE_DATABASE'),
      schema: 'SESSIONS',
    });
    conn.connect((err, c) => (err ? reject(err) : resolve(c)));
  });
}

function execute(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

async function mergeRows(conn, brand, date, rows) {
  if (rows.length === 0) return 0;
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(',\n        ');
  const binds = rows.flatMap((r) => [brand, date, r.path, r.sessions, r.conv]);
  const sql = `
    MERGE INTO BOCO_DASHBOARD.SESSIONS.DAILY_SESSIONS t
    USING (
      SELECT
        column1 AS BRAND, column2::DATE AS ACTIVITY_DATE, column3 AS LANDING_PATH,
        column4 AS SESSIONS, column5 AS CONVERSION_RATE
      FROM VALUES
        ${placeholders}
    ) s
    ON t.BRAND = s.BRAND AND t.ACTIVITY_DATE = s.ACTIVITY_DATE AND t.LANDING_PATH = s.LANDING_PATH
    WHEN MATCHED THEN UPDATE SET
      SESSIONS = s.SESSIONS, CONVERSION_RATE = s.CONVERSION_RATE, UPDATED_AT = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT
      (BRAND, ACTIVITY_DATE, LANDING_PATH, SESSIONS, CONVERSION_RATE)
      VALUES (s.BRAND, s.ACTIVITY_DATE, s.LANDING_PATH, s.SESSIONS, s.CONVERSION_RATE)
  `;
  await execute(conn, sql, binds);
  return rows.length;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

function dateForOffset(offset) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

const daysBack = Number(process.env.SESSIONS_SYNC_DAYS_BACK) || 1;
const conn = await connectSnowflake();
let total = 0;
try {
  for (const brand of BRANDS) {
    const creds = await shopCreds(brand);
    if (!creds) {
      console.log(`Skipping ${brand} — no Shopify credentials in Redis`);
      continue;
    }
    for (let offset = 1; offset <= daysBack; offset++) {
      const date = dateForOffset(offset);
      try {
        const rows = await fetchDay(creds, brand, offset);
        const written = await mergeRows(conn, brand, date, rows);
        total += written;
        console.log(`  ${brand} ${date}: ${written} landing pages`);
      } catch (err) {
        console.error(`  FAILED ${brand} ${date}: ${err.message}`);
      }
    }
  }
} finally {
  conn.destroy(() => {});
}
console.log(`Done. Total rows written/updated: ${total}`);
