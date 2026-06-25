import { execute } from '@/lib/snowflake';
import { withCache } from '@/lib/cache';
import {
  getSessionsByPath,
  getSourceByPath,
  getPageSessionTimeSeries,
  type SourceBreakdownRow,
} from '@/lib/shopify';
import { bucketFromTimeSeries } from '@/lib/queries/orders';
import { getClarityMetrics, type ClarityPageMetrics } from '@/lib/clarity-metrics';
import { getActivePromos } from '@/lib/queries/promos';
import { type IntelligemsTest } from '@/lib/intelligems-tests';
import {
  getActiveTests,
  getExperienceResults,
  matchActiveTestsForPath,
  type ActiveTest,
  type ExperienceResults,
} from '@/lib/intelligems-api';
import { getAttachedTestIds } from '@/lib/intelligems-attach';
import type { Brand, Period, Bucket, DailyPoint } from '@/lib/queries/orders';
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
  // Full per-page buckets (current/prior/yesterday/7-day/year-ago + daily
  // series) for the Layer-1-style cards. Orders & revenue only — Shopify
  // doesn't give a clean per-page daily series for sessions/conv.
  orderBucket: Bucket;
  revenueBucket: Bucket;
  // Per-page session + conversion buckets (ShopifyQL daily series) so the
  // deep dive can show them as rich sparkline cards like orders/revenue.
  sessionsBucket: Bucket;
  convRateBucket: Bucket;
  // Subscription revenue landed on this page (web subscription orders).
  subRevenueBucket: Bucket;
  // Most recent two complete days (orders + revenue), so the AI summary
  // can lead with day-over-day movement and consecutive daily snapshots
  // read as a timeline rather than near-duplicate trailing-window text.
  recentDays: {
    yesterday: { orders: number; revenue: number };
    dayBefore: { orders: number; revenue: number };
  };
  // Device × source breakdown for the current window
  sourceBreakdown: SourceBreakdownRow[];
  // Clarity friction signals for the path (last 3 days per Clarity API)
  clarity: ClarityPageMetrics | null;
  // Brand-level promos active during this window (not filtered to URL —
  // the page might be touched by a sitewide promo)
  activePromos: Promo[];
  // If this path is the origin/destination of a redirect (split-URL)
  // test, surface the role + test deep link (drives the header pill).
  intelligemsTest: { test: IntelligemsTest; role: 'origin' | 'destination' } | null;
  // All active Intelligems tests located to this page (redirect tests +
  // on-site edits targeting this URL) — for the deep-dive section, each
  // with its cohort-attributed results when available.
  activeTests: {
    id: string;
    name: string;
    type: string;
    testUrl: string;
    role: 'origin' | 'destination' | 'targeted';
    results: ExperienceResults | null;
    // When this page is a redirect origin, where its traffic is sent.
    redirectsTo: string[];
    // When this page is a redirect destination, which pages funnel here.
    redirectedFrom: string[];
    // True when the team manually attached this test (not auto-located).
    manual: boolean;
  }[];
  // All of the brand's active tests (id/name/type) — for the "attach a
  // test to this page" picker, including ones we can't auto-locate.
  allIntelligemsTests: { id: string; name: string; type: string }[];
};

type OrdersRow = {
  CURRENT_COUNT: string;
  CURRENT_REVENUE: string;
  PRIOR_COUNT: string;
  PRIOR_REVENUE: string;
  YDAY_COUNT: string;
  YDAY_REVENUE: string;
  DBEFORE_COUNT: string;
  DBEFORE_REVENUE: string;
};

const n = (v: unknown): number => Number(v ?? 0) || 0;

async function getOrdersForPath(
  brand: Brand,
  path: string,
  period: Period,
): Promise<{
  current: number;
  prior: number;
  currentRev: number;
  priorRev: number;
  ydayCount: number;
  ydayRev: number;
  dbeforeCount: number;
  dbeforeRev: number;
}> {
  // Yesterday = [-1 day, today); day-before = [-2 days, -1 day). Literal
  // offsets (no extra binds) — both fall inside the classified window.
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
        COALESCE(SUM(IFF(CREATED_AT < DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS PRIOR_REVENUE,
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -1, DATE_TRUNC('day', CURRENT_TIMESTAMP())), 1, 0)), 0) AS YDAY_COUNT,
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -1, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS YDAY_REVENUE,
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -2, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AND CREATED_AT < DATEADD(day, -1, DATE_TRUNC('day', CURRENT_TIMESTAMP())), 1, 0)), 0) AS DBEFORE_COUNT,
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -2, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AND CREATED_AT < DATEADD(day, -1, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS DBEFORE_REVENUE
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
    ydayCount: n(r?.YDAY_COUNT),
    ydayRev: n(r?.YDAY_REVENUE),
    dbeforeCount: n(r?.DBEFORE_COUNT),
    dbeforeRev: n(r?.DBEFORE_REVENUE),
  };
}

