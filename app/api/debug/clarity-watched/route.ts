import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getWatchedPaths } from '@/lib/watched-store';
import { getClarityMetrics } from '@/lib/clarity-metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Diagnostic: do the brand's watched paths intersect with the paths
// Clarity returned in the last 3 days? Lists each watched path, whether
// Clarity has any metric data for it, and (for misses) the closest
// candidates so we can spot normalization mismatches.
//
// Usage: /api/debug/clarity-watched?brand=PRL
export async function GET(request: NextRequest) {
  const brand = parseBrand(request.nextUrl.searchParams.get('brand'));

  const [watched, clarityMap] = await Promise.all([
    getWatchedPaths(brand),
    getClarityMetrics(brand),
  ]);

  const clarityPaths = Array.from(clarityMap.keys()).sort();

  const watchedReport = watched.map((path) => {
    const metrics = clarityMap.get(path) ?? null;
    if (metrics) {
      return { path, matched: true, metrics };
    }
    // Suggest near-matches so we can see if it's a trailing-slash /
    // protocol / casing issue.
    const lower = path.toLowerCase();
    const lastSeg = path.split('/').filter(Boolean).pop() ?? '';
    const candidates = clarityPaths.filter((p) => {
      const lp = p.toLowerCase();
      return (
        lp === lower ||
        lp.startsWith(lower) ||
        lower.startsWith(lp) ||
        (lastSeg.length > 3 && lp.includes(lastSeg.toLowerCase()))
      );
    });
    return { path, matched: false, suggestions: candidates.slice(0, 5) };
  });

  return Response.json({
    brand,
    watchedCount: watched.length,
    clarityPathsReturned: clarityPaths.length,
    watchedReport,
    // Full Clarity path list so we can eyeball normalization mismatches.
    allClarityPaths: clarityPaths,
  });
}
