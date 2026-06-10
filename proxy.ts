import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, isAuthConfigured, verifySession } from '@/lib/auth';

// Route gate (Next 16 renamed middleware → proxy; runs on the Node.js
// runtime, so node:crypto is available for session verification).
//
// Enforced only when AUTH_SECRET is configured. Public paths: the login
// page and the auth endpoints themselves. Everything else requires a
// valid session cookie; otherwise redirect to /login?next=…
export function proxy(request: NextRequest) {
  if (!isAuthConfigured()) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  // Public paths: the login page, the auth endpoints, and the cron
  // endpoint (which protects itself via CRON_SECRET, and is hit by Vercel
  // Cron with no session cookie).
  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/cron/')
  ) {
    return NextResponse.next();
  }

  const session = verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('next', pathname + (search || ''));
  return NextResponse.redirect(url);
}

export const config = {
  // Gate everything except Next internals and the favicon.
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};
