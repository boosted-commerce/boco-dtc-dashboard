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
// Explicit display order for the watched list (JSON array of paths). The
// membership SET stays the source of truth; this just records the team's
// preferred ordering. Paths not in the array sort to the end alphabetically,
// so a newly-added page appears last until it's moved.
const orderKey = (brand: Brand) => `watched:${brand}:order`;

async function getWatchedOrder(brand: Brand): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.get<string[] | string>(orderKey(brand));
    if (!raw) return [];
    const arr = typeof raw === 'string' ? (JSON.parse(raw) as string[]) : raw;
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

// Order a set of member paths by the stored order, with any unordered
// members appended alphabetically. Pure helper shared by read + move.
function applyOrder(members: string[], order: string[]): string[] {
  const rank = new Map(order.map((p, i) => [p, i]));
  return [...members].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1; // ordered ones first
    if (rb != null) return 1;
    return a.localeCompare(b); // both unordered → alphabetical
  });
}

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
    const [members, order] = await Promise.all([
      redis.smembers(key(brand)),
      getWatchedOrder(brand),
    ]);
    return applyOrder(members, order);
  } catch (err) {
    console.error('watched-store read failed; falling back to defaults', err);
    return [...(WATCHED_PAGES[brand] ?? [])].sort();
  }
}

// Move a watched path one slot up or down in the display order. Rebuilds
// the order array from the current membership (so it self-heals if the
// stored order drifted from the SET), swaps the path with its neighbour,
// and persists. No-op at the ends.
export async function moveWatchedPath(
  brand: Brand,
  path: string,
  dir: 'up' | 'down',
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Watched-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await ensureSeeded(brand);
  const [members, order] = await Promise.all([
    redis.smembers(key(brand)),
    getWatchedOrder(brand),
  ]);
  const ordered = applyOrder(members, order);
  const i = ordered.indexOf(path);
  if (i === -1) return; // not a watched page
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ordered.length) return; // already at the end
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  await redis.set(orderKey(brand), JSON.stringify(ordered));
}

export async function getAllWatchedPaths(): Promise<Record<Brand, string[]>> {
  // Parallel reads for all brands. Used by Server Components to decide
  // per-row star state across the Layer 2 page-type tabs.
  const entries = await Promise.all(
    BRANDS.map(async (brand) => [brand, await getWatchedPaths(brand)] as const),
  );
  return Object.fromEntries(entries) as Record<Brand, string[]>;
}

// Max watched URLs per brand. Matches the Clarity API's per-call return
// budget (top-100 URLs) — keeping the watched list short means a single
// Clarity API call covers all of them with overhead to spare.
export const WATCHED_MAX = 10;

export async function addWatchedPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Watched-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await ensureSeeded(brand);

  // Idempotent — re-adding an already-watched path is a no-op and
  // doesn't count against the cap.
  const alreadyMember = await redis.sismember(key(brand), path);
  if (alreadyMember === 1) return;

  const currentCount = await redis.scard(key(brand));
  if (currentCount >= WATCHED_MAX) {
    throw new Error(
      `Watched list is at the ${WATCHED_MAX}-page max for ${brand}. Remove one before adding another.`,
    );
  }

  await redis.sadd(key(brand), path);
  // Watching a page overrides any hide — clear it so the page reliably
  // shows. "Watch" wins over "hidden", and re-adding via the watch input
  // doubles as a bring-back path for a hidden page.
  await redis.hdel(hiddenKey(brand), path).catch(() => {});
}

export async function removeWatchedPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Watched-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await ensureSeeded(brand);
  await redis.srem(key(brand), path);
}

// --- Hidden (excluded) pages ---
// Normalized paths to EXCLUDE from the auto-discovered Layer 2 page tabs
// (PDPs / Collections / CMS). Lets the team drop stale, deleted, or
// parked landing pages without touching the curated Watched list.
//
// Stored as a Redis HASH `hiddenpages:{brand}` mapping path -> expiry
// timestamp (ms). Hides auto-expire after HIDDEN_TTL so the list
// self-cleans; expired fields are pruned lazily on read (no cron). A new
// key name (vs the old SET) avoids a WRONGTYPE collision on migration.
export const HIDDEN_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 days
const hiddenKey = (brand: Brand) => `hiddenpages:${brand}`;

export type HiddenEntry = { path: string; expiresAt: number };

export async function getHiddenEntries(brand: Brand): Promise<HiddenEntry[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.hgetall<Record<string, number | string>>(hiddenKey(brand));
    if (!raw) return [];
    const now = Date.now();
    const live: HiddenEntry[] = [];
    const expired: string[] = [];
    for (const [path, exp] of Object.entries(raw)) {
      const expiresAt = typeof exp === 'number' ? exp : Number(exp);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) expired.push(path);
      else live.push({ path, expiresAt });
    }
    // Lazy cleanup of expired hides — fire-and-forget so a read never
    // blocks on the prune.
    if (expired.length) redis.hdel(hiddenKey(brand), ...expired).catch(() => {});
    return live.sort((a, b) => a.path.localeCompare(b.path));
  } catch (err) {
    console.error('hidden-store read failed; treating as none hidden', err);
    return [];
  }
}

