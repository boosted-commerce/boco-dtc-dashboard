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
  const query = `FROM sessions SHOW sessions, conversion_rate GROUP BY landing_page_url SINCE -${period}d UNTIL today ORDER BY sessions DESC LIMIT 250`;
  const tableData = await runShopifyQL(brand, query);
  if (!tableData) return new Map();

  // Aggregate sessions + implied orders across all URL variants that map to
  // the same path. conv_rate = sum(orders) / sum(sessions) after merging
  // — averaging conv_rate directly would weight all variants equally
  // regardless of traffic volume.
  const merged = new Map<string, { sessions: number; orders: number }>();
  for (const row of tableData.rows) {
    const url = String(row.landing_page_url ?? '');
    if (!url) continue;
    const path = normalizeShopifyUrl(url);
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
