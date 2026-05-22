// Daily sync: Northbeam Data Export API -> Snowflake
// BOCO_DASHBOARD.NORTHBEAM.DAILY_CHANNEL_METRICS.
//
// One row per (brand, snapshot_date, platform, model, accounting_mode).
// The API is async: POST returns an id, then poll GET /result/<id> until
// the export is ready. We MERGE the parsed result into Snowflake so
// re-running the same day is idempotent.
//
// Default: yesterday's data only. Pass NORTHBEAM_SYNC_DAYS_BACK=N to
// backfill N days of history (sequential, ~30-60s per brand per day).

import snowflake from 'snowflake-sdk';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};

const BRANDS = ['ASN', 'HHH', 'VIV', 'PRL'];
const ATTRIBUTION_MODEL = 'northbeam_custom__va';
const ACCOUNTING_MODE = 'accrual';
const NORTHBEAM_BASE = 'https://api.northbeam.io';

// Metrics we want per row. Keep this list small — each extra metric
// makes the export slower and we only consume a handful in the UI.
const METRICS = ['spend', 'revAttributed', 'txns', 'customersFt', 'newVisits', 'roas'];

// Polling: an export typically takes 5-30 seconds for a small request.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 40; // 40 * 3s = 2 minutes total max

// ---------------------------------------------------------------------
// Northbeam: kick off + poll the async data export
// ---------------------------------------------------------------------

function northbeamCreds(brand) {
  const clientId = process.env[`NORTHBEAM_CLIENT_ID_${brand}`];
  const apiKey = process.env[`NORTHBEAM_API_KEY_${brand}`];
  if (!clientId || !apiKey) {
    throw new Error(`Missing Northbeam creds for ${brand}`);
  }
  return { clientId, apiKey };
}

function northbeamHeaders({ clientId, apiKey }) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Data-Client-ID': clientId,
    Authorization: `Basic ${apiKey}`,
  };
}

