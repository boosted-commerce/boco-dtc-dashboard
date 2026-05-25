import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Probes a few candidate ShopifyQL queries that should give us
// order-level data (not session-level) broken down by landing_page_path.
// Goal: verify whether the "conv rate" mismatch with Snowflake is due
// to ShopifyQL counting checkouts-reached vs orders-completed, or due
// to a path-matching issue between ShopifyQL and Snowflake.
//
// Whichever query returns status 200 with row-level data is the one we
// can use as the authoritative "orders per landing path" source.
export async function GET(request: NextRequest) {
  try {
    const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
    const creds = await getShopifyCredentials(brand);
    if (!creds) {
      return Response.json(
        { error: `No Shopify credentials stored for ${brand}.` },
        { status: 404 },
      );
    }

    // landing_page_path only exists on the `sessions` table per prior
    // probes. So we stay on `sessions` and search for the order/revenue
    // metrics that must live there (conversion_rate is computed from
    // something — try to find the raw counts).
    const queries = [
      // sessions table with revenue metric — most likely to work
      `FROM sessions SHOW sessions, total_sales GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 10`,
      // Order count metric candidates on sessions table
      `FROM sessions SHOW sessions, orders GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 10`,
      `FROM sessions SHOW sessions, converted_sessions GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 10`,
      `FROM sessions SHOW sessions, sessions_converted GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 10`,
      `FROM sessions SHOW sessions, total_orders GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 10`,
      // gross_sales / net_sales also worth a try
      `FROM sessions SHOW sessions, gross_sales GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY sessions DESC LIMIT 10`,
    ];

    const attempts = await Promise.all(
      queries.map(async (query) => {
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
            },
          );
          const text = await res.text();
          let body: unknown = text.slice(0, 2000);
          try { body = JSON.parse(text); } catch { /* keep text */ }
          return { query, status: res.status, body };
        } catch (err) {
          return {
            query,
            status: 'error' as const,
            body: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return Response.json({ brand, shop: creds.shop, attempts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
