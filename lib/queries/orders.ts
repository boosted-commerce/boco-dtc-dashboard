import { execute } from '@/lib/snowflake';
import { getSessionTimeSeries, type SessionDailyPoint } from '@/lib/shopify';

export type Period = 7 | 28 | 90;
export const PERIODS: readonly Period[] = [7, 28, 90] as const;

export function parsePeriod(raw: unknown): Period {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return PERIODS.find((p) => p === n) ?? 28;
}

export const BRANDS = ['ASN', 'VIV', 'PRL'] as const;
export type Brand = (typeof BRANDS)[number];

export function parseBrand(raw: unknown): Brand {
  return (BRANDS as readonly string[]).includes(raw as string) ? (raw as Brand) : 'ASN';
}

// Sales-channel filter. 'all' = every channel (current behavior), 'dtc' =
// Shopify Online Store only (SOURCE_NAME='web'). Subscription metrics are
// already web-scoped so this only affects Orders / Revenue / AOV.
export const SOURCES = ['all', 'dtc'] as const;
export type SourceFilter = (typeof SOURCES)[number];

export function parseSource(raw: unknown): SourceFilter {
  return (SOURCES as readonly string[]).includes(raw as string)
    ? (raw as SourceFilter)
    : 'all';
}

export type DailyPoint = { date: string; value: number };

export type Bucket = {
  current: number;
  prior: number;
  yesterday: number;
  sevenDayTotal: number;
  yearAgo: number;
  daily: DailyPoint[];
};

export type SubBucket = {
  current: number;
  prior: number;
  daily: DailyPoint[];
};

export type TopSubProduct = {
  product: string;
  newSubscriptions: number;
  firstOrderRevenue: number;
};

export type ChannelMixRow = {
  channel: string;
  currentRevenue: number;
  priorRevenue: number;
  sharePct: number;
};

export type ChannelMix = {
  channels: ChannelMixRow[];
  totalCurrent: number;
  totalPrior: number;
};

export type StoreOverview = {
  brand: Brand;
  period: Period;
  source: SourceFilter;
  channelMix: ChannelMix;
  orders: Bucket;
  revenue: Bucket;
  aov: Bucket;
  subscriptionShare: SubBucket;
  subscriptionRevenue: Bucket;
  recurringRevenue: Bucket;
  newSubscriptions: SubBucket;
  topSubscriptionProducts: TopSubProduct[];
  // ShopifyQL-sourced. Null when the brand has no Shopify install yet
  // (graceful degrade — Layer 1 still renders the Snowflake-backed cards).
  sessions: Bucket | null;
  convRate: Bucket | null;
};

const n = (v: unknown) => Number(v ?? 0);

// All windows are aligned to calendar-day boundaries and END at start-of-today
// (i.e., exclude any in-progress current day). Shopify queries also exclude
// Faire (B2B wholesale) orders so the dashboard reflects DTC only.

type ShopifyAggRow = {
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
  // Used for the Subscription Share % card (web sub revenue / web revenue).
  // The "Subscription Revenue $" / "Recurring Revenue $" cards are sourced
  // from Recharge instead — see getRechargeAggregates.
  SUB_REV_CURRENT: number | string | null;
  SUB_REV_PRIOR: number | string | null;
  WEB_REV_CURRENT: number | string | null;
  WEB_REV_PRIOR: number | string | null;
};

