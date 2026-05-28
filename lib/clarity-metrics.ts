import { Redis } from '@upstash/redis';
import type { Brand } from '@/lib/queries/orders';
import { normalizeShopifyUrl } from '@/lib/shopify';

// Microsoft Clarity Data Export API client. Reads per-brand API tokens
// from `CLARITY_API_TOKEN_<BRAND>` env vars (set in Vercel).
//
// Endpoint:
//   GET https://www.clarity.ms/export-data/api/v1/project-live-insights
//        ?numOfDays=3&dimension1=URL
//   Header: Authorization: Bearer <token>
//
// Response shape (confirmed via /api/debug/clarity probe):
//   [{ metricName: "DeadClickCount", information: [
//       { Url, sessionsCount, sessionsWithMetricPercentage, subTotal, ... }
//     ]}, ...]
//
// Clarity's API has tight limits — 10 calls per project per day, and
// data only goes back 1-3 days. We cache responses in Upstash 12h per
// brand so the per-brand budget is never exhausted.

const CLARITY_API_URL =
  'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL';
const CACHE_TTL_SECONDS = 12 * 60 * 60;

export type ClarityPageMetrics = {
  /** Total sessions on this normalized path within the Clarity window. */
  sessions: number | null;
  /** Total rage-click count summed across sessions on this path. */
  rageClicks: number | null;
  /** Total dead-click count summed across sessions on this path. */
  deadClicks: number | null;
  /** Total quickback-click count — sessions where user landed and bounced back fast. */
  quickbackClicks: number | null;
  /** Average scroll depth across sessions on this path (0-100). */
  scrollDepthPct: number | null;
  /** Average session time on this path, in seconds. */
  avgTimeSeconds: number | null;
};

export type ClarityMetricsMap = Map<string, ClarityPageMetrics>;

function getClarityToken(brand: Brand): string | null {
  return process.env[`CLARITY_API_TOKEN_${brand}`] ?? null;
}

let _redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  try { _redis = Redis.fromEnv(); } catch { _redis = null; }
  return _redis;
}

const num = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Most metrics share these fields. ScrollDepth and EngagementTime have
// their own narrower shapes (see comments below).
type RawInformation = {
  Url?: string | null;
  sessionsCount?: string | number;
  sessionsWithMetricPercentage?: number;
  pagesViews?: string | number;
  subTotal?: string | number;
  // ScrollDepth metric only:
  averageScrollDepth?: number;
  // EngagementTime metric only — seconds, total across sessions:
  totalTime?: string | number;
  activeTime?: string | number;
  // Traffic metric only:
  totalSessionCount?: string | number;
};
type RawMetric = { metricName?: string; information?: RawInformation[] };

// Aggregator: collects per-path totals across all metrics + all URL
// variants (srsltid, utm, etc.) that collapse to the same normalized
// path. Sessions and counts sum; scroll depth and time are weighted
// averages (sum of value*sessions / sum of sessions).
type Accumulator = {
  sessions: number;
  rageTotal: number; // subTotal summed
  deadTotal: number;
  quickbackTotal: number;
  scrollDepthWeighted: number; // sum of pct * sessions, divided at the end
  scrollDepthSessions: number;
  timeWeighted: number; // sum of seconds * sessions
  timeSessions: number;
};

