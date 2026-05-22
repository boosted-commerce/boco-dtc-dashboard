import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';
import type { Brand, Period } from '@/lib/queries/orders';

// ShopifyQL client. Reads per-brand OAuth tokens from KV (populated by
// /api/shopify/callback) and runs analytics queries against each store's
// Admin GraphQL endpoint.
//
// All returns are tolerant of missing credentials (brand not yet installed)
// or API errors — they yield an empty Map so the dashboard renders with
// "—" placeholders instead of 500-ing the whole page.

type ColumnDef = { name: string; dataType: string };
type RawRow = Record<string, string>;
type TableData = { columns: ColumnDef[]; rows: RawRow[] };

async function runShopifyQL(brand: Brand, query: string): Promise<TableData | null> {
  const creds = await getShopifyCredentials(brand);
  if (!creds) return null;
  try {
    const res = await fetch(
      `https://${creds.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Shopify-Access-Token': creds.token,
        },
        body: JSON.stringify({
          query: `query { shopifyqlQuery(query: ${JSON.stringify(query)}) {
            parseErrors
            tableData { columns { name dataType } rows }
          } }`,
        }),
        // Server-Component fetches default to caching; force fresh data
        // so dashboard reflects current Shopify state.
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      console.error(`Shopify GQL ${brand} HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: { shopifyqlQuery?: { parseErrors?: string[]; tableData?: TableData } };
      errors?: unknown;
    };
    if (json.errors) {
      console.error(`Shopify GQL ${brand} errors:`, json.errors);
      return null;
    }
    const r = json.data?.shopifyqlQuery;
    if (!r) return null;
    if (Array.isArray(r.parseErrors) && r.parseErrors.length > 0) {
      console.error(`ShopifyQL parse errors ${brand}:`, r.parseErrors);
      return null;
    }
    return r.tableData ?? null;
  } catch (err) {
    console.error(`Shopify GQL ${brand} threw:`, err);
    return null;
  }
}

// Strip protocol + host + query string + fragment so a ShopifyQL
// landing_page_url ("https://www.asterwood.co/products/foo?srsltid=...")
// reduces to the Snowflake-style path ("/products/foo") that the rest of
// the dashboard uses as a key.
export function normalizeShopifyUrl(raw: string): string {
  if (!raw) return '/';
  try {
    const url = new URL(raw);
    let path = url.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
    return path;
  } catch {
    // Already a path; strip query/fragment defensively.
    let p = raw.split('?')[0].split('#')[0];
    if (!p.startsWith('/')) p = '/' + p;
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
    return p;
  }
}

export type PageSessions = { sessions: number; convRate: number };

// Sessions + conversion rate per normalized landing path, merged across
// URL variants (the same page with different srsltid/utm params collapses
// into one entry, weighted properly by sessions).
export async function getSessionsByPath(
  brand: Brand,
  period: Period,
): Promise<Map<string, PageSessions>> {
  // landing_page_path collapses query-string variants (notably Google
  // Shopping's srsltid) on Shopify's side BEFORE LIMIT applies — using
  // landing_page_url instead created hundreds of single-session srsltid
  // rows per page, most of which fell off the long-tail cutoff.
  const query = `FROM sessions SHOW sessions, conversion_rate GROUP BY landing_page_path SINCE -${period}d UNTIL today ORDER BY sessions DESC LIMIT 250`;
  const tableData = await runShopifyQL(brand, query);
  if (!tableData) return new Map();

  // Light JS-side normalization is still defensive (handles trailing
  // slashes, missing leading slash, etc.) even though Shopify gives us
  // clean paths. conv_rate = sum(orders) / sum(sessions) so we weight
  // by traffic when multiple rows happen to share a normalized path.
  const merged = new Map<string, { sessions: number; orders: number }>();
  for (const row of tableData.rows) {
    const raw = String(row.landing_page_path ?? '');
    if (!raw) continue;
    const path = normalizeShopifyUrl(raw);
    const sessions = Number(row.sessions) || 0;
    const convRateDecimal = Number(row.conversion_rate) || 0;
    const ordersAttributable = sessions * convRateDecimal;
    const existing = merged.get(path);
    if (existing) {
      existing.sessions += sessions;
      existing.orders += ordersAttributable;
    } else {
      merged.set(path, { sessions, orders: ordersAttributable });
    }
  }

  const out = new Map<string, PageSessions>();
  for (const [path, { sessions, orders }] of merged) {
    out.set(path, {
      sessions,
      // Convert decimal back to percent (0.0125 → 1.25)
      convRate: sessions > 0 ? (orders / sessions) * 100 : 0,
    });
  }
  return out;
}

