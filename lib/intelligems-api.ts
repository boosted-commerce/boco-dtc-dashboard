import type { Brand } from '@/lib/queries/orders';
import { INTELLIGEMS_TESTS, type IntelligemsTest } from '@/lib/intelligems-tests';
import { withCache } from '@/lib/cache';

// Live Intelligems External API client. Reads per-brand keys from
// `INTELLIGEMS_API_TOKEN_<BRAND>` and pulls active experiments so the
// dashboard reflects real tests automatically (replacing the
// hand-maintained intelligems-tests.ts list). Falls back to that static
// list when a brand has no token or the API is unavailable.
//
// Two consumers:
//   - Layer 2 A/B badge: redirect / split-URL tests (origin/destination
//     paths) → getIntelligemsTests + matchIntelligemsTest.
//   - Layer 3 deep dive "Active A/B tests on this page": ALL tests we can
//     locate to a path — redirects PLUS on-site edits with URL targeting
//     → getActiveTests + matchActiveTestsForPath.
//
// Auth header: `intelligems-access-token`. Docs:
// https://docs.intelligems.io/developer-resources/external-api

const BASE = 'https://api.intelligems.io/v25-10-beta';
const CACHE_TTL_SECONDS = 30 * 60;

function token(brand: Brand): string | null {
  return process.env[`INTELLIGEMS_API_TOKEN_${brand}`] ?? null;
}

type RawRedirect = { originUrl?: string | null; destinationUrl?: string | null };
type RawVariation = { redirects?: RawRedirect[] | null };
type RawTargetQuery = { value?: string | null; type?: string | null };
type RawTargetExpression = { query?: RawTargetQuery | null };
type RawPageTargeting = { expression?: RawTargetExpression[] | null };
type RawExperience = {
  id: string;
  name?: string | null;
  status?: string | null; // pending | started | ended | paused
  type?: string | null;
  variations?: RawVariation[] | null;
  experiencePageTargeting?: RawPageTargeting[] | null;
};
type ExperiencesListResponse = { experiencesList?: RawExperience[] | null };

// A located Intelligems test: everything we can map to page paths.
export type ActiveTest = {
  id: string;
  name: string;
  type: string; // e.g. personalization | content/template | content/onsiteEdits
  testUrl: string;
  origins: string[]; // redirect origins (paths)
  destinations: string[]; // redirect destinations (paths)
  targetPaths: string[]; // page-targeting urlPath values (on-site edits)
  redirects: { origin: string; destination: string }[]; // paired origin→destination
};

// Normalize a URL or path to a clean path (strip protocol+host, query,
// fragment, trailing slash).
function toPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v) return null;
  try {
    v = new URL(v).pathname;
  } catch {
    // already a path-ish string
  }
  v = v.split('?')[0].split('#')[0];
  if (!v.startsWith('/')) v = `/${v}`;
  if (v.length > 1) v = v.replace(/\/+$/, '');
  return v || '/';
}