export async function getHiddenPaths(brand: Brand): Promise<string[]> {
  return (await getHiddenEntries(brand)).map((e) => e.path);
}

export async function addHiddenPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Hidden-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await redis.hset(hiddenKey(brand), { [path]: Date.now() + HIDDEN_TTL_MS });
  // Hidden and pinned are opposites — clear any pin so they can't conflict.
  await redis.srem(pinnedKey(brand), path).catch(() => {});
}

export async function removeHiddenPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Hidden-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await redis.hdel(hiddenKey(brand), path);
}

// --- Pinned (force-included) pages ---
// Paths to ALWAYS show in the auto-discovered Layer 2 page tabs, even if
// not top-by-revenue or with zero orders — WITHOUT adding them to the
// curated Watched list. The inverse of hidden. Per-brand SET
// `pinned:{brand}`.
const pinnedKey = (brand: Brand) => `pinned:${brand}`;

export async function getPinnedPaths(brand: Brand): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    return (await redis.smembers(pinnedKey(brand))).sort();
  } catch (err) {
    console.error('pinned-store read failed; treating as none pinned', err);
    return [];
  }
}

export async function addPinnedPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Pinned-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await redis.sadd(pinnedKey(brand), path);
  // Pinning overrides a hide — clear any hidden entry for this path.
  await redis.hdel(hiddenKey(brand), path).catch(() => {});
}

export async function removePinnedPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Pinned-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await redis.srem(pinnedKey(brand), path);
}

// --- Landing Pages (manual curated list) ---
// A separate team-curated list of campaign/ad landing pages that don't
// surface in the auto-discovered PDP/Collection/CMS tabs (e.g. /pages/*
// promo or funnel pages). Per-brand SET `lp:{brand}`. Unlike Watched, it's
// not Clarity-budget-constrained, so the cap is looser. Seeds empty.
const lpKey = (brand: Brand) => `lp:${brand}`;
export const LP_MAX = 50;

export async function getLPPaths(brand: Brand): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    return (await redis.smembers(lpKey(brand))).sort();
  } catch (err) {
    console.error('lp-store read failed; treating as empty', err);
    return [];
  }
}

export async function addLPPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Landing-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  const alreadyMember = await redis.sismember(lpKey(brand), path);
  if (alreadyMember === 1) return;
  const currentCount = await redis.scard(lpKey(brand));
  if (currentCount >= LP_MAX) {
    throw new Error(
      `Landing-pages list is at the ${LP_MAX}-page max for ${brand}. Remove one before adding another.`,
    );
  }
  await redis.sadd(lpKey(brand), path);
}

export async function removeLPPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Landing-pages store not configured (UPSTASH_REDIS_REST_URL missing)');
  await redis.srem(lpKey(brand), path);
}

// --- Social (manual curated list) ---
// Team-curated list of pages promoted on social (paste any URL), separate
// from Landing Pages. Per-brand SET `social:{brand}`. Seeds empty.
const socialKey = (brand: Brand) => `social:${brand}`;
export const SOCIAL_MAX = 50;

export async function getSocialPaths(brand: Brand): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    return (await redis.smembers(socialKey(brand))).sort();
  } catch (err) {
    console.error('social-store read failed; treating as empty', err);
    return [];
  }
}

export async function addSocialPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Social store not configured (UPSTASH_REDIS_REST_URL missing)');
  const alreadyMember = await redis.sismember(socialKey(brand), path);
  if (alreadyMember === 1) return;
  const currentCount = await redis.scard(socialKey(brand));
  if (currentCount >= SOCIAL_MAX) {
    throw new Error(
      `Social list is at the ${SOCIAL_MAX}-page max for ${brand}. Remove one before adding another.`,
    );
  }
  await redis.sadd(socialKey(brand), path);
}

export async function removeSocialPath(brand: Brand, path: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Social store not configured (UPSTASH_REDIS_REST_URL missing)');
  await redis.srem(socialKey(brand), path);
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

// --- Shopify per-brand OAuth token storage ---
// One token + shop pair per brand, written by the OAuth callback and read
// by the ShopifyQL client.

const shopifyTokenKey = (brand: Brand) => `shopify:${brand}:token`;
const shopifyShopKey = (brand: Brand) => `shopify:${brand}:shop`;

export async function saveShopifyCredentials(
  brand: Brand,
  shop: string,
  accessToken: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('KV not configured');
  await Promise.all([
    redis.set(shopifyShopKey(brand), shop),
    redis.set(shopifyTokenKey(brand), accessToken),
  ]);
}

export async function getShopifyCredentials(
  brand: Brand,
): Promise<{ shop: string; token: string } | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const [shop, token] = await Promise.all([
      redis.get<string>(shopifyShopKey(brand)),
      redis.get<string>(shopifyTokenKey(brand)),
    ]);
    if (!shop || !token) return null;
    return { shop, token };
  } catch (err) {
    console.error('shopify creds read failed', err);
    return null;
  }
}
