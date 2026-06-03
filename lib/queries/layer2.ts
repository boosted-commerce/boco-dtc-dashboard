import { execute } from '@/lib/snowflake';
import { withCache } from '@/lib/cache';
import type { Brand, DailyPoint, Period } from '@/lib/queries/orders';
import { getWatchedPaths, getHiddenPaths } from '@/lib/watched-store';
import { getChannelSessions, getSessionsByPath } from '@/lib/shopify';

// Layer 2 — page-/product-/source-level tables below Level 1. Each function
// returns the top N rows for the selected period with a daily-revenue series
// per row for the inline sparkline. Calendar-day boundaries match Layer 1:
// current period = last N complete days ending end-of-yesterday; prior period
// = the N days before that.

const n = (v: unknown) => Number(v ?? 0);
const TOP_LIMIT = 100;

export type Layer2Row = {
  key: string;
  label: string;
  sublabel?: string;
  currentRevenue: number;
  priorRevenue: number;
  currentCount: number;
  countNoun: 'orders' | 'units';
  daily: DailyPoint[];
  // Optional: subscription-flagged order count (IS_SUBSCRIPTION = TRUE).
  // Pulled out so the main `currentCount` is comparable to Shopify's
  // session-based conv rate (subscriptions / renewals don't have sessions).
  subCount?: number;
  // Optional ShopifyQL-sourced session metrics. Undefined for rows whose
  // key isn't a path (e.g. Top Products by Sales uses product titles) or
  // brands without a Shopify install.
  sessions?: number;
  convRate?: number; // percent (0-100)
  priorSessions?: number; // for sessions-based trend on attribution rows
};

type RawRow = {
  KEY: string | null;
  LABEL: string | null;
  SUBLABEL: string | null;
  CURRENT_REVENUE: number | string | null;
  PRIOR_REVENUE: number | string | null;
  CURRENT_COUNT: number | string | null;
  CURRENT_SUB_COUNT: number | string | null;
  DAILY_JSON: string | null;
};

const parseDaily = (raw: string | null): DailyPoint[] => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ d: string; v: number | string | null }>;
    return arr.map((p) => ({ date: p.d, value: n(p.v) }));
  } catch {
    return [];
  }
};

const toRow = (r: RawRow, countNoun: 'orders' | 'units'): Layer2Row => ({
  key: r.KEY ?? '(unknown)',
  label: r.LABEL ?? '(untitled)',
  sublabel: r.SUBLABEL ?? undefined,
  currentRevenue: n(r.CURRENT_REVENUE),
  priorRevenue: n(r.PRIOR_REVENUE),
  currentCount: n(r.CURRENT_COUNT),
  subCount: r.CURRENT_SUB_COUNT !== undefined && r.CURRENT_SUB_COUNT !== null
    ? n(r.CURRENT_SUB_COUNT)
    : undefined,
  countNoun,
  daily: parseDaily(r.DAILY_JSON),
});

