import { type NextRequest } from 'next/server';
import { parseBrand, parsePeriod } from '@/lib/queries/orders';
import { normalizePathInput } from '@/lib/watched-store';
import { getComments } from '@/lib/comments-store';
import { getPageDeepDive } from '@/lib/queries/page-deep-dive';
import { getPageNarrative } from '@/lib/queries/narrative';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Body = {
  brand?: string;
  path?: string;
  period?: string;
  force?: boolean;
};

// On-demand page-narrative generation. Non-watched pages don't auto-spend
// tokens on load — they call this when the user clicks "Generate" (or
// "Refresh" with force). On success the client refreshes and the page
// reads the now-cached summary.
export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const brand = parseBrand(body.brand);
  const period = parsePeriod(body.period);
  const path = body.path ? normalizePathInput(body.path) : null;
  if (!path) return Response.json({ error: 'Invalid path' }, { status: 400 });

  try {
    const [data, comments] = await Promise.all([
      getPageDeepDive(brand, path, period),
      getComments(brand, path),
    ]);
    const text = await getPageNarrative({
      brand,
      period,
      path,
      sessions: data.sessions,
      convRate: data.convRate,
      orderCount: data.orderCount,
      revenue: data.revenue,
      recentDays: data.recentDays,
      sourceBreakdown: data.sourceBreakdown,
      clarity: data.clarity,
      activePromos: data.activePromos,
      intelligemsRole: data.intelligemsTest?.role ?? null,
      intelligemsTests: data.activeTests,
      comments,
      force: body.force === true,
    });
    if (!text) {
      return Response.json(
        { error: 'Could not generate a summary (AI key missing or request failed).' },
        { status: 502 },
      );
    }
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
