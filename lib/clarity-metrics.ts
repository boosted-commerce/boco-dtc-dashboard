import type { Brand } from '@/lib/queries/orders';

// Microsoft Clarity Data Export API client. Reads per-brand API tokens
// from `CLARITY_API_TOKEN_<BRAND>` env vars (set in Vercel).
//
// Endpoint we plan to call (subject to verification once a token lands):
//   GET https://www.clarity.ms/export-data/api/v1/project-live-insights
//        ?numOfDays=3&dimension1=URL
//   Header: Authorization: Bearer <token>
//
// Clarity's API has tight limits — 10 calls per project per day, and
// data only goes back 1-3 days. We pull once per brand per dashboard
// load with Upstash-cached responses (12h TTL) so the per-brand budget
// is never close to exhausted.

export type ClarityPageMetrics = {
  /** Sessions on this URL within the Clarity window (1-3 days). */
  sessions: number | null;
  /** Number of rage-click sessions — repeated rapid clicks indicating frustration. */
  rageClicks: number | null;
  /** Number of dead-click sessions — clicks on non-interactive elements. */
  deadClicks: number | null;
  /** Average scroll depth, 0-100. */
  scrollDepthPct: number | null;
  /** Average session time on page, in seconds. */
  avgTimeSeconds: number | null;
};

export type ClarityMetricsMap = Map<string, ClarityPageMetrics>;

function getClarityToken(brand: Brand): string | null {
  return process.env[`CLARITY_API_TOKEN_${brand}`] ?? null;
}

// Returns Clarity page-level metrics for a brand, keyed by normalized
// path. Returns an empty Map when:
//   - the brand has no Clarity project / token configured (e.g. ASN)
//   - the API call fails for any reason
//   - the response shape doesn't match what we expect
//
// This tolerance means the dashboard always renders — brands without
// Clarity get "—" placeholders in the metric columns rather than a
// broken page.
export async function getClarityMetrics(brand: Brand): Promise<ClarityMetricsMap> {
  const token = getClarityToken(brand);
  if (!token) return new Map();

  // TODO once a real Clarity API token lands in Vercel:
  //   1. Hit the project-live-insights endpoint above
  //   2. Cache the response in Upstash (key: `clarity:${brand}:v1`, TTL 12h)
  //   3. Parse insights[].information arrays to extract per-URL metrics
  //   4. Build the Map keyed on normalized path
  //
  // For now we short-circuit to an empty Map — the dashboard renders
  // placeholders. When the token is configured, swap this body for the
  // real call and the columns light up automatically.
  return new Map();
}