type PageAggRow = {
  ORDERS_CURRENT: number | string | null;
  REVENUE_CURRENT: number | string | null;
  ORDERS_PRIOR: number | string | null;
  REVENUE_PRIOR: number | string | null;
  ORDERS_YESTERDAY: number | string | null;
  REVENUE_YESTERDAY: number | string | null;
  ORDERS_7D: number | string | null;
  REVENUE_7D: number | string | null;
  ORDERS_YEAR_AGO: number | string | null;
  REVENUE_YEAR_AGO: number | string | null;
  SUBREV_CURRENT: number | string | null;
  SUBREV_PRIOR: number | string | null;
  SUBREV_YESTERDAY: number | string | null;
  SUBREV_7D: number | string | null;
  SUBREV_YEAR_AGO: number | string | null;
};
type PageDailyRow = {
  D: string;
  ORDERS: number | string | null;
  REVENUE: number | string | null;
  SUB_REV: number | string | null;
};

// Full per-page orders + revenue buckets (mirrors the brand-level
// getShopifyAggregates/getShopifyDaily windows, filtered to one landing
// path) so the Layer 3 deep dive can render Layer-1-style cards.
async function getPageBuckets(
  brand: Brand,
  path: string,
  period: Period,
): Promise<{ orders: Bucket; revenue: Bucket; subRevenue: Bucket }> {
  const pathFilter = `REGEXP_REPLACE(SPLIT_PART(LANDING_SITE, '?', 1), '(^https?://[^/]+)|/$', '') = ?`;
  // Web subscription revenue, matching the brand-level definition.
  const subAmt = `IFF(c.IS_SUBSCRIPTION = TRUE AND c.SOURCE_NAME = 'web', c.TOTAL_PRICE_AMOUNT, 0)`;
  const [aggRows, dailyRows] = await Promise.all([
    execute<PageAggRow>(
      `
        WITH classified AS (
          SELECT CREATED_AT, TOTAL_PRICE_AMOUNT, IS_SUBSCRIPTION, SOURCE_NAME
          FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS
          WHERE BRAND = ?
            AND (IS_FAIRE_ORDER = FALSE OR IS_FAIRE_ORDER IS NULL)
            AND CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
            AND CREATED_AT < DATE_TRUNC('day', CURRENT_TIMESTAMP())
            AND ${pathFilter}
        ),
        bounds AS (
          SELECT
            DATE_TRUNC('day', CURRENT_TIMESTAMP()) AS today_start,
            DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS current_start,
            DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS prior_start,
            DATEADD(day, -1, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS yesterday_start,
            DATEADD(day, -7, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS seven_day_start,
            DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS year_ago_start,
            DATEADD(day, -365, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS year_ago_end
        )
        SELECT
          COUNT_IF(c.CREATED_AT >= b.current_start AND c.CREATED_AT < b.today_start) AS ORDERS_CURRENT,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.current_start AND c.CREATED_AT < b.today_start, c.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_CURRENT,
          COUNT_IF(c.CREATED_AT >= b.prior_start AND c.CREATED_AT < b.current_start) AS ORDERS_PRIOR,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.prior_start AND c.CREATED_AT < b.current_start, c.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_PRIOR,
          COUNT_IF(c.CREATED_AT >= b.yesterday_start AND c.CREATED_AT < b.today_start) AS ORDERS_YESTERDAY,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.yesterday_start AND c.CREATED_AT < b.today_start, c.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_YESTERDAY,
          COUNT_IF(c.CREATED_AT >= b.seven_day_start AND c.CREATED_AT < b.today_start) AS ORDERS_7D,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.seven_day_start AND c.CREATED_AT < b.today_start, c.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_7D,
          COUNT_IF(c.CREATED_AT >= b.year_ago_start AND c.CREATED_AT < b.year_ago_end) AS ORDERS_YEAR_AGO,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.year_ago_start AND c.CREATED_AT < b.year_ago_end, c.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_YEAR_AGO,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.current_start AND c.CREATED_AT < b.today_start, ${subAmt}, 0)), 0) AS SUBREV_CURRENT,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.prior_start AND c.CREATED_AT < b.current_start, ${subAmt}, 0)), 0) AS SUBREV_PRIOR,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.yesterday_start AND c.CREATED_AT < b.today_start, ${subAmt}, 0)), 0) AS SUBREV_YESTERDAY,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.seven_day_start AND c.CREATED_AT < b.today_start, ${subAmt}, 0)), 0) AS SUBREV_7D,
          COALESCE(SUM(IFF(c.CREATED_AT >= b.year_ago_start AND c.CREATED_AT < b.year_ago_end, ${subAmt}, 0)), 0) AS SUBREV_YEAR_AGO
        FROM classified c, bounds b
      `,
      [brand, 365 + period, path, period, period * 2, 365 + period],
    ),
    execute<PageDailyRow>(
      `
        SELECT
          TO_VARCHAR(DATE(CREATED_AT), 'YYYY-MM-DD') AS D,
          COUNT(*) AS ORDERS,
          COALESCE(SUM(TOTAL_PRICE_AMOUNT), 0) AS REVENUE,
          COALESCE(SUM(IFF(IS_SUBSCRIPTION = TRUE AND SOURCE_NAME = 'web', TOTAL_PRICE_AMOUNT, 0)), 0) AS SUB_REV
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS
        WHERE BRAND = ?
          AND CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
          AND CREATED_AT < DATE_TRUNC('day', CURRENT_TIMESTAMP())
          AND (IS_FAIRE_ORDER = FALSE OR IS_FAIRE_ORDER IS NULL)
          AND ${pathFilter}
        GROUP BY DATE(CREATED_AT)
        ORDER BY DATE(CREATED_AT)
      `,
      [brand, period, path],
    ),
  ]);
  const a = aggRows[0] ?? ({} as PageAggRow);
  const ordersDaily: DailyPoint[] = dailyRows.map((d) => ({ date: d.D, value: n(d.ORDERS) }));
  const revenueDaily: DailyPoint[] = dailyRows.map((d) => ({ date: d.D, value: n(d.REVENUE) }));
  const subRevDaily: DailyPoint[] = dailyRows.map((d) => ({ date: d.D, value: n(d.SUB_REV) }));
  return {
    orders: {
      current: n(a.ORDERS_CURRENT),
      prior: n(a.ORDERS_PRIOR),
      yesterday: n(a.ORDERS_YESTERDAY),
      sevenDayTotal: n(a.ORDERS_7D),
      yearAgo: n(a.ORDERS_YEAR_AGO),
      daily: ordersDaily,
    },
    revenue: {
      current: n(a.REVENUE_CURRENT),
      prior: n(a.REVENUE_PRIOR),
      yesterday: n(a.REVENUE_YESTERDAY),
      sevenDayTotal: n(a.REVENUE_7D),
      yearAgo: n(a.REVENUE_YEAR_AGO),
      daily: revenueDaily,
    },
    subRevenue: {
      current: n(a.SUBREV_CURRENT),
      prior: n(a.SUBREV_PRIOR),
      yesterday: n(a.SUBREV_YESTERDAY),
      sevenDayTotal: n(a.SUBREV_7D),
      yearAgo: n(a.SUBREV_YEAR_AGO),
      daily: subRevDaily,
    },
  };
}

