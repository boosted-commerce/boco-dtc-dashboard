import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { dismissTest, undismissTest } from '@/lib/intelligems-attach';
import { normalizePathInput } from '@/lib/watched-store';
import { bustCache } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  brand?: string;
  path?: string;
  testId?: string;
  action?: 'add' | 'remove';
};

// Dismiss (hide) or restore an auto-located A/B test on a page's deep dive.
export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const brand = parseBrand(body.brand);
  const path = body.path ? normalizePathInput(body.path) : null;
  const testId = typeof body.testId === 'string' ? body.testId : null;
  if (!path || !testId) {
    return Response.json({ error: 'Missing path or testId' }, { status: 400 });
  }
  const action = body.action === 'remove' ? 'remove' : 'add';

  try {
    if (action === 'add') {
      await dismissTest(brand, path, testId);
    } else {
      await undismissTest(brand, path, testId);
    }
    await bustCache(`deepdive:${brand}:`);
    return Response.json({ brand, path, testId, action });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