async function startExport(brand, snapshotDate) {
  const creds = northbeamCreds(brand);
  const body = {
    period_type: 'FIXED',
    period_options: {
      // Single-day window — we accumulate daily snapshots in Snowflake.
      period_starting_at: `${snapshotDate}T00:00:00Z`,
      period_ending_at: `${snapshotDate}T23:59:59Z`,
    },
    time_granularity: 'DAILY',
    // Aggregating at platform level gives one row per channel — exactly
    // what the panel wants. If this is rejected we'll fall back to
    // a finer level (e.g. campaign) and roll up in JS.
    level: 'platform',
    options: {
      export_aggregation: 'BREAKDOWN',
      remove_zero_spend: false,
      aggregate_data: false,
      include_ids: false,
      include_kind_and_platform: true,
    },
    attribution_options: {
      attribution_models: [ATTRIBUTION_MODEL],
      accounting_modes: [ACCOUNTING_MODE],
      attribution_windows: ['1'],
    },
    metrics: METRICS.map((id) => ({ id })),
  };

  const res = await fetch(`${NORTHBEAM_BASE}/v1/exports/data-export`, {
    method: 'POST',
    headers: northbeamHeaders(creds),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`startExport ${brand} ${snapshotDate} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`startExport ${brand} ${snapshotDate} non-JSON response: ${text.slice(0, 500)}`);
  }
  if (!json.id) throw new Error(`startExport ${brand} ${snapshotDate} no id in response: ${JSON.stringify(json).slice(0, 500)}`);
  return json.id;
}

async function pollExportResult(brand, exportId) {
  const creds = northbeamCreds(brand);
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${NORTHBEAM_BASE}/v1/exports/data-export/result/${exportId}`, {
      method: 'GET',
      headers: northbeamHeaders(creds),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }

    if (attempt === 1 || attempt % 5 === 0) {
      console.log(`  poll #${attempt} status=${res.status} body=${text.slice(0, 500)}`);
    }

    // Northbeam signals "ready" with: finished_at != null AND result is a
    // non-empty array of GCS presigned URLs pointing to CSV files.
    if (
      res.ok &&
      json &&
      json.finished_at &&
      Array.isArray(json.result) &&
      json.result.length > 0
    ) {
      return json;
    }
    if (res.status === 404 || res.status >= 500) {
      throw new Error(`pollExportResult ${brand} ${exportId} fatal: ${res.status} ${text.slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`pollExportResult ${brand} ${exportId} timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
}

// The result object contains presigned URLs to CSV files in GCS.
// Download each, parse, and combine into one rows array.
async function downloadAndParseRows(brand, snapshotDate, result) {
  const urls = result.result;
  let parsedRows = [];
  let headerLogged = false;
  for (const url of urls) {
    console.log(`  downloading export file (${url.split('?')[0].slice(-40)})`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  failed to download: ${res.status}`);
      continue;
    }
    const text = await res.text();
    if (!headerLogged) {
      console.log(`  csv head (first 500 chars): ${text.slice(0, 500)}`);
      headerLogged = true;
    }
    parsedRows = parsedRows.concat(parseCsv(text));
  }

  // Northbeam returns campaign-level rows even when level=platform is
  // requested. Aggregate by breakdown_platform_northbeam (the channel
  // label like "Facebook Ads", "Google Ads", "Amazon - Ads and Organic")
  // so we land at one row per platform per day.
  //
  // ROAS is intentionally recomputed (sum(rev)/sum(spend)) rather than
  // averaged — averaging per-campaign ROAS doesn't weight by spend and
  // gives meaningless numbers when one campaign has tiny spend.
  const byPlatform = new Map();
  for (const r of parsedRows) {
    const platform = r.breakdown_platform_northbeam;
    if (!platform || platform === '') continue;
    const acc = byPlatform.get(platform) ?? {
      SPEND: 0, REV_ATTRIBUTED: 0, TXNS: 0, CUSTOMERS_FT: 0, NEW_VISITS: 0,
    };
    acc.SPEND += numOrZero(r.spend);
    acc.REV_ATTRIBUTED += numOrZero(r.attributed_rev);
    acc.TXNS += numOrZero(r.transactions);
    acc.CUSTOMERS_FT += numOrZero(r.customers_new);
    acc.NEW_VISITS += numOrZero(r.new_visits);
    byPlatform.set(platform, acc);
  }

  const out = [];
  for (const [platform, m] of byPlatform) {
    out.push({
      BRAND: brand,
      SNAPSHOT_DATE: snapshotDate,
      PLATFORM: platform,
      ATTRIBUTION_MODEL,
      ACCOUNTING_MODE,
      SPEND: m.SPEND,
      REV_ATTRIBUTED: m.REV_ATTRIBUTED,
      TXNS: m.TXNS,
      CUSTOMERS_FT: m.CUSTOMERS_FT,
      NEW_VISITS: m.NEW_VISITS,
      ROAS: m.SPEND > 0 ? m.REV_ATTRIBUTED / m.SPEND : null,
    });
  }
  return out;
}

function numOrZero(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Minimal CSV parser: handles quoted fields with embedded commas and
// escaped double-quotes ("").
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    out.push(row);
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ',' && !inQuotes) { out.push(current); current = ''; continue; }
    current += c;
  }
  out.push(current);
  return out;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------
// Snowflake: idempotent MERGE
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
      schema: 'NORTHBEAM',
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

async function mergeRows(conn, rows) {
  if (rows.length === 0) return 0;

  // Multi-row VALUES merge via WITH clause.
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',\n  ');
  const binds = rows.flatMap((r) => [
    r.BRAND, r.SNAPSHOT_DATE, r.PLATFORM, r.ATTRIBUTION_MODEL, r.ACCOUNTING_MODE,
    r.SPEND, r.REV_ATTRIBUTED, r.TXNS, r.CUSTOMERS_FT, r.NEW_VISITS, r.ROAS,
  ]);

  const sql = `
    MERGE INTO BOCO_DASHBOARD.NORTHBEAM.DAILY_CHANNEL_METRICS t
    USING (
      SELECT
        column1 AS BRAND, column2::DATE AS SNAPSHOT_DATE, column3 AS PLATFORM,
        column4 AS ATTRIBUTION_MODEL, column5 AS ACCOUNTING_MODE,
        column6 AS SPEND, column7 AS REV_ATTRIBUTED, column8 AS TXNS,
        column9 AS CUSTOMERS_FT, column10 AS NEW_VISITS, column11 AS ROAS
      FROM VALUES
        ${placeholders}
    ) s
    ON t.BRAND = s.BRAND
      AND t.SNAPSHOT_DATE = s.SNAPSHOT_DATE
      AND t.PLATFORM = s.PLATFORM
      AND t.ATTRIBUTION_MODEL = s.ATTRIBUTION_MODEL
      AND t.ACCOUNTING_MODE = s.ACCOUNTING_MODE
    WHEN MATCHED THEN UPDATE SET
      SPEND = s.SPEND,
      REV_ATTRIBUTED = s.REV_ATTRIBUTED,
      TXNS = s.TXNS,
      CUSTOMERS_FT = s.CUSTOMERS_FT,
      NEW_VISITS = s.NEW_VISITS,
      ROAS = s.ROAS,
      WRITTEN_AT = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT
      (BRAND, SNAPSHOT_DATE, PLATFORM, ATTRIBUTION_MODEL, ACCOUNTING_MODE,
       SPEND, REV_ATTRIBUTED, TXNS, CUSTOMERS_FT, NEW_VISITS, ROAS)
      VALUES
      (s.BRAND, s.SNAPSHOT_DATE, s.PLATFORM, s.ATTRIBUTION_MODEL, s.ACCOUNTING_MODE,
       s.SPEND, s.REV_ATTRIBUTED, s.TXNS, s.CUSTOMERS_FT, s.NEW_VISITS, s.ROAS)
  `;
  await execute(conn, sql, binds);
  return rows.length;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

function daysBack(n) {
  const out = [];
  const now = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const daysBackCount = Number(process.env.NORTHBEAM_SYNC_DAYS_BACK) || 1;
const dates = daysBack(daysBackCount);

const conn = await connectSnowflake();
let totalWritten = 0;
try {
  for (const brand of BRANDS) {
    for (const date of dates) {
      console.log(`Starting export for ${brand} ${date}`);
      try {
        const exportId = await startExport(brand, date);
        console.log(`  exportId=${exportId}`);
        const result = await pollExportResult(brand, exportId);
        const rows = await downloadAndParseRows(brand, date, result);
        const written = await mergeRows(conn, rows);
        console.log(`  wrote ${written} rows for ${brand} ${date}`);
        totalWritten += written;
      } catch (err) {
        console.error(`  FAILED ${brand} ${date}: ${err.message}`);
      }
    }
  }
} finally {
  conn.destroy(() => {});
}
console.log(`Done. Total rows written/updated: ${totalWritten}`);
