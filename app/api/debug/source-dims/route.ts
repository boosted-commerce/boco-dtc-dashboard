import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';
import { execute } from '@/lib/snowflake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Probe how granular Shopify's session source attribution is, so we can pick
// the right dimension to split "social" into Instagram / Facebook / TikTok
// — and see how ShopifyQL source values compare to the UTM sources on the
// Snowflake orders (which we'd use for order/revenue-by-source).
//
//   /api/debug/source-dims?brand=ASN&path=/products/foo
//
// For each candidate ShopifyQL dimension, returns the top values (scoped to
// the path if given). Plus the top utm_source values from Snowflake orders
// landing on that path.
async function shopifyql(shop: string, token: string, query: string) {
  try {
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({
        query: `query { shopifyqlQuery(query: ${JSON.stringify(query)}) {
          parseErrors
          tableData { columns { name dataType } rows }
        } }`,
      }),
      cache: 'no-store',
    });
    const json = await res.json();
    return json?.data?.shopifyqlQuery ?? { httpStatus: res.status, raw: json };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const brand = parseBrand(sp.get('brand'));
  const path = sp.get('path'); // optional
  const creds = await getShopifyCredentials(brand);

  const candidates = [
    'referrer_source',
    'referrer_name',
    'referring_channel',
    'utm_source',
    'utm_medium',
    'utm_campaign',
  ];
  const where = path ? ` WHERE landing_page_path = '${path.replace(/'/g, "''")}'` : '';

  const shopifyDims = creds
    ? await Promise.all(
        candidates.map(async (field) => {
          const q = `FROM sessions SHOW sessions, conversion_rate GROUP BY ${field}${where} SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 20`;
          const r = await shopifyql(creds.shop, creds.token, q);
          const rows = r?.tableData?.rows ?? null;
          return {
            field,
            parseErrors: r?.parseErrors ?? null,
            values: rows
              ? rows.map((row: Record<string, unknown>) => ({
                  value: row[field] ?? '(null)',
                  sessions: Number(row.sessions) || 0,
                }))
              : null,
          };
        }),
      )
    : `No Shopify creds for ${brand}`;

  // Snowflake order-side UTM sources for this path (what we'd use for
  // order/revenue-by-source). Uses the same LANDING_SITE utm extraction as
  // the Channel Attribution tab.
  let orderUtmSources: unknown = null;
  try {
    const rows = await execute<{ SOURCE: string | null; ORDERS: number | string; REVENUE: number | string }>(
      `
        SELECT
          COALESCE(NULLIF(LOWER(REGEXP_SUBSTR(o.LANDING_SITE, 'utm_source=([^&]+)', 1, 1, 'e', 1)), ''), '(direct)') AS SOURCE,
          COUNT(*) AS ORDERS,
          COALESCE(SUM(o.TOTAL_PRICE_AMOUNT), 0) AS REVENUE
        FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o
        WHERE o.BRAND = ?
          AND o.SOURCE_NAME = 'web'
          AND (o.IS_FAIRE_ORDER = FALSE OR o.IS_FAIRE_ORDER IS NULL)
          AND o.CREATED_AT >= DATEADD(day, -28, DATE_TRUNC('day', CURRENT_TIMESTAMP()))
          AND o.CREATED_AT < DATE_TRUNC('day', CURRENT_TIMESTAMP())
          ${path ? `AND REGEXP_REPLACE(SPLIT_PART(o.LANDING_SITE, '?', 1), '(^https?://[^/]+)|/$', '') = ?` : ''}
        GROUP BY 1 ORDER BY ORDERS DESC LIMIT 20
      `,
      path ? [brand, path] : [brand],
    );
    orderUtmSources = rows;
  } catch (err) {
    orderUtmSources = { error: err instanceof Error ? err.message : String(err) };
  }

  return Response.json({ brand, path: path ?? '(all pages)', shopifyDims, orderUtmSources });
}
