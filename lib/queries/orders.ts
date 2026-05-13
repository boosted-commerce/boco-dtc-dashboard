import { execute } from '@/lib/snowflake';

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

export type StoreOverview = {
  brand: Brand;
  period: Period;
  orders: Bucket;
  revenue: Bucket;
  aov: Bucket;
  subscriptionShare: SubBucket;
  subscriptionRevenue: Bucket;
  recurringRevenue: Bucket;
  newSubscriptions: SubBucket;
  topSubscriptionProducts: TopSubProduct[];
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
  SUB_REV_CURRENT: number | string | null;
  SUB_REV_PRIOR: number | string | null;
  SUB_REV_YESTERDAY: number | string | null;
  SUB_REV_7D: number | string | null;
  SUB_REV_YEAR_AGO: number | string | null;
  WEB_REV_CURRENT: number | string | null;
  WEB_REV_PRIOR: number | string | null;
};

async function getShopifyAggregates(brand: Brand, period: Period) {
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
        COALESCE(SUM(IFF(o.CREATED_AT >= b.yesterday_start AND o.CREATED_AT < b.today_start AND o.IS_SUBSCRIPTION = TRUE AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS SUB_REV_YESTERDAY,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.seven_day_start AND o.CREATED_AT < b.today_start AND o.IS_SUBSCRIPTION = TRUE AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS SUB_REV_7D,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.year_ago_start AND o.CREATED_AT < b.year_ago_end AND o.IS_SUBSCRIPTION = TRUE AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS SUB_REV_YEAR_AGO,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.current_start AND o.CREATED_AT < b.today_start AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS WEB_REV_CURRENT,
        COALESCE(SUM(IFF(o.CREATED_AT >= b.prior_start AND o.CREATED_AT < b.current_start AND o.SOURCE_NAME = 'web', o.TOTAL_PRICE_AMOUNT, 0)), 0) AS WEB_REV_PRIOR
      FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o, bounds b
      WHERE o.BRAND = ?
        AND o.CREATED_AT >= b.year_ago_start
        AND o.CREATED_AT < b.today_start
        AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
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

async function getShopifyDaily(brand: Brand, period: Period): Promise<DailyRow[]> {
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
      GROUP BY DATE(CREATED_AT)
      ORDER BY DATE(CREATED_AT)
    `,
    [brand, period],
  );
}

type RechargeAggRow = {
  NEW_SUBS_CURRENT: number | string | null;
  NEW_SUBS_PRIOR: number | string | null;
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
  RECURRING_REV: number | string | null;
};

async function getRechargeDaily(brand: Brand, period: Period): Promise<RechargeDailyRow[]> {
  return execute<RechargeDailyRow>(
    `
      SELECT
        TO_VARCHAR(DATE(TO_TIMESTAMP(PROCESSED_AT)), 'YYYY-MM-DD') AS D,
        COUNT_IF(TYPE = 'checkout') AS NEW_SUBS,
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
      LIMIT 10
    `,
    [brand, period],
  );
  return rows.map((r) => ({
    product: r.PRODUCT ?? '(untitled)',
    newSubscriptions: n(r.NEW_SUBSCRIPTIONS),
    firstOrderRevenue: n(r.FIRST_ORDER_REVENUE),
  }));
}

export async function getStoreOverview(
  brand: Brand = 'ASN',
  period: Period = 28,
): Promise<StoreOverview> {
  const [agg, daily, rechargeAgg, rechargeDaily, topProducts] = await Promise.all([
    getShopifyAggregates(brand, period),
    getShopifyDaily(brand, period),
    getRechargeAggregates(brand, period),
    getRechargeDaily(brand, period),
    getTopSubscriptionProducts(brand, period),
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
  const subRevenueDaily: DailyPoint[] = daily.map((r) => ({
    date: r.D,
    value: n(r.SUB_REV),
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
  const subscriptionRevenue: Bucket = {
    current: subRevCurrent,
    prior: subRevPrior,
    yesterday: n(agg.SUB_REV_YESTERDAY),
    sevenDayTotal: n(agg.SUB_REV_7D),
    yearAgo: n(agg.SUB_REV_YEAR_AGO),
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

  return {
    brand,
    period,
    orders,
    revenue,
    aov: aovBucket,
    subscriptionShare,
    subscriptionRevenue,
    recurringRevenue,
    newSubscriptions,
    topSubscriptionProducts: topProducts,
  };
}
