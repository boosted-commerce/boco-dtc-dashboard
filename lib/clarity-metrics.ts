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

type RawInformation = {
  Url?: string;
  sessionsCount?: string | number;
  sessionsWithMetricPercentage?: number;
  pagesViews?: string | number;
  subTotal?: string | number;
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
  scrollDepthWeighted: number; // sum of pct * sessions, divided at the end
  scrollDepthSessions: number;
  timeWeighted: number; // sum of seconds * sessions
  timeSessions: number;
};

function parseClarityResponse(raw: RawMetric[]): ClarityMetricsMap {
  const byPath = new Map<string, Accumulator>();
  // The same row's sessionCount appears across multiple metrics for
  // the same URL — only count it once per URL, using whichever metric
  // we see first. Track which URLs we've already credited sessions for.
  const sessionsCounted = new Set<string>();

  for (const metric of raw) {
    const name = (metric.metricName ?? '').toLowerCase();
    const info = metric.information ?? [];
    for (const row of info) {
      const url = row.Url;
      if (!url) continue;
      const path = normalizeShopifyUrl(url);
      const sessions = num(row.sessionsCount);
      const acc = byPath.get(path) ?? {
        sessions: 0,
        rageTotal: 0,
        deadTotal: 0,
        scrollDepthWeighted: 0,
        scrollDepthSessions: 0,
        timeWeighted: 0,
        timeSessions: 0,
      };

      const urlSessionKey = `${path}|${url}`;
      if (!sessionsCounted.has(urlSessionKey)) {
        acc.sessions += sessions;
        sessionsCounted.add(urlSessionKey);
      }

      // Metric-specific extraction. Clarity returns one metric object
      // per type; we accumulate across them per path.
      if (name.includes('rageclick')) {
        acc.rageTotal += num(row.subTotal);
      } else if (name.includes('deadclick')) {
        acc.deadTotal += num(row.subTotal);
      } else if (name.includes('scrolldepth') || name.includes('scroll_depth')) {
        // sessionsWithMetricPercentage on scroll metrics roughly = avg
        // % scrolled across sessions. Weight by sessions.
        const pct = row.sessionsWithMetricPercentage ?? 0;
        if (sessions > 0 && pct > 0) {
          acc.scrollDepthWeighted += pct * sessions;
          acc.scrollDepthSessions += sessions;
        }
      } else if (name.includes('engagementtime') || name.includes('timespent')) {
        // subTotal is total seconds across sessions (Clarity reports
        // time in seconds at this endpoint).
        const totalSeconds = num(row.subTotal);
        if (sessions > 0 && totalSeconds > 0) {
          acc.timeWeighted += totalSeconds;
          acc.timeSessions += sessions;
        }
      }

      byPath.set(path, acc);
    }
  }

  const out: ClarityMetricsMap = new Map();
  for (const [path, acc] of byPath) {
    out.set(path, {
      sessions: acc.sessions > 0 ? acc.sessions : null,
      rageClicks: acc.rageTotal > 0 ? acc.rageTotal : null,
      deadClicks: acc.deadTotal > 0 ? acc.deadTotal : null,
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