async function getShopifyAggregates(
  brand: Brand,
  period: Period,
  source: SourceFilter,
) {
  const sourceFilter = source === 'dtc' ? "AND o.SOURCE_NAME = 'web'" : '';
  const rows = await execute<ShopifyAggRow>(
    `
      WITH bounds AS (
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
        COUNT_IF(o.CREATED_AT >= b.current_start AND o.CREATED_AT < b.today_start) AS ORDERS_CURRENT,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.current_start AND o.CREATED_AT < b.today_start, o.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_CURRENT,
        COUNT_IF(o.CREATED_AT >= b.prior_start AND o.CREATED_AT < b.current_start) AS ORDERS_PRIOR,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.prior_start AND o.CREATED_AT < b.current_start, o.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_PRIOR,
        COUNT_IF(o.CREATED_AT >= b.yesterday_start AND o.CREATED_AT < b.today_start) AS ORDERS_YESTERDAY,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.yesterday_start AND o.CREATED_AT < b.today_start, o.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_YESTERDAY,
        COUNT_IF(o.CREATED_AT >= b.seven_day_start AND o.CREATED_AT < b.today_start) AS ORDERS_7D,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.seven_day_start AND o.CREATED_AT < b.today_start, o.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_7D,
        COUNT_IF(o.CREATED_AT >= b.year_ago_start AND o.CREATED_AT < b.year_ago_end) AS ORDERS_YEAR_AGO,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.year_ago_start AND o.CREATED_AT < b.year_ago_end, o.TOTAL_PRICE_AMOUNT, 0)), 0) AS REVENUE_YEAR_AGO,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.current_start AND o.CREATED_AT < b.today_start AND o.IS_SUBSCRIPTION = TRUE AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS SUB_REV_CURRENT,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.prior_start AND o.CREATED_AT < b.current_start AND o.IS_SUBSCRIPTION = TRUE AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS SUB_REV_PRIOR,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.current_start AND o.CREATED_AT < b.today_start AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS WEB_REV_CURRENT,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.prior_start AND o.CREATED_AT < b.current_start AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS WEB_REV_PRIOR
      FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o, bounds b
      WHERE o.BRAND = ?
        AND o.CREATED_AT >= b.year_ago_start
        AND o.CREATED_AT < b.today_start
        AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
        ${sourceFilter}
    `,
    [period, period * 2, 365 + period, brand],
  );
  return rows[0] ?? ({} as ShopifyAggRow);
}

type DailyRow = {
  D: string;
  ORDERS: number | string | null;
  REVENUE: number | string | null;
  SUB_REV: number | string | null;
  TOTAL_REV: number | string | null;
};

async function getShopifyDaily(
  brand: Brand,
  period: Period,
  source: SourceFilter,
): Promise<DailyRow[]> {
  const sourceFilter = source === 'dtc' ? "AND SOURCE_NAME = 'web'" : '';
  return execute<DailyRow>(
    `
      SELECT
        TO_VARCHAR(DATE(CREATED_AT), 'YYYY-MM-DD') AS D,
        COUNT(*) AS ORDERS,
        COALESCE(SUM(TOTAL_PRICE_AMOUNT), 0) AS REVENUE,
        COALESCE(SUM(IFF(IS_SUBSCRIPTION = TRUE AND SOURCE_NAME = 'web', TOTAL_PRICE_AMOUNT, 0)), 0) AS SUB_REV,
        COALESCE(SUM(IFF(SOURCE_NAME = 'web', TOTAL_PRICE_AMOUNT, 0)), 0) AS TOTAL_REV
      FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS
      WHERE BRAND = ?
        AND CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
        AND CREATED_AT < DATE_TRUNC('day', CURRENT_TIMESTAMP())
        AND (IS_FAIRE_ORDER = FALSE OR IS_FAIRE_ORDER IS NULL)
        ${sourceFilter}
      GROUP BY DATE(CREATED_AT)
      ORDER BY DATE(CREATED_AT)
    `,
    [brand, period],
  );
}

type RechargeAggRow = {
  NEW_SUBS_CURRENT: number | string | null;
  NEW_SUBS_PRIOR: number | string | null;
  NEW_SUB_REV_CURRENT: number | string | null;
  NEW_SUB_REV_PRIOR: number | string | null;
  NEW_SUB_REV_YESTERDAY: number | string | null;
  NEW_SUB_REV_7D: number | string | null;
  NEW_SUB_REV_YEAR_AGO: number | string | null;
  REC_REV_CURRENT: number | string | null;
  REC_REV_PRIOR: number | string | null;
  REC_REV_YESTERDAY: number | string | null;
  REC_REV_7D: number | string | null;
  REC_REV_YEAR_AGO: number | string | null;
};

