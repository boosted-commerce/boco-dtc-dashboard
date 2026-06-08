import crypto from 'node:crypto';

// Lightweight, dependency-free auth for the dashboard. A signed session
// cookie (HMAC-SHA256) gates every route via proxy.ts. Two ways in:
//   1. Microsoft (Entra ID / Outlook) sign-in restricted to the
//      @boostedcommerce.com tenant + domain
//   2. A shared passcode (for anyone without a Boosted Microsoft account)
//
// Auth is ENFORCED only when AUTH_SECRET is set. With no secret (e.g.
// local dev without `vercel env pull`) the proxy lets everything through,
// matching the rest of the app's tolerant-degradation pattern and
// avoiding a lockout. Set the env vars to turn protection on.

export const SESSION_COOKIE = 'bc_session';
export const OAUTH_STATE_COOKIE = 'bc_oauth_state';
export const OAUTH_NEXT_COOKIE = 'bc_oauth_next';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 1 week
export const ALLOWED_DOMAIN = 'boostedcommerce.com';

export type Session = {
  email: string;
  method: 'microsoft' | 'passcode';
  exp: number; // ms epoch
};

export function isAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET);
}

export function isMicrosoftConfigured(): boolean {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

// Entra ID authority tenant. Prefer the specific Boosted tenant ID (so
// only that org can sign in); fall back to 'organizations' (any work/
// school account) with the domain check below as the gate.
export function msTenant(): string {
  return process.env.MS_TENANT_ID || 'organizations';
}

export function isPasscodeConfigured(): boolean {
  return Boolean(process.env.DASHBOARD_PASSCODE);
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url');

function hmac(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

// token = base64url(JSON payload) + "." + base64url(HMAC(payload))
export function signSession(session: Session): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET not set');
  const body = b64url(JSON.stringify(session));
  return `${body}.${hmac(body, secret)}`;
}

export function verifySession(token: string | undefined): Session | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body, secret);
  // Constant-time compare; lengths must match for timingSafeEqual.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

// Constant-time string compare for the shared passcode.
export function passcodeMatches(input: string): boolean {
  const expected = process.env.DASHBOARD_PASSCODE;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function newSession(email: string, method: Session['method']): Session {
  return { email, method, exp: Date.now() + SESSION_TTL_SECONDS * 1000 };
}

export function randomState(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Email passes the domain gate: @boostedcommerce.com. (Microsoft id
// tokens don't carry an email_verified claim; the tenant-restricted
// authority is the primary gate, this domain check is defense in depth.)
export function emailAllowed(email: string | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
}
