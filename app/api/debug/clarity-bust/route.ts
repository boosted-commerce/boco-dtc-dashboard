import { type NextRequest } from 'next/server';
import { Redis } from '@upstash/redis';
import { parseBrand } from '@/lib/queries/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Bust the cached Clarity API response for a brand so the next read
// goes live to Clarity. Useful after a tracking-install change on the
// Shopify side — without this you'd wait up to 12h for the cache
// (clarity:<brand>:metrics:v1) to expire.
//
// Usage: /api/debug/clarity-bust?brand=PRL
export async function GET(request: NextRequest) {
  const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
  const cacheKey = `clarity:${brand}:metrics:v1`;
  try {
    const redis = Redis.fromEnv();
    const existed = await redis.del(cacheKey);
    return Response.json({ brand, cacheKey, deleted: existed === 1 });
  } catch (err) {
    return Response.json({
      brand,
      cacheKey,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