async function getRechargeAggregates(brand: Brand, period: Period) {
  // Single pass over RECHARGE_ORDERS covering both metric families:
  //   - NEW_SUBS_* counts rows where TYPE='checkout' (new sign-ups)
  //   - REC_REV_*  sums LINE_ITEMS_TOTAL_PRICE where TYPE='recurring' (renewals)
  // Common filters (subscription line items, success status) live in the WHERE.
  const rows = await execute<RechargeAggRow>(
    `
      WITH bounds AS (
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
        COUNT_IF(r.TYPE = 'checkout' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.current_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start) AS NEW_SUBS_CURRENT,
        COUNT_IF(r.TYPE = 'checkout' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.prior_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.current_start) AS NEW_SUBS_PRIOR,
        COALESCE(SUM(IFF(r.TYPE = 'checkout' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.current_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS NEW_SUB_REV_CURRENT,
        COALESCE(SUM(IFF(r.TYPE = 'checkout' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.prior_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.current_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS NEW_SUB_REV_PRIOR,
        COALESCE(SUM(IFF(r.TYPE = 'checkout' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.yesterday_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS NEW_SUB_REV_YESTERDAY,
        COALESCE(SUM(IFF(r.TYPE = 'checkout' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.seven_day_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS NEW_SUB_REV_7D,
        COALESCE(SUM(IFF(r.TYPE = 'checkout' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.year_ago_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.year_ago_end, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS NEW_SUB_REV_YEAR_AGO,
        COALESCE(SUM(IFF(r.TYPE = 'recurring' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.current_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS REC_REV_CURRENT,
        COALESCE(SUM(IFF(r.TYPE = 'recurring' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.prior_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.current_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS REC_REV_PRIOR,
        COALESCE(SUM(IFF(r.TYPE = 'recurring' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.yesterday_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS REC_REV_YESTERDAY,
        COALESCE(SUM(IFF(r.TYPE = 'recurring' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.seven_day_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS REC_REV_7D,
        COALESCE(SUM(IFF(r.TYPE = 'recurring' AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.year_ago_start AND TO_TIMESTAMP(r.PROCESSED_AT) < b.year_ago_end, r.LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS REC_REV_YEAR_AGO
      FROM DW_ANALYTICS.FACT.RECHARGE_ORDERS r, bounds b
      WHERE r.BRAND = ?
        AND r.LINE_ITEMS_PURCHASE_ITEM_TYPE = 'subscription'
        AND r.STATUS = 'success'
        AND TO_TIMESTAMP(r.PROCESSED_AT) >= b.year_ago_start
        AND TO_TIMESTAMP(r.PROCESSED_AT) < b.today_start
    `,
    [period, period * 2, 365 + period, brand],
  );
  return rows[0] ?? ({} as RechargeAggRow);
}

type RechargeDailyRow = {
  D: string;
  NEW_SUBS: number | string | null;
  NEW_SUB_REV: number | string | null;
  RECURRING_REV: number | string | null;
};

async function getRechargeDaily(brand: Brand, period: Period): Promise<RechargeDailyRow[]> {
  return execute<RechargeDailyRow>(
    `
      SELECT
        TO_VARCHAR(DATE(TO_TIMESTAMP(PROCESSED_AT)), 'YYYY-MM-DD') AS D,
        COUNT_IF(TYPE = 'checkout') AS NEW_SUBS,
        COALESCE(SUM(IFF(TYPE = 'checkout', LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS NEW_SUB_REV,
        COALESCE(SUM(IFF(TYPE = 'recurring', LINE_ITEMS_TOTAL_PRICE, 0)), 0) AS RECURRING_REV
      FROM DW_ANALYTICS.FACT.RECHARGE_ORDERS
      WHERE BRAND = ?
        AND LINE_ITEMS_PURCHASE_ITEM_TYPE = 'subscription'
        AND STATUS = 'success'
        AND TO_TIMESTAMP(PROCESSED_AT) >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
        AND TO_TIMESTAMP(PROCESSED_AT) < DATE_TRUNC('day', CURRENT_TIMESTAMP())
      GROUP BY DATE(TO_TIMESTAMP(PROCESSED_AT))
      ORDER BY DATE(TO_TIMESTAMP(PROCESSED_AT))
    `,
    [brand, period],
  );
}

type TopProductRow = {
  PRODUCT: string | null;
  NEW_SUBSCRIPTIONS: number | string | null;
  FIRST_ORDER_REVENUE: number | string | null;
};

