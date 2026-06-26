import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { moveWatchedPath, normalizePathInput } from '@/lib/watched-store';
import { bustCache } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ReorderBody = {
  brand?: string;
  path?: string;
  dir?: 'up' | 'down';
};

// Move a watched page one slot up/down in the display order.
export async function POST(request: NextRequest) {
  let body: ReorderBody;
  try {
    body = (await request.json()) as ReorderBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const brand = parseBrand(body.brand);
  const normalizedPath = body.path ? normalizePathInput(body.path) : null;
  if (!normalizedPath) {
    return Response.json({ error: 'Invalid path' }, { status: 400 });
  }
  const dir = body.dir === 'up' ? 'up' : 'down';

  try {
    await moveWatchedPath(brand, normalizedPath, dir);
    await bustCache(`layer2:${brand}:`);
    return Response.json({ brand, path: normalizedPath, dir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
