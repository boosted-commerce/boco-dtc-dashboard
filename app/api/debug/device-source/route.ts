import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Probe several ShopifyQL dimension names for "device" since we
// don't know which one is correct (device_type vs device_category
// vs device). Whichever returns 200 with rows is the right one.
export async function GET(request: NextRequest) {
  const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
  const creds = await getShopifyCredentials(brand);
  if (!creds) {
    return Response.json({ error: `No Shopify creds for ${brand}` }, { status: 404 });
  }

  const candidates = [
    'device_type',
    'device_category',
    'device',
    'client_type',
  ];

  const attempts = await Promise.all(
    candidates.map(async (field) => {
      const query = `FROM sessions SHOW sessions GROUP BY ${field} SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 10`;
      try {
        const res = await fetch(
          `https://${creds.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Shopify-Access-Token': creds.token,
            },
            body: JSON.stringify({
              query: `query { shopifyqlQuery(query: ${JSON.stringify(query)}) {
                parseErrors
                tableData { columns { name dataType } rows }
              } }`,
            }),
            cache: 'no-store',
          },
        );
        const json = await res.json();
        return { field, status: res.status, body: json };
      } catch (err) {
        return {
          field,
          status: 'error' as const,
          body: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return Response.json({ brand, shop: creds.shop, attempts });
}
