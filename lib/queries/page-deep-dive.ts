import { execute } from '@/lib/snowflake';
import { withCache } from '@/lib/cache';
import {
  getSessionsByPath,
  getSourceByPath,
  type SourceBreakdownRow,
} from '@/lib/shopify';
import { getClarityMetrics, type ClarityPageMetrics } from '@/lib/clarity-metrics';
import { getActivePromos } from '@/lib/queries/promos';
import { findIntelligemsTest, type IntelligemsTest } from '@/lib/intelligems-tests';
import type { Brand, Period } from '@/lib/queries/orders';
import type { Promo } from '@/lib/queries/promos';

// Page-scoped deep dive: pulls every metric we have for a single URL
// in one structure, ready for the Layer 3 route to render.

export type PageDeepDive = {
  brand: Brand;
  path: string;
  period: Period;
  // Sessions / orders / revenue + their prior-period values for vs-prior
  // computations. ShopifyQL sessions are 28-day max (their cap); Snowflake
  // orders span whatever window we ask for.
  sessions: { current: number; prior: number };
  convRate: { current: number; prior: number }; // percent (same-session)
  orderCount: { current: number; prior: number };
  revenue: { current: number; prior: number };
  // Device × source breakdown for the current window
  sourceBreakdown: SourceBreakdownRow[];
  // Clarity friction signals for the path (last 3 days per Clarity API)
  clarity: ClarityPageMetrics | null;
  // Brand-level promos active during this window (not filtered to URL —
  // the page might be touched by a sitewide promo)
  activePromos: Promo[];
  // If this path is part of a current Intelligems test, surface the
  // role + test deep link
  intelligemsTest: { test: IntelligemsTest; role: 'origin' | 'destination' } | null;
};

type OrdersRow = {
  CURRENT_COUNT: string;
  CURRENT_REVENUE: string;
  PRIOR_COUNT: string;
  PRIOR_REVENUE: string;
};

const n = (v: unknown): number => Number(v ?? 0) || 0;

async function getOrdersForPath(
  brand: Brand,
  path: string,
  period: Period,
): Promise<{ current: number; prior: number; currentRev: number; priorRev: number }> {
  const rows = await execute<OrdersRow>(
    `
      WITH classified AS (
        SELECT
          CREATED_AT,
          TOTAL_PRICE_AMOUNT,
          SPLIT_PART(LANDING_SITE, '?', 1) AS LANDING_PATH
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS
        WHERE BRAND = ?
          AND CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
          AND CREATED_AT < DATE_TRUNC('day', CURRENT_TIMESTAMP())
      )
      SELECT
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())), 1, 0)), 0) AS CURRENT_COUNT,
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS CURRENT_REVENUE,
        COALESCE(SUM(IFF(CREATED_AT < DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())), 1, 0)), 0) AS PRIOR_COUNT,
        COALESCE(SUM(IFF(CREATED_AT < DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS PRIOR_REVENUE
      FROM classified
      WHERE REGEXP_REPLACE(LANDING_PATH, '(^https?://[^/]+)|/$', '') = ?
    `,
    [brand, period * 2, period, period, period, period, path],
  );
  const r = rows[0];
  return {
    current: n(r?.CURRENT_COUNT),
    prior: n(r?.PRIOR_COUNT),
    currentRev: n(r?.CURRENT_REVENUE),
    priorRev: n(r?.PRIOR_REVENUE),
  };
}

export async function getPageDeepDive(
  brand: Brand,
  path: string,
  period: Period,
): Promise<PageDeepDive> {
  return withCache(
    `deepdive:${brand}:${period}:${encodeURIComponent(path)}:v1`,
    120,
    () => getPageDeepDiveUncached(brand, path, period),
  );
}

async function getPageDeepDiveUncached(
  brand: Brand,
  path: string,
  period: Period,
): Promise<PageDeepDive> {
  const [
    sessionsByPath,
    sourceBreakdown,
    clarityMap,
    activePromos,
    orders,
  ] = await Promise.all([
    getSessionsByPath(brand, period).catch(() => new Map()),
    getSourceByPath(brand, path, period).catch(() => [] as SourceBreakdownRow[]),
    getClarityMetrics(brand).catch(() => new Map()),
    getActivePromos(brand).catch(() => [] as Promo[]),
    getOrdersForPath(brand, path, period).catch(() => ({
      current: 0,
      prior: 0,
      currentRev: 0,
      priorRev: 0,
    })),
  ]);

  // ShopifyQL session metrics for this path. The prior-period numbers
  // we don't have separately, so leave them zero for now — vs-prior on
  // sessions will read as "new" but vs-prior on orders/revenue works.
  // (Could extend with a second ShopifyQL call later if useful.)
  const sess = sessionsByPath.get(path);
  return {
    brand,
    path,
    period,
    sessions: { current: sess?.sessions ?? 0, prior: 0 },
    convRate: { current: sess?.convRate ?? 0, prior: 0 },
    orderCount: { current: orders.current, prior: orders.prior },
    revenue: { current: orders.currentRev, prior: orders.priorRev },
    sourceBreakdown,
    clarity: clarityMap.get(path) ?? null,
    activePromos,
    intelligemsTest: findIntelligemsTest(brand, path),
  };
}