export async function getWatchedPages(brand: Brand, period: Period): Promise<Layer2Row[]> {
  const watched = await getWatchedPaths(brand);
  if (watched.length === 0) return [];
  // LEFT JOIN against a watched(path) virtual table so pages with no orders
  // in the period still render (as $0 rows) — that's signal too, not noise.
  // Use UNION ALL since Snowflake's VALUES inside a WITH clause is finicky.
  const watchedCte = watched
    .map((_, i) => (i === 0 ? '        SELECT ? AS path' : '        UNION ALL SELECT ?'))
    .join('\n');
  const rows = await execute<RawRow>(
    `
      WITH bounds AS (
        SELECT
          DATE_TRUNC('day', CURRENT_TIMESTAMP()) AS today_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS current_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS prior_start
      ),
      watched AS (
${watchedCte}
      ),
      classified AS (
        SELECT
          SPLIT_PART(o.LANDING_SITE, '?', 1) AS landing_path,
          o.CREATED_AT,
          o.TOTAL_PRICE_AMOUNT,
          COALESCE(o.IS_SUBSCRIPTION, FALSE) AS is_subscription
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o, bounds b
        WHERE o.BRAND = ?
          AND o.SOURCE_NAME = 'web'
          AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
          AND o.CREATED_AT >= b.prior_start
          AND o.CREATED_AT < b.today_start
          AND SPLIT_PART(o.LANDING_SITE, '?', 1) IN (SELECT path FROM watched)
      ),
      aggregates AS (
        SELECT
          w.path AS landing_path,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.current_start AND NOT c.is_subscription, 1, 0)), 0) AS current_count,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.current_start AND c.is_subscription, 1, 0)), 0) AS current_sub_count,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.current_start, c.TOTAL_PRICE_AMOUNT, 0)), 0) AS current_revenue,
          COALESCE(SUM(IFF(c.CREATED_AT < b.current_start, c.TOTAL_PRICE_AMOUNT, 0)), 0) AS prior_revenue
        FROM watched w
        LEFT JOIN classified c ON c.landing_path = w.path
        , bounds b
        GROUP BY w.path
      ),
      daily AS (
        SELECT
          c.landing_path,
          TO_VARCHAR(DATE(c.CREATED_AT), 'YYYY-MM-DD') AS d,
          SUM(c.TOTAL_PRICE_AMOUNT) AS v
        FROM classified c, bounds b
        WHERE c.CREATED_AT >= b.current_start
        GROUP BY c.landing_path, DATE(c.CREATED_AT)
      ),
      sparklines AS (
        SELECT
          landing_path,
          ARRAY_AGG(OBJECT_CONSTRUCT('d', d, 'v', v)) WITHIN GROUP (ORDER BY d) AS daily_series
        FROM daily
        GROUP BY landing_path
      )
      SELECT
        a.landing_path AS KEY,
        a.landing_path AS LABEL,
        NULL AS SUBLABEL,
        a.current_revenue AS CURRENT_REVENUE,
        a.prior_revenue AS PRIOR_REVENUE,
        a.current_count AS CURRENT_COUNT,
        a.current_sub_count AS CURRENT_SUB_COUNT,
        TO_VARCHAR(s.daily_series) AS DAILY_JSON
      FROM aggregates a
      LEFT JOIN sparklines s ON a.landing_path = s.landing_path
      ORDER BY a.current_revenue DESC NULLS LAST
    `,
    [period, period * 2, ...watched, brand],
  );
  return rows.map((r) => toRow(r, 'orders'));
}

