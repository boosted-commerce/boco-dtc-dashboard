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

// Invalidate cache entries by key prefix. Used after mutations (e.g.
// adding a watched URL) so the next read fetches fresh data instead
// of returning the stale cached version.
//
// Upstash supports SCAN which is safer than KEYS on production
// datasets. We page through matching keys and DEL in batches.
export async function bustCache(prefix: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  let cursor: string | number = 0;
  let deleted = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    while (true) {
      const result = (await redis.scan(cursor, { match: `${prefix}*`, count: 100 })) as [string | number, string[]];
      const nextCursor = result[0];
      const keys = result[1];
      if (keys.length > 0) {
        await redis.del(...(keys as [string, ...string[]]));
        deleted += keys.length;
      }
      if (String(nextCursor) === '0') break;
      cursor = nextCursor;
    }
  } catch (err) {
    console.error(`bustCache failed (${prefix}):`, err);
  }
  return deleted;
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
