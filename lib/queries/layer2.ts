import { execute } from '@/lib/snowflake';
import type { Brand, DailyPoint, Period } from '@/lib/queries/orders';

// Layer 2 — page-/product-/source-level tables below Level 1. Each function
// returns the top N rows for the selected period with a daily-revenue series
// per row for the inline sparkline. Calendar-day boundaries match Layer 1:
// current period = last N complete days ending end-of-yesterday; prior period
// = the N days before that.

const n = (v: unknown) => Number(v ?? 0);
const TOP_LIMIT = 25;

export type Layer2Row = {
  key: string;
  label: string;
  sublabel?: string;
  currentRevenue: number;
  priorRevenue: number;
  currentCount: number;
  countNoun: 'orders' | 'units';
  daily: DailyPoint[];
};

type RawRow = {
  KEY: string | null;
  LABEL: string | null;
  SUBLABEL: string | null;
  CURRENT_REVENUE: number | string | null;
  PRIOR_REVENUE: number | string | null;
  CURRENT_COUNT: number | string | null;
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
  countNoun,
  daily: parseDaily(r.DAILY_JSON),
});

export async function getLandingPages(brand: Brand, period: Period): Promise<Layer2Row[]> {
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
          o.TOTAL_PRICE_AMOUNT
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o, bounds b
        WHERE o.BRAND = ?
          AND o.SOURCE_NAME = 'web'
          AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
          AND o.CREATED_AT >= b.prior_start
          AND o.CREATED_AT < b.today_start
          AND o.LANDING_SITE IS NOT NULL
          AND o.LANDING_SITE NOT LIKE '%/online_store_preview%'
          AND o.LANDING_SITE NOT LIKE '%/checkouts/sessions/clone%'
          AND o.LANDING_SITE NOT LIKE '%/cart/update.js%'
      ),
      aggregates AS (
        SELECT
          c.landing_path,
          SUM(IFF(c.CREATED_AT >= b.current_start, 1, 0)) AS current_count,
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
        TO_VARCHAR(s.daily_series) AS DAILY_JSON
      FROM aggregates a
      LEFT JOIN sparklines s USING (landing_path)
      ORDER BY a.current_revenue DESC NULLS LAST
    `,
    [period, period * 2, brand],
  );
  return rows.map((r) => toRow(r, 'orders'));
}

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

export async function getChannelAttribution(
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

export type Layer2Tab = 'landing' | 'products' | 'attribution';
export const LAYER2_TABS: readonly Layer2Tab[] = ['landing', 'products', 'attribution'] as const;

export const LAYER2_LABELS: Record<Layer2Tab, string> = {
  landing: 'Landing Pages',
  products: 'Top Products',
  attribution: 'Channel Attribution',
};

export function parseLayer2Tab(raw: unknown): Layer2Tab {
  return (LAYER2_TABS as readonly string[]).includes(raw as string)
    ? (raw as Layer2Tab)
    : 'landing';
}

export async function getLayer2(
  brand: Brand,
  period: Period,
  tab: Layer2Tab,
): Promise<Layer2Row[]> {
  switch (tab) {
    case 'landing':
      return getLandingPages(brand, period);
    case 'products':
      return getTopProductsBySales(brand, period);
    case 'attribution':
      return getChannelAttribution(brand, period);
  }
}
