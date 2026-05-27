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
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    // Summarize so we can see ALL metric names without hitting the 50K
    // response truncation limit. Each metric gets a 2-row sample so we
    // can see the field shape too.
    let summary: unknown = parsed;
    if (Array.isArray(parsed)) {
      summary = parsed.map((m: { metricName?: string; information?: unknown[] }) => ({
        metricName: m.metricName,
        informationCount: Array.isArray(m.information) ? m.information.length : 0,
        sampleRows: Array.isArray(m.information) ? m.information.slice(0, 2) : [],
      }));
    }
    return Response.json({
      brand,
      ok: res.ok,
      status: res.status,
      tokenPrefix: token.slice(0, 8),
      url,
      summary,
    });
  } catch (err) {
    return Response.json({
      brand,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
