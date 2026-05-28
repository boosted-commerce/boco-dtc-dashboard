import type { Brand } from '@/lib/queries/orders';

// Microsoft Clarity project IDs per brand. null = brand isn't on Clarity yet;
// the dashboard renders no heatmap link for those brands (graceful skip).
//
// Get the ID from clarity.microsoft.com — the project URL is
// /projects/view/<this-id>/dashboard.
export const CLARITY_PROJECT_IDS: Record<Brand, string | null> = {
  ASN: null,
  HHH: 'c8sm63dtq1',
  VIV: 'u0foay6d7x',
  PRL: 'c9cysvy4ep',
};

// Deep link to Clarity's heatmap view, filtered to one URL on the brand's
// project. Returns null if the brand isn't configured — callers should
// not render the link in that case.
//
// `path` is the same normalized path the rest of the dashboard uses
// (e.g. "/products/copper-peptides-serum"), not a full URL.
export function clarityHeatmapUrl(brand: Brand, path: string): string | null {
  const projectId = CLARITY_PROJECT_IDS[brand];
  if (!projectId) return null;
  // Clarity's URL filter expects the full landing URL; we don't know the
  // brand's storefront domain here, so we send the path. If the filter
  // doesn't match, the user still lands on the heatmap view and can
  // refine manually — better than no link.
  return `https://clarity.microsoft.com/projects/view/${projectId}/heatmaps?url=${encodeURIComponent(path)}&date=Last%2028%20days`;
}

// Deep link to Clarity's recordings view, filtered to sessions that
// had a specific insight (rage clicks, dead clicks, etc.) on a given
// URL. Lets the team click a Dead clicks count on the dashboard and
// land directly on the recordings that produced it.
//
// Clarity's filter format isn't fully documented — we pass both `url`
// and `insight` query params. If Clarity's UI ignores one, the user
// still lands on the recordings view for the project and can refine
// in-app. Better than no link.
export function clarityRecordingsUrl(
  brand: Brand,
  path: string,
  insight: 'dead-clicks' | 'rage-clicks' | 'quickback-clicks' | 'excessive-scrolling',
): string | null {
  const projectId = CLARITY_PROJECT_IDS[brand];
  if (!projectId) return null;
  const params = new URLSearchParams({
    date: 'Last 3 days',
    url: path,
    insight,
  });
  return `https://clarity.microsoft.com/projects/view/${projectId}/recordings?${params.toString()}`;
}