export async function getPageDeepDive(
  brand: Brand,
  path: string,
  period: Period,
): Promise<PageDeepDive> {
  // Bump the version when the PageDeepDive shape changes so stale cached
  // objects (missing newer fields like activeTests) can't be served.
  return withCache(
    `deepdive:${brand}:${period}:${encodeURIComponent(path)}:v9`,
    120,
    () => getPageDeepDiveUncached(brand, path, period),
  );
}

async function getPageDeepDiveUncached(
  brand: Brand,
  path: string,
  period: Period,
): Promise<PageDeepDive> {
  const emptyBucket: Bucket = {
    current: 0,
    prior: 0,
    yesterday: 0,
    sevenDayTotal: 0,
    yearAgo: 0,
    daily: [],
  };
  const [
    sessionsByPath,
    sourceBreakdown,
    clarityMap,
    activePromos,
    orders,
    igActive,
    buckets,
    sessionSeries,
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
      ydayCount: 0,
      ydayRev: 0,
      dbeforeCount: 0,
      dbeforeRev: 0,
    })),
    getActiveTests(brand).catch(() => [] as ActiveTest[]),
    getPageBuckets(brand, path, period).catch(() => ({
      orders: emptyBucket,
      revenue: emptyBucket,
      subRevenue: emptyBucket,
    })),
    // ~13-month per-page session series for the rich Sessions/Conv cards.
    getPageSessionTimeSeries(brand, path, 365 + period).catch(() => []),
  ]);

  // ShopifyQL session metrics for this path. The prior-period numbers
  // we don't have separately, so leave them zero for now — vs-prior on
  // sessions will read as "new" but vs-prior on orders/revenue works.
  // (Could extend with a second ShopifyQL call later if useful.)
  const sess = sessionsByPath.get(path);

  // Per-page session + conv buckets from the daily series. Fall back to a
  // current-only bucket (from getSessionsByPath) if the series is empty
  // (e.g. ShopifyQL didn't support the per-path filter).
  const fallbackSessions: Bucket = { ...emptyBucket, current: sess?.sessions ?? 0 };
  const fallbackConv: Bucket = { ...emptyBucket, current: sess?.convRate ?? 0 };
  const sessionsBucket =
    sessionSeries.length > 0 ? bucketFromTimeSeries(sessionSeries, period, 'sessions') : fallbackSessions;
  const convRateBucket =
    sessionSeries.length > 0 ? bucketFromTimeSeries(sessionSeries, period, 'convRate') : fallbackConv;

  // Intelligems tests located to this page. The redirect (origin/dest)
  // match drives the header pill; the full list (incl. on-site edits
  // targeting this URL) feeds the deep-dive "Active A/B tests" section.
  const onPage = matchActiveTestsForPath(igActive, path);
  // Manually-attached tests (template/product-targeted ones the team
  // pinned to this page) that auto-detection didn't already surface.
  const attachedIds = await getAttachedTestIds(brand, path).catch(() => [] as string[]);
  const onPageIds = new Set(onPage.map((t) => t.id));
  const manualTests = attachedIds
    .filter((id) => !onPageIds.has(id))
    .map((id) => igActive.find((t) => t.id === id))
    .filter((t): t is ActiveTest => Boolean(t));
  const combined = [
    ...onPage.map((t) => ({ t, manual: false })),
    ...manualTests.map((t) => ({ t, manual: true })),
  ];
  const redirectMatch = onPage.find(
    (t) => t.origins.includes(path) || t.destinations.includes(path),
  );
  const intelligemsTest = redirectMatch
    ? {
        test: {
          name: redirectMatch.name,
          testUrl: redirectMatch.testUrl,
          origins: redirectMatch.origins,
          destinations: redirectMatch.destinations,
        } as IntelligemsTest,
        role: (redirectMatch.origins.includes(path) ? 'origin' : 'destination') as
          | 'origin'
          | 'destination',
      }
    : null;
  const activeTests = await Promise.all(
    combined.map(async ({ t, manual }) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      testUrl: t.testUrl,
      role: (t.origins.includes(path)
        ? 'origin'
        : t.destinations.includes(path)
          ? 'destination'
          : 'targeted') as 'origin' | 'destination' | 'targeted',
      results: await getExperienceResults(brand, t.id).catch(() => null),
      redirectsTo: t.redirects
        .filter((r) => r.origin === path)
        .map((r) => r.destination),
      redirectedFrom: t.redirects
        .filter((r) => r.destination === path)
        .map((r) => r.origin),
      manual,
    })),
  );
  const allIntelligemsTests = igActive.map((t) => ({ id: t.id, name: t.name, type: t.type }));

  return {
    brand,
    path,
    period,
    sessions: { current: sess?.sessions ?? 0, prior: 0 },
    convRate: { current: sess?.convRate ?? 0, prior: 0 },
    orderCount: { current: orders.current, prior: orders.prior },
    revenue: { current: orders.currentRev, prior: orders.priorRev },
    orderBucket: buckets.orders,
    revenueBucket: buckets.revenue,
    subRevenueBucket: buckets.subRevenue,
    sessionsBucket,
    convRateBucket,
    recentDays: {
      yesterday: { orders: orders.ydayCount, revenue: orders.ydayRev },
      dayBefore: { orders: orders.dbeforeCount, revenue: orders.dbeforeRev },
    },
    sourceBreakdown,
    clarity: clarityMap.get(path) ?? null,
    activePromos,
    intelligemsTest,
    activeTests,
    allIntelligemsTests,
  };
}
