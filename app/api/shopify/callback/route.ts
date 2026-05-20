import { type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { BRANDS, type Brand } from '@/lib/queries/orders';
import {
  exchangeCodeForToken,
  normalizeShopDomain,
  shopifyApiSecret,
  verifyHmac,
} from '@/lib/shopify-oauth';
import { saveShopifyCredentials } from '@/lib/watched-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function verifyState(state: string | null, cookieState: string | null): {
  ok: boolean;
  brand?: Brand;
  reason?: string;
} {
  if (!state) return { ok: false, reason: 'missing state' };
  if (state !== cookieState) return { ok: false, reason: 'state mismatch' };
  const parts = state.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed state' };
  const [brand, nonce, sig] = parts;
  if (!(BRANDS as readonly string[]).includes(brand)) return { ok: false, reason: 'bad brand' };
  // Use the brand-specific secret (each brand has its own Shopify app).
  const expected = crypto
    .createHmac('sha256', shopifyApiSecret(brand as Brand))
    .update(`${brand}.${nonce}`)
    .digest('hex');
  if (sig.length !== expected.length) return { ok: false, reason: 'state sig length' };
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return { ok: false, reason: 'state sig invalid' };
  return { ok: true, brand: brand as Brand };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Shopify install</title><style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 64px auto; padding: 0 24px; line-height: 1.5; color: #18181b; }
      .ok { color: #047857; } .err { color: #b91c1c; }
      code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
      pre { background: #f4f4f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
      h1 { font-size: 1.5rem; }
      a { color: #2563eb; }
    </style></head><body>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  // 1. State validation FIRST — we need to know which brand to look up the
  // right secret. HMAC validation immediately after with that secret.
  const cookieMatch = request.headers.get('cookie')?.match(/shopify_oauth_state=([^;]+)/);
  const state = sp.get('state');
  const { ok, brand, reason } = verifyState(state, cookieMatch?.[1] ?? null);
  if (!ok || !brand) {
    return htmlResponse(
      `<h1 class="err">Install failed</h1><p>State validation failed (${reason}). Try the install link again.</p>`,
      400,
    );
  }

  // 2. HMAC validation — confirms this callback really came from Shopify.
  if (!verifyHmac(sp, shopifyApiSecret(brand))) {
    return htmlResponse(
      `<h1 class="err">Install failed</h1><p>HMAC validation failed. Try the install link again.</p>`,
      400,
    );
  }

  // 3. Validate shop param matches the cookie we set on /install.
  const shopParam = sp.get('shop');
  const shop = shopParam ? normalizeShopDomain(shopParam) : null;
  const shopCookie = request.headers.get('cookie')?.match(/shopify_oauth_shop=([^;]+)/)?.[1];
  if (!shop || (shopCookie && shopCookie !== shop)) {
    return htmlResponse(
      `<h1 class="err">Install failed</h1><p>Shop parameter mismatch.</p>`,
      400,
    );
  }

  // 4. Exchange code for offline access token.
  const code = sp.get('code');
  if (!code) {
    return htmlResponse(
      `<h1 class="err">Install failed</h1><p>No code returned from Shopify.</p>`,
      400,
    );
  }

  try {
    const { access_token, scope } = await exchangeCodeForToken({ brand, shop, code });
    await saveShopifyCredentials(brand, shop, access_token);
    return htmlResponse(
      `<h1 class="ok">✓ Installed for ${brand}</h1>
       <p>Shop: <code>${shop}</code></p>
       <p>Scopes granted: <code>${scope}</code></p>
       <p>The dashboard can now query ShopifyQL Analytics for <strong>${brand}</strong>. You can close this tab.</p>
       <p><a href="/?brand=${brand}">← Back to dashboard</a></p>`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return htmlResponse(
      `<h1 class="err">Install failed</h1><p>Token exchange failed:</p><pre>${msg.replace(/</g, '&lt;')}</pre>`,
      500,
    );
  }
}
