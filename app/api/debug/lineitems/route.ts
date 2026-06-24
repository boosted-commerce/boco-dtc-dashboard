import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { execute } from '@/lib/snowflake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Probe the order line-items table columns (to confirm variant fields)
// before building the per-variant breakdown. /api/debug/lineitems?brand=VIV
export async function GET(request: NextRequest) {
  const brand = parseBrand(new URL(request.url).searchParams.get('brand'));
  try {
    const rows = await execute(
      `WITH x AS (
         SELECT li.*
         FROM DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS_ITEMS li
         JOIN DW_ANALYTICS.FACT.SHOPIFY_ORDERS_RD_ORDERS o ON li.ORDER_ID = o.ID
         WHERE o.BRAND = ? AND o.SOURCE_NAME = 'web'
         ORDER BY o.CREATED_AT DESC
         LIMIT 3
       )
       SELECT OBJECT_CONSTRUCT(*) AS OBJ FROM x`,
      [brand],
    );
    return Response.json({ brand, sample: rows });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
