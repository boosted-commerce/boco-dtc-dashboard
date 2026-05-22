import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Smoke test for a brand's stored OAuth token: runs a ShopifyQL query for
// sessions by landing_page_url over the last 28 days and returns the table.
// Confirms (a) the token works, (b) the read_analytics scope was granted,
// (c) ShopifyQL's landing_page_url dimension is the right name.
export async function GET(request: NextRequest) {
  try {
    const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
    const creds = await getShopifyCredentials(brand);
    if (!creds) {
      return Response.json(
        { error: `No Shopify credentials stored for ${brand}. Install the app first.` },
        { status: 404 },
      );
    }

    const query = `
      FROM sessions
      SHOW sessions, conversion_rate
      GROUP BY landing_page_path
      SINCE -28d UNTIL today
      ORDER BY sessions DESC
      LIMIT 10
    `.trim();

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
      },
    );

    const json = await res.json();
    return Response.json({ brand, shop: creds.shop, status: res.status, body: json });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