async function getTopSubscriptionProducts(
  brand: Brand,
  period: Period,
): Promise<TopSubProduct[]> {
  const rows = await execute<TopProductRow>(
    `
      SELECT
        LINE_ITEMS_TITLE AS PRODUCT,
        COUNT(*) AS NEW_SUBSCRIPTIONS,
        COALESCE(SUM(LINE_ITEMS_TOTAL_PRICE), 0) AS FIRST_ORDER_REVENUE
      FROM DW_ANALYTICS.FACT.RECHARGE_ORDERS
      WHERE BRAND = ?
        AND TYPE = 'checkout'
        AND LINE_ITEMS_PURCHASE_ITEM_TYPE = 'subscription'
        AND STATUS = 'success'
        AND TO_TIMESTAMP(PROCESSED_AT) >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
        AND TO_TIMESTAMP(PROCESSED_AT) < DATE_TRUNC('day', CURRENT_TIMESTAMP())
      GROUP BY LINE_ITEMS_TITLE
      ORDER BY NEW_SUBSCRIPTIONS DESC
      LIMIT 5
    `,
    [brand, period],
  );
  return rows.map((r) => ({
    product: r.PRODUCT ?? '(untitled)',
    newSubscriptions: n(r.NEW_SUBSCRIPTIONS),
    firstOrderRevenue: n(r.FIRST_ORDER_REVENUE),
  }));
}

// Channel mix — all-channel revenue breakdown for scope framing.
// Calendar-day boundaries match other metrics; period-aware.
type ChannelRow = {
  CHANNEL: string | null;
  CURRENT_REV: number | string | null;
  PRIOR_REV: number | string | null;
};

async function getChannelMix(brand: Brand, period: Period): Promise<ChannelMix> {
  const rows = await execute<ChannelRow>(
    `
      WITH classified AS (
        SELECT
          CASE
            WHEN IS_FAIRE_ORDER = TRUE OR SOURCE_NAME = 'faire' THEN 'Faire'
            WHEN SOURCE_NAME = 'web' THEN 'DTC'
            WHEN SOURCE_NAME = 'tiktok' THEN 'TikTok'
            ELSE 'Other'
          END AS CHANNEL,
          CREATED_AT,
          TOTAL_PRICE_AMOUNT
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS
        WHERE BRAND = ?
          AND CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
          AND CREATED_AT < DATE_TRUNC('day', CURRENT_TIMESTAMP())
      )
      SELECT
        CHANNEL,
        COALESCE(SUM(IFF(CREATED_AT >= DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS CURRENT_REV,
        COALESCE(SUM(IFF(CREATED_AT < DATEADD(day, -?, DATE_TRUNC('day', CURRENT_TIMESTAMP())), TOTAL_PRICE_AMOUNT, 0)), 0) AS PRIOR_REV
      FROM classified
      GROUP BY CHANNEL
    `,
    [brand, period * 2, period, period],
  );

  const totalCurrent = rows.reduce((s, r) => s + n(r.CURRENT_REV), 0);
  const totalPrior = rows.reduce((s, r) => s + n(r.PRIOR_REV), 0);

  const channels: ChannelMixRow[] = rows
    .map((r) => {
      const currentRevenue = n(r.CURRENT_REV);
      return {
        channel: r.CHANNEL ?? 'Other',
        currentRevenue,
        priorRevenue: n(r.PRIOR_REV),
        sharePct: totalCurrent > 0 ? (100 * currentRevenue) / totalCurrent : 0,
      };
    })
    .filter((c) => c.currentRevenue > 0)
    .sort((a, b) => b.currentRevenue - a.currentRevenue);

  return { channels, totalCurrent, totalPrior };
}

