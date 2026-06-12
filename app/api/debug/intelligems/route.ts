import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { fetchActiveExperiences, getIntelligemsTests } from '@/lib/intelligems-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Verify the live Intelligems integration for a brand:
//   /api/debug/intelligems?brand=VIV
// Returns the mapped tests (what the badges will use) plus a trimmed raw
// sample so we can confirm the field mapping against real data. Behind
// the auth gate like the rest of the app.
export async function GET(request: NextRequest) {
  const brand = parseBrand(new URL(request.url).searchParams.get('brand'));
  const tokenSet = Boolean(process.env[`INTELLIGEMS_API_TOKEN_${brand}`]);

  const [tests, raw] = await Promise.all([
    getIntelligemsTests(brand).catch((e) => ({ error: String(e) })),
    fetchActiveExperiences(brand).catch((e) => ({ error: String(e) })),
  ]);

  // Trim the raw payload to the fields that matter, to keep it readable.
  const rawSample = Array.isArray(raw)
    ? raw.slice(0, 5).map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        type: e.type,
        variations: (e.variations ?? []).map((v) => ({ redirects: v.redirects ?? null })),
      }))
    : raw;

  return Response.json({ brand, tokenSet, tests, rawCount: Array.isArray(raw) ? raw.length : 0, rawSample });
}
