import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';
import { normalizeShopifyUrl } from '@/lib/shopify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pulls orders directly from Shopify Admin REST API and groups by
// normalized landing_site path. Ground-truth answer for "how many
// orders per landing page" — bypasses both ShopifyQL and Snowflake.
//
// Usage:
//   /api/debug/orders-by-path?brand=VIV               — top paths by order count
//   /api/debug/orders-by-path?brand=VIV&path=/pages/x — drill into a single path
//
// Compare results against:
//   - Dashboard's Orders column (Snowflake) for that path
//   - ShopifyQL sessions × conv rate
// to nail down whether discrepancies are attribution or definitional.

type ShopifyOrder = {
  id: number;
  landing_site: string | null;
  total_price: string;
  created_at: string;
  financial_status: string;
};

export async function GET(request: NextRequest) {
  try {
    const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
    const filterPath = request.nextUrl.searchParams.get('path');
    const days = Number(request.nextUrl.searchParams.get('days')) || 28;
    const creds = await getShopifyCredentials(brand);
    if (!creds) {
      return Response.json(
        { error: `No Shopify credentials stored for ${brand}.` },
        { status: 404 },
      );
    }

    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const headers = { 'X-Shopify-Access-Token': creds.token };

    // Paginate via Link header. Cap at 20 pages (5K orders) for safety.
    let nextUrl: string | null =
      `https://${creds.shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
      `?status=any&created_at_min=${encodeURIComponent(since)}&limit=250` +
      `&fields=id,landing_site,total_price,created_at,financial_status`;
    const allOrders: ShopifyOrder[] = [];
    let pageCount = 0;
    let lastStatus = 0;
    while (nextUrl && pageCount < 20) {
      const res: Response = await fetch(nextUrl, { headers, cache: 'no-store' });
      lastStatus = res.status;
      if (!res.ok) {
        return Response.json({
          error: `Shopify orders fetch failed`,
          status: res.status,
          body: (await res.text()).slice(0, 1000),
          fetchedSoFar: allOrders.length,
        }, { status: 500 });
      }
      const json = (await res.json()) as { orders?: ShopifyOrder[] };
      if (Array.isArray(json.orders)) allOrders.push(...json.orders);

      const link = res.headers.get('link') || '';
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = match ? match[1] : null;
      pageCount++;
    }

    // Group by normalized landing path.
    type Bucket = {
      orderCount: number;
      revenue: number;
      sample: { id: number; created_at: string; total_price: string; financial_status: string; raw_landing_site: string | null }[];
    };
    const byPath = new Map<string, Bucket>();
    let nullLandingSiteCount = 0;
    for (const order of allOrders) {
      if (!order.landing_site) {
        nullLandingSiteCount++;
        continue;
      }
      const path = normalizeShopifyUrl(order.landing_site);
      const bucket = byPath.get(path) ?? { orderCount: 0, revenue: 0, sample: [] };
      bucket.orderCount += 1;
      bucket.revenue += parseFloat(order.total_price) || 0;
      if (bucket.sample.length < 5) {
        bucket.sample.push({
          id: order.id,
          created_at: order.created_at,
          total_price: order.total_price,
          financial_status: order.financial_status,
          raw_landing_site: order.landing_site,
        });
      }
      byPath.set(path, bucket);
    }

    if (filterPath) {
      const bucket = byPath.get(filterPath) ?? null;
      return Response.json({
        brand,
        shop: creds.shop,
        days,
        pagesFetched: pageCount,
        totalOrdersInWindow: allOrders.length,
        ordersWithNullLandingSite: nullLandingSiteCount,
        filterPath,
        match: bucket,
      });
    }

    const topPaths = [...byPath.entries()]
      .sort((a, b) => b[1].orderCount - a[1].orderCount)
      .slice(0, 25)
      .map(([path, b]) => ({
        path,
        orderCount: b.orderCount,
        revenue: Number(b.revenue.toFixed(2)),
      }));

    return Response.json({
      brand,
      shop: creds.shop,
      days,
      pagesFetched: pageCount,
      totalOrdersInWindow: allOrders.length,
      ordersWithNullLandingSite: nullLandingSiteCount,
      uniquePaths: byPath.size,
      topPaths,
      lastStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
