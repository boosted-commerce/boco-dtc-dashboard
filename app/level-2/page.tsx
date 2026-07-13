import Link from 'next/link';
import { BRANDS, parseBrand, parsePeriod, PERIODS, type Period, type Brand } from '@/lib/queries/orders';
import {
  getLayer2,
  LAYER2_LABELS,
  LAYER2_TABS,
  parseLayer2Tab,
  type Layer2Row,
  type Layer2Tab,
} from '@/lib/queries/layer2';
import { AddLPInput, RemoveLPButton } from '@/app/_components/lp-controls';
import { AddSocialInput, RemoveSocialButton } from '@/app/_components/social-controls';
import { TopProductRow } from '@/app/_components/top-product-row';
import { ReorderControls } from '@/app/_components/reorder-controls';
import { AttachTestToPage } from '@/app/_components/attach-test-to-page';
import { ChannelSelect } from '@/app/_components/channel-select';
import { CHANNELS } from '@/lib/shopify';
import { getActiveTests } from '@/lib/intelligems-api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type DailyPoint = { date: string; value: number };

const pctChange = (current: number, prior: number): number | null => {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
};

function Sparkline({
  points,
  width = 240,
  height = 28,
}: {
  points: DailyPoint[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return <div style={{ height }} aria-hidden="true" />;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = innerW / (values.length - 1);
  const coords = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return [x, y] as const;
  });
  const linePath = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${height - pad} L${coords[0][0].toFixed(1)},${height - pad} Z`;
  const [lastX, lastY] = coords[coords.length - 1];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
      aria-hidden="true"
    >
      <path d={areaPath} fill="currentColor" opacity="0.08" />
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r="2.5" fill="currentColor" />
    </svg>
  );
}

function MiniTrend({ current, prior }: { current: number; prior: number }) {
  const pct = pctChange(current, prior);
  if (pct === null) {
    return <span className="text-xs text-zinc-400 dark:text-zinc-500">new</span>;
  }
  const absPct = Math.abs(pct);
  if (absPct < 0.05) {
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">→ flat</span>;
  }
  const arrow = pct > 0 ? '↑' : '↓';
  const color =
    pct > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';
  const display = absPct < 10 ? absPct.toFixed(1) : Math.round(absPct).toString();
  return (
    <span className={`text-xs font-medium ${color}`}>
      {arrow} {display}%
    </span>
  );
}

function trendTagFor(current: number, prior: number) {
  const pct = pctChange(current, prior);
  if (pct === null) {
    return {
      label: 'new',
      className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
    };
  }
  const abs = Math.abs(pct);
  if (abs < 5) {
    return {
      label: '→ stable',
      className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
    };
  }
  if (pct > 0) {
    return {
      label: '↑ trending up',
      className:
        'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
    };
  }
  return {
    label: '↓ watch',
    className: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400',
  };
}

function PillTabs<T extends string | number>({
  items,
  active,
  hrefFor,
  ariaLabel,
  labelFor,
}: {
  items: readonly T[];
  active: T;
  hrefFor: (item: T) => string;
  ariaLabel: string;
  labelFor?: (item: T) => string;
}) {
  const renderLabel = (item: T) => {
    if (labelFor) return labelFor(item);
    return `${String(item)}${typeof item === 'number' ? ' days' : ''}`;
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex rounded-full border border-zinc-200 bg-white p-1 text-sm dark:border-zinc-800 dark:bg-zinc-950"
    >
      {items.map((item) => {
        const isActive = item === active;
        return (
          <Link
            key={String(item)}
            href={hrefFor(item)}
            scroll={false}
            role="tab"
            aria-selected={isActive}
            className={`rounded-full px-3 py-1 transition ${
              isActive
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            {renderLabel(item)}
          </Link>
        );
      })}
    </div>
  );
}

