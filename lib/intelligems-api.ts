import type { Brand } from '@/lib/queries/orders';
import { INTELLIGEMS_TESTS, type IntelligemsTest } from '@/lib/intelligems-tests';
import { withCache } from '@/lib/cache';

// Live Intelligems External API client. Reads per-brand keys from
// `INTELLIGEMS_API_TOKEN_<BRAND>` env vars and pulls active experiments so
// the A/B badges populate automatically — replacing the hand-maintained
// list in intelligems-tests.ts. Falls back to that static list when a
// brand has no token or the API is unavailable, so nothing breaks.
//
// Auth: `intelligems-access-token` header. Docs:
// https://docs.intelligems.io/developer-resources/external-api

const BASE = 'https://api.intelligems.io/v25-10-beta';
const CACHE_TTL_SECONDS = 30 * 60;

function token(brand: Brand): string | null {
  return process.env[`INTELLIGEMS_API_TOKEN_${brand}`] ?? null;
}

// A redirect (split-URL test) entry, per the API schema:
// variations[].redirects[].{originUrl,destinationUrl}.
type RawRedirect = { originUrl?: string | null; destinationUrl?: string | null };
type RawVariation = { redirects?: RawRedirect[] | null };
type RawExperience = {
  id: string;
  name?: string | null;
  status?: string | null; // pending | started | ended | paused
  type?: string | null;
  variations?: RawVariation[] | null;
};
type ExperiencesListResponse = { experiencesList?: RawExperience[] | null };

// Normalize a URL or path to a clean path the dashboard matches on
// (strip protocol+host, query, fragment, trailing slash).
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

// Raw fetch of active experiences for a brand (used by the debug route).
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

// Map raw experiences → the dashboard's IntelligemsTest shape, keeping
// only those with redirect (split-URL) origin/destination paths — those
// are what the page-level A/B badge keys on.
function mapExperiences(experiences: RawExperience[]): IntelligemsTest[] {
  const tests: IntelligemsTest[] = [];
  for (const e of experiences) {
    const origins = new Set<string>();
    const destinations = new Set<string>();
    for (const v of e.variations ?? []) {
      for (const r of v.redirects ?? []) {
        const o = toPath(r.originUrl);
        const d = toPath(r.destinationUrl);
        if (o) origins.add(o);
        if (d) destinations.add(d);
      }
    }
    if (origins.size === 0 && destinations.size === 0) continue;
    tests.push({
      name: e.name ?? 'Intelligems test',
      testUrl: `https://app.intelligems.io/experiment/${e.id}`,
      origins: [...origins],
      destinations: [...destinations],
    });
  }
  return tests;
}

// Active Intelligems tests for a brand, cached. Live from the API when a
// token is set; otherwise the static fallback list.
export async function getIntelligemsTests(brand: Brand): Promise<IntelligemsTest[]> {
  if (!token(brand)) return INTELLIGEMS_TESTS[brand] ?? [];
  return withCache(`intelligems:${brand}:v1`, CACHE_TTL_SECONDS, async () => {
    try {
      const experiences = await fetchActiveExperiences(brand);
      const mapped = mapExperiences(experiences);
      // If the API returned nothing usable, fall back to the static list
      // rather than dropping badges entirely.
      return mapped.length > 0 ? mapped : INTELLIGEMS_TESTS[brand] ?? [];
    } catch (err) {
      console.error(`Intelligems ${brand} fetch failed:`, err);
      return INTELLIGEMS_TESTS[brand] ?? [];
    }
  });
}

// Pure lookup over an already-fetched test list (so callers fetch once,
// then match many paths synchronously). Mirrors findIntelligemsTest.
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
