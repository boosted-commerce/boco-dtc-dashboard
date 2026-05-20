import { type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { BRANDS, type Brand } from '@/lib/queries/orders';
import { buildAuthorizeUrl, normalizeShopDomain } from '@/lib/shopify-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Required scopes for ShopifyQL Analytics + order/report reads.
const SCOPES = 'read_analytics,read_orders,read_reports';

// State cookie carries the brand identifier so the callback can associate
// the issued token with the right brand. The HMAC over the nonce + brand
// prevents forgery.
function signState(payload: { brand: Brand; nonce: string }): string {
  // Per-brand secret since each brand has its own Shopify app.
  const secret =
    process.env[`SHOPIFY_APP_API_SECRET_${payload.brand}`] ??
    process.env.SHOPIFY_APP_API_SECRET ??
    '';
  const message = `${payload.brand}.${payload.nonce}`;
  const sig = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return `${message}.${sig}`;
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const brandRaw = (sp.get('brand') ?? '').toUpperCase();
    const shopRaw = sp.get('shop') ?? '';

    if (!(BRANDS as readonly string[]).includes(brandRaw)) {
      return Response.json(
        { error: `brand must be one of ${BRANDS.join(', ')}` },
        { status: 400 },
      );
    }
    const brand = brandRaw as Brand;

    const shop = normalizeShopDomain(shopRaw);
    if (!shop) {
      return Response.json(
        { error: 'shop must be a valid myshopify.com subdomain' },
        { status: 400 },
      );
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const state = signState({ brand, nonce });

    const redirectUri = `${request.nextUrl.origin}/api/shopify/callback`;
    const authorizeUrl = buildAuthorizeUrl({ brand, shop, scopes: SCOPES, redirectUri, state });

    // Build the redirect Response manually because Response.redirect()
    // returns an immutable headers object. We need to set Set-Cookie
    // alongside Location, which requires the standard Response constructor.
    const headers = new Headers();
    headers.set('location', authorizeUrl);
    headers.append(
      'Set-Cookie',
      `shopify_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    headers.append(
      'Set-Cookie',
      `shopify_oauth_shop=${shop}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    return new Response(null, { status: 302, headers });
  } catch (err) {
    // Surface the underlying cause rather than letting Next.js swallow it
    // as an empty 500 body. Common case: SHOPIFY_APP_API_KEY missing.
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
