import { Redis } from '@upstash/redis';
import type { Brand, Period, SourceFilter, StoreOverview } from '@/lib/queries/orders';
import type { Promo } from '@/lib/queries/promos';
import type { NorthbeamSummary } from '@/lib/queries/northbeam';
import type { ClarityMetricsMap } from '@/lib/clarity-metrics';
import type { Layer2Row } from '@/lib/queries/layer2';

// Server-side narrative generation via Anthropic. Reads ANTHROPIC_API_KEY
// from Vercel env. Returns null on any error so the dashboard falls
// back to the existing placeholder text instead of breaking.
//
// Cached in Upstash for 30 min keyed on (brand, period, source) — the
// underlying metrics change at most daily, and the narrative is a
// summary not a live feed, so aggressive caching is fine.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
// Cheapest model that still produces good prose. Per-call cost
// ~$0.002 at our input/output token counts.
const MODEL = 'claude-haiku-4-5-20251001';
const CACHE_TTL_SECONDS = 30 * 60;

// Brand-specific context so the LLM knows what the company sells and
// can write more concrete prose ("supplements", "subscription
// customers") rather than generic ("products", "users").
const BRAND_CONTEXT: Record<Brand, string> = {
  ASN: 'Asterwood Naturals — beauty/skincare DTC brand (copper peptides, snail mucin, anti-aging).',
  HHH: 'Happy Healthy Hippie Co — wellness/supplements brand (hormone balance, adrenal, brain).',
  VIV: 'MyVitalVitamins (parent: Poww Nutrition) — vitamins/supplements brand (multi-collagen, chlorophyll, brain support).',
  PRL: 'Prime Labs Supplements — men\'s health supplements brand (testosterone support, thermogenic, performance).',
};

