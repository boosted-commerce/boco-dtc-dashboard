import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Diagnostic for the Clarity Data Export API. Returns the raw response
// so we can see the actual shape (metric names, dimension keys, value
// types) before locking the parser in lib/clarity-metrics.ts.
//
// Usage: /api/debug/clarity?brand=HHH
export async function GET(request: NextRequest) {
  const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
  const token = process.env[`CLARITY_API_TOKEN_${brand}`];
  if (!token) {
    return Response.json({
      ok: false,
      reason: `CLARITY_API_TOKEN_${brand} not set in Vercel env vars.`,
    });
  }

  // Per Clarity's documented Data Export API:
  //   GET https://www.clarity.ms/export-data/api/v1/project-live-insights
  //         ?numOfDays=1..3 &dimension1=URL [&dimension2=...] [&dimension3=...]
  //   Header: Authorization: Bearer <token>
  const url = `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    const text = await res.text();
    let body: unknown = text.slice(0, 5000);
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return Response.json({
      brand,
      ok: res.ok,
      status: res.status,
      tokenPrefix: token.slice(0, 8),
      url,
      body,
    });
  } catch (err) {
    return Response.json({
      brand,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
