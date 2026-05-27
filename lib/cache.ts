import { Redis } from '@upstash/redis';

// Tiny wrapper that memoizes async results in Upstash Redis. Used to
// cut Snowflake round-trip time off repeat reads (tab switching, brand
// switching back and forth, etc.).
//
// Cache key conventions: include every input that affects the result.
// e.g. `overview:VIV:28:all` not `overview:VIV`.
//
// Tolerant: if Upstash isn't configured (UPSTASH_REDIS_REST_URL missing
// in local dev), withCache just calls the fetcher directly.

let _redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  try { _redis = Redis.fromEnv(); } catch { _redis = null; }
  return _redis;
}

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  if (!redis) return fetcher();

  try {
    const cached = await redis.get<T>(key);
    // Upstash returns null for missing keys. Empty arrays/maps are
    // valid cached results so we only short-circuit on a null miss.
    if (cached !== null) return cached;
  } catch (err) {
    console.error(`cache read failed (${key}):`, err);
    // Fall through to live fetch
  }

  const result = await fetcher();

  try {
    // Upstash's set() accepts plain JS values (objects, arrays) and
    // serializes for us. Maps don't survive JSON serialization so
    // callers using withCache for Map results have to convert to
    // entries-array first.
    await redis.set(key, result as unknown as object, { ex: ttlSeconds });
  } catch (err) {
    console.error(`cache write failed (${key}):`, err);
  }

  return result;
}