function Layer2Table({
  rows,
  metricNoun,
  emptyMessage,
  period,
  brand,
  pathKeyed,
  showSessions,
  showRevenue,
  lpTab,
  socialTab,
  reorderTab,
}: {
  rows: Layer2Row[];
  metricNoun: 'orders' | 'units' | 'orders attributed';
  emptyMessage: string;
  period: Period;
  brand: Brand;
  pathKeyed: boolean;
  showSessions: boolean;
  showRevenue: boolean;
  lpTab?: boolean;
  socialTab?: boolean;
  reorderTab?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-6 text-sm text-zinc-500 dark:text-zinc-400">{emptyMessage}</div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
        <tr>
          <th className="px-5 py-2 font-medium">Name</th>
          {showSessions && <th className="px-5 py-2 text-right font-medium">Sessions</th>}
          {showSessions && (
            <th
              className="px-5 py-2 text-right font-medium"
              title="Sessions that COMPLETED checkout ÷ sessions — Shopify's conversion rate (actual purchases, session-attributed)"
            >
              Conv rate
            </th>
          )}
          {showSessions && (
            <th
              className="px-5 py-2 text-right font-medium"
              title="Completed orders ÷ sessions (our calculation from Snowflake)"
            >
              Order rate
            </th>
          )}
          <th className="px-5 py-2 text-right font-medium">{metricNoun}</th>
          {showRevenue && <th className="px-5 py-2 text-right font-medium">Revenue</th>}
          <th className="px-5 py-2 text-right font-medium">vs prior</th>
          {showRevenue && (
            <th className="px-5 py-2 font-medium">{period}-day trend</th>
          )}
          <th className="px-5 py-2 font-medium">Direction</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          // Top Products rows with a variant split render as a self-contained
          // client row so selecting a variant swaps the whole row's metrics.
          if (r.variants && r.variants.length > 1) {
            return (
              <TopProductRow
                key={r.key}
                label={r.label}
                product={{
                  units: r.currentCount,
                  revenue: r.currentRevenue,
                  priorRevenue: r.priorRevenue,
                  daily: r.daily,
                }}
                variants={r.variants}
              />
            );
          }
          // For sessions-only tabs (Channel Attribution), trend on sessions
          // vs prior_sessions — revenue is always $0 on those rows.
          const currentForTrend = showRevenue ? r.currentRevenue : r.sessions ?? 0;
          const priorForTrend = showRevenue ? r.priorRevenue : r.priorSessions ?? 0;
          const tag = trendTagFor(currentForTrend, priorForTrend);
          return (
            <tr
              key={r.key}
              className={
                'border-t border-zinc-100 dark:border-zinc-800' +
                (pathKeyed
                  ? ' transition-colors hover:bg-sky-50/60 dark:hover:bg-sky-950/20'
                  : '')
              }
            >
              <td className="max-w-md truncate px-5 py-3 text-zinc-900 dark:text-zinc-100">
                {reorderTab && (
                  <span className="mr-2 inline-block align-middle">
                    <ReorderControls
                      brand={brand}
                      path={r.key}
                      isFirst={i === 0}
                      isLast={i === rows.length - 1}
                    />
                  </span>
                )}
                {pathKeyed ? (
                  <Link
                    href={`/details/${brand}${r.key === '/' ? '' : r.key}?period=${period}`}
                    className="group inline-flex max-w-full items-center gap-1 truncate font-medium text-sky-700 underline decoration-sky-200 decoration-1 underline-offset-2 hover:decoration-sky-500 dark:text-sky-400 dark:decoration-sky-900 dark:hover:decoration-sky-500"
                    title="Open page deep-dive"
                  >
                    <span className="truncate">{r.label}</span>
                    <span
                      className="shrink-0 text-xs text-sky-400 transition group-hover:translate-x-0.5 group-hover:text-sky-700 dark:text-sky-600 dark:group-hover:text-sky-400"
                      aria-hidden="true"
                    >
                      →
                    </span>
                  </Link>
                ) : (
                  <div className="truncate font-medium">{r.label}</div>
                )}
                {r.sublabel && (
                  <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {r.sublabel}
                  </div>
                )}
                {lpTab && (
                  <div className="mt-1">
                    <RemoveLPButton brand={brand} path={r.key} />
                  </div>
                )}
                {socialTab && (
                  <div className="mt-1">
                    <RemoveSocialButton brand={brand} path={r.key} />
                  </div>
                )}
              </td>
              {showSessions && (
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {r.sessions !== undefined
                    ? r.sessions.toLocaleString()
                    : <span className="text-zinc-400 dark:text-zinc-500">—</span>}
                </td>
              )}
              {showSessions && (
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {r.convRate !== undefined
                    ? `${r.convRate.toFixed(2)}%`
                    : <span className="text-zinc-400 dark:text-zinc-500">—</span>}
                </td>
              )}
              {showSessions && (
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {r.sessions !== undefined && r.sessions > 0
                    ? `${((r.currentCount / r.sessions) * 100).toFixed(2)}%`
                    : <span className="text-zinc-400 dark:text-zinc-500">—</span>}
                </td>
              )}
              <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                {r.currentCount.toLocaleString()}
              </td>
              {showRevenue && (
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  ${r.currentRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </td>
              )}
              <td className="px-5 py-3 text-right tabular-nums">
                <MiniTrend current={currentForTrend} prior={priorForTrend} />
              </td>
              {showRevenue && (
                <td className="px-5 py-3">
                  <div className="w-32 text-emerald-600 dark:text-emerald-400">
                    <Sparkline points={r.daily} height={28} />
                  </div>
                </td>
              )}
              <td className="px-5 py-3">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tag.className}`}
                >
                  {tag.label}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default async function Level2Page({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; brand?: string; tab?: string; channel?: string }>;
}) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const brand = parseBrand(sp.brand);
  const tab = parseLayer2Tab(sp.tab);
  const channel = typeof sp.channel === 'string' ? sp.channel : undefined;
  const rows = await getLayer2(brand, period, tab, channel);
  // For the A/B tab's attach control: the brand's full active-test roster.
  const abTestOptions =
    tab === 'abtests'
      ? (await getActiveTests(brand).catch(() => [])).map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
        }))
      : [];
  const metricNounByTab: Record<Layer2Tab, 'orders' | 'units' | 'orders attributed'> = {
    watched: 'orders',
    lps: 'orders',
    social: 'orders',
    abtests: 'orders',
    pdps: 'orders',
    collections: 'orders',
    cms: 'orders',
    products: 'units',
    attribution: 'orders attributed',
  };
  const pathKeyedTabs: ReadonlySet<Layer2Tab> = new Set([
    'watched',
    'lps',
    'social',
    'abtests',
    'pdps',
    'collections',
    'cms',
  ]);
  const showSessions = pathKeyedTabs.has(tab) || tab === 'attribution';
  const showRevenue = tab !== 'attribution';
  // Per-tab one-line description under the heading.
  const tabBlurb: Partial<Record<Layer2Tab, string>> = {
    lps: 'manually-curated landing pages',
    social: 'manually-curated pages promoted on social',
    abtests: 'pages in an active Intelligems test (auto-detected)',
  };

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <header className="sticky top-0 z-20 -mx-6 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/85 px-6 py-3 backdrop-blur dark:border-zinc-800 dark:bg-black/85">
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href={`/?brand=${brand}&period=${period}`}
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              ← Overview
            </Link>
            <h1 className="text-xl font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
              Pages &amp; Sources
            </h1>
            <PillTabs<Brand>
              items={BRANDS}
              active={brand}
              hrefFor={(b) => `/level-2?brand=${b}&period=${period}&tab=${tab}`}
              ariaLabel="Select brand"
            />
          </div>
          <PillTabs<Period>
            items={PERIODS}
            active={period}
            hrefFor={(p) => `/level-2?brand=${brand}&period=${p}&tab=${tab}`}
            ariaLabel="Select period"
          />
        </header>

        <section className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div>
              <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {LAYER2_LABELS[tab]}
              </div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {tab === 'attribution' ? (
                  `Traffic sources · session-level data from ShopifyQL · ${brand}`
                ) : (
                  <>
                    {tabBlurb[tab] ?? (tab === 'watched' ? 'pages on the watch list' : 'top 100 by revenue')} · DTC orders only · {brand}{' '}
                    <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                      <span aria-hidden="true">👉</span>
                      click any page → deep-dive view
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {pathKeyedTabs.has(tab) && <ChannelSelect channels={CHANNELS} />}
              <PillTabs<Layer2Tab>
                items={LAYER2_TABS}
                active={tab}
                hrefFor={(t) => `/level-2?brand=${brand}&period=${period}&tab=${t}`}
                ariaLabel="Select layer 2 tab"
                labelFor={(t) => LAYER2_LABELS[t]}
              />
            </div>
          </div>
          {tab === 'lps' && (
            <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <AddLPInput brand={brand} />
            </div>
          )}
          {tab === 'social' && (
            <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <AddSocialInput brand={brand} />
            </div>
          )}
          {tab === 'abtests' && (
            <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Attach a test to a page — for template/product tests that can&rsquo;t be auto-located
              </div>
              <AttachTestToPage brand={brand} tests={abTestOptions} />
            </div>
          )}
          <Layer2Table
            rows={rows}
            metricNoun={metricNounByTab[tab]}
            emptyMessage={
              tab === 'lps'
                ? `No landing pages added yet for ${brand}. Add one above.`
                : tab === 'social'
                  ? `No social pages added yet for ${brand}. Add one above.`
                  : tab === 'abtests'
                    ? `No active Intelligems A/B tests located to pages for ${brand}.`
                    : `No ${LAYER2_LABELS[tab].toLowerCase()} data in this period for ${brand}.`
            }
            period={period}
            brand={brand}
            pathKeyed={pathKeyedTabs.has(tab)}
            showSessions={showSessions}
            showRevenue={showRevenue}
            lpTab={tab === 'lps'}
            socialTab={tab === 'social'}
            reorderTab={tab === 'watched'}
          />
        </section>

        <footer className="text-xs text-zinc-400 dark:text-zinc-500">
          Preview · Layer 2 as a separate page.{' '}
          <Link href={`/?brand=${brand}&period=${period}`} className="underline">
            Back to single-page view
          </Link>
        </footer>
      </div>
    </main>
  );
}