// Brand-wide totals: sum of sessions and overall conversion rate across
// the whole store for the period. Used by the Layer 1 Sessions card.
export type BrandSessions = {
  sessions: number;
  convRate: number; // percent
};

export async function getBrandSessions(
  brand: Brand,
  period: Period,
): Promise<BrandSessions | null> {
  const query = `FROM sessions SHOW sessions, conversion_rate SINCE -${period}d UNTIL today`;
  const tableData = await runShopifyQL(brand, query);
  if (!tableData || tableData.rows.length === 0) return null;
  const row = tableData.rows[0];
  const sessions = Number(row.sessions) || 0;
  const convRateDecimal = Number(row.conversion_rate) || 0;
  return { sessions, convRate: convRateDecimal * 100 };
}

// Sessions broken down by traffic source + campaign. ShopifyQL's
// referrer_source maps to utm_source (e.g. "facebook", "google",
// "(direct)") and referrer_name maps to utm_campaign (e.g. "ASN | Copper
// Peptides | US | ABO | Testing | 2026") — so a single Meta campaign
// shows as its own row, which the order-based attribution can't see when
// the campaign has zero conversions.
export type ChannelSessionRow = {
  source: string;
  name: string;
  sessions: number;
  convRate: number; // percent
  priorSessions: number;
};

// Daily sessions + conversion-rate timeseries from ShopifyQL. One query
// covers the entire year-back window so the Layer 1 cards can derive
// every comparison bucket (current / prior / yesterday / 7-day / year ago)
// in JS without N additional API calls.
export type SessionDailyPoint = {
  date: string; // YYYY-MM-DD
  sessions: number;
  // Orders implied for this day (sessions × conv_rate). Re-summed across
  // a window to compute weighted conv rate without averaging percents.
  ordersImplied: number;
};

export async function getSessionTimeSeries(
  brand: Brand,
  days: number,
): Promise<SessionDailyPoint[]> {
  const tableData = await runShopifyQL(
    brand,
    `FROM sessions SHOW sessions, conversion_rate TIMESERIES day SINCE -${days}d UNTIL today ORDER BY day`,
  );
  if (!tableData) return [];
  return tableData.rows.map((r) => {
    const sessions = Number(r.sessions) || 0;
    const convRateDec = Number(r.conversion_rate) || 0;
    return {
      date: String(r.day ?? '').slice(0, 10),
      sessions,
      ordersImplied: sessions * convRateDec,
    };
  });
}

export async function getChannelSessions(
  brand: Brand,
  period: Period,
): Promise<ChannelSessionRow[]> {
  const [current, prior] = await Promise.all([
    runShopifyQL(
      brand,
      `FROM sessions SHOW sessions, conversion_rate GROUP BY referrer_source, referrer_name SINCE -${period}d UNTIL today ORDER BY sessions DESC LIMIT 50`,
    ),
    runShopifyQL(
      brand,
      `FROM sessions SHOW sessions GROUP BY referrer_source, referrer_name SINCE -${period * 2}d UNTIL -${period}d ORDER BY sessions DESC LIMIT 100`,
    ),
  ]);

  if (!current) return [];

  const priorMap = new Map<string, number>();
  if (prior) {
    for (const r of prior.rows) {
      const source = String(r.referrer_source ?? '(none)');
      const name = String(r.referrer_name ?? '');
      priorMap.set(`${source}|${name}`, Number(r.sessions) || 0);
    }
  }

  return current.rows.map((r) => {
    const source = String(r.referrer_source ?? '(none)');
    const name = String(r.referrer_name ?? '');
    return {
      source,
      name,
      sessions: Number(r.sessions) || 0,
      convRate: (Number(r.conversion_rate) || 0) * 100,
      priorSessions: priorMap.get(`${source}|${name}`) ?? 0,
    };
  });
}