// Compute a Bucket from a daily SessionDailyPoint series. The window
// boundaries match the calendar-day pattern used for every other Bucket:
// current ends at start-of-today (excludes in-progress today).
function bucketFromTimeSeries(
  series: SessionDailyPoint[],
  period: Period,
  metric: 'sessions' | 'convRate',
): Bucket {
  // Today (exclusive end) — we don't include today's partial data so the
  // bucket aligns with the Snowflake-derived cards.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dayInMs = 24 * 60 * 60 * 1000;
  const todayMs = today.getTime();
  const offset = (n: number) => new Date(todayMs - n * dayInMs).toISOString().slice(0, 10);

  // Build a date -> data map for fast lookups.
  const byDate = new Map<string, SessionDailyPoint>();
  for (const p of series) byDate.set(p.date, p);

  // Window aggregator. Sums sessions + ordersImplied between [from, to)
  // (date strings compared lexicographically — YYYY-MM-DD sorts correctly).
  const sum = (from: string, to: string) => {
    let sessions = 0;
    let orders = 0;
    for (const p of series) {
      if (p.date >= from && p.date < to) {
        sessions += p.sessions;
        orders += p.ordersImplied;
      }
    }
    return { sessions, orders };
  };

  const value = (windowSessions: number, windowOrders: number): number => {
    if (metric === 'sessions') return windowSessions;
    return windowSessions > 0 ? (windowOrders / windowSessions) * 100 : 0;
  };

  const todayStr = offset(0);
  const currentStart = offset(period);
  const priorStart = offset(period * 2);
  const yesterdayStart = offset(1);
  const sevenDayStart = offset(7);
  const yearAgoEnd = offset(365);
  const yearAgoStart = offset(365 + period);

  const current = sum(currentStart, todayStr);
  const prior = sum(priorStart, currentStart);
  const yesterday = sum(yesterdayStart, todayStr);
  const sevenDay = sum(sevenDayStart, todayStr);
  const yearAgo = sum(yearAgoStart, yearAgoEnd);

  const daily: DailyPoint[] = [];
  for (let i = period - 1; i >= 0; i--) {
    const d = offset(i + 1);
    const p = byDate.get(d);
    if (p) {
      daily.push({
        date: d,
        value:
          metric === 'sessions'
            ? p.sessions
            : p.sessions > 0
              ? (p.ordersImplied / p.sessions) * 100
              : 0,
      });
    } else {
      daily.push({ date: d, value: 0 });
    }
  }

  return {
    current: value(current.sessions, current.orders),
    prior: value(prior.sessions, prior.orders),
    yesterday: value(yesterday.sessions, yesterday.orders),
    sevenDayTotal: value(sevenDay.sessions, sevenDay.orders),
    yearAgo: value(yearAgo.sessions, yearAgo.orders),
    daily,
  };
}