// Pages filtered by URL pattern (e.g. '/products/%' for PDPs, '/collections/%'
// for collections, '/pages/%' for CMS landing pages). Returns top-by-revenue
// in the selected period with daily-revenue sparklines per row.
async function getPagesByType(
  brand: Brand,
  period: Period,
  pathPattern: string,
): Promise<Layer2Row[]> {
  // Paths the team has explicitly hidden (stale / deleted / parked pages).
  // Excluded at the SQL level so a hidden row is replaced by the next real
  // page rather than leaving a gap in the top-N. Reversible via Restore.
  const hidden = await getHiddenPaths(brand);
  const hiddenClause = hidden.length
    ? `AND SPLIT_PART(o.LANDING_SITE, '?', 1) NOT IN (${hidden.map(() => '?').join(', ')})`
    : '';
  const rows = await execute<RawRow>(
    `
      WITH bounds AS (
        SELECT
          DATE_TRUNC('day', CURRENT_TIMESTAMP()) AS today_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS current_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS prior_start
      ),
      classified AS (
        SELECT
          SPLIT_PART(o.LANDING_SITE, '?', 1) AS landing_path,
          o.CREATED_AT,
          o.TOTAL_PRICE_AMOUNT,
          COALESCE(o.IS_SUBSCRIPTION, FALSE) AS is_subscription
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o, bounds b
        WHERE o.BRAND = ?
          AND o.SOURCE_NAME = 'web'
          AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
          AND o.CREATED_AT >= b.prior_start
          AND o.CREATED_AT < b.today_start
          AND o.LANDING_SITE IS NOT NULL
          AND SPLIT_PART(o.LANDING_SITE, '?', 1) LIKE ?
          ${hiddenClause}
          AND o.LANDING_SITE NOT LIKE '%/online_store_preview%'
          AND o.LANDING_SITE NOT LIKE '%/checkouts/sessions/clone%'
          AND o.LANDING_SITE NOT LIKE '%/cart/update.js%'
      ),
      aggregates AS (
        SELECT
          c.landing_path,
          -- One-time / first-purchase orders (comparable to session conv rate)
          SUM(IFF(c.CREATED_AT >= b.current_start AND NOT c.is_subscription, 1, 0)) AS current_count,
          -- Subscription orders (sign-ups + renewals). Renewals don't generate
          -- sessions so we surface them separately to keep conv rate sensible.
          SUM(IFF(c.CREATED_AT >= b.current_start AND c.is_subscription, 1, 0)) AS current_sub_count,
          SUM(IFF(c.CREATED_AT >= b.current_start, c.TOTAL_PRICE_AMOUNT, 0)) AS current_revenue,
          SUM(IFF(c.CREATED_AT < b.current_start, c.TOTAL_PRICE_AMOUNT, 0)) AS prior_revenue
        FROM classified c, bounds b
        GROUP BY c.landing_path
        HAVING SUM(IFF(c.CREATED_AT >= b.current_start, 1, 0)) > 0
        ORDER BY current_revenue DESC NULLS LAST
        LIMIT ${TOP_LIMIT}
      ),
      daily AS (
        SELECT
          c.landing_path,
          TO_VARCHAR(DATE(c.CREATED_AT), 'YYYY-MM-DD') AS d,
          SUM(c.TOTAL_PRICE_AMOUNT) AS v
        FROM classified c, bounds b
        WHERE c.CREATED_AT >= b.current_start
          AND c.landing_path IN (SELECT landing_path FROM aggregates)
        GROUP BY c.landing_path, DATE(c.CREATED_AT)
      ),
      sparklines AS (
        SELECT
          landing_path,
          ARRAY_AGG(OBJECT_CONSTRUCT('d', d, 'v', v)) WITHIN GROUP (ORDER BY d) AS daily_series
        FROM daily
        GROUP BY landing_path
      )
      SELECT
        a.landing_path AS KEY,
        a.landing_path AS LABEL,
        NULL AS SUBLABEL,
        a.current_revenue AS CURRENT_REVENUE,
        a.prior_revenue AS PRIOR_REVENUE,
        a.current_count AS CURRENT_COUNT,
        a.current_sub_count AS CURRENT_SUB_COUNT,
        TO_VARCHAR(s.daily_series) AS DAILY_JSON
      FROM aggregates a
      LEFT JOIN sparklines s USING (landing_path)
      ORDER BY a.current_revenue DESC NULLS LAST
    `,
    [period, period * 2, brand, pathPattern, ...hidden],
  );
  return rows.map((r) => toRow(r, 'orders'));
}

export const getPDPs = (brand: Brand, period: Period) =>
  getPagesByType(brand, period, '/products/%');
export const getCollections = (brand: Brand, period: Period) =>
  getPagesByType(brand, period, '/collections/%');
export const getCMSPages = (brand: Brand, period: Period) =>
  getPagesByType(brand, period, '/pages/%');

export async function getTopProductsBySales(
  brand: Brand,
  period: Period,
): Promise<Layer2Row[]> {
  const rows = await execute<RawRow>(
    `
      WITH bounds AS (
        SELECT
          DATE_TRUNC('day', CURRENT_TIMESTAMP()) AS today_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS current_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS prior_start
      ),
      base AS (
        SELECT
          li.TITLE AS product,
          li.QUANTITY,
          li.PRICE_AMOUNT,
          o.CREATED_AT
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS_ITEMS li
        JOIN DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o ON li.ORDER_ID = o.ID
        , bounds b
        WHERE o.BRAND = ?
          AND o.SOURCE_NAME = 'web'
          AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
          AND o.CREATED_AT >= b.prior_start
          AND o.CREATED_AT < b.today_start
      ),
      aggregates AS (
        SELECT
          base.product,
          SUM(IFF(base.CREATED_AT >= b.current_start, base.QUANTITY, 0)) AS current_count,
          SUM(IFF(base.CREATED_AT >= b.current_start, base.QUANTITY * base.PRICE_AMOUNT, 0)) AS current_revenue,
          SUM(IFF(base.CREATED_AT < b.current_start, base.QUANTITY * base.PRICE_AMOUNT, 0)) AS prior_revenue
        FROM base, bounds b
        GROUP BY base.product
        HAVING SUM(IFF(base.CREATED_AT >= b.current_start, base.QUANTITY, 0)) > 0
        ORDER BY current_revenue DESC NULLS LAST
        LIMIT ${TOP_LIMIT}
      ),
      daily AS (
        SELECT
          base.product,
          TO_VARCHAR(DATE(base.CREATED_AT), 'YYYY-MM-DD') AS d,
          SUM(base.QUANTITY * base.PRICE_AMOUNT) AS v
        FROM base, bounds b
        WHERE base.CREATED_AT >= b.current_start
          AND base.product IN (SELECT product FROM aggregates)
        GROUP BY base.product, DATE(base.CREATED_AT)
      ),
      sparklines AS (
        SELECT
          product,
          ARRAY_AGG(OBJECT_CONSTRUCT('d', d, 'v', v)) WITHIN GROUP (ORDER BY d) AS daily_series
        FROM daily
        GROUP BY product
      )
      SELECT
        a.product AS KEY,
        a.product AS LABEL,
        NULL AS SUBLABEL,
        a.current_revenue AS CURRENT_REVENUE,
        a.prior_revenue AS PRIOR_REVENUE,
        a.current_count AS CURRENT_COUNT,
        TO_VARCHAR(s.daily_series) AS DAILY_JSON
      FROM aggregates a
      LEFT JOIN sparklines s USING (product)
      ORDER BY a.current_revenue DESC NULLS LAST
    `,
    [period, period * 2, brand],
  );
  return rows.map((r) => toRow(r, 'units'));
}

