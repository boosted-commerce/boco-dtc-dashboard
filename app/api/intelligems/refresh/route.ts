import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { bustCache } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Force a fresh pull from Intelligems for a brand by clearing the cached
// active-tests + results, plus the page deep-dive cache that embeds them.
// The next page load re-fetches live from the External API.
export async function POST(request: NextRequest) {
  let body: { brand?: string };
  try {
    body = (await request.json()) as { brand?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const brand = parseBrand(body.brand);
  try {
    const cleared =
      (await bustCache(`intelligems:active:${brand}`)) +
      (await bustCache(`intelligems:results:${brand}`)) +
      (await bustCache(`deepdive:${brand}:`));
    return Response.json({ ok: true, brand, cleared });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
