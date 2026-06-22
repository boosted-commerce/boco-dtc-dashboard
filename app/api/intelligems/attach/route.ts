import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { normalizePathInput } from '@/lib/watched-store';
import { attachTest, detachTest } from '@/lib/intelligems-attach';
import { bustCache } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { brand?: string; path?: string; testId?: string; action?: 'add' | 'remove' };

// Attach / detach an Intelligems test to a page. Lets the team surface
// template/product-targeted tests that auto-detection can't locate.
export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const brand = parseBrand(body.brand);
  const path = body.path ? normalizePathInput(body.path) : null;
  const testId = (body.testId ?? '').trim();
  if (!path) return Response.json({ error: 'Invalid path' }, { status: 400 });
  if (!testId) return Response.json({ error: 'Missing test id' }, { status: 400 });

  try {
    if (body.action === 'remove') {
      await detachTest(brand, path, testId);
    } else {
      await attachTest(brand, path, testId);
    }
    // Bust the page deep-dive cache so the change shows on reload.
    await bustCache(`deepdive:${brand}:`);
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
