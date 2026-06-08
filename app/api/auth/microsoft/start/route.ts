import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  OAUTH_NEXT_COOKIE,
  OAUTH_STATE_COOKIE,
  isAuthConfigured,
  isMicrosoftConfigured,
  msTenant,
  randomState,
} from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Kick off Microsoft Entra ID (Outlook) OAuth 2.0 authorization-code
// flow. Restricted to the Boosted tenant via the authority; stashes a
// CSRF state + post-login destination in short-lived cookies.
export async function GET(request: Request) {
  if (!isAuthConfigured() || !isMicrosoftConfigured()) {
    return NextResponse.redirect(new URL('/login?error=config', request.url));
  }
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/';
  const state = randomState();
  const redirectUri = `${url.origin}/api/auth/microsoft/callback`;

  const authUrl = new URL(
    `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/authorize`,
  );
  authUrl.searchParams.set('client_id', process.env.MS_CLIENT_ID as string);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');

  const store = await cookies();
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 600,
  };
  store.set(OAUTH_STATE_COOKIE, state, opts);
  store.set(OAUTH_NEXT_COOKIE, next, opts);

  return NextResponse.redirect(authUrl.toString());
}