// ShopifyQL-sourced Channel Attribution. Replaces the previous
// order-based UTM extraction from LANDING_SITE. Big win: campaigns with
// zero conversions still show up here (e.g. "facebook · ASN | Copper
// Peptides | US | ABO | Testing | 2026" with 484 sessions and 0% conv
// that was invisible before because the order-side query had nothing to
// extract from).
export async function getChannelAttribution(
  brand: Brand,
  period: Period,
): Promise<Layer2Row[]> {
  const channels = await getChannelSessions(brand, period);
  if (channels.length > 0) {
    return channels.map((c) => {
      const ordersAttributed = Math.round(c.sessions * (c.convRate / 100));
      const labelSource = c.source || '(none)';
      const fullLabel = c.name ? `${labelSource} · ${c.name}` : labelSource;
      return {
        key: `${labelSource}|${c.name}`,
        label: fullLabel,
        currentRevenue: 0,
        priorRevenue: 0,
        currentCount: ordersAttributed,
        countNoun: 'orders' as const,
        daily: [],
        sessions: c.sessions,
        convRate: c.convRate,
        priorSessions: c.priorSessions,
      };
    });
  }
  // Fall through to the legacy order-based UTM extraction if ShopifyQL
  // isn't available for this brand (no install or API outage). Keeps the
  // tab usable in degraded mode.
  return getChannelAttributionFromOrders(brand, period);
}

