import { Redis } from '@upstash/redis';
import type { Brand } from '@/lib/queries/orders';

// Per-page team comments — persistent notes attached to a Layer 3 page
// deep-dive (brand + path). Lets a teammate record the *why* behind a
// metric (e.g. "conversion low — redirect bug on this page, see Clarity")
// so the next person reading the AI summary has the context.
//
// Stored as a JSON array under `comments:{brand}:{path}`. Low write
// volume (small team) so a read-modify-write is fine; no list ops needed.

export type PageComment = {
  id: string;
  author: string;
  text: string;
  createdAt: number; // ms epoch
};

// Cap per page so the key can't grow unbounded. Oldest are dropped first.
const MAX_COMMENTS = 200;

let _redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  try {
    _redis = Redis.fromEnv();
  } catch {
    _redis = null;
  }
  return _redis;
}

const key = (brand: Brand, path: string) => `comments:${brand}:${path}`;

export async function getComments(brand: Brand, path: string): Promise<PageComment[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const list = await redis.get<PageComment[]>(key(brand, path));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('comments read failed', err);
    return [];
  }
}

export async function addComment(
  brand: Brand,
  path: string,
  author: string,
  text: string,
): Promise<PageComment> {
  const redis = getRedis();
  if (!redis) throw new Error('Comments store not configured (UPSTASH_REDIS_REST_URL missing)');
  const comment: PageComment = {
    id: crypto.randomUUID(),
    author: author.trim().slice(0, 60) || 'Anonymous',
    text: text.trim().slice(0, 2000),
    createdAt: Date.now(),
  };
  const existing = await getComments(brand, path);
  // Newest last; trim from the front if over the cap.
  const next = [...existing, comment].slice(-MAX_COMMENTS);
  await redis.set(key(brand, path), next);
  return comment;
}

export async function deleteComment(
  brand: Brand,
  path: string,
  id: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Comments store not configured (UPSTASH_REDIS_REST_URL missing)');
  const existing = await getComments(brand, path);
  await redis.set(key(brand, path), existing.filter((c) => c.id !== id));
}
