import { execute } from '@/lib/snowflake';
import { withCache } from '@/lib/cache';
import {
  getSessionsByPath,
  getSourceByPath,
  type SourceBreakdownRow,
} from '@/lib/shopify';
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
  }[];
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

export async function getPageDeepDive(
  brand: Brand,
  path: string,
  period: Period,
): Promise<PageDeepDive> {
  // Bump the version when the PageDeepDive shape changes so stale cached
  // objects (missing newer fields like activeTests) can't be served.
  return withCache(
    `deepdive:${brand}:${period}:${encodeURIComponent(path)}:v5`,
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
    igActive,
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
  ]);

  // ShopifyQL session metrics for this path. The prior-period numbers
  // we don't have separately, so leave them zero for now — vs-prior on
  // sessions will read as "new" but vs-prior on orders/revenue works.
  // (Could extend with a second ShopifyQL call later if useful.)
  const sess = sessionsByPath.get(path);

  // Intelligems tests located to this page. The redirect (origin/dest)
  // match drives the header pill; the full list (incl. on-site edits
  // targeting this URL) feeds the deep-dive "Active A/B tests" section.
  const onPage = matchActiveTestsForPath(igActive, path);
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
    onPage.map(async (t) => ({
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
    })),
  );

  return {
    brand,
    path,
    period,
    sessions: { current: sess?.sessions ?? 0, prior: 0 },
    convRate: { current: sess?.convRate ?? 0, prior: 0 },
    orderCount: { current: orders.current, prior: orders.prior },
    revenue: { current: orders.currentRev, prior: orders.priorRev },
    recentDays: {
      yesterday: { orders: orders.ydayCount, revenue: orders.ydayRev },
      dayBefore: { orders: orders.dbeforeCount, revenue: orders.dbeforeRev },
    },
    sourceBreakdown,
    clarity: clarityMap.get(path) ?? null,
    activePromos,
    intelligemsTest,
    activeTests,
  };
}
