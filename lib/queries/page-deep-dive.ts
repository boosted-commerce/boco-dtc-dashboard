import { execute } from '@/lib/snowflake';
import { withCache } from '@/lib/cache';
import {
  getSessionsByPath,
  getSourceByPath,
  getPageSessionTimeSeries,
  getChannelDailyByPath,
  getProductVariants,
  type SourceBreakdownRow,
  type SessionDailyPoint,
  type ChannelDailyPoint,
} from '@/lib/shopify';
import { bucketFromTimeSeries } from '@/lib/queries/orders';
import { getClarityMetrics, type ClarityPageMetrics } from '@/lib/clarity-metrics';
import { getActivePromos } from '@/lib/queries/promos';
import { type IntelligemsTest } from '@/lib/intelligems-tests';
import {
  getActiveTests,
  getEndedTests,
  getExperienceResults,
  matchActiveTestsForPath,
  type ActiveTest,
  type ExperienceResults,
} from '@/lib/intelligems-api';
import { getAttachedTestIds, getDismissedTestIds } from '@/lib/intelligems-attach';
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
    // `pending` = the order pipeline hasn't loaded this day yet (lags ~1–2
    // days), so a 0 here means "not loaded", not "no orders". `latestLoaded`
    // is the brand's most recent loaded order date (YYYY-MM-DD).
    yesterday: { orders: number; revenue: number; pending: boolean };
    dayBefore: { orders: number; revenue: number; pending: boolean };
    latestLoaded: string | null;
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
  // Ended/prior Intelligems tests located to this page (with results),
  // for the collapsed "prior tests" accordion.
  endedTests: {
    id: string;
    name: string;
    type: string;
    testUrl: string;
    role: 'origin' | 'destination' | 'targeted';
    results: ExperienceResults | null;
  }[];
  // Active tests the team dismissed from this page — shown in the accordion
  // with a restore control, so dismissing is reversible.
  dismissedTests: { id: string; name: string; type: string; testUrl: string }[];
  // For PDPs: per-variant sales composition of this product (product-scoped
  // — all web orders containing the product in the window, regardless of
  // landing page). Empty for non-product pages or single-variant products.
  variants: VariantSalesRow[];
  // Per-channel rich-card data for the "filter by channel" dropdown above
  // the cards. One entry per traffic channel on this page.
  channelCards: ChannelCard[];
};

export type VariantSalesRow = {
  variantId: string;
  title: string; // variant title (e.g. "60 capsules / Vanilla"), or SKU/#id fallback
  sku: string | null;
  units: number;
  orders: number;
  revenue: number;
  aov: number; // revenue / orders
  revenueShare: number; // 0..1 of this product's total variant revenue
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
  // Pipeline-freshness flags. SHOPIFY_ORDERS_RD_ORDERS is loaded by a
  // data-team job that lags ~1–2 days, so a recent day reading 0 orders may
  // simply be unloaded rather than genuinely empty. These compare the brand's
  // latest loaded order date against each recent day.
  YDAY_PENDING: boolean | null;
  DBEFORE_PENDING: boolean | null;
  LATEST_LOADED: string | null;
};

const n = (v: unknown): number => Number(v ?? 0) || 0;

// Per-channel version of the rich cards, for the Layer 3 channel filter.
export type ChannelCard = {
  channel: string;
  sessions: Bucket;
  convRate: Bucket;
  orders: Bucket;
  revenue: Bucket;
  aov: Bucket;
};

