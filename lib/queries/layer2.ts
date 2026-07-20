import { execute } from '@/lib/snowflake';
import { withCache } from '@/lib/cache';
import type { Brand, DailyPoint, Period } from '@/lib/queries/orders';
import { getWatchedPaths, getHiddenPaths, getPinnedPaths, getLPPaths, getSocialPaths } from '@/lib/watched-store';
import { getChannelSessions, getChannelSalesByReferrer, getSessionsByPath, getProductVariantTitles, getChannelSessionsByPath, CHANNELS, type ProductVariantTitles } from '@/lib/shopify';
import { getActiveTests } from '@/lib/intelligems-api';
import { getAllAttachedPaths } from '@/lib/intelligems-attach';

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
  // Channel Attribution only: MEASURED per-channel AOV (real orders +
  // revenue from ShopifyQL `sales` by referrer). Undefined when unavailable.
  aov?: number;
  // True when this row is force-included via the pinned list (shows even
  // if it isn't top-by-revenue), rather than discovered organically.
  pinned?: boolean;
  // Top Products only: per-variant split for products with >1 variant, so
  // the row can offer a "view by variant" dropdown. Units + revenue only
  // (variants have no page sessions).
  variants?: ProductVariantSplit[];
};

export type ProductVariantSplit = {
  variantId: string;
  title: string; // variant title, or SKU/#id fallback
  sku: string | null;
  units: number;
  revenue: number;
  priorRevenue: number; // prior-period revenue (for the row's vs-prior + trend)
  revenueShare: number; // 0..1 of the product's variant revenue
  daily: DailyPoint[]; // current-window daily revenue (for the row's sparkline)
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
  const order = await getWatchedPaths(brand); // already in the team's chosen order
  const rows = await getRowsForPaths(brand, period, order);
  // getRowsForPaths sorts by revenue; restore the watched display order.
  const rank = new Map(order.map((p, i) => [p, i]));
  return [...rows].sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
}

// Metrics for an explicit list of paths, force-included even at $0 (LEFT
// JOIN against a path virtual table). Shared by the Watched tab and the
// pinned force-includes on the discovered page tabs.
async function getRowsForPaths(
  brand: Brand,
  period: Period,
  paths: string[],
): Promise<Layer2Row[]> {
  const watched = paths;
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
  const discovered = rows.map((r) => toRow(r, 'orders'));

  // Force-include pinned pages matching this tab's path prefix, even if
  // they're below the top-N or have zero orders — without putting them on
  // the Watched list. Pinned rows that the discovered query already
  // surfaced just get flagged; the rest are fetched and appended.
  const pinned = await getPinnedPaths(brand);
  const prefix = pathPattern.replace(/%$/, '');
  const pinnedForTab = pinned.filter((p) => p.startsWith(prefix));
  if (pinnedForTab.length === 0) return discovered;

  const have = new Set(discovered.map((r) => r.key));
  const missing = pinnedForTab.filter((p) => !have.has(p));
  const pinnedRows = missing.length ? await getRowsForPaths(brand, period, missing) : [];
  const pinnedSet = new Set(pinnedForTab);
  return [...discovered, ...pinnedRows]
    .map((r) => (pinnedSet.has(r.key) ? { ...r, pinned: true } : r))
    .sort((a, b) => b.currentRevenue - a.currentRevenue);
}

export const getPDPs = (brand: Brand, period: Period) =>
  getPagesByType(brand, period, '/products/%');
export const getCollections = (brand: Brand, period: Period) =>
  getPagesByType(brand, period, '/collections/%');
export const getCMSPages = (brand: Brand, period: Period) =>
  getPagesByType(brand, period, '/pages/%');

// Manually-curated Landing Pages list (separate Redis set, seeded empty).
// Same $0-inclusive metrics as Watched so a freshly-added campaign page
// still renders before it has orders.
export async function getLandingPages(brand: Brand, period: Period): Promise<Layer2Row[]> {
  return getRowsForPaths(brand, period, await getLPPaths(brand));
}

// Manually-curated Social list (pages promoted on social). Same $0-inclusive
// metrics as Watched/Landing Pages.
export async function getSocialPages(brand: Brand, period: Period): Promise<Layer2Row[]> {
  return getRowsForPaths(brand, period, await getSocialPaths(brand));
}