const fmt = {
  count: (n: number) => Math.round(n).toLocaleString(),
  currency: (n: number) =>
    `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
  percent: (n: number) => `${n.toFixed(1)}%`,
  pctChange: (current: number, prior: number): string => {
    if (prior === 0) return 'new (no prior comparison)';
    const pct = ((current - prior) / prior) * 100;
    const arrow = pct >= 0 ? '↑' : '↓';
    return `${arrow}${Math.abs(pct).toFixed(1)}% vs prior period`;
  },
};

let _redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  try { _redis = Redis.fromEnv(); } catch { _redis = null; }
  return _redis;
}

function cacheKey(brand: Brand, period: Period, source: SourceFilter): string {
  return `narrative:${brand}:${period}:${source}:v1`;
}

function buildPrompt(args: {
  brand: Brand;
  period: Period;
  source: SourceFilter;
  data: StoreOverview;
  activePromos: Promo[];
  northbeam: NorthbeamSummary | null;
  clarityMetrics: ClarityMetricsMap;
  watchedRows: Layer2Row[];
}): string {
  const { brand, period, source, data, activePromos, northbeam, clarityMetrics, watchedRows } = args;

  const promoLines = activePromos
    .filter((p) => p.state === 'active')
    .map((p) => `  - "${p.name}" (${p.code ?? 'no code'}, ${p.discountType ?? '?'}, ends ${p.endDate})`)
    .join('\n');
  const recentLines = activePromos
    .filter((p) => p.state === 'recent')
    .map((p) => `  - "${p.name}" ended ${p.endDate}`)
    .join('\n');
  const upcomingLines = activePromos
    .filter((p) => p.state === 'upcoming')
    .map((p) => `  - "${p.name}" starts ${p.startDate}`)
    .join('\n');

  const topChannels = data.channelMix.channels
    .slice(0, 3)
    .map((c) => `  - ${c.channel}: ${c.sharePct.toFixed(1)}% share, ${fmt.currency(c.currentRevenue)}`)
    .join('\n');

  // Top subscription products (already on StoreOverview). Lets the
  // narrative answer questions like "where did the sub surge go?"
  const topSubs = (data.topSubscriptionProducts ?? [])
    .slice(0, 5)
    .map((p) => `  - ${p.product}: ${fmt.count(p.newSubscriptions)} new subs, ${fmt.currency(p.firstOrderRevenue)} first-order rev`)
    .join('\n');

  // Per-platform Northbeam (not just totals). Surfaces ROAS shifts at
  // the channel level — "Facebook ROAS dropped 22%" — instead of
  // requiring the reader to dig into the panel.
  const perPlatform = northbeam
    ? northbeam.channels
        .filter((c) => c.spend > 0 || c.priorSpend > 0)
        .slice(0, 5)
        .map((c) => {
          const roas = c.roas != null ? `${c.roas.toFixed(2)}x` : 'n/a';
          const priorRoas = c.priorRoas != null ? `${c.priorRoas.toFixed(2)}x` : 'n/a';
          const roasShift =
            c.roas != null && c.priorRoas != null && c.priorRoas > 0
              ? ` (${fmt.pctChange(c.roas, c.priorRoas)})`
              : '';
          return `  - ${c.platform}: ${fmt.currency(c.spend)} spend, ${fmt.currency(c.revAttributed)} attr rev, ROAS ${roas} (prior ${priorRoas})${roasShift}`;
        })
        .join('\n')
    : '';

  const northbeamLines = northbeam
    ? `Paid attribution (Northbeam MTA):
  - Total spend: ${fmt.currency(northbeam.totalSpend)} (${fmt.pctChange(northbeam.totalSpend, northbeam.priorTotalSpend)})
  - Attributed revenue: ${fmt.currency(northbeam.totalRevAttributed)} (${fmt.pctChange(northbeam.totalRevAttributed, northbeam.priorTotalRevAttributed)})
  - Blended ROAS: ${northbeam.totalRoas != null ? `${northbeam.totalRoas.toFixed(2)}x` : 'n/a'}${
    northbeam.totalRoas != null && northbeam.priorTotalRoas != null && northbeam.priorTotalRoas > 0
      ? ` (${fmt.pctChange(northbeam.totalRoas, northbeam.priorTotalRoas)})`
      : ''
  }
By platform (top 5 by spend):
${perPlatform || '  (no per-platform data)'}`
    : 'Paid attribution (Northbeam): data not available for this period.';

  // Watched pages — the curated short list the team explicitly monitors.
  // Show sessions + conv rate + Clarity UX signals if available.
  const watchedLines = watchedRows
    .slice(0, 10)
    .map((r) => {
      const c = clarityMetrics.get(r.key);
      const clarityNote = c
        ? `, Clarity: ${c.rageClicks ?? 0} rage, ${c.deadClicks ?? 0} dead, ${
            c.scrollDepthPct != null ? `${Math.round(c.scrollDepthPct)}% scroll` : 'no scroll data'
          }`
        : '';
      const orderRate =
        r.sessions && r.sessions > 0
          ? `${((r.currentCount / r.sessions) * 100).toFixed(2)}% order rate`
          : 'no sessions';
      return `  - ${r.label}: ${fmt.count(r.sessions ?? 0)} sessions, ${orderRate}, ${r.currentCount} orders, ${fmt.currency(r.currentRevenue)} rev${clarityNote}`;
    })
    .join('\n');

  return `You are writing a concise narrative summary for the Boosted Commerce DTC analytics dashboard. The audience is operators of the brand — they want to know what changed and why, fast.

BRAND CONTEXT: ${BRAND_CONTEXT[brand]}

WINDOW: last ${period} days · channel filter: ${source === 'dtc' ? 'DTC orders only' : 'all channels'}

CORE METRICS (current vs prior ${period}-day window):
  - Orders: ${fmt.count(data.orders.current)} (${fmt.pctChange(data.orders.current, data.orders.prior)})
  - Revenue: ${fmt.currency(data.revenue.current)} (${fmt.pctChange(data.revenue.current, data.revenue.prior)})
  - AOV: $${data.aov.current.toFixed(2)} (${fmt.pctChange(data.aov.current, data.aov.prior)})
  - Subscription revenue: ${fmt.currency(data.subscriptionRevenue.current)} (${fmt.pctChange(data.subscriptionRevenue.current, data.subscriptionRevenue.prior)})
  - Subscription share: ${data.subscriptionShare.current.toFixed(1)}% (${fmt.pctChange(data.subscriptionShare.current, data.subscriptionShare.prior)})${data.sessions ? `
  - Sessions: ${fmt.count(data.sessions.current)} (${fmt.pctChange(data.sessions.current, data.sessions.prior)})` : ''}${data.convRate ? `
  - Conversion rate: ${data.convRate.current.toFixed(2)}% (${fmt.pctChange(data.convRate.current, data.convRate.prior)})` : ''}

CHANNEL MIX (top 3 by current revenue):
${topChannels || '  (no channel data)'}

TOP SUBSCRIPTION PRODUCTS (new sign-ups this window):
${topSubs || '  (no subscription product data)'}

${northbeamLines}

WATCHED PAGES (team-curated key URLs):
${watchedLines || '  (no watched pages with data)'}

PROMOS:
${promoLines ? `Active now:\n${promoLines}` : 'No active promos.'}
${recentLines ? `\nRecently ended:\n${recentLines}` : ''}
${upcomingLines ? `\nStarting soon:\n${upcomingLines}` : ''}

INSTRUCTIONS:
Write 3-5 sentences (max 110 words total) covering:
1. The most notable shift in core metrics this window
2. Where that shift concentrated — a specific channel, product, or page (use the per-platform Northbeam, top sub products, or watched pages context to attribute the change to specifics, not vague directional words). For example: "The 33% subscription revenue surge came almost entirely from Joy Filled (240 new subs of 320 total)."
3. One thing worth attention — a divergence, risk, or opportunity supported by the data (Clarity red flags on a watched page, ROAS drop on a specific platform, conversion gap, etc.)

Style: factual, concrete, no hype, no hedging, no bullet points, no markdown. Use specific numbers and named entities (channel/product/page names) from the data. Don't recommend actions unless the data strongly supports one. Write as plain prose.`;
}

export async function getNarrative(args: {
  brand: Brand;
  period: Period;
  source: SourceFilter;
  data: StoreOverview;
  activePromos: Promo[];
  northbeam: NorthbeamSummary | null;
  clarityMetrics: ClarityMetricsMap;
  watchedRows: Layer2Row[];
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const redis = getRedis();
  const key = cacheKey(args.brand, args.period, args.source);

  // Cache lookup
  if (redis) {
    try {
      const cached = await redis.get<string>(key);
      if (cached) return cached;
    } catch {
      // Fall through to live call on cache failure
    }
  }

  const prompt = buildPrompt(args);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Anthropic API error', res.status, errText.slice(0, 500));
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((c) => c.type === 'text')?.text?.trim() ?? null;

    if (text && redis) {
      try { await redis.set(key, text, { ex: CACHE_TTL_SECONDS }); } catch {}
    }
    return text;
  } catch (err) {
    console.error('Narrative fetch failed:', err);
    return null;
  }
}
