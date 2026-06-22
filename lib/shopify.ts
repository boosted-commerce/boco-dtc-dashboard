import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';
import { withCache } from '@/lib/cache';
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

// --- Live "today so far" figures -------------------------------------
// Orders/revenue come from the Orders API (real-time, read_orders scope).
// Sessions/conv come from ShopifyQL (day-grained, lags a few hours). All
// best-effort: null on missing creds / API error.

// Generic Admin GraphQL call (mirrors runShopifyQL's auth).
async function runAdminGraphQL(
  brand: Brand,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
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
        body: JSON.stringify({ query, variables: variables ?? {} }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      console.error(`Shopify Admin GQL ${brand} HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown };
    if (json.errors) {
      console.error(`Shopify Admin GQL ${brand} errors:`, json.errors);
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    console.error(`Shopify Admin GQL ${brand} threw:`, err);
    return null;
  }
}

// Start-of-today in the shop's timezone as an ISO string with offset
// (e.g. "2026-06-14T00:00:00-07:00") for the Orders created_at filter.
async function shopStartOfTodayIso(brand: Brand): Promise<string> {
  const now = new Date();
  let tz = 'UTC';
  const data = await runAdminGraphQL(brand, `query { shop { ianaTimezone } }`);
  const shop = data?.shop as { ianaTimezone?: string } | undefined;
  if (shop?.ianaTimezone) tz = shop.ianaTimezone;
  try {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now); // YYYY-MM-DD in the shop's tz
    const tzName =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
    const offset = tzName.replace('GMT', '') || '+00:00';
    return `${date}T00:00:00${offset}`;
  } catch {
    return `${now.toISOString().slice(0, 10)}T00:00:00+00:00`;
  }
}

export type TodayOrders = {
  orders: number;
  revenue: number;
  // Subscription split, auto-detected from Recharge signals (app/tags/
  // sourceName). Best-effort — verify via /api/debug/today.
  subOrders: number;
  subRevenue: number;
  recurringOrders: number;
  recurringRevenue: number;
  newSubOrders: number;
  newSubRevenue: number;
};

type RawOrderNode = {
  test?: boolean;
  tags?: string[] | null;
  sourceName?: string | null;
  app?: { name?: string | null } | null;
  currentTotalPriceSet?: { shopMoney?: { amount?: string } } | null;
};

// Classify an order's subscription status from Recharge signals.
function classifyOrder(o: RawOrderNode): { isSub: boolean; isRecurring: boolean } {
  const tags = (o.tags ?? []).join(' ').toLowerCase();
  const app = (o.app?.name ?? '').toLowerCase();
  const src = (o.sourceName ?? '').toLowerCase();
  const isSub =
    app.includes('recharge') ||
    tags.includes('subscription') ||
    src.includes('subscription');
  // Recurring (renewal) vs first/new sign-up.
  const isRecurring = isSub && (tags.includes('recurring') || tags.includes('renewal'));
  return { isSub, isRecurring };
}

const ORDER_FIELDS = `test sourceName tags app{ name } currentTotalPriceSet{ shopMoney{ amount } }`;

// Today's non-test orders + revenue (all channels), live from the Orders
// API, with an auto-detected subscription split. Paginates (capped).
export async function getTodayOrders(
  brand: Brand,
  source: 'all' | 'dtc' = 'all',
): Promise<TodayOrders | null> {
  const startIso = await shopStartOfTodayIso(brand);
  const q = `created_at:>='${startIso}'`;
  let cursor: string | null = null;
  const t: TodayOrders = {
    orders: 0,
    revenue: 0,
    subOrders: 0,
    subRevenue: 0,
    recurringOrders: 0,
    recurringRevenue: 0,
    newSubOrders: 0,
    newSubRevenue: 0,
  };
  let pages = 0;
  let any = false;
  do {
    const data: Record<string, unknown> | null = await runAdminGraphQL(
      brand,
      `query($q:String!,$cursor:String){
        orders(first:250, after:$cursor, query:$q, sortKey:CREATED_AT){
          pageInfo{ hasNextPage endCursor }
          nodes{ ${ORDER_FIELDS} }
        }
      }`,
      { q, cursor },
    );
    const conn = data?.orders as
      | { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: RawOrderNode[] }
      | undefined;
    if (!conn) break;
    any = true;
    for (const o of conn.nodes ?? []) {
      if (o.test) continue;
      // DTC-only toggle → count just online-store ('web') orders, matching
      // the Snowflake SOURCE_NAME = 'web' definition.
      if (source === 'dtc' && (o.sourceName ?? '').toLowerCase() !== 'web') continue;
      const amt = Number(o.currentTotalPriceSet?.shopMoney?.amount ?? 0) || 0;
      t.orders += 1;
      t.revenue += amt;
      const { isSub, isRecurring } = classifyOrder(o);
      if (isSub) {
        t.subOrders += 1;
        t.subRevenue += amt;
        if (isRecurring) {
          t.recurringOrders += 1;
          t.recurringRevenue += amt;
        } else {
          t.newSubOrders += 1;
          t.newSubRevenue += amt;
        }
      }
    }
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor ?? null : null;
    pages += 1;
  } while (cursor && pages < 12);
  return any ? t : null;
}

// Sample of today's orders with their raw subscription signals — for the
// debug route to verify auto-detection against real data.
export async function getTodayOrdersSample(
  brand: Brand,
): Promise<Array<{ tags: string[]; app: string; sourceName: string; isSub: boolean; isRecurring: boolean }>> {
  const startIso = await shopStartOfTodayIso(brand);
  const data = await runAdminGraphQL(
    brand,
    `query($q:String!){ orders(first:25, query:$q, sortKey:CREATED_AT, reverse:true){ nodes{ ${ORDER_FIELDS} } } }`,
    { q: `created_at:>='${startIso}'` },
  );
  const nodes = (data?.orders as { nodes?: RawOrderNode[] } | undefined)?.nodes ?? [];
  return nodes.map((o) => {
    const c = classifyOrder(o);
    return {
      tags: o.tags ?? [],
      app: o.app?.name ?? '',
      sourceName: o.sourceName ?? '',
      isSub: c.isSub,
      isRecurring: c.isRecurring,
    };
  });
}

export type TodaySessions = { sessions: number; convRate: number };

// Today's sessions + conversion rate from ShopifyQL (may lag a few hours).
export async function getTodaySessions(brand: Brand): Promise<TodaySessions | null> {
  const table = await runShopifyQL(
    brand,
    `FROM sessions SHOW sessions, conversion_rate DURING today`,
  );
  const row = table?.rows?.[0];
  if (!row) return null;
  const sessions = Number(row.sessions) || 0;
  const convRate = (Number(row.conversion_rate) || 0) * 100;
  return { sessions, convRate };
}

// --- Exact storefront page titles ------------------------------------
// Resolve a landing path → its real Shopify title (product/collection/
// page), so Layer 2 can show "Copper Peptides Serum" instead of a slug.
// Requires read_products + read_content scopes (re-auth). Returns null on
// missing scope / not found → caller falls back to a slug-derived title.

async function fetchTitleForPath(brand: Brand, path: string): Promise<string | null> {
  const segs = path.split('?')[0].split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const type = segs[0];
  const handle = segs[segs.length - 1];
  const field =
    type === 'products' ? 'products' : type === 'collections' ? 'collections' : type === 'pages' ? 'pages' : null;
  if (!field) return null;
  const data = await runAdminGraphQL(
    brand,
    `query($q:String!){ ${field}(first:1, query:$q){ nodes{ title } } }`,
    { q: `handle:${handle}` },
  );
  const conn = data?.[field] as { nodes?: Array<{ title?: string }> } | undefined;
  return conn?.nodes?.[0]?.title ?? null;
}

// Map of path → exact title for the given paths. Cached 7 days per path
// (titles rarely change); unresolved paths are simply omitted.
export async function getPageTitles(
  brand: Brand,
  paths: string[],
): Promise<Record<string, string>> {
  const uniq = [...new Set(paths)];
  const entries = await Promise.all(
    uniq.map(async (p) => {
      if (p === '/') return [p, 'Home'] as const;
      const title = await withCache(
        `title:${brand}:${encodeURIComponent(p)}:v1`,
        7 * 24 * 60 * 60,
        () => fetchTitleForPath(brand, p),
      ).catch(() => null);
      return [p, title] as const;
    }),
  );
  const out: Record<string, string> = {};
  for (const [p, t] of entries) if (t) out[p] = t;
  return out;
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

// Source breakdown for a single landing page. ShopifyQL's sessions
// table doesn't expose device info (confirmed via probe — device_type,
// device_category, device, client_type all return "Column Not Found"),
// so this is source-only. Used by the Layer 3 deep-dive view to show
// where conversion concentrates (e.g. "Meta: 3,200 sessions @ 0.4%
// vs Direct: 1,400 @ 2.8%").
export type SourceBreakdownRow = {
  source: string;
  sessions: number;
  convRate: number; // percent
  priorSessions: number;
  priorConvRate: number;
};

export async function getSourceByPath(
  brand: Brand,
  path: string,
  period: Period,
): Promise<SourceBreakdownRow[]> {
  const [cur, prior] = await Promise.all([
    runShopifyQL(
      brand,
      `FROM sessions SHOW sessions, conversion_rate GROUP BY referrer_source, landing_page_path SINCE -${period}d UNTIL today ORDER BY sessions DESC LIMIT 1000`,
    ),
    runShopifyQL(
      brand,
      `FROM sessions SHOW sessions, conversion_rate GROUP BY referrer_source, landing_page_path SINCE -${period * 2}d UNTIL -${period}d ORDER BY sessions DESC LIMIT 1000`,
    ),
  ]);
  if (!cur) return [];

  const accumulate = (
    table: { rows: RawRow[] } | null,
  ): Map<string, { sessions: number; ordersImplied: number }> => {
    const map = new Map<string, { sessions: number; ordersImplied: number }>();
    if (!table) return map;
    for (const r of table.rows) {
      const rowPath = String(r.landing_page_path ?? '');
      if (rowPath !== path) continue;
      const source = String(r.referrer_source ?? '(direct)');
      const sessions = Number(r.sessions) || 0;
      const cr = Number(r.conversion_rate) || 0;
      const existing = map.get(source) ?? { sessions: 0, ordersImplied: 0 };
      existing.sessions += sessions;
      existing.ordersImplied += sessions * cr;
      map.set(source, existing);
    }
    return map;
  };

  const curMap = accumulate(cur);
  const priorMap = accumulate(prior);

  const rows: SourceBreakdownRow[] = [];
  for (const [source, c] of curMap) {
    const p = priorMap.get(source) ?? { sessions: 0, ordersImplied: 0 };
    rows.push({
      source,
      sessions: c.sessions,
      convRate: c.sessions > 0 ? (c.ordersImplied / c.sessions) * 100 : 0,
      priorSessions: p.sessions,
      priorConvRate: p.sessions > 0 ? (p.ordersImplied / p.sessions) * 100 : 0,
    });
  }
  rows.sort((a, b) => b.sessions - a.sessions);
  return rows;
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
