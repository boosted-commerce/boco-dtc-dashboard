import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  isAuthConfigured,
  isPasscodeConfigured,
  newSession,
  passcodeMatches,
  signSession,
} from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Passcode sign-in: validates the shared passcode and sets the session
// cookie. Client navigates to `next` on success.
export async function POST(request: Request) {
  if (!isAuthConfigured() || !isPasscodeConfigured()) {
    return Response.json({ error: 'Passcode sign-in is not configured.' }, { status: 400 });
  }
  let body: { passcode?: string };
  try {
    body = (await request.json()) as { passcode?: string };
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
  const passcode = (body.passcode ?? '').trim();
  if (!passcode || !passcodeMatches(passcode)) {
    return Response.json({ error: 'Incorrect passcode.' }, { status: 401 });
  }
  const token = signSession(newSession('passcode@local', 'passcode'));
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return Response.json({ ok: true });
}
