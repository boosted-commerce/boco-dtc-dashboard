// Daily sync: SharePoint promo workbook -> Snowflake DW_ANALYTICS.STG.PROMOS.
//
// Strategy: full refresh (TRUNCATE + INSERT). The sheet is the source of
// truth and ~50-200 rows is trivial — MERGE complexity isn't worth it.
//
// Run via .github/workflows/promos-sync.yml (cron) or `node scripts/sync-promos.mjs`
// locally with env vars set in .env (and dotenv loaded ahead of this).

import snowflake from 'snowflake-sdk';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};

// Brands the dashboard knows about. Rows with any other BRAND value are
// dropped (we still log them so unrecognized brands surface in CI logs).
const KNOWN_BRANDS = new Set(['ASN', 'HHH', 'VIV', 'PRL']);

// ---------------------------------------------------------------------
// Microsoft Graph: client-credentials token + Excel workbook read
// ---------------------------------------------------------------------

async function getGraphToken() {
  const body = new URLSearchParams({
    client_id: env('GRAPH_CLIENT_ID'),
    client_secret: env('GRAPH_CLIENT_SECRET'),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${env('GRAPH_TENANT_ID')}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
  );
  if (!res.ok) throw new Error(`Graph token failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

// Convert a SharePoint share URL to the Graph /shares/{id} addressing
// scheme. See https://learn.microsoft.com/graph/api/shares-get
function encodeShareUrl(url) {
  const b64 = Buffer.from(url).toString('base64')
    .replace(/=+$/, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-');
  return 'u!' + b64;
}

async function fetchPromoRows(token) {
  const shareId = encodeShareUrl(env('SHAREPOINT_FILE_URL'));

  // Resolve the shared URL to a driveItem so we can use the workbook API.
  const itemRes = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!itemRes.ok) throw new Error(`Graph driveItem failed: ${itemRes.status} ${await itemRes.text()}`);
  const item = await itemRes.json();
  const driveId = item.parentReference?.driveId;
  const itemId = item.id;
  if (!driveId || !itemId) throw new Error('driveItem missing parentReference.driveId or id');

  // Read the used range of the named worksheet. valuesOnly=true returns
  // computed values (not formulas) as a 2D array.
  const sheetName = process.env.PROMOS_SHEET_NAME || 'Sheet1';
  const rangeRes = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}` +
    `/workbook/worksheets('${encodeURIComponent(sheetName)}')/usedRange(valuesOnly=true)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!rangeRes.ok) throw new Error(`Graph usedRange failed: ${rangeRes.status} ${await rangeRes.text()}`);
  const range = await rangeRes.json();

  const values = Array.isArray(range.values) ? range.values : [];
  if (values.length < 2) return []; // header only or empty

  // Skip the header row. Column order is fixed: A=Brand, B=Promo Name,
  // C=Description, D=Start, E=End, F=Code, G=Discount Type, H=Applies To.
  const rows = values.slice(1);
  const out = [];
  const unknownBrands = new Set();
  for (const r of rows) {
    const brandRaw = String(r[0] ?? '').trim().toUpperCase();
    if (!brandRaw) continue;
    if (!KNOWN_BRANDS.has(brandRaw)) { unknownBrands.add(brandRaw); continue; }
    const promoName = String(r[1] ?? '').trim();
    if (!promoName) continue;
    out.push({
      BRAND: brandRaw,
      PROMO_NAME: promoName,
      PROMO_DESCRIPTION: String(r[2] ?? '').trim() || null,
      START_DATE: toISODate(r[3]),
      END_DATE:   toISODate(r[4]),
      PROMO_CODE: String(r[5] ?? '').trim() || null,
      DISCOUNT_TYPE: String(r[6] ?? '').trim() || null,
      APPLIES_TO: String(r[7] ?? '').trim() || null,
    });
  }
  if (unknownBrands.size > 0) {
    console.warn(`Skipped rows with unrecognized BRAND values: ${[...unknownBrands].join(', ')}`);
  }
  return out;
}

// Excel cells (valuesOnly=true) come back as a number (serial date) when
// the cell is formatted as Date, or as a string otherwise. Handle both.
function toISODate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    // Excel serial day count: days since 1899-12-30 (off-by-2 vs Unix
    // epoch + Lotus 1-2-3's 1900 leap-year bug, which Excel preserves).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const d = new Date(String(v));
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// ---------------------------------------------------------------------
// Snowflake: connect, replace contents of PROMOS table
// ---------------------------------------------------------------------

function connectSnowflake() {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: env('SNOWFLAKE_ACCOUNT'),
      username: env('SNOWFLAKE_USER'),
      password: env('SNOWFLAKE_PASSWORD'),
      role: env('SNOWFLAKE_ROLE'),
      warehouse: env('SNOWFLAKE_WAREHOUSE'),
      database: env('SNOWFLAKE_DATABASE'),
      schema: env('SNOWFLAKE_SCHEMA'),
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

async function writeToSnowflake(rows) {
  const conn = await connectSnowflake();
  try {
    await execute(conn, 'BEGIN', undefined);
    await execute(conn, 'TRUNCATE TABLE PROMOS', undefined);
    if (rows.length > 0) {
      // snowflake-sdk doesn't support array-of-arrays binds against
      // multi-row VALUES, so we expand placeholders manually.
      const placeholders = rows
        .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())')
        .join(',\n');
      const binds = rows.flatMap((r) => [
        r.BRAND, r.PROMO_NAME, r.PROMO_DESCRIPTION,
        r.START_DATE, r.END_DATE,
        r.PROMO_CODE, r.DISCOUNT_TYPE, r.APPLIES_TO,
      ]);
      await execute(
        conn,
        `INSERT INTO PROMOS
           (BRAND, PROMO_NAME, PROMO_DESCRIPTION, START_DATE, END_DATE,
            PROMO_CODE, DISCOUNT_TYPE, APPLIES_TO, UPDATED_AT)
         VALUES ${placeholders}`,
        binds,
      );
    }
    await execute(conn, 'COMMIT', undefined);
  } catch (err) {
    try { await execute(conn, 'ROLLBACK', undefined); } catch {}
    throw err;
  } finally {
    conn.destroy(() => {});
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

const token = await getGraphToken();
const rows = await fetchPromoRows(token);
console.log(`Fetched ${rows.length} valid promo rows from SharePoint`);
await writeToSnowflake(rows);
console.log(`Wrote ${rows.length} rows to DW_ANALYTICS.STG.PROMOS`);