// Pages involved in an Intelligems test — auto-located (redirect origins &
// destinations + on-site-edit URL targets) PLUS pages the team manually
// attached a test to via a deep-dive dropdown. Each row's sublabel names the
// test(s) touching that path.
export async function getABTestPages(brand: Brand, period: Period): Promise<Layer2Row[]> {
  const [tests, manual] = await Promise.all([
    getActiveTests(brand).catch(() => []),
    getAllAttachedPaths(brand).catch(() => ({} as Record<string, string[]>)),
  ]);
  // path -> set of test names touching it
  const byPath = new Map<string, Set<string>>();
  const addName = (p: string, name: string) => {
    if (!p) return;
    const set = byPath.get(p) ?? new Set<string>();
    set.add(name);
    byPath.set(p, set);
  };
  for (const t of tests) {
    for (const p of [...t.origins, ...t.destinations, ...t.targetPaths]) addName(p, t.name);
  }
  // Manual attachments — resolve the test name from active tests where we
  // can; otherwise label generically (e.g. token missing or test ended).
  const idToName = new Map(tests.map((t) => [t.id, t.name]));
  for (const [path, ids] of Object.entries(manual)) {
    for (const id of ids) addName(path, idToName.get(id) ?? 'Attached test');
  }
  if (byPath.size === 0) return [];
  const rows = await getRowsForPaths(brand, period, [...byPath.keys()]);
  return rows.map((r) => {
    const names = byPath.get(r.key);
    return names ? { ...r, sublabel: [...names].join(' · ') } : r;
  });
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
  const productRows = rows.map((r) => toRow(r, 'units'));
  const variantsByProduct = await getVariantsForProducts(
    brand,
    period,
    productRows.map((r) => r.key),
  ).catch(() => new Map<string, ProductVariantSplit[]>());
  return productRows.map((r) => {
    const variants = variantsByProduct.get(r.key);
    return variants && variants.length > 1 ? { ...r, variants } : r;
  });
}

type VariantSalesRaw = {
  PRODUCT: string | null;
  PRODUCT_ID: string | null;
  VARIANT_ID: string | null;
  SKU: string | null;
  UNITS: number | string | null;
  REVENUE: number | string | null;
  PRIOR_REVENUE: number | string | null;
  DAILY_JSON: string | null;
};