async function getChannelAttributionFromOrders(
  brand: Brand,
  period: Period,
): Promise<Layer2Row[]> {
  // First-touch landing-page attribution from LANDING_SITE's utm_source param.
  // The original plan was to join STG.GA4_REVENUE_SHARE for multi-touch
  // attribution, but that pipeline has been stale since Jan 2025 (data team
  // ticket). UTM extraction works today and gives the headline answer:
  // "where did this order's customer land from?" Sources with no UTM are
  // bucketed as "(direct)" — matches GA4's convention.
  const rows = await execute<RawRow>(
    `
      WITH bounds AS (
        SELECT
          DATE_TRUNC('day', CURRENT_TIMESTAMP()) AS today_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS current_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS prior_start
      ),
      classified AS (
        SELECT
          COALESCE(
            NULLIF(LOWER(REGEXP_SUBSTR(o.LANDING_SITE, 'utm_source=([^&]+)', 1, 1, 'e', 1)), ''),
            '(direct)'
          ) AS source,
          o.CREATED_AT,
          o.TOTAL_PRICE_AMOUNT
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o, bounds b
        WHERE o.BRAND = ?
          AND o.SOURCE_NAME = 'web'
          AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
          AND o.CREATED_AT >= b.prior_start
          AND o.CREATED_AT < b.today_start
      ),
      aggregates AS (
        SELECT
          c.source,
          SUM(IFF(c.CREATED_AT >= b.current_start, 1, 0)) AS current_count,
          SUM(IFF(c.CREATED_AT >= b.current_start, c.TOTAL_PRICE_AMOUNT, 0)) AS current_revenue,
          SUM(IFF(c.CREATED_AT < b.current_start, c.TOTAL_PRICE_AMOUNT, 0)) AS prior_revenue
        FROM classified c, bounds b
        GROUP BY c.source
        HAVING SUM(IFF(c.CREATED_AT >= b.current_start, c.TOTAL_PRICE_AMOUNT, 0)) > 0
        ORDER BY current_revenue DESC NULLS LAST
        LIMIT ${TOP_LIMIT}
      ),
      daily AS (
        SELECT
          c.source,
          TO_VARCHAR(DATE(c.CREATED_AT), 'YYYY-MM-DD') AS d,
          SUM(c.TOTAL_PRICE_AMOUNT) AS v
        FROM classified c, bounds b
        WHERE c.CREATED_AT >= b.current_start
          AND c.source IN (SELECT source FROM aggregates)
        GROUP BY c.source, DATE(c.CREATED_AT)
      ),
      sparklines AS (
        SELECT
          source,
          ARRAY_AGG(OBJECT_CONSTRUCT('d', d, 'v', v)) WITHIN GROUP (ORDER BY d) AS daily_series
        FROM daily
        GROUP BY source
      )
      SELECT
        a.source AS KEY,
        a.source AS LABEL,
        NULL AS SUBLABEL,
        a.current_revenue AS CURRENT_REVENUE,
        a.prior_revenue AS PRIOR_REVENUE,
        a.current_count AS CURRENT_COUNT,
        TO_VARCHAR(s.daily_series) AS DAILY_JSON
      FROM aggregates a
      LEFT JOIN sparklines s USING (source)
      ORDER BY a.current_revenue DESC NULLS LAST
    `,
    [period, period * 2, brand],
  );
  return rows.map((r) => toRow(r, 'orders'));
}

export type Layer2Tab =
  | 'watched'
  | 'pdps'
  | 'collections'
  | 'cms'
  | 'products'
  | 'attribution';
export const LAYER2_TABS: readonly Layer2Tab[] = [
  'watched',
  'pdps',
  'collections',
  'cms',
  'products',
  'attribution',
] as const;

export const LAYER2_LABELS: Record<Layer2Tab, string> = {
  watched: 'Watched',
  pdps: 'PDPs',
  collections: 'Collections',
  cms: 'CMS Pages',
  products: 'Top Products',
  attribution: 'Channel Attribution',
};

export function parseLayer2Tab(raw: unknown): Layer2Tab {
  return (LAYER2_TABS as readonly string[]).includes(raw as string)
    ? (raw as Layer2Tab)
    : 'watched';
}

// Tabs whose rows are keyed on landing paths (so we can enrich with
// ShopifyQL session data). Top Products (product titles) and Channel
// Attribution (utm sources) are not path-keyed.
const PATH_KEYED_TABS: ReadonlySet<Layer2Tab> = new Set([
  'watched',
  'pdps',
  'collections',
  'cms',
]);

export async function getLayer2(
  brand: Brand,
  period: Period,
  tab: Layer2Tab,
): Promise<Layer2Row[]> {
  return withCache(`layer2:${brand}:${period}:${tab}:v1`, 120, () =>
    getLayer2Uncached(brand, period, tab),
  );
}

async function getLayer2Uncached(
  brand: Brand,
  period: Period,
  tab: Layer2Tab,
): Promise<Layer2Row[]> {
  const [rows, sessions] = await Promise.all([
    getLayer2RowsInner(brand, period, tab),
    PATH_KEYED_TABS.has(tab) ? getSessionsByPath(brand, period) : Promise.resolve(new Map()),
  ]);
  if (sessions.size === 0) return rows;
  return rows.map((r) => {
    const s = sessions.get(r.key);
    return s ? { ...r, sessions: s.sessions, convRate: s.convRate } : r;
  });
}

async function getLayer2RowsInner(
  brand: Brand,
  period: Period,
  tab: Layer2Tab,
): Promise<Layer2Row[]> {
  switch (tab) {
    case 'watched':
      return getWatchedPages(brand, period);
    case 'pdps':
      return getPDPs(brand, period);
    case 'collections':
      return getCollections(brand, period);
    case 'cms':
      return getCMSPages(brand, period);
    case 'products':
      return getTopProductsBySales(brand, period);
    case 'attribution':
      return getChannelAttribution(brand, period);
  }
}
