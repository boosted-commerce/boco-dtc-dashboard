import { type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lightweight env-presence probe for debugging the OAuth wiring. Reports
// whether each expected env var is set (does NOT reveal values).
export async function GET(_request: NextRequest) {
  const secret = process.env.SHOPIFY_APP_API_SECRET ?? '';
  const checks = {
    SHOPIFY_APP_API_KEY: !!process.env.SHOPIFY_APP_API_KEY,
    SHOPIFY_APP_API_KEY_length: (process.env.SHOPIFY_APP_API_KEY ?? '').length,
    SHOPIFY_APP_API_SECRET: !!process.env.SHOPIFY_APP_API_SECRET,
    SHOPIFY_APP_API_SECRET_length: secret.length,
    SHOPIFY_APP_API_SECRET_starts_with_shpss: secret.startsWith('shpss_'),
    SHOPIFY_APP_API_SECRET_has_leading_or_trailing_whitespace:
      secret !== secret.trim(),
    // Upstash SDK falls back from UPSTASH_REDIS_* to KV_REST_API_* — Vercel's
    // marketplace integration usually populates one or the other.
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
    SNOWFLAKE_ACCOUNT: !!process.env.SNOWFLAKE_ACCOUNT,
  };
  return Response.json(checks);
}
