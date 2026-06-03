import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import {
  addHiddenPath,
  normalizePathInput,
  removeHiddenPath,
} from '@/lib/watched-store';
import { bustCache } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ToggleBody = {
  brand?: string;
  path?: string;
  action?: 'add' | 'remove';
};

// Hide / restore a page from the auto-discovered Layer 2 page tabs.
// Mirrors /api/watched/toggle. `add` hides, `remove` restores.
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
      await addHiddenPath(brand, normalizedPath);
    } else {
      await removeHiddenPath(brand, normalizedPath);
    }
    // Hidden set changed → invalidate the cached Layer 2 rows so the next
    // dashboard load recomputes the page tabs with the new exclusions.
    await bustCache(`layer2:${brand}:`);
    return Response.json({ brand, path: normalizedPath, action, hidden: action === 'add' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
