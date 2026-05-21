import { type NextRequest } from 'next/server';
import { parseBrand, parsePeriod } from '@/lib/queries/orders';
import { rawBreakdowns } from '@/lib/northbeam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Diagnostic for Northbeam credentials + API shape. Confirms (a) the
// per-brand env vars are set, (b) the auth headers work, (c) the
// breakdowns endpoint accepts our request body. Returns the raw
// response so we can inspect the actual shape and finalize the parser.
//
// Usage: /api/northbeam/test?brand=ASN&period=28
export async function GET(request: NextRequest) {
  try {
    const brand = parseBrand(request.nextUrl.searchParams.get('brand'));
    const period = parsePeriod(request.nextUrl.searchParams.get('period'));
    const result = await rawBreakdowns(brand, period);
    return Response.json({ brand, period, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
