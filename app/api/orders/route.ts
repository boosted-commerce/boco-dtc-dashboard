import { type NextRequest } from 'next/server';
import {
  getStoreOverview,
  parseBrand,
  parsePeriod,
  parseSource,
} from '@/lib/queries/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const brand = parseBrand(sp.get('brand'));
  const period = parsePeriod(sp.get('period'));
  const source = parseSource(sp.get('source'));

  try {
    const overview = await getStoreOverview(brand, period, source);
    return Response.json(overview);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