// Build per-channel buckets. Sessions + conversion daily come from REAL
// per-channel ShopifyQL series (channelDaily) so each channel's sparkline and
// hover reflect that channel. Orders/revenue daily are the page's real daily
// series allocated by the channel's *per-day* session share (varies day to
// day, so the shape differs per channel) — a labeled allocation, since Shopify
// has no per-channel order attribution. When channelDaily is missing for a
// channel we fall back to the old constant-share scaling. Year-ago is 0 —
// not available per channel.
function buildChannelCards(
  sources: SourceBreakdownRow[],
  page: { sessions: Bucket; convRate: Bucket; orders: Bucket; revenue: Bucket },
  channelDaily: Map<string, ChannelDailyPoint[]>,
): ChannelCard[] {
  const totalCur = sources.reduce((s, r) => s + r.sessions, 0);
  const totalPrior = sources.reduce((s, r) => s + r.priorSessions, 0);
  const scale = (daily: DailyPoint[], f: number): DailyPoint[] =>
    daily.map((p) => ({ date: p.date, value: p.value * f }));
  const last = (d: DailyPoint[]) => (d.length ? d[d.length - 1].value : 0);
  const last7 = (d: DailyPoint[]) => d.slice(-7).reduce((s, p) => s + p.value, 0);
  const bucket = (current: number, prior: number, daily: DailyPoint[]): Bucket => ({
    current,
    prior,
    yesterday: last(daily),
    sevenDayTotal: last7(daily),
    yearAgo: 0,
    daily,
  });

  // Total real per-channel sessions per day (denominator for daily share).
  const totalSessByDate = new Map<string, number>();
  for (const pts of channelDaily.values()) {
    for (const p of pts) totalSessByDate.set(p.date, (totalSessByDate.get(p.date) ?? 0) + p.sessions);
  }

  return sources.map((r) => {
    const shareCur = totalCur > 0 ? r.sessions / totalCur : 0;
    const sharePrior = totalPrior > 0 ? r.priorSessions / totalPrior : 0;
    const priorOrders = r.priorSessions * (r.priorConvRate / 100);
    const priorRevenue = page.revenue.prior * sharePrior;

    const chDaily = channelDaily.get(r.source);
    const chSessByDate = new Map<string, number>();
    const chConvByDate = new Map<string, number>();
    if (chDaily) {
      for (const p of chDaily) {
        chSessByDate.set(p.date, p.sessions);
        chConvByDate.set(p.date, p.convRate);
      }
    }
    // Per-day allocation factor from real channel session share that day.
    const dayShare = (date: string): number => {
      const tot = totalSessByDate.get(date) ?? 0;
      return tot > 0 ? (chSessByDate.get(date) ?? 0) / tot : 0;
    };

    let sessions: Bucket;
    let convRate: Bucket;
    let orders: Bucket;
    let revenue: Bucket;

    if (chDaily && chDaily.length > 0) {
      // Real per-channel daily sessions/conv; allocate orders/revenue by daily share.
      const sessDaily = page.sessions.daily.map((p) => ({ date: p.date, value: chSessByDate.get(p.date) ?? 0 }));
      const convDaily = page.convRate.daily.map((p) => ({ date: p.date, value: chConvByDate.get(p.date) ?? 0 }));
      const ordDaily = page.orders.daily.map((p) => ({ date: p.date, value: p.value * dayShare(p.date) }));
      const revDaily = page.revenue.daily.map((p) => ({ date: p.date, value: p.value * dayShare(p.date) }));
      sessions = bucket(r.sessions, r.priorSessions, sessDaily);
      orders = bucket(r.orders, priorOrders, ordDaily);
      revenue = bucket(r.revenue, priorRevenue, revDaily);
      // Conversion is a rate: yesterday = last day's rate; 7-day tile = the
      // session-weighted rate over the last 7 days (Σ implied orders ÷ Σ
      // sessions), not a sum of daily rates.
      const last7Sess = sessDaily.slice(-7).reduce((s, p) => s + p.value, 0);
      const last7Ord = sessDaily.slice(-7).reduce((s, p, i, arr) => {
        const idx = sessDaily.length - arr.length + i;
        return s + p.value * ((convDaily[idx]?.value ?? 0) / 100);
      }, 0);
      convRate = {
        current: r.convRate,
        prior: r.priorConvRate,
        yesterday: convDaily.length ? convDaily[convDaily.length - 1].value : 0,
        sevenDayTotal: last7Sess > 0 ? (last7Ord / last7Sess) * 100 : 0,
        yearAgo: 0,
        daily: convDaily,
      };
    } else {
      // Fallback (channel had no daily rows): old constant-share scaling.
      sessions = bucket(r.sessions, r.priorSessions, scale(page.sessions.daily, shareCur));
      orders = bucket(r.orders, priorOrders, scale(page.orders.daily, shareCur));
      revenue = bucket(r.revenue, priorRevenue, scale(page.revenue.daily, shareCur));
      convRate = {
        current: r.convRate,
        prior: r.priorConvRate,
        yesterday: page.convRate.yesterday,
        sevenDayTotal: page.convRate.sevenDayTotal,
        yearAgo: 0,
        daily: page.convRate.daily,
      };
    }

    // AOV is a rate, not a sum — divide revenue by orders at each aggregate
    // level (so the "7-day" tile is 7-day revenue ÷ 7-day orders, an AOV,
    // not the sum of daily AOVs). Mirrors deriveAovBucket.
    const aov: Bucket = {
      current: orders.current > 0 ? revenue.current / orders.current : 0,
      prior: orders.prior > 0 ? revenue.prior / orders.prior : 0,
      yesterday: orders.yesterday > 0 ? revenue.yesterday / orders.yesterday : 0,
      sevenDayTotal: orders.sevenDayTotal > 0 ? revenue.sevenDayTotal / orders.sevenDayTotal : 0,
      yearAgo: 0,
      daily: revenue.daily.map((p, i) => {
        const o = orders.daily[i]?.value ?? 0;
        return { date: p.date, value: o > 0 ? p.value / o : 0 };
      }),
    };
    return { channel: r.source, sessions, convRate, orders, revenue, aov };
  });
}

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
  ydayPending: boolean;
  dbeforePending: boolean;
  latestLoaded: string | null;
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
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -2, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AND CREATED_AT < DATEADD(day, -1, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS DBEFORE_REVENUE,
        -- Pipeline freshness: brand-level latest loaded order (not path-scoped,
        -- so it reflects the data-team job, not this page's own gaps).
        (SELECT MAX(CREATED_AT) FROM classified) < DATEADD(day, -1, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS YDAY_PENDING,
        (SELECT MAX(CREATED_AT) FROM classified) < DATEADD(day, -2, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS DBEFORE_PENDING,
        TO_VARCHAR((SELECT MAX(CREATED_AT) FROM classified), 'YYYY-MM-DD') AS LATEST_LOADED
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
    ydayPending: r?.YDAY_PENDING === true,
    dbeforePending: r?.DBEFORE_PENDING === true,
    latestLoaded: r?.LATEST_LOADED ?? null,
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

type DailySessionRow = {
  D: string;
  SESSIONS: number | string | null;
  CONVERSION_RATE: number | string | null;
};

// Per-page daily session series, preferring our own Snowflake history
// (BOCO_DASHBOARD.SESSIONS.DAILY_SESSIONS, populated by the daily sync) so
// the rich cards aren't capped at ShopifyQL's ~28-day retention. Falls back
// to live ShopifyQL when the table has no rows for this path yet (e.g. a
// page the sync hasn't seen, or before the backfill reached it).
async function getPageSessionSeries(
  brand: Brand,
  path: string,
  days: number,
): Promise<SessionDailyPoint[]> {
  try {
    const rows = await execute<DailySessionRow>(
      `
        SELECT
          TO_VARCHAR(ACTIVITY_DATE, 'YYYY-MM-DD') AS D,
          SESSIONS,
          CONVERSION_RATE
        FROM BOCO_DASHBOARD.SESSIONS.DAILY_SESSIONS
        WHERE BRAND = ?
          AND LANDING_PATH = ?
          AND ACTIVITY_DATE >= DATEADD(day, -?, CURRENT_DATE())
        ORDER BY ACTIVITY_DATE
      `,
      [brand, path, days],
    );
    if (rows.length > 0) {
      // Stored CONVERSION_RATE is a decimal fraction (orders/sessions), so
      // ordersImplied = sessions × rate matches the ShopifyQL path's shape.
      const snow: SessionDailyPoint[] = rows.map((r) => {
        const sessions = n(r.SESSIONS);
        const rate = Number(r.CONVERSION_RATE) || 0;
        return { date: r.D, sessions, ordersImplied: sessions * rate };
      });
      // DAILY_SESSIONS is synced once a day, so it lags ~a day (yesterday
      // isn't in it yet in the morning → "yesterday" tiles read 0 and the
      // sparkline drops to 0). Overlay live ShopifyQL for the recent days so
      // the tail is fresh; Snowflake still provides the long history.
      const ql = await getPageSessionTimeSeries(brand, path, days).catch(() => []);
      if (ql.length === 0) return snow;
      const byDate = new Map(snow.map((p) => [p.date, p]));
      for (const p of ql) byDate.set(p.date, p); // ShopifyQL wins on overlap (fresher)
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    }
  } catch {
    // Table missing / query error → degrade to ShopifyQL below.
  }
  return getPageSessionTimeSeries(brand, path, days).catch(() => []);
}

type VariantRow = {
  VARIANT_ID: string | null;
  SKU: string | null;
  UNITS: number | string | null;
  REVENUE: number | string | null;
  ORDERS: number | string | null;
};

// Per-variant sales for a PDP's product, product-scoped: every web order in
// the window that contains a line item of this product. Variant titles come
// from the Admin API (Snowflake line items have no variant title). Returns
// [] for non-product pages, uninstalled brands, or single-variant products.
async function getVariantBreakdown(
  brand: Brand,
  path: string,
  period: Period,
): Promise<VariantSalesRow[]> {
  const product = await getProductVariants(brand, path);
  if (!product) return [];

  const rows = await execute<VariantRow>(
    `
      WITH bounds AS (
        SELECT
          DATE_TRUNC('day', CURRENT_TIMESTAMP()) AS today_start,
          DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())) AS current_start
      )
      SELECT
        li.VARIANT_ID AS VARIANT_ID,
        ANY_VALUE(li.SKU) AS SKU,
        SUM(li.QUANTITY) AS UNITS,
        SUM(li.QUANTITY * li.PRICE_AMOUNT) AS REVENUE,
        COUNT(DISTINCT o.ID) AS ORDERS
      FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS_ITEMS li
      JOIN DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o ON li.ORDER_ID = o.ID
      , bounds b
      WHERE o.BRAND = ?
        AND o.SOURCE_NAME = 'web'
        AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
        AND o.CREATED_AT >= b.current_start
        AND o.CREATED_AT < b.today_start
        AND li.PRODUCT_ID = ?
        -- Page-scoped: only orders that LANDED on this page (matches the
        -- page's other cards). The product-wide variant view lives on the
        -- Layer 2 Top Products tab instead.
        AND REGEXP_REPLACE(SPLIT_PART(o.LANDING_SITE, '?', 1), '(^https?://[^/]+)|/$', '') = ?
      GROUP BY li.VARIANT_ID
      HAVING SUM(li.QUANTITY) > 0
      ORDER BY REVENUE DESC NULLS LAST
    `,
    [period, brand, product.productId, path],
  );

  const totalRevenue = rows.reduce((s, r) => s + n(r.REVENUE), 0) || 0;
  const mapped: VariantSalesRow[] = rows.map((r) => {
    const variantId = r.VARIANT_ID ? String(r.VARIANT_ID) : '';
    const meta = product.variants[variantId];
    const sku = meta?.sku ?? (r.SKU || null);
    const title =
      meta?.title?.trim() ||
      (sku ? `SKU ${sku}` : variantId ? `Variant #${variantId}` : 'Unknown variant');
    const revenue = n(r.REVENUE);
    const orders = n(r.ORDERS);
    return {
      variantId,
      title,
      sku,
      units: n(r.UNITS),
      orders,
      revenue,
      aov: orders > 0 ? revenue / orders : 0,
      revenueShare: totalRevenue > 0 ? revenue / totalRevenue : 0,
    };
  });
  // Only meaningful when the product actually has a variant split.
  return mapped.length > 1 ? mapped : [];
}

export async function getPageDeepDive(
  brand: Brand,
  path: string,
  period: Period,
): Promise<PageDeepDive> {
  // Bump the version when the PageDeepDive shape changes so stale cached
  // objects (missing newer fields like activeTests) can't be served.
  return withCache(
    `deepdive:${brand}:${period}:${encodeURIComponent(path)}:v17`,
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
    igEnded,
    variants,
    channelDaily,
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
      ydayPending: false,
      dbeforePending: false,
      latestLoaded: null,
    })),
    getActiveTests(brand).catch(() => [] as ActiveTest[]),
    getPageBuckets(brand, path, period).catch(() => ({
      orders: emptyBucket,
      revenue: emptyBucket,
      subRevenue: emptyBucket,
    })),
    // ~13-month per-page session series for the rich Sessions/Conv cards.
    // Prefers Snowflake DAILY_SESSIONS (full history), falls back to ShopifyQL.
    getPageSessionSeries(brand, path, 365 + period).catch(() => []),
    getEndedTests(brand).catch(() => [] as ActiveTest[]),
    getVariantBreakdown(brand, path, period).catch(() => [] as VariantSalesRow[]),
    // Real per-channel daily sessions + conversion for this page (drives the
    // channel-filter sparklines/hover). Empty map -> buildChannelCards falls
    // back to the old constant-share scaling.
    getChannelDailyByPath(brand, path, period).catch(
      () => new Map<string, ChannelDailyPoint[]>(),
    ),
  ]);

  // Allocate the page's real (Snowflake) revenue across channels in
  // proportion to each channel's converting sessions (implied orders).
  // Shopify can't give per-page revenue-by-channel, so this first-touch
  // model distributes the page's actual revenue — it sums to orders.currentRev.
  const totalImpliedOrders = sourceBreakdown.reduce((s, r) => s + r.orders, 0);
  const sourceBreakdownWithRev =
    totalImpliedOrders > 0
      ? sourceBreakdown.map((r) => ({
          ...r,
          revenue: orders.currentRev * (r.orders / totalImpliedOrders),
        }))
      : sourceBreakdown;

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

  // Per-channel card data for the "filter by channel" dropdown above the
  // cards. Sessions/conversion sparklines use REAL per-channel daily series
  // (channelDaily); orders/revenue are the page's daily allocated by the
  // channel's per-day session share. Current/prior are exact per channel
  // (sessions/conv/orders) or allocated (revenue). Year-ago isn't available
  // per channel.
  const channelCards = buildChannelCards(
    sourceBreakdownWithRev,
    { sessions: sessionsBucket, convRate: convRateBucket, orders: buckets.orders, revenue: buckets.revenue },
    channelDaily,
  );

  // Intelligems tests located to this page. The redirect (origin/dest)
  // match drives the header pill; the full list (incl. on-site edits
  // targeting this URL) feeds the deep-dive "Active A/B tests" section.
  const onPage = matchActiveTestsForPath(igActive, path);
  // Manually-attached tests (template/product-targeted ones the team
  // pinned to this page) that auto-detection didn't already surface.
  const [attachedIds, dismissedIdArr] = await Promise.all([
    getAttachedTestIds(brand, path).catch(() => [] as string[]),
    getDismissedTestIds(brand, path).catch(() => [] as string[]),
  ]);
  const dismissedIds = new Set(dismissedIdArr);
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
  // Dismissed located tests are pulled out of the prominent list and shown
  // (restorable) in the accordion instead.
  const shown = combined.filter(({ t }) => !dismissedIds.has(t.id));
  const roleFor = (t: ActiveTest) =>
    (t.origins.includes(path)
      ? 'origin'
      : t.destinations.includes(path)
        ? 'destination'
        : 'targeted') as 'origin' | 'destination' | 'targeted';
  const activeTests = await Promise.all(
    shown.map(async ({ t, manual }) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      testUrl: t.testUrl,
      role: roleFor(t),
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
  const dismissedTests = combined
    .filter(({ t }) => dismissedIds.has(t.id))
    .map(({ t }) => ({ id: t.id, name: t.name, type: t.type, testUrl: t.testUrl }));

  // Ended/prior tests located to this page (cap the results fetches).
  const endedOnPage = matchActiveTestsForPath(igEnded, path).slice(0, 8);
  const endedTests = await Promise.all(
    endedOnPage.map(async (t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      testUrl: t.testUrl,
      role: roleFor(t),
      results: await getExperienceResults(brand, t.id).catch(() => null),
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
      yesterday: {
        orders: orders.ydayCount,
        revenue: orders.ydayRev,
        pending: orders.ydayPending,
      },
      dayBefore: {
        orders: orders.dbeforeCount,
        revenue: orders.dbeforeRev,
        pending: orders.dbeforePending,
      },
      latestLoaded: orders.latestLoaded,
    },
    sourceBreakdown: sourceBreakdownWithRev,
    clarity: clarityMap.get(path) ?? null,
    activePromos,
    intelligemsTest,
    activeTests,
    allIntelligemsTests,
    endedTests,
    dismissedTests,
    variants,
    channelCards,
  };
}
