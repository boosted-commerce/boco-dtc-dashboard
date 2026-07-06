import Link from 'next/link';
import { parseBrand, parsePeriod, PERIODS, type Brand, type Period } from '@/lib/queries/orders';
import { getPageDeepDive } from '@/lib/queries/page-deep-dive';
import {
  getPageNarrative,
  peekPageNarrative,
  getPageNarrativeHistory,
} from '@/lib/queries/narrative';
import { clarityHeatmapUrl, clarityRecordingsUrl } from '@/lib/clarity';
import { getComments } from '@/lib/comments-store';
import { getWatchedPaths } from '@/lib/watched-store';
import { PageComments } from '@/app/_components/page-comments';
import { GenerateNarrativeButton } from '@/app/_components/narrative-actions';
import { HistoryPicker } from '@/app/_components/history-picker';
import { RefreshIntelligems } from '@/app/_components/refresh-intelligems';
import { AttachTestPicker, DetachButton } from '@/app/_components/attach-test';
import { DismissTestButton, RestoreTestButton } from '@/app/_components/dismiss-test';
import { ChannelCards } from '@/app/_components/channel-cards';
import type { ExperienceResults } from '@/lib/intelligems-api';
import { Sparkline, type SparklineBand } from '@/app/_components/sparkline';
import { fmt, type Format } from '@/lib/format';
import type { Bucket } from '@/lib/queries/orders';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Layer 3 deep-dive view for a single landing page. Reached from
// Layer 2 row names (path-keyed tabs). Shows the page's metrics,
// device × source breakdown, Clarity friction signals, and
// (later) an AI narrative scoped to this page.

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}
function fmtSeconds(s: number): string {
  return s >= 60 ? `${Math.round(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}
function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function pctChange(current: number, prior: number): { arrow: '↑' | '↓' | '→'; text: string; color: string } | null {
  if (prior === 0) return null;
  const pct = ((current - prior) / prior) * 100;
  if (Math.abs(pct) < 0.05) return { arrow: '→', text: 'flat', color: 'text-zinc-500 dark:text-zinc-400' };
  const arrow = pct > 0 ? '↑' : '↓';
  const color = pct > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  const display = Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct)).toString();
  return { arrow, text: `${display}%`, color };
}

function Tiny({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  );
}

// Layer-1-style rich card for a single page (sparkline + Yesterday /
// 7-day avg / Year-ago). Used for per-page Orders & Revenue.
function RichMetricCard({
  title,
  bucket,
  kind,
  sparklineColor,
  bands,
}: {
  title: string;
  bucket: Bucket;
  kind: Format;
  sparklineColor: string;
  bands?: SparklineBand[];
}) {
  const change = pctChange(bucket.current, bucket.prior);
  const sevenDayAvg = kind === 'aov' ? bucket.sevenDayTotal : bucket.sevenDayTotal / 7;
  const sevenDayLabel = kind === 'aov' ? '7-DAY AOV' : '7-DAY AVG/DAY';
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {fmt(bucket.current, kind)}
      </div>
      <div className="mt-1 text-xs">
        {change ? (
          <span className={`font-medium ${change.color}`}>
            {change.arrow} {change.text} <span className="text-zinc-500 dark:text-zinc-400">vs prior</span>
          </span>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-500">new (no prior comparison)</span>
        )}
      </div>
      <div className={`mt-3 ${sparklineColor}`}>
        <Sparkline points={bucket.daily} kind={kind} bands={bands} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
        <Tiny label="Yesterday" value={fmt(bucket.yesterday, kind)} />
        <Tiny label={sevenDayLabel} value={fmt(sevenDayAvg, kind)} />
        <Tiny label="Year ago" value={fmt(bucket.yearAgo, kind)} />
      </div>
    </div>
  );
}

// Derive a per-page AOV bucket (revenue ÷ orders) from the order &
// revenue buckets — no extra query needed.
function deriveAovBucket(orders: Bucket, revenue: Bucket): Bucket {
  const div = (r: number, o: number) => (o > 0 ? r / o : 0);
  const ordByDate = new Map(orders.daily.map((p) => [p.date, p.value]));
  return {
    current: div(revenue.current, orders.current),
    prior: div(revenue.prior, orders.prior),
    yesterday: div(revenue.yesterday, orders.yesterday),
    sevenDayTotal: div(revenue.sevenDayTotal, orders.sevenDayTotal),
    yearAgo: div(revenue.yearAgo, orders.yearAgo),
    daily: revenue.daily.map((p) => ({
      date: p.date,
      value: div(p.value, ordByDate.get(p.date) ?? 0),
    })),
  };
}

function FrictionCard({
  title,
  value,
  hint,
  recordingsUrl,
  recordingsLabel,
  hasIssue,
}: {
  title: string;
  value: string;
  hint?: string;
  recordingsUrl?: string | null;
  recordingsLabel?: string;
  hasIssue?: boolean;
}) {
  // When there are actual incidents (rage > 0 / dead > 0), accent the
  // card with rose so it visually pops and add a prominent "View
  // recordings" button. Otherwise stay neutral.
  const accent = hasIssue
    ? 'border-rose-200 bg-rose-50/40 dark:border-rose-900/60 dark:bg-rose-950/10'
    : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950';
  return (
    <div className={`rounded-lg border p-4 ${accent}`}>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${hasIssue ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-900 dark:text-zinc-50'}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</div>}
      {recordingsUrl && (
        <a
          href={recordingsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-400"
        >
          ▶ {recordingsLabel ?? 'View recordings in Clarity'}
        </a>
      )}
    </div>
  );
}

function ScrollBar({ pct }: { pct: number | null }) {
  if (pct == null) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Average scroll depth</div>
        <div className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">No Clarity scroll data available</div>
      </div>
    );
  }
  const width = Math.max(2, Math.min(100, pct));
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Average scroll depth</div>
        <div className="text-[10px] text-zinc-400 dark:text-zinc-500">3-day Clarity window</div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{Math.round(pct)}%</div>
        <div className="flex-1">
          <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-400 to-sky-600"
              style={{ width: `${width}%` }}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Average visitor scrolled to {Math.round(pct)}% of the page. Section-level breakdown will require
        custom storefront instrumentation; coming later.
      </div>
    </div>
  );
}

// Cohort-attributed A/B results table for one test (control vs variants
// with RPV uplift), or a single-row summary for a 100% rollout.
function TestResults({ results }: { results: ExperienceResults }) {
  const vars = results.variations;
  if (vars.length === 0) return null;
  const control = vars.find((v) => v.isControl) ?? vars[0];
  const multi = vars.length > 1;
  const pct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);
  const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
  const uplift = (v: number | null, base: number | null) =>
    v == null || base == null || base === 0 ? null : (v - base) / base;

  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-zinc-400 dark:text-zinc-500">
            <th className="py-1 pr-3 font-medium">Variation</th>
            <th className="py-1 px-2 text-right font-medium">Visitors</th>
            <th className="py-1 px-2 text-right font-medium">Conv</th>
            <th className="py-1 px-2 text-right font-medium" title="Net revenue per order (Intelligems)">AOV</th>
            <th className="py-1 px-2 text-right font-medium">RPV</th>
            {multi && <th className="py-1 pl-2 text-right font-medium">RPV vs control</th>}
          </tr>
        </thead>
        <tbody>
          {vars.map((v) => {
            const u = multi && !v.isControl ? uplift(v.rpv, control.rpv) : null;
            return (
              <tr key={v.id} className="border-t border-amber-100 dark:border-amber-900/40">
                <td className="py-1 pr-3 text-zinc-700 dark:text-zinc-300">
                  {v.name}
                  {v.isControl && (
                    <span className="ml-1 text-[10px] text-zinc-400">
                      {multi ? '(control)' : '(rolled out)'}
                    </span>
                  )}
                </td>
                <td className="py-1 px-2 text-right tabular-nums">{v.visitors.toLocaleString()}</td>
                <td className="py-1 px-2 text-right tabular-nums">{pct(v.convRate)}</td>
                <td className="py-1 px-2 text-right tabular-nums">{money(v.aov)}</td>
                <td className="py-1 px-2 text-right tabular-nums">{money(v.rpv)}</td>
                {multi && (
                  <td
                    className={`py-1 pl-2 text-right tabular-nums ${
                      u == null
                        ? ''
                        : u >= 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {u == null ? '—' : `${u >= 0 ? '+' : ''}${(u * 100).toFixed(1)}%`}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!multi && (
        <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-500">
          100% rollout — no control group to compare against.
        </div>
      )}
    </div>
  );
}

