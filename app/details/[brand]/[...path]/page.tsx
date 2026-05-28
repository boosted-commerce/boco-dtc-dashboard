import Link from 'next/link';
import { parseBrand, parsePeriod, PERIODS, type Brand, type Period } from '@/lib/queries/orders';
import { getPageDeepDive } from '@/lib/queries/page-deep-dive';
import { getPageNarrative } from '@/lib/queries/narrative';
import { clarityHeatmapUrl, clarityRecordingsUrl } from '@/lib/clarity';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Layer 3 deep-dive view for a single landing page. Reached from
// Layer 2 row names (path-keyed tabs). Shows the page's metrics,
// device × source breakdown, Clarity friction signals, and
// (later) an AI narrative scoped to this page.

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtCurrency(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}
function fmtSeconds(s: number): string {
  return s >= 60 ? `${Math.round(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
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

function MetricCard({
  title,
  value,
  current,
  prior,
  label,
}: {
  title: string;
  value: string;
  current: number;
  prior: number;
  label: string;
}) {
  const change = pctChange(current, prior);
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</div>
      <div className="mt-1 text-xs">
        {change ? (
          <span className={`font-medium ${change.color}`}>
            {change.arrow} {change.text} <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
          </span>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-500">new (no prior comparison)</span>
        )}
      </div>
    </div>
  );
}

function FrictionCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</div>}
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

export default async function PageDeepDivePage({
  params,
  searchParams,
}: {
  params: Promise<{ brand: string; path: string[] }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { brand: brandRaw, path: pathSegments } = await params;
  const sp = await searchParams;
  const brand: Brand = parseBrand(brandRaw);
  const period: Period = parsePeriod(sp.period);
  // Reconstruct the dashboard-style normalized path from URL segments
  const path = '/' + pathSegments.join('/');

  const data = await getPageDeepDive(brand, path, period);
  const heatmapUrl = clarityHeatmapUrl(brand, path);

  // Narrative needs the resolved data; runs after the main fetch.
  // Returns null on missing API key / errors → story card falls back
  // to a friendly placeholder.
  const narrative = await getPageNarrative({
    brand,
    period,
    path,
    sessions: data.sessions,
    convRate: data.convRate,
    orderCount: data.orderCount,
    revenue: data.revenue,
    deviceSource: data.deviceSource,
    clarity: data.clarity,
    activePromos: data.activePromos,
    intelligemsRole: data.intelligemsTest?.role ?? null,
  }).catch(() => null);

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
                  href={`/details/${brand}${path}?period=${p}`}
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
            <div className="text-xs text-zinc-400 dark:text-zinc-500">
              {narrative ? 'Generated by Claude · cached 30 min' : 'AI narrative — awaiting API key'}
            </div>
          </div>
          {narrative ? (
            <p className="whitespace-pre-line text-zinc-700 dark:text-zinc-200">{narrative}</p>
          ) : (
            <p className="text-zinc-500 dark:text-zinc-400">
              Once ANTHROPIC_API_KEY is configured in Vercel, this section explains what&rsquo;s
              shifting on this page, where the change concentrates (which device × source segment,
              which Clarity friction signal), and what deserves attention.
            </p>
          )}
        </section>

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

        {/* Core metric cards */}
        <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard
            title={`Sessions · ${period}d`}
            value={fmtCount(data.sessions.current)}
            current={data.sessions.current}
            prior={data.sessions.prior}
            label="vs prior"
          />
          <MetricCard
            title={`Conv rate · ${period}d`}
            value={fmtPct(data.convRate.current)}
            current={data.convRate.current}
            prior={data.convRate.prior}
            label="vs prior (same-session)"
          />
          <MetricCard
            title={`Orders · ${period}d`}
            value={fmtCount(data.orderCount.current)}
            current={data.orderCount.current}
            prior={data.orderCount.prior}
            label="vs prior"
          />
          <MetricCard
            title={`Revenue · ${period}d`}
            value={fmtCurrency(data.revenue.current)}
            current={data.revenue.current}
            prior={data.revenue.prior}
            label="vs prior"
          />
        </section>

        {/* Scroll depth bar */}
        <section className="mb-6">
          <ScrollBar pct={data.clarity?.scrollDepthPct ?? null} />
        </section>

        {/* Clarity friction signals */}
        <section className="mb-6">
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
            />
            <FrictionCard
              title="Dead clicks"
              value={data.clarity?.deadClicks != null ? data.clarity.deadClicks.toLocaleString() : '—'}
              hint={
                data.clarity?.deadClicks && data.clarity.deadClicks > 0
                  ? 'Clicks on non-interactive elements'
                  : 'No dead clicks detected'
              }
            />
            <FrictionCard
              title="Quickback clicks"
              value={data.clarity?.quickbackClicks != null ? data.clarity.quickbackClicks.toLocaleString() : '—'}
              hint="Sessions that bounced back fast"
            />
            <FrictionCard
              title="Avg time on page"
              value={data.clarity?.avgTimeSeconds != null ? fmtSeconds(data.clarity.avgTimeSeconds) : '—'}
              hint="Average session duration"
            />
          </div>
          {(data.clarity?.rageClicks ?? 0) > 0 || (data.clarity?.deadClicks ?? 0) > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {(data.clarity?.rageClicks ?? 0) > 0 && (
                <a
                  href={clarityRecordingsUrl(brand, path, 'rage-clicks') ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:border-sky-300 hover:text-sky-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-sky-700 dark:hover:text-sky-400"
                >
                  View rage-click recordings →
                </a>
              )}
              {(data.clarity?.deadClicks ?? 0) > 0 && (
                <a
                  href={clarityRecordingsUrl(brand, path, 'dead-clicks') ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:border-sky-300 hover:text-sky-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-sky-700 dark:hover:text-sky-400"
                >
                  View dead-click recordings →
                </a>
              )}
            </div>
          ) : null}
        </section>

        {/* Device × source conversion */}
        <section className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Device × source conversion
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Where conversion concentrates · {period}-day window
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-5 py-2 font-medium">Device · Source</th>
                  <th className="px-5 py-2 text-right font-medium">Sessions</th>
                  <th className="px-5 py-2 text-right font-medium">Conv rate</th>
                  <th className="px-5 py-2 text-right font-medium">vs prior</th>
                </tr>
              </thead>
              <tbody>
                {data.deviceSource.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                      No device/source breakdown available for this page in the {period}-day window.
                    </td>
                  </tr>
                ) : (
                  data.deviceSource.slice(0, 12).map((r) => {
                    const change = pctChange(r.convRate, r.priorConvRate);
                    return (
                      <tr key={`${r.deviceType}|${r.source}`} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="px-5 py-3 text-zinc-900 dark:text-zinc-100">
                          <span className="font-medium">{r.deviceType}</span>
                          <span className="text-zinc-400 dark:text-zinc-500"> · </span>
                          <span>{r.source}</span>
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          {fmtCount(r.sessions)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          {fmtPct(r.convRate)}
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
