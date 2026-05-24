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

    // Try several candidate (table, metric) combos. ShopifyQL has both
    // `orders` and `sales` tables historically; the exact column names
    // for order count vary by API version.
    const queries = [
      // total_sales should always exist on the sales table; if this works
      // we know we can at least pull revenue per path
      `FROM sales SHOW total_sales GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY total_sales DESC LIMIT 10`,
      // ordered_item_quantity is units sold (not orders) but useful as a
      // signal of how many actual order-line-items happened per path
      `FROM sales SHOW total_sales, ordered_item_quantity GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY total_sales DESC LIMIT 10`,
      // gross_sales is the revenue before discounts/returns
      `FROM sales SHOW gross_sales, total_sales GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY total_sales DESC LIMIT 10`,
      // If a top-level `orders` table exists with an orders count metric,
      // these are the most common naming conventions
      `FROM orders SHOW orders GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY orders DESC LIMIT 10`,
      `FROM orders SHOW total_orders GROUP BY landing_page_path SINCE -28d UNTIL today ORDER BY total_orders DESC LIMIT 10`,
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