// Per-variant units + revenue (+ prior revenue + daily series) for a set of
// product titles, keyed back to the product title, so a Top Products row can
// swap its whole metric set to a selected variant. Variant titles resolved
// via the Admin API (Snowflake has no variant title).
async function getVariantsForProducts(
  brand: Brand,
  period: Period,
  productTitles: string[],
): Promise<Map<string, ProductVariantSplit[]>> {
  const titles = [...new Set(productTitles.filter(Boolean))];
  if (titles.length === 0) return new Map();
  const placeholders = titles.map(() => '?').join(', ');
  const rows = await execute<VariantSalesRaw>(
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
          li.PRODUCT_ID,
          li.VARIANT_ID,
          li.SKU,
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
          AND li.TITLE IN (${placeholders})
      ),
      agg AS (
        SELECT
          base.product,
          ANY_VALUE(base.PRODUCT_ID) AS product_id,
          base.VARIANT_ID,
          ANY_VALUE(base.SKU) AS sku,
          SUM(IFF(base.CREATED_AT >= b.current_start, base.QUANTITY, 0)) AS units,
          SUM(IFF(base.CREATED_AT >= b.current_start, base.QUANTITY * base.PRICE_AMOUNT, 0)) AS revenue,
          SUM(IFF(base.CREATED_AT < b.current_start, base.QUANTITY * base.PRICE_AMOUNT, 0)) AS prior_revenue
        FROM base, bounds b
        GROUP BY base.product, base.VARIANT_ID
        HAVING SUM(IFF(base.CREATED_AT >= b.current_start, base.QUANTITY, 0)) > 0
      ),
      daily AS (
        SELECT
          base.product,
          base.VARIANT_ID,
          TO_VARCHAR(DATE(base.CREATED_AT), 'YYYY-MM-DD') AS d,
          SUM(base.QUANTITY * base.PRICE_AMOUNT) AS v
        FROM base, bounds b
        WHERE base.CREATED_AT >= b.current_start
        GROUP BY base.product, base.VARIANT_ID, DATE(base.CREATED_AT)
      ),
      sparks AS (
        SELECT
          product,
          VARIANT_ID,
          ARRAY_AGG(OBJECT_CONSTRUCT('d', d, 'v', v)) WITHIN GROUP (ORDER BY d) AS daily_series
        FROM daily
        GROUP BY product, VARIANT_ID
      )
      SELECT
        a.product AS PRODUCT,
        a.product_id AS PRODUCT_ID,
        a.VARIANT_ID AS VARIANT_ID,
        a.sku AS SKU,
        a.units AS UNITS,
        a.revenue AS REVENUE,
        a.prior_revenue AS PRIOR_REVENUE,
        TO_VARCHAR(s.daily_series) AS DAILY_JSON
      FROM agg a
      LEFT JOIN sparks s ON a.product = s.product AND a.VARIANT_ID = s.VARIANT_ID
    `,
    [period, period * 2, brand, ...titles],
  );

  // Resolve variant titles for the products we saw (batched Admin lookup).
  const productIds = [...new Set(rows.map((r) => r.PRODUCT_ID).filter(Boolean).map(String))];
  const titleMap = await getProductVariantTitles(brand, productIds).catch(
    () => ({} as ProductVariantTitles),
  );

  // Group variant rows by product title.
  const byProduct = new Map<string, VariantSalesRaw[]>();
  for (const r of rows) {
    const key = r.PRODUCT ?? '';
    if (!key) continue;
    (byProduct.get(key) ?? byProduct.set(key, []).get(key)!).push(r);
  }

  const out = new Map<string, ProductVariantSplit[]>();
  for (const [product, vRows] of byProduct) {
    const total = vRows.reduce((s, r) => s + n(r.REVENUE), 0) || 0;
    const variants: ProductVariantSplit[] = vRows
      .map((r) => {
        const variantId = r.VARIANT_ID ? String(r.VARIANT_ID) : '';
        const pid = r.PRODUCT_ID ? String(r.PRODUCT_ID) : '';
        const meta = titleMap[pid]?.[variantId];
        const sku = meta?.sku ?? (r.SKU || null);
        const title =
          meta?.title?.trim() ||
          (sku ? `SKU ${sku}` : variantId ? `Variant #${variantId}` : 'Unknown variant');
        const revenue = n(r.REVENUE);
        return {
          variantId,
          title,
          sku,
          units: n(r.UNITS),
          revenue,
          priorRevenue: n(r.PRIOR_REVENUE),
          revenueShare: total > 0 ? revenue / total : 0,
          daily: parseDaily(r.DAILY_JSON),
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
    out.set(product, variants);
  }
  return out;
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
  const [channels, salesByRef] = await Promise.all([
    getChannelSessions(brand, period),
    getChannelSalesByReferrer(brand, period).catch(
      () => new Map<string, { orders: number; revenue: number; aov: number }>(),
    ),
  ]);
  if (channels.length > 0) {
    return channels.map((c) => {
      const ordersAttributed = Math.round(c.sessions * (c.convRate / 100));
      const labelSource = c.source || '(none)';
      const fullLabel = c.name ? `${labelSource} · ${c.name}` : labelSource;
      // Real orders/revenue/AOV for this referrer, if the sales dataset has it.
      const sales = salesByRef.get(`${c.source || '(none)'}|${c.name}`);
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
        aov: sales && sales.orders > 0 ? sales.aov : undefined,
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
  | 'lps'
  | 'social'
  | 'abtests'
  | 'pdps'
  | 'collections'
  | 'cms'
  | 'products'
  | 'attribution';
export const LAYER2_TABS: readonly Layer2Tab[] = [
  'watched',
  'lps',
  'social',
  'abtests',
  'pdps',
  'collections',
  'cms',
  'products',
  'attribution',
] as const;

export const LAYER2_LABELS: Record<Layer2Tab, string> = {
  watched: 'Watched',
  lps: 'Landing Pages',
  social: 'Social',
  abtests: 'A/B Tests',
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
  'lps',
  'social',
  'abtests',
  'pdps',
  'collections',
  'cms',
]);

export async function getLayer2(
  brand: Brand,
  period: Period,
  tab: Layer2Tab,
  channel?: string,
): Promise<Layer2Row[]> {
  const ch = channel && (CHANNELS as readonly string[]).includes(channel) ? channel : null;
  return withCache(`layer2:${brand}:${period}:${tab}:${ch ?? 'all'}:v1`, 120, () =>
    getLayer2Uncached(brand, period, tab, ch),
  );
}

async function getLayer2Uncached(
  brand: Brand,
  period: Period,
  tab: Layer2Tab,
  channel: string | null,
): Promise<Layer2Row[]> {
  const rows = await getLayer2RowsInner(brand, period, tab);
  if (!PATH_KEYED_TABS.has(tab)) return rows;

  // Channel filter: re-scope each page row to one traffic channel. Sessions
  // & conv are exact per channel; orders/revenue (and the sparkline) are the
  // page's numbers allocated by that channel's share of the page's sessions.
  if (channel) {
    const chMap = await getChannelSessionsByPath(brand, period).catch(
      () => new Map<string, { total: number; byChannel: Map<string, { sessions: number; convRate: number }> }>(),
    );
    return rows
      .map((r) => {
        const entry = chMap.get(r.key);
        const ch = entry?.byChannel.get(channel);
        if (!entry || !ch || entry.total <= 0) {
          // No traffic from this channel to this page in the window.
          return { ...r, sessions: 0, convRate: 0, currentCount: 0, subCount: 0, currentRevenue: 0, priorRevenue: 0, daily: [] };
        }
        const share = ch.sessions / entry.total;
        return {
          ...r,
          sessions: ch.sessions,
          convRate: ch.convRate,
          currentCount: Math.round(ch.sessions * (ch.convRate / 100)),
          subCount: undefined,
          currentRevenue: r.currentRevenue * share,
          priorRevenue: r.priorRevenue * share,
          daily: r.daily.map((p) => ({ date: p.date, value: p.value * share })),
        };
      })
      .sort((a, b) => b.currentRevenue - a.currentRevenue);
  }

  const sessions = await getSessionsByPath(brand, period);
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
    case 'lps':
      return getLandingPages(brand, period);
    case 'social':
      return getSocialPages(brand, period);
    case 'abtests':
      return getABTestPages(brand, period);
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
