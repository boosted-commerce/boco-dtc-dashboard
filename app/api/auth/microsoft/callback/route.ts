import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  OAUTH_NEXT_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  emailAllowed,
  isAuthConfigured,
  isMicrosoftConfigured,
  msTenant,
  newSession,
  signSession,
} from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Decode a JWT payload without signature verification — safe here
// because the id_token comes straight from Microsoft's token endpoint
// over TLS using our client secret, not from the user.
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const loginRedirect = (request: Request, error: string) =>
  NextResponse.redirect(new URL(`/login?error=${error}`, request.url));

export async function GET(request: Request) {
  if (!isAuthConfigured() || !isMicrosoftConfigured()) {
    return loginRedirect(request, 'config');
  }
  const url = new URL(request.url);
  const store = await cookies();

  if (url.searchParams.get('error')) return loginRedirect(request, 'microsoft');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const savedState = store.get(OAUTH_STATE_COOKIE)?.value;
  const nextRaw = store.get(OAUTH_NEXT_COOKIE)?.value || '/';
  store.delete(OAUTH_STATE_COOKIE);
  store.delete(OAUTH_NEXT_COOKIE);

  if (!code || !state || !savedState || state !== savedState) {
    return loginRedirect(request, 'state');
  }

  const redirectUri = `${url.origin}/api/auth/microsoft/callback`;
  let claims: Record<string, unknown> | null = null;
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.MS_CLIENT_ID as string,
          client_secret: process.env.MS_CLIENT_SECRET as string,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: 'openid email profile',
        }),
      },
    );
    if (!tokenRes.ok) return loginRedirect(request, 'microsoft');
    const tokenJson = (await tokenRes.json()) as { id_token?: string };
    if (!tokenJson.id_token) return loginRedirect(request, 'microsoft');
    claims = decodeJwtPayload(tokenJson.id_token);
  } catch {
    return loginRedirect(request, 'microsoft');
  }

  // Microsoft puts the email in `email` or (more reliably) the UPN in
  // `preferred_username`. Optionally pin the tenant id as an extra check.
  const email =
    (typeof claims?.email === 'string' && claims.email) ||
    (typeof claims?.preferred_username === 'string' && claims.preferred_username) ||
    undefined;
  const tenantOk =
    !process.env.MS_TENANT_ID ||
    (typeof claims?.tid === 'string' && claims.tid === process.env.MS_TENANT_ID);

  if (!emailAllowed(email) || !tenantOk) {
    return loginRedirect(request, 'domain');
  }

  const token = signSession(newSession(email as string, 'microsoft'));
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  const dest = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/';
  return NextResponse.redirect(new URL(dest, request.url));
}
