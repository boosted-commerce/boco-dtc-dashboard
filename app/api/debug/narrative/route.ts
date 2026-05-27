import { type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Quick diagnostic to verify Anthropic auth works without any of the
// dashboard's data layer in the path. Returns the raw API response so
// we can see exactly what Anthropic says — auth error, model issue,
// rate limit, etc.
export async function GET(_request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({
      step: 'env-check',
      ok: false,
      reason: 'ANTHROPIC_API_KEY is not set in Vercel env vars.',
    });
  }

  // Don't return the full key. Just confirm it's present and the
  // prefix looks right.
  const prefix = apiKey.slice(0, 14);
  const length = apiKey.length;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Reply with exactly: "API call succeeded."' }],
      }),
    });
    const text = await res.text();
    let body: unknown = text.slice(0, 1500);
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return Response.json({
      step: 'live-call',
      ok: res.ok,
      status: res.status,
      keyPrefix: prefix,
      keyLength: length,
      body,
    });
  } catch (err) {
    return Response.json({
      step: 'live-call',
      ok: false,
      keyPrefix: prefix,
      keyLength: length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