// Raw fetch of active experiences for a brand (also used by the debug route).
export async function fetchActiveExperiences(brand: Brand): Promise<RawExperience[]> {
  const t = token(brand);
  if (!t) return [];
  const res = await fetch(`${BASE}/experiences-list?status=started&limit=100`, {
    headers: { 'intelligems-access-token': t, accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    console.error(`Intelligems ${brand} HTTP ${res.status}`);
    return [];
  }
  const json = (await res.json()) as ExperiencesListResponse;
  return (json.experiencesList ?? []).filter((e) => !e.status || e.status === 'started');
}

// Raw analytics for one experiment (cohort-attributed results per
// variation + significance). Schema TBD — used by the debug route to
// capture the real shape before building the Tier 2 results card.
export async function fetchExperienceAnalytics(
  brand: Brand,
  experienceId: string,
): Promise<unknown> {
  const t = token(brand);
  if (!t) return { error: 'no token' };
  const res = await fetch(`${BASE}/analytics/resource/${experienceId}`, {
    headers: { 'intelligems-access-token': t, accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) return { error: `HTTP ${res.status}`, body: await res.text().catch(() => '') };
  return res.json();
}

// Cohort-attributed results per variation (Tier 2). Values are fractions
// for rates (conv) and dollars for revenue. CIs available but not surfaced
// in the lean shape yet.
export type VariationResult = {
  id: string;
  name: string;
  isControl: boolean;
  visitors: number;
  orders: number;
  convRate: number | null; // fraction 0-1
  rpv: number | null; // net revenue per visitor ($)
  aov: number | null; // net revenue per order ($)
  netRevenue: number | null;
};
export type ExperienceResults = {
  experienceId: string;
  experienceName: string;
  variations: VariationResult[];
};

// Pull a {value} out of a metric cell like { value, ci_low, ... }.
function metricNum(row: Record<string, unknown> | undefined, key: string): number | null {
  const m = row?.[key];
  if (m && typeof m === 'object' && 'value' in (m as object)) {
    const v = (m as { value?: unknown }).value;
    return typeof v === 'number' ? v : null;
  }
  return null;
}

// Cohort-attributed results for one experiment, mapped + cached.
export async function getExperienceResults(
  brand: Brand,
  experienceId: string,
): Promise<ExperienceResults | null> {
  if (!token(brand)) return null;
  return withCache(`intelligems:results:${brand}:${experienceId}:v1`, CACHE_TTL_SECONDS, async () => {
    try {
      const raw = (await fetchExperienceAnalytics(brand, experienceId)) as {
        experienceName?: string;
        metrics?: Array<Record<string, unknown>>;
        variations?: Array<{ id: string; name?: string; isControl?: boolean; order?: number }>;
      };
      if (!raw || !Array.isArray(raw.variations) || raw.variations.length === 0) return null;
      const metricsByVar = new Map<string, Record<string, unknown>>();
      for (const m of raw.metrics ?? []) {
        const vid = m['variation_id'];
        if (typeof vid === 'string') metricsByVar.set(vid, m);
      }
      const variations: VariationResult[] = raw.variations
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((v) => {
          const m = metricsByVar.get(v.id);
          return {
            id: v.id,
            name: v.name ?? 'Variation',
            isControl: Boolean(v.isControl),
            visitors: metricNum(m, 'n_visitors') ?? 0,
            orders: metricNum(m, 'n_orders') ?? 0,
            convRate: metricNum(m, 'conversion_rate'),
            rpv: metricNum(m, 'net_revenue_per_visitor'),
            aov: metricNum(m, 'net_revenue_per_order'),
            netRevenue: metricNum(m, 'net_revenue'),
          };
        });
      return { experienceId, experienceName: raw.experienceName ?? '', variations };
    } catch (err) {
      console.error(`Intelligems results ${brand}/${experienceId} failed:`, err);
      return null;
    }
  });
}

function mapToActiveTests(experiences: RawExperience[]): ActiveTest[] {
  return experiences.map((e) => {
    const origins = new Set<string>();
    const destinations = new Set<string>();
    const targetPaths = new Set<string>();
    const pairs = new Map<string, string>(); // origin → destination
    for (const v of e.variations ?? []) {
      for (const r of v.redirects ?? []) {
        const o = toPath(r.originUrl);
        const d = toPath(r.destinationUrl);
        if (o) origins.add(o);
        if (d) destinations.add(d);
        if (o && d) pairs.set(o, d);
      }
    }
    // On-site edits target by URL path (no redirect). Extract those.
    for (const pt of e.experiencePageTargeting ?? []) {
      for (const ex of pt.expression ?? []) {
        if (ex.query?.type === 'urlPath') {
          const p = toPath(ex.query.value);
          if (p) targetPaths.add(p);
        }
      }
    }
    return {
      id: e.id,
      name: e.name ?? 'Intelligems test',
      type: e.type ?? 'test',
      testUrl: `https://app.intelligems.io/experiment/${e.id}`,
      origins: [...origins],
      destinations: [...destinations],
      targetPaths: [...targetPaths],
      redirects: [...pairs].map(([origin, destination]) => ({ origin, destination })),
    };
  });
}

// Static fallback (intelligems-tests.ts) → ActiveTest shape.
function staticToActive(brand: Brand): ActiveTest[] {
  return (INTELLIGEMS_TESTS[brand] ?? []).map((t) => ({
    id: t.testUrl.split('/').pop() ?? t.name,
    name: t.name,
    type: 'content/url',
    testUrl: t.testUrl,
    origins: t.origins,
    destinations: t.destinations,
    targetPaths: [],
    redirects: [],
  }));
}

// All active tests for a brand (located to paths where possible), cached.
export async function getActiveTests(brand: Brand): Promise<ActiveTest[]> {
  if (!token(brand)) return staticToActive(brand);
  return withCache(`intelligems:active:${brand}:v2`, CACHE_TTL_SECONDS, async () => {
    try {
      const experiences = await fetchActiveExperiences(brand);
      const mapped = mapToActiveTests(experiences);
      // Return real tests even when none are URL-locatable — template /
      // product tests have empty origins/destinations/targetPaths, but the
      // team still needs them in the manual attach-by-dropdown flow (and
      // the A/B tab once attached). Only fall back to the static list when
      // the API returned nothing at all (no token / outage).
      return mapped.length > 0 ? mapped : staticToActive(brand);
    } catch (err) {
      console.error(`Intelligems ${brand} fetch failed:`, err);
      return staticToActive(brand);
    }
  });
}

// Layer 2 badge view: redirect/split-URL tests only (origin/destination).
export async function getIntelligemsTests(brand: Brand): Promise<IntelligemsTest[]> {
  const active = await getActiveTests(brand);
  return active
    .filter((t) => t.origins.length > 0 || t.destinations.length > 0)
    .map((t) => ({
      name: t.name,
      testUrl: t.testUrl,
      origins: t.origins,
      destinations: t.destinations,
    }));
}

// Badge lookup (redirect tests) — origin vs destination role.
export function matchIntelligemsTest(
  tests: IntelligemsTest[],
  path: string,
): { test: IntelligemsTest; role: 'origin' | 'destination' } | null {
  for (const test of tests) {
    if (test.origins.includes(path)) return { test, role: 'origin' };
    if (test.destinations.includes(path)) return { test, role: 'destination' };
  }
  return null;
}

// Deep-dive lookup: every active test that touches this page (redirect
// origin/destination OR on-site URL targeting).
export function matchActiveTestsForPath(tests: ActiveTest[], path: string): ActiveTest[] {
  return tests.filter(
    (t) =>
      t.origins.includes(path) ||
      t.destinations.includes(path) ||
      t.targetPaths.includes(path),
  );
}
