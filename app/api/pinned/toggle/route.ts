import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import {
  addPinnedPath,
  normalizePathInput,
  removePinnedPath,
} from '@/lib/watched-store';
import { bustCache } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ToggleBody = {
  brand?: string;
  path?: string;
  action?: 'add' | 'remove';
};

// Pin / unpin a page into the auto-discovered Layer 2 page tabs. Mirrors
// /api/hidden/toggle. `add` pins (force-include), `remove` unpins.
export async function POST(request: NextRequest) {
  let body: ToggleBody;
  try {
    body = (await request.json()) as ToggleBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const brand = parseBrand(body.brand);
  const normalizedPath = body.path ? normalizePathInput(body.path) : null;
  if (!normalizedPath) {
    return Response.json({ error: 'Invalid path' }, { status: 400 });
  }
  const action = body.action === 'remove' ? 'remove' : 'add';

  try {
    if (action === 'add') {
      await addPinnedPath(brand, normalizedPath);
    } else {
      await removePinnedPath(brand, normalizedPath);
    }
    await bustCache(`layer2:${brand}:`);
    return Response.json({ brand, path: normalizedPath, action, pinned: action === 'add' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
