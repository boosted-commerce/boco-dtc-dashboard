import { Redis } from '@upstash/redis';
import { BRANDS, type Brand } from '@/lib/queries/orders';
import { WATCHED_PAGES } from '@/lib/watched-pages';

// Team-shared watched-pages store. One Redis SET per brand at key
// `watched:{brand}`, containing normalized path strings (e.g. '/products/foo').
// On first access for a brand, seeds from the static `WATCHED_PAGES` config
// in lib/watched-pages.ts so existing entries aren't lost in the migration.

// Lazy + tolerant client. If UPSTASH_REDIS_REST_URL / _TOKEN are missing
// (e.g. local dev without `vercel env pull`), reads degrade to the static
// defaults so the dashboard stays usable. Writes throw — the toggle API
// surfaces the error to the user.
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

const key = (brand: Brand) => `watched:${brand}`;
const seedKey = (brand: Brand) => `watched:${brand}:seeded`;

async function ensureSeeded(brand: Brand): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const seeded = await redis.get<string>(seedKey(brand));
  if (seeded) return;
  const defaults = WATCHED_PAGES[brand] ?? [];
  if (defaults.length > 0) {
    // @upstash/redis sadd typed as `(key, member, ...members)` — needs
    // at least one positional member, so split off the first.
    const [first, ...rest] = defaults;
    await redis.sadd(key(brand), first, ...rest);
  }
  await redis.set(seedKey(brand), '1');
}

export async function getWatchedPaths(brand: Brand): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [...(WATCHED_PAGES[brand] ?? [])].sort();
  try {
    await ensureSeeded(brand);
    const members = await redis.smembers(key(brand));
    return members.sort();
  } catch (err) {
    console.error('watched-store read failed; falling back to defaults', err);
    return [...(WATCHED_PAGES[brand] ?? [])].sort();
  }
}

export async function getAllWatchedPaths(): Promise<Record<Brand, string[]>> {
  // Parallel reads for all brands. Used by Server Components to decide
  // per-row star state across the Layer 2 page-type tabs.
  const entries = await Promise.all(
    BRANDS.map(async (brand) => [brand, await getWatchedPaths(brand)] as const),
  );
  return Object.fromEntries(entries) as Record<Brand, string[]>;
}

export async function addWatchedPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Watched-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await ensureSeeded(brand);
  await redis.sadd(key(brand), path);
}

export async function removeWatchedPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Watched-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await ensureSeeded(brand);
  await redis.srem(key(brand), path);
}

// Normalize a user-typed URL into a path the dashboard can match.
//  - Strip protocol + host so 'https://site.com/pages/foo?utm=x' -> '/pages/foo'
//  - Drop query string
//  - Ensure leading slash
export function normalizePathInput(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  // If it parses as a URL, take just the pathname.
  try {
    const u = new URL(v);
    v = u.pathname;
  } catch {
    // Not a full URL — assume it's already a path
  }
  // Strip query string if present (in case it wasn't a parseable URL)
  v = v.split('?')[0].split('#')[0];
  if (!v.startsWith('/')) v = '/' + v;
  // Collapse trailing slashes except for root
  if (v.length > 1 && v.endsWith('/')) v = v.replace(/\/+$/, '');
  // Reject anything with whitespace or obviously invalid characters
  if (/\s/.test(v)) return null;
  return v;
}