export async function getStoreOverview(
  brand: Brand = 'ASN',
  period: Period = 28,
  source: SourceFilter = 'all',
): Promise<StoreOverview> {
  const [agg, daily, rechargeAgg, rechargeDaily, topProducts, channelMix, sessionSeries] =
    await Promise.all([
      getShopifyAggregates(brand, period, source),
      getShopifyDaily(brand, period, source),
      getRechargeAggregates(brand, period),
      getRechargeDaily(brand, period),
      getTopSubscriptionProducts(brand, period),
      getChannelMix(brand, period),
      // Pull ~year-back daily series so all comparison windows can be derived.
      getSessionTimeSeries(brand, 365 + period),
    ]);

  const ordersDaily: DailyPoint[] = daily.map((r) => ({ date: r.D, value: n(r.ORDERS) }));
  const revenueDaily: DailyPoint[] = daily.map((r) => ({ date: r.D, value: n(r.REVENUE) }));
  const aovDaily: DailyPoint[] = daily.map((r) => {
    const o = n(r.ORDERS);
    const rev = n(r.REVENUE);
    return { date: r.D, value: o > 0 ? rev / o : 0 };
  });
  const subShareDaily: DailyPoint[] = daily.map((r) => {
    const sub = n(r.SUB_REV);
    const tot = n(r.TOTAL_REV);
    return { date: r.D, value: tot > 0 ? (100 * sub) / tot : 0 };
  });
  // Subscription Revenue daily = new-sub first-order revenue + recurring renewals
  // (total subscription business per day). Recurring is shown separately as a
  // subset card.
  const subRevenueDaily: DailyPoint[] = rechargeDaily.map((r) => ({
    date: r.D,
    value: n(r.NEW_SUB_REV) + n(r.RECURRING_REV),
  }));
  const newSubsDaily: DailyPoint[] = rechargeDaily.map((r) => ({
    date: r.D,
    value: n(r.NEW_SUBS),
  }));
  const recurringRevDaily: DailyPoint[] = rechargeDaily.map((r) => ({
    date: r.D,
    value: n(r.RECURRING_REV),
  }));

  const ordersCurrent = n(agg.ORDERS_CURRENT);
  const ordersPrior = n(agg.ORDERS_PRIOR);
  const revenueCurrent = n(agg.REVENUE_CURRENT);
  const revenuePrior = n(agg.REVENUE_PRIOR);
  const ordersYesterday = n(agg.ORDERS_YESTERDAY);
  const revenueYesterday = n(agg.REVENUE_YESTERDAY);
  const orders7d = n(agg.ORDERS_7D);
  const revenue7d = n(agg.REVENUE_7D);
  const ordersYearAgo = n(agg.ORDERS_YEAR_AGO);
  const revenueYearAgo = n(agg.REVENUE_YEAR_AGO);
  const subRevCurrent = n(agg.SUB_REV_CURRENT);
  const subRevPrior = n(agg.SUB_REV_PRIOR);
  const webRevCurrent = n(agg.WEB_REV_CURRENT);
  const webRevPrior = n(agg.WEB_REV_PRIOR);

  const aov = (rev: number, ord: number) => (ord > 0 ? rev / ord : 0);

  const orders: Bucket = {
    current: ordersCurrent,
    prior: ordersPrior,
    yesterday: ordersYesterday,
    sevenDayTotal: orders7d,
    yearAgo: ordersYearAgo,
    daily: ordersDaily,
  };
  const revenue: Bucket = {
    current: revenueCurrent,
    prior: revenuePrior,
    yesterday: revenueYesterday,
    sevenDayTotal: revenue7d,
    yearAgo: revenueYearAgo,
    daily: revenueDaily,
  };
  const aovBucket: Bucket = {
    current: aov(revenueCurrent, ordersCurrent),
    prior: aov(revenuePrior, ordersPrior),
    yesterday: aov(revenueYesterday, ordersYesterday),
    sevenDayTotal: aov(revenue7d, orders7d),
    yearAgo: aov(revenueYearAgo, ordersYearAgo),
    daily: aovDaily,
  };
  const subscriptionShare: SubBucket = {
    current: webRevCurrent > 0 ? (100 * subRevCurrent) / webRevCurrent : 0,
    prior: webRevPrior > 0 ? (100 * subRevPrior) / webRevPrior : 0,
    daily: subShareDaily,
  };
  // Total subscription business revenue (new sign-ups + renewals), from
  // Recharge. Recurring Revenue is shown alongside as the renewals subset;
  // Sub Rev − Recurring = new sign-up first-order revenue.
  const subscriptionRevenue: Bucket = {
    current: n(rechargeAgg.NEW_SUB_REV_CURRENT) + n(rechargeAgg.REC_REV_CURRENT),
    prior: n(rechargeAgg.NEW_SUB_REV_PRIOR) + n(rechargeAgg.REC_REV_PRIOR),
    yesterday:
      n(rechargeAgg.NEW_SUB_REV_YESTERDAY) + n(rechargeAgg.REC_REV_YESTERDAY),
    sevenDayTotal: n(rechargeAgg.NEW_SUB_REV_7D) + n(rechargeAgg.REC_REV_7D),
    yearAgo: n(rechargeAgg.NEW_SUB_REV_YEAR_AGO) + n(rechargeAgg.REC_REV_YEAR_AGO),
    daily: subRevenueDaily,
  };
  const recurringRevenue: Bucket = {
    current: n(rechargeAgg.REC_REV_CURRENT),
    prior: n(rechargeAgg.REC_REV_PRIOR),
    yesterday: n(rechargeAgg.REC_REV_YESTERDAY),
    sevenDayTotal: n(rechargeAgg.REC_REV_7D),
    yearAgo: n(rechargeAgg.REC_REV_YEAR_AGO),
    daily: recurringRevDaily,
  };
  const newSubscriptions: SubBucket = {
    current: n(rechargeAgg.NEW_SUBS_CURRENT),
    prior: n(rechargeAgg.NEW_SUBS_PRIOR),
    daily: newSubsDaily,
  };

  const sessions =
    sessionSeries.length > 0 ? bucketFromTimeSeries(sessionSeries, period, 'sessions') : null;
  const convRate =
    sessionSeries.length > 0 ? bucketFromTimeSeries(sessionSeries, period, 'convRate') : null;

  return {
    brand,
    period,
    source,
    channelMix,
    orders,
    revenue,
    aov: aovBucket,
    subscriptionShare,
    subscriptionRevenue,
    recurringRevenue,
    newSubscriptions,
    topSubscriptionProducts: topProducts,
    sessions,
    convRate,
  };
}
