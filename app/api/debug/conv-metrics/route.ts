import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Verify what ShopifyQL's `conversion_rate` actually measures (reached
// checkout vs completed checkout) and which funnel-stage columns exist, so
// we can switch to the COMPLETED-checkout conversion if needed.
//   /api/debug/conv-metrics?brand=VIV
async function ql(shop: string, token: string, query: string) {
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
  const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
  const creds = await getShopifyCredentials(brand);
  if (!creds) return Response.json({ error: `No Shopify creds for ${brand}` }, { status: 404 });

  // Candidate metric names to test one-by-one (isolates which parse).
  const candidates = [
    'conversion_rate',
    'session_conversion_rate',
    'sessions_that_reached_checkout',
    'sessions_that_completed_checkout',
    'sessions_with_cart_additions',
    'checkout_started_rate',
    'checkout_completed_rate',
    'reached_checkout_rate',
    'completed_checkout_rate',
    'add_to_cart_rate',
  ];
  const fieldProbes = await Promise.all(
    candidates.map(async (m) => {
      const r = await ql(creds.shop, creds.token, `FROM sessions SHOW ${m} SINCE -7d UNTIL today`);
      return { metric: m, parseErrors: r?.parseErrors ?? null, sample: r?.tableData?.rows?.[0] ?? null };
    }),
  );

  // One combined query so we can compare conversion_rate against
  // completed-checkout ÷ sessions on the same 7-day window.
  const combined = await ql(
    creds.shop,
    creds.token,
    `FROM sessions SHOW sessions, conversion_rate, sessions_that_reached_checkout, sessions_that_completed_checkout SINCE -7d UNTIL today`,
  );

  return Response.json({
    brand,
    fieldProbes,
    combined: { parseErrors: combined?.parseErrors ?? null, rows: combined?.tableData?.rows ?? null },
  });
}