// Human label for an Intelligems experience type.
function igTypeLabel(type: string): string {
  if (type === 'personalization' || type === 'content/url') return 'Split URL';
  if (type === 'content/onsiteEdits') return 'On-site edit';
  if (type === 'content/template') return 'Template';
  if (type === 'content/theme') return 'Theme';
  if (type === 'pricing') return 'Pricing';
  if (type === 'shipping') return 'Shipping';
  return type;
}

// Format a stored snapshot date (YYYY-MM-DD) as e.g. "Jun 1". Parsed at
// noon UTC to avoid a timezone off-by-one.
function fmtSnapshotDate(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export default async function PageDeepDivePage({
  params,
  searchParams,
}: {
  params: Promise<{ brand: string; path?: string[] }>;
  searchParams: Promise<{ period?: string; asOf?: string }>;
}) {
  const { brand: brandRaw, path: pathSegments } = await params;
  const sp = await searchParams;
  const brand: Brand = parseBrand(brandRaw);
  const period: Period = parsePeriod(sp.period);
  // Optional catch-all: when watched path is '/' (homepage), the URL is
  // /details/<brand> with no trailing segments → pathSegments is
  // undefined. Treat empty segments as the storefront root.
  const path =
    !pathSegments || pathSegments.length === 0 || pathSegments.join('') === ''
      ? '/'
      : '/' + pathSegments.join('/');

  const data = await getPageDeepDive(brand, path, period);
  const heatmapUrl = clarityHeatmapUrl(brand, path);

  // Team notes are fetched first so they can feed the AI analysis as
  // authoritative context — a note (e.g. a redirect bug) revises the read.
  const [comments, watchedPaths, history] = await Promise.all([
    getComments(brand, path).catch(() => []),
    getWatchedPaths(brand).catch(() => [] as string[]),
    getPageNarrativeHistory(brand, period, path).catch(() => []),
  ]);
  const isWatched = watchedPaths.includes(path);

  // Historical view: ?asOf=YYYY-MM-DD shows that day's stored snapshot
  // (read-only, no regeneration, no token spend).
  const asOf = typeof sp.asOf === 'string' ? sp.asOf : null;
  const historical = asOf ? history.find((h) => h.date === asOf) ?? null : null;
  const viewingHistory = historical !== null;

  // Token-saving: Watched pages auto-generate their summary on load. Any
  // other page only generates once the user clicks "Generate" — but once
  // a summary EXISTS, it behaves like a watched page: adding a note
  // regenerates it (incorporating the note) rather than reverting to the
  // button. We peek (no API call) to learn whether a summary exists; if
  // it does (or the page is watched), getPageNarrative returns the cached
  // text when fresh, or regenerates when the notes have changed.
  const existingSummary = viewingHistory
    ? null
    : await peekPageNarrative({ brand, period, path }).catch(() => null);
  const narrative = viewingHistory
    ? historical.text
    : isWatched || existingSummary !== null
      ? await getPageNarrative({
          brand,
          period,
          path,
          sessions: data.sessions,
          convRate: data.convRate,
          orderCount: data.orderCount,
          revenue: data.revenue,
          recentDays: data.recentDays,
          sourceBreakdown: data.sourceBreakdown,
          clarity: data.clarity,
          activePromos: data.activePromos,
          intelligemsRole: data.intelligemsTest?.role ?? null,
      intelligemsTests: data.activeTests,
          comments,
        }).catch(() => null)
      : null;

  // Promo windows → shaded sparkline bands (same as Layer 1). The chart
  // clamps to the visible range, so non-overlapping promos just don't show.
  const promoBands: SparklineBand[] = data.activePromos.map((p) => ({
    start: p.startDate,
    end: p.endDate,
    label: `${p.name} · ${p.startDate} → ${p.endDate}`,
  }));

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-8 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6">
          <nav className="mb-2 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <Link href={`/?brand=${brand}&period=${period}`} className="hover:text-zinc-900 dark:hover:text-zinc-100">
              ← {brand} dashboard
            </Link>
            <span>/</span>
            <span>Page deep dive</span>
          </nav>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{path}</h1>
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {brand}
                {data.intelligemsTest && (
                  <>
                    {' '}·{' '}
                    <a
                      href={data.intelligemsTest.test.testUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300"
                    >
                      A/B {data.intelligemsTest.role}
                    </a>{' '}
                    <span className="text-zinc-500">in &ldquo;{data.intelligemsTest.test.name}&rdquo;</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {PERIODS.map((p) => (
                <Link
                  key={p}
                  href={`/details/${brand}${path === '/' ? '' : path}?period=${p}`}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    p === period
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
                  }`}
                >
                  {p}d
                </Link>
              ))}
            </div>
          </div>
        </header>

        {/* AI narrative — page-scoped */}
        <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-2 flex items-baseline justify-between">
            <div className="text-sm font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              What&rsquo;s happening on this page
            </div>
            <div className="flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
              {viewingHistory ? (
                <span>Snapshot from {fmtSnapshotDate(historical.date)} · read-only</span>
              ) : narrative ? (
                <>
                  <span>
                    {comments.length > 0
                      ? 'Generated by Claude · factors in team notes below'
                      : 'Generated by Claude'}
                  </span>
                  <GenerateNarrativeButton
                    brand={brand}
                    path={path}
                    period={period}
                    force
                    subtle
                    label="↻ refresh"
                  />
                </>
              ) : (
                <span>{isWatched ? 'AI narrative — awaiting API key' : 'On-demand'}</span>
              )}
            </div>
          </div>

          {/* History — past daily snapshots (up to 10 days). */}
          {history.length > 0 && (
            <div className="mb-3">
              <HistoryPicker
                brand={brand}
                path={path}
                period={period}
                active={asOf ?? 'latest'}
                options={history.map((h) => ({ value: h.date, label: fmtSnapshotDate(h.date) }))}
              />
            </div>
          )}

          {narrative ? (
            <p className="whitespace-pre-line text-zinc-700 dark:text-zinc-200">{narrative}</p>
          ) : isWatched ? (
            <p className="text-zinc-500 dark:text-zinc-400">
              Once ANTHROPIC_API_KEY is configured in Vercel, this section explains what&rsquo;s
              shifting on this page, where the change concentrates (which device × source segment,
              which Clarity friction signal), and what deserves attention.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                No summary generated for this page yet. Summaries auto-run only for Watched pages to
                save tokens — generate one for the last {period} days on demand.
              </p>
              <GenerateNarrativeButton
                brand={brand}
                path={path}
                period={period}
                label="Generate summary"
              />
            </div>
          )}
        </section>

        {/* Team notes — persistent per-page commentary */}
        <PageComments brand={brand} path={path} comments={comments} />

        {/* Active promos context strip */}
        {data.activePromos.filter((p) => p.state === 'active').length > 0 && (
          <section className="mb-6 rounded-lg border border-amber-200 bg-amber-50/50 px-5 py-3 text-xs text-zinc-700 dark:border-amber-900/60 dark:bg-amber-950/10 dark:text-zinc-300">
            <span className="font-semibold text-amber-700 dark:text-amber-400">Context:</span>{' '}
            {data.activePromos
              .filter((p) => p.state === 'active')
              .map((p) => `"${p.name}" (ends ${p.endDate})`)
              .join(' · ')}
          </section>
        )}

        {/* Active A/B tests located to this page (live from Intelligems).
            Always rendered so the Sync button + "none detected" note show
            even when no test is mapped to this page. */}
        <section className="mb-6 rounded-lg border border-amber-200 bg-amber-50/40 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/10">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Active A/B tests on this page
            </div>
            <RefreshIntelligems brand={brand} />
          </div>
          {(data.activeTests?.length ?? 0) > 0 ? (
            <>
            <ul className="space-y-3">
              {data.activeTests.map((t) => (
                <li key={t.id} className="border-t border-amber-100 pt-2 first:border-t-0 first:pt-0 dark:border-amber-900/40">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      {igTypeLabel(t.type)}
                    </span>
                    <a
                      href={t.testUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:decoration-sky-500 dark:text-sky-400 dark:decoration-sky-900"
                    >
                      {t.name}
                    </a>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t.role === 'origin'
                        ? 'redirect origin'
                        : t.role === 'destination'
                          ? 'redirect destination'
                          : 'targeted here'}
                    </span>
                    {t.manual ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                        · manually attached <DetachButton brand={brand} path={path} testId={t.id} />
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                        · <DismissTestButton brand={brand} path={path} testId={t.id} />
                      </span>
                    )}
                  </div>
                  {(t.redirectsTo?.length ?? 0) > 0 && (
                    <div className="mt-1 rounded-md bg-amber-100/70 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      ↪ Visitors to this page are redirected to{' '}
                      {t.redirectsTo.map((dest, i) => (
                        <span key={dest}>
                          {i > 0 && ', '}
                          <Link
                            href={`/details/${brand}${dest === '/' ? '' : dest}?period=${period}`}
                            className="font-medium underline decoration-amber-300 underline-offset-2 hover:decoration-amber-500"
                          >
                            {dest}
                          </Link>
                        </span>
                      ))}{' '}
                      — that&rsquo;s where customers actually land, so this page&rsquo;s own metrics read low.
                    </div>
                  )}
                  {(t.redirectedFrom?.length ?? 0) > 0 && (
                    <div className="mt-1 rounded-md bg-amber-100/70 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      ↩ This page receives redirected traffic from{' '}
                      {t.redirectedFrom.map((src, i) => (
                        <span key={src}>
                          {i > 0 && ', '}
                          <Link
                            href={`/details/${brand}${src === '/' ? '' : src}?period=${period}`}
                            className="font-medium underline decoration-amber-300 underline-offset-2 hover:decoration-amber-500"
                          >
                            {src}
                          </Link>
                        </span>
                      ))}{' '}
                      — visitors who land there are sent here, so this page absorbs their traffic.
                    </div>
                  )}
                  {t.results && <TestResults results={t.results} />}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-500">
              Live from Intelligems · results are <span className="font-medium">test-level</span>{' '}
              (cohort-attributed across the whole experiment, not just this page). Template/
              product-targeted tests can&rsquo;t be auto-located — attach them below.
            </p>
            </>
          ) : (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              No Intelligems test auto-located to this page. If you just started one, click{' '}
              <span className="font-medium">Sync from Intelligems</span> (data caches ~30 min).
              Template-type and product-targeted tests can&rsquo;t be auto-located — attach the right
              one below.
            </p>
          )}
          <AttachTestPicker
            brand={brand}
            path={path}
            options={data.allIntelligemsTests.filter(
              (o) => !data.activeTests.some((t) => t.id === o.id),
            )}
          />

          {/* Prior (ended) + dismissed tests — collapsed by default. */}
          {(data.endedTests.length > 0 || data.dismissedTests.length > 0) && (
            <details className="mt-3 border-t border-amber-100 pt-2 dark:border-amber-900/40">
              <summary className="cursor-pointer text-xs font-medium text-amber-800 hover:underline dark:text-amber-300">
                Prior &amp; dismissed tests ({data.endedTests.length + data.dismissedTests.length})
              </summary>
              <div className="mt-2 space-y-3">
                {data.dismissedTests.map((t) => (
                  <div key={`d-${t.id}`} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="inline-flex items-center rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      dismissed
                    </span>
                    <a
                      href={t.testUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:decoration-sky-500 dark:text-sky-400 dark:decoration-sky-900"
                    >
                      {t.name}
                    </a>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                      · <RestoreTestButton brand={brand} path={path} testId={t.id} />
                    </span>
                  </div>
                ))}
                {data.endedTests.map((t) => (
                  <div key={`e-${t.id}`} className="border-t border-amber-100/60 pt-2 first:border-t-0 first:pt-0 dark:border-amber-900/30">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="inline-flex items-center rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        ended
                      </span>
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                        {igTypeLabel(t.type)}
                      </span>
                      <a
                        href={t.testUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:decoration-sky-500 dark:text-sky-400 dark:decoration-sky-900"
                      >
                        {t.name}
                      </a>
                    </div>
                    {t.results && <TestResults results={t.results} />}
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        {/* Core metric cards — full Layer-1-style rich cards, with a
            channel filter above them. "All channels" = page totals; picking
            a channel re-scopes the cards (see ChannelCards for the exact vs
            allocated breakdown). */}
        <ChannelCards
          all={{
            sessions: data.sessionsBucket,
            convRate: data.convRateBucket,
            orders: data.orderBucket,
            revenue: data.revenueBucket,
            aov: deriveAovBucket(data.orderBucket, data.revenueBucket),
            subRevenue: data.subRevenueBucket,
          }}
          channels={data.channelCards}
          period={period}
          bands={promoBands}
        />

        {/* Per-variant sales composition (PDPs with a variant split). */}
        {data.variants.length > 1 && (
          <section className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Variant breakdown
              </div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Which variant drives sales · orders that landed on this page · {period}-day window
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-5 py-2 font-medium">Variant</th>
                    <th className="px-5 py-2 text-right font-medium">Units</th>
                    <th className="px-5 py-2 text-right font-medium">Orders</th>
                    <th className="px-5 py-2 text-right font-medium">Revenue</th>
                    <th className="px-5 py-2 text-right font-medium">AOV</th>
                    <th className="px-5 py-2 text-right font-medium">% of revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.variants.map((v) => (
                    <tr key={v.variantId} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-5 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                        {v.title}
                        {v.sku && (
                          <span className="ml-2 text-[11px] font-normal text-zinc-400 dark:text-zinc-500">
                            {v.sku}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                        {fmtCount(v.units)}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                        {fmtCount(v.orders)}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                        {fmtMoney(v.revenue)}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                        {fmtMoney(v.aov)}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-zinc-900 dark:text-zinc-100">
                            {fmtPct(v.revenueShare * 100)}
                          </span>
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                            <span
                              className="block h-full rounded-full bg-sky-500/70 dark:bg-sky-400/70"
                              style={{ width: `${Math.round(v.revenueShare * 100)}%` }}
                            />
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Scroll depth bar */}
        <section className="mb-6">
          <ScrollBar pct={data.clarity?.scrollDepthPct ?? null} />
        </section>

        {/* Clarity friction signals */}
        <section className="mb-6">
          {data.clarity === null && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <span className="font-semibold">No Clarity data for this URL in the last 3 days.</span>{' '}
              Common causes: (1) the storefront Clarity tracking script isn&rsquo;t
              installed in <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px] dark:bg-amber-900/40">theme.liquid</code>{' '}
              (check Shopify Admin → Themes → Edit code), or (2) the page had
              very few sessions in the Clarity window. HHH and VIV currently
              track the full storefront; PRL only tracks checkout pages.
            </div>
          )}
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
              Friction signals (3-day Clarity window)
            </h2>
            {heatmapUrl && (
              <a
                href={heatmapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-zinc-500 underline hover:text-sky-600 dark:text-zinc-400 dark:hover:text-sky-400"
              >
                Open heatmap in Clarity →
              </a>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <FrictionCard
              title="Rage clicks"
              value={data.clarity?.rageClicks != null ? data.clarity.rageClicks.toLocaleString() : '—'}
              hint={
                data.clarity?.rageClicks && data.clarity.rageClicks > 0
                  ? 'Repeated rapid clicks — frustration signal'
                  : 'No rage clicks detected'
              }
              recordingsUrl={(data.clarity?.rageClicks ?? 0) > 0 ? clarityRecordingsUrl(brand, path, 'rage-clicks') : null}
              recordingsLabel="Watch rage sessions"
              hasIssue={(data.clarity?.rageClicks ?? 0) > 0}
            />
            <FrictionCard
              title="Dead clicks"
              value={data.clarity?.deadClicks != null ? data.clarity.deadClicks.toLocaleString() : '—'}
              hint={
                data.clarity?.deadClicks && data.clarity.deadClicks > 0
                  ? 'Clicks on non-interactive elements'
                  : 'No dead clicks detected'
              }
              recordingsUrl={(data.clarity?.deadClicks ?? 0) > 0 ? clarityRecordingsUrl(brand, path, 'dead-clicks') : null}
              recordingsLabel="Watch dead-click sessions"
              hasIssue={(data.clarity?.deadClicks ?? 0) > 0}
            />
            <FrictionCard
              title="Quickback clicks"
              value={data.clarity?.quickbackClicks != null ? data.clarity.quickbackClicks.toLocaleString() : '—'}
              hint="Sessions that bounced back fast"
              recordingsUrl={(data.clarity?.quickbackClicks ?? 0) > 0 ? clarityRecordingsUrl(brand, path, 'quickback-clicks') : null}
              recordingsLabel="Watch quickback sessions"
              hasIssue={(data.clarity?.quickbackClicks ?? 0) > 0}
            />
            <FrictionCard
              title="Avg time on page"
              value={data.clarity?.avgTimeSeconds != null ? fmtSeconds(data.clarity.avgTimeSeconds) : '—'}
              hint="Average session duration"
            />
          </div>
        </section>

        {/* Per-channel breakdown for this page. Channels come from Shopify's
            session referrer (referring_channel), so paid/organic social split
            into Facebook / Instagram / TikTok. Sessions, conv, and orders are
            exact; revenue is the page's real revenue allocated across channels
            by converting-session share (Shopify has no per-page revenue-by-
            channel), so the Revenue column sums to the page's revenue. */}
        <section className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Channel breakdown
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              How each traffic source performs on this page · sessions/conv/orders exact · revenue allocated by converting-session share · {period}-day window
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-5 py-2 font-medium">Channel</th>
                  <th className="px-5 py-2 text-right font-medium">Sessions</th>
                  <th className="px-5 py-2 text-right font-medium">Conv rate</th>
                  <th className="px-5 py-2 text-right font-medium">Orders</th>
                  <th className="px-5 py-2 text-right font-medium" title="Page revenue allocated by each channel's converting-session share">Revenue</th>
                  <th className="px-5 py-2 text-right font-medium">vs prior</th>
                </tr>
              </thead>
              <tbody>
                {data.sourceBreakdown.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                      No channel breakdown available for this page in the {period}-day window.
                    </td>
                  </tr>
                ) : (
                  data.sourceBreakdown.slice(0, 12).map((r) => {
                    const change = pctChange(r.convRate, r.priorConvRate);
                    return (
                      <tr key={r.source} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="px-5 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                          {r.source || '(direct)'}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          {fmtCount(r.sessions)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          {fmtPct(r.convRate)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          {fmtCount(r.orders)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          {fmtMoney(r.revenue)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {change ? (
                            <span className={`text-xs font-medium ${change.color}`}>
                              {change.arrow} {change.text}
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-400 dark:text-zinc-500">new</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="text-xs text-zinc-400 dark:text-zinc-500">
          Layer 3 deep dive · data refreshes every ~2 min · Clarity signals use the platform&apos;s 3-day window.
        </footer>
      </div>
    </main>
  );
}
