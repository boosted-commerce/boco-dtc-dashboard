import { NextResponse } from 'next/server';
import { BRANDS, type Brand } from '@/lib/queries/orders';
import { getWatchedPaths } from '@/lib/watched-store';
import { getComments } from '@/lib/comments-store';
import { getPageDeepDive } from '@/lib/queries/page-deep-dive';
import { getPageNarrative } from '@/lib/queries/narrative';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Generations run sequentially in small batches; 60s covers a few dozen
// watched pages. (Vercel Pro raises this ceiling to 300s if ever needed.)
export const maxDuration = 60;

// Daily snapshot window — matches the dashboard default so the History
// dropdown (which is per-period) fills in for the 28-day view.
const SNAPSHOT_PERIOD = 28 as const;
const CONCURRENCY = 5;

// Generate (force) one watched page's summary so today's snapshot is
// recorded even if nobody opened the page.
async function snapshotOne(brand: Brand, path: string): Promise<void> {
  const [data, comments] = await Promise.all([
    getPageDeepDive(brand, path, SNAPSHOT_PERIOD),
    getComments(brand, path).catch(() => []),
  ]);
  await getPageNarrative({
    brand,
    period: SNAPSHOT_PERIOD,
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
    force: true,
  });
}

// Daily cron: record a fresh AI-summary snapshot for every watched page
// across all brands, so the historical timeline has no gaps on days when
// nobody opened the page. Triggered by Vercel Cron (see vercel.json).
export async function GET(request: Request) {
  // Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when
  // CRON_SECRET is set. Reject anything that doesn't match.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Work list: every watched path across all brands.
  const jobs: { brand: Brand; path: string }[] = [];
  for (const brand of BRANDS) {
    const paths = await getWatchedPaths(brand).catch(() => [] as string[]);
    for (const path of paths) jobs.push({ brand, path });
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((j) => snapshotOne(j.brand, j.path)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else failed++;
    }
  }

  return NextResponse.json({ ok, failed, total: jobs.length, period: SNAPSHOT_PERIOD });
}
