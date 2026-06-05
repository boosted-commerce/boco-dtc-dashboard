import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { normalizePathInput } from '@/lib/watched-store';
import { addComment, deleteComment } from '@/lib/comments-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  brand?: string;
  path?: string;
  action?: 'add' | 'delete';
  text?: string;
  author?: string;
  id?: string;
};

// Add or delete a per-page team comment. Mirrors the watched/hidden
// toggle routes. No cache to bust — comments are read live per request.
export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const brand = parseBrand(body.brand);
  const normalizedPath = body.path ? normalizePathInput(body.path) : null;
  if (!normalizedPath) {
    return Response.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    if (body.action === 'delete') {
      if (!body.id) return Response.json({ error: 'Missing comment id' }, { status: 400 });
      await deleteComment(brand, normalizedPath, body.id);
      return Response.json({ ok: true });
    }
    const text = (body.text ?? '').trim();
    if (!text) return Response.json({ error: 'Comment cannot be empty' }, { status: 400 });
    const comment = await addComment(brand, normalizedPath, body.author ?? '', text);
    return Response.json({ ok: true, comment });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
