import { Redis } from '@upstash/redis';
import type { Brand } from '@/lib/queries/orders';

// Manual page↔test attachments for Intelligems tests that can't be
// auto-located to a URL (template / product-targeted tests). The team
// picks a test on a page's deep dive; we store the experiment id under
// that brand+path so it shows there going forward. Team-shared (Redis).
//
// One HASH per brand at `igattach:{brand}` mapping path → JSON id array.

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

const key = (brand: Brand) => `igattach:${brand}`;

export async function getAttachedTestIds(brand: Brand, path: string): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.hget<string[] | string>(key(brand), path);
    if (!raw) return [];
    // Upstash may return the parsed array or a JSON string depending on how
    // it was written — handle both.
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  } catch (err) {
    console.error('igattach read failed', err);
    return [];
  }
}

// All manual attachments for a brand: path → attached test ids. Used by the
// Layer 2 A/B Tests tab to surface pages that have a test pinned to them even
// when it can't be auto-located by URL.
export async function getAllAttachedPaths(brand: Brand): Promise<Record<string, string[]>> {
  const redis = getRedis();
  if (!redis) return {};
  try {
    const raw = await redis.hgetall<Record<string, string[] | string>>(key(brand));
    if (!raw) return {};
    const out: Record<string, string[]> = {};
    for (const [path, val] of Object.entries(raw)) {
      const ids = Array.isArray(val)
        ? val
        : (() => {
            try {
              const p = JSON.parse(val as string);
              return Array.isArray(p) ? p : [];
            } catch {
              return [];
            }
          })();
      if (ids.length) out[path] = ids;
    }
    return out;
  } catch (err) {
    console.error('igattach hgetall failed', err);
    return {};
  }
}

export async function attachTest(brand: Brand, path: string, testId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Attachment store not configured (UPSTASH_REDIS_REST_URL missing)');
  const ids = await getAttachedTestIds(brand, path);
  if (!ids.includes(testId)) ids.push(testId);
  await redis.hset(key(brand), { [path]: JSON.stringify(ids) });
}

export async function detachTest(brand: Brand, path: string, testId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Attachment store not configured (UPSTASH_REDIS_REST_URL missing)');
  const ids = (await getAttachedTestIds(brand, path)).filter((id) => id !== testId);
  await redis.hset(key(brand), { [path]: JSON.stringify(ids) });
}
