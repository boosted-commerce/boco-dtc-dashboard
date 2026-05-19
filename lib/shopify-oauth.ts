import crypto from 'node:crypto';

// Shopify OAuth helpers. Server-side only.

export const SHOPIFY_API_VERSION = '2026-04';

export function shopifyApiSecret(): string {
  const v = process.env.SHOPIFY_APP_API_SECRET;
  if (!v) throw new Error('SHOPIFY_APP_API_SECRET not configured');
  return v;
}

export function shopifyApiKey(): string {
  const v = process.env.SHOPIFY_APP_API_KEY;
  if (!v) throw new Error('SHOPIFY_APP_API_KEY not configured');
  return v;
}

// Validate the canonical .myshopify.com subdomain format. Shopify expects
// only the subdomain piece for the OAuth URL (e.g. "poww-nutrition" or the
// full "poww-nutrition.myshopify.com").
export function normalizeShopDomain(input: string): string | null {
  const s = input.trim().toLowerCase();
  // Accept full domain or just subdomain
  const m = s.match(/^([a-z0-9][a-z0-9-]*)(?:\.myshopify\.com)?$/);
  if (!m) return null;
  return `${m[1]}.myshopify.com`;
}

// Build the OAuth authorize URL that Shopify redirects the user to. After
// the merchant grants permissions, Shopify redirects to redirectUri with
// ?code=... which we exchange for an offline access token.
export function buildAuthorizeUrl(opts: {
  shop: string; // full myshopify.com domain
  scopes: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://${opts.shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', shopifyApiKey());
  url.searchParams.set('scope', opts.scopes);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  // Offline access — token doesn't expire (vs online which is per-session).
  url.searchParams.set('grant_options[]', '');
  return url.toString();
}

// Validate the HMAC that Shopify includes in the callback. Confirms the
// callback really came from Shopify and wasn't forged.
export function verifyHmac(params: URLSearchParams, secret: string): boolean {
  const received = params.get('hmac');
  if (!received) return false;
  const entries: [string, string][] = [];
  params.forEach((value, key) => {
    if (key === 'hmac' || key === 'signature') return;
    entries.push([key, value]);
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  const message = entries
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const computed = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');
  // Constant-time compare
  if (computed.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(received));
}

// Exchange the temp `code` from the callback for a long-lived offline
// access token. The token is what we'll use to call Admin GraphQL.
export async function exchangeCodeForToken(opts: {
  shop: string;
  code: string;
}): Promise<{ access_token: string; scope: string }> {
  const res = await fetch(`https://${opts.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: shopifyApiKey(),
      client_secret: shopifyApiSecret(),
      code: opts.code,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: HTTP ${res.status} ${body}`);
  }
  return res.json();
}