function parseClarityResponse(raw: RawMetric[]): ClarityMetricsMap {
  // First pass: collect sessions per URL. ScrollDepth and EngagementTime
  // metric rows DON'T include sessionsCount themselves — they only
  // include Url + their metric value. So we look up sessions from a
  // count-bearing metric (RageClickCount / DeadClickCount / etc.) by
  // URL when aggregating those two.
  const sessionsPerUrl = new Map<string, number>();
  for (const metric of raw) {
    for (const row of metric.information ?? []) {
      if (!row.Url) continue;
      if (sessionsPerUrl.has(row.Url)) continue;
      const s = num(row.sessionsCount);
      if (s > 0) sessionsPerUrl.set(row.Url, s);
    }
  }

  // Second pass: aggregate per normalized path. Multiple URL variants
  // (srsltid, utm) collapse to one path; their sessions sum, their
  // metric counts sum, and scroll/time become sessions-weighted avgs.
  const byPath = new Map<string, Accumulator & { urlsCounted: Set<string> }>();

  for (const metric of raw) {
    const name = (metric.metricName ?? '').toLowerCase();
    for (const row of metric.information ?? []) {
      const url = row.Url;
      if (!url) continue;
      const path = normalizeShopifyUrl(url);
      const sessions = sessionsPerUrl.get(url) ?? num(row.sessionsCount);

      let acc = byPath.get(path);
      if (!acc) {
        acc = {
          sessions: 0,
          rageTotal: 0,
          deadTotal: 0,
          quickbackTotal: 0,
          scrollDepthWeighted: 0,
          scrollDepthSessions: 0,
          timeWeighted: 0,
          timeSessions: 0,
          urlsCounted: new Set<string>(),
        };
        byPath.set(path, acc);
      }

      // Credit sessions ONCE per URL variant (not per metric — each
      // metric's information array re-lists the same URLs with the
      // same sessions count).
      if (!acc.urlsCounted.has(url) && sessions > 0) {
        acc.sessions += sessions;
        acc.urlsCounted.add(url);
      }

      // Metric-specific extraction — use the actual field names
      // Clarity's response uses (confirmed via the debug probe).
      if (name === 'rageclickcount') {
        acc.rageTotal += num(row.subTotal);
      } else if (name === 'deadclickcount') {
        acc.deadTotal += num(row.subTotal);
      } else if (name === 'quickbackclick') {
        acc.quickbackTotal += num(row.subTotal);
      } else if (name === 'scrolldepth') {
        // Shape: { Url, averageScrollDepth: number }
        const pct = num(row.averageScrollDepth);
        if (pct > 0 && sessions > 0) {
          acc.scrollDepthWeighted += pct * sessions;
          acc.scrollDepthSessions += sessions;
        }
      } else if (name === 'engagementtime') {
        // Shape: { Url, totalTime, activeTime } — values in seconds.
        // totalTime is summed across sessions on this URL, so we sum
        // across URL variants then divide by total sessions at the end.
        const totalSeconds = num(row.totalTime);
        if (totalSeconds > 0 && sessions > 0) {
          acc.timeWeighted += totalSeconds;
          acc.timeSessions += sessions;
        }
      }
    }
  }

  const out: ClarityMetricsMap = new Map();
  for (const [path, acc] of byPath) {
    out.set(path, {
      sessions: acc.sessions > 0 ? acc.sessions : null,
      rageClicks: acc.rageTotal > 0 ? acc.rageTotal : null,
      deadClicks: acc.deadTotal > 0 ? acc.deadTotal : null,
      quickbackClicks: acc.quickbackTotal > 0 ? acc.quickbackTotal : null,
      scrollDepthPct:
        acc.scrollDepthSessions > 0
          ? acc.scrollDepthWeighted / acc.scrollDepthSessions
          : null,
      avgTimeSeconds:
        acc.timeSessions > 0 ? acc.timeWeighted / acc.timeSessions : null,
    });
  }
  return out;
}

// Returns Clarity page-level metrics for a brand, keyed by normalized
// path. Returns an empty Map when the brand has no Clarity project /
// token configured (e.g. ASN today), or when the API call fails for
// any reason. Tolerance keeps the dashboard rendering with "—"
// placeholders rather than breaking.
export async function getClarityMetrics(brand: Brand): Promise<ClarityMetricsMap> {
  const token = getClarityToken(brand);
  if (!token) return new Map();

  const redis = getRedis();
  const cacheKey = `clarity:${brand}:metrics:v1`;

  if (redis) {
    try {
      const cached = await redis.get<RawMetric[]>(cacheKey);
      if (cached) return parseClarityResponse(cached);
    } catch {
      // Fall through to live call
    }
  }

  try {
    const res = await fetch(CLARITY_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`Clarity ${brand} HTTP ${res.status}`);
      return new Map();
    }
    const raw = (await res.json()) as RawMetric[];
    if (!Array.isArray(raw)) {
      console.error(`Clarity ${brand} unexpected shape — not an array`);
      return new Map();
    }
    if (redis) {
      try { await redis.set(cacheKey, raw, { ex: CACHE_TTL_SECONDS }); } catch {}
    }
    return parseClarityResponse(raw);
  } catch (err) {
    console.error(`Clarity ${brand} fetch failed:`, err);
    return new Map();
  }
}
