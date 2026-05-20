import { type NextRequest } from 'next/server';
import { BRANDS } from '@/lib/queries/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lightweight env-presence probe for debugging the OAuth wiring. Reports
// whether each expected env var is set (does NOT reveal values).
export async function GET(_request: NextRequest) {
  // Per-brand Shopify credentials (each brand has its own Shopify app).
  const perBrand: Record<string, { key: boolean; secret: boolean }> = {};
  for (const brand of BRANDS) {
    perBrand[brand] = {
      key:
        !!process.env[`SHOPIFY_APP_API_KEY_${brand}`] ||
        !!process.env.SHOPIFY_APP_API_KEY,
      secret:
        !!process.env[`SHOPIFY_APP_API_SECRET_${brand}`] ||
        !!process.env.SHOPIFY_APP_API_SECRET,
    };
  }
  return Response.json({
    shopify_credentials: perBrand,
    // Upstash SDK falls back from UPSTASH_REDIS_* to KV_REST_API_* — Vercel's
    // marketplace integration usually populates one or the other.
    KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    SNOWFLAKE_ACCOUNT: !!process.env.SNOWFLAKE_ACCOUNT,
  });
}
