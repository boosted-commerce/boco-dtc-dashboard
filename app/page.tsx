import Link from 'next/link';
import {
  BRANDS,
  getStoreOverview,
  parseBrand,
  parsePeriod,
  parseSource,
  PERIODS,
  SOURCES,
  type Brand,
  type Bucket,
  type ChannelMix as ChannelMixData,
  type DailyPoint,
  type Period,
  type SourceFilter,
  type SubBucket,
  type TopSubProduct,
} from '@/lib/queries/orders';
import {
  getLayer2,
  LAYER2_LABELS,
  LAYER2_TABS,
  parseLayer2Tab,
  type Layer2Row,
  type Layer2Tab,
} from '@/lib/queries/layer2';
import { getWatchedPaths } from '@/lib/watched-store';
import { StarButton } from '@/app/_components/star-button';
import { AddWatchedInput } from '@/app/_components/add-watched-input';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Format = 'count' | 'currency' | 'aov' | 'percent';

const fmt = (n: number, kind: Format): string => {
  if (kind === 'count') return Math.round(n).toLocaleString();
  if (kind === 'currency')
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (kind === 'aov')
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${n.toFixed(1)}%`;
};

const pctChange = (current: number, prior: number): number | null => {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
};

function Sparkline({
  points,
  className = '',
  width = 240,
  height = 48,
}: {
  points: DailyPoint[];
  className?: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <div className={`h-12 ${className}`} aria-hidden="true" />;
  }
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
      className={`w-full ${className}`}
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

function ChangeChip({
  current,
  prior,
  label,
}: {
  current: number;
  prior: number;
  label: string;
}) {
  const pct = pctChange(current, prior);
  if (pct === null) {
    return <span className="text-sm text-zinc-500 dark:text-zinc-400">— {label}</span>;
  }
  const absPct = Math.abs(pct);
  // < 0.05% is effectively zero — show "flat" to avoid "↑ 0.0%" reading as noise.
  if (absPct < 0.05) {
    return (
      <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
        → flat {label}
      </span>
    );
  }
  const arrow = pct > 0 ? '↑' : '↓';
  const color =
    pct > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';
  // One decimal under 10%, integer at or above. Surfaces small movements
  // (sub-1%) without making big swings noisy.
  const display = absPct < 10 ? absPct.toFixed(1) : Math.round(absPct).toString();
  return (
    <span className={`text-sm font-medium ${color}`}>
      {arrow} {display}% {label}
    </span>
  );
}

function MetricCard({
  title,
  bucket,
  kind,
  sparklineColor = 'text-zinc-700 dark:text-zinc-300',
}: {
  title: string;
  bucket: Bucket;
  kind: Format;
  sparklineColor?: string;
}) {
  const sevenDayAvg = kind === 'aov' ? bucket.sevenDayTotal : bucket.sevenDayTotal / 7;
  const sevenDayLabel = kind === 'aov' ? '7-DAY AOV' : '7-DAY AVG / DAY';

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Period total
        </div>
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {fmt(bucket.current, kind)}
      </div>
      <div className="mt-1">
        <ChangeChip current={bucket.current} prior={bucket.prior} label="vs prior period" />
      </div>
      <div className={`mt-3 ${sparklineColor}`}>
        <Sparkline points={bucket.daily} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <Tiny label="Yesterday" value={fmt(bucket.yesterday, kind)} />
        <Tiny label={sevenDayLabel} value={fmt(sevenDayAvg, kind)} />
        <Tiny label="Year ago" value={fmt(bucket.yearAgo, kind)} />
      </div>
    </div>
  );
}

function SubMetricCard({
  title,
  bucket,
  kind,
  sparklineColor = 'text-zinc-700 dark:text-zinc-300',
}: {
  title: string;
  bucket: SubBucket;
  kind: Format;
  sparklineColor?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Period {kind === 'percent' ? 'avg' : 'total'}
        </div>
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {fmt(bucket.current, kind)}
      </div>
      <div className="mt-1">
        <ChangeChip current={bucket.current} prior={bucket.prior} label="vs prior period" />
      </div>
      <div className={`mt-3 ${sparklineColor}`}>
        <Sparkline points={bucket.daily} />
      </div>
    </div>
  );
}

function Tiny({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {value}
      </div>
    </div>
  );
}

function PillTabs<T extends string | number>({
  items,
  active,
  hrefFor,
  ariaLabel,
  labelFor,
  preserveScroll = false,
}: {
  items: readonly T[];
  active: T;
  hrefFor: (item: T) => string;
  ariaLabel: string;
  labelFor?: (item: T) => string;
  preserveScroll?: boolean;
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
            scroll={!preserveScroll}
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

const CHANNEL_STYLES: Record<
  string,
  { stroke: string; dot: string; text: string }
> = {
  DTC: {
    stroke: 'stroke-emerald-500',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  TikTok: {
    stroke: 'stroke-rose-500',
    dot: 'bg-rose-500',
    text: 'text-rose-700 dark:text-rose-400',
  },
  Faire: {
    stroke: 'stroke-amber-500',
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-500',
  },
  Other: {
    stroke: 'stroke-zinc-400 dark:stroke-zinc-600',
    dot: 'bg-zinc-400 dark:bg-zinc-600',
    text: 'text-zinc-500 dark:text-zinc-400',
  },
};

const fmtShort = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n).toLocaleString()}`;
};

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

function ChannelDonut({
  channels,
  size = 120,
  strokeWidth = 18,
}: {
  channels: ChannelMixData['channels'];
  size?: number;
  strokeWidth?: number;
}) {
  const cx = size / 2;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  let cumulative = 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90"
      aria-hidden="true"
    >
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        strokeWidth={strokeWidth}
        className="stroke-zinc-100 dark:stroke-zinc-800"
      />
      {channels.map((c) => {
        const len = (c.sharePct / 100) * circumference;
        const dashArray = `${len.toFixed(2)} ${(circumference - len).toFixed(2)}`;
        const dashOffset = -cumulative;
        cumulative += len;
        const style = CHANNEL_STYLES[c.channel] ?? CHANNEL_STYLES.Other;
        return (
          <circle
            key={c.channel}
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            strokeWidth={strokeWidth}
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset.toFixed(2)}
            className={style.stroke}
          />
        );
      })}
    </svg>
  );
}

function ChannelMix({
  data,
  period,
}: {
  data: ChannelMixData;
  period: Period;
}) {
  if (data.channels.length === 0 || data.totalCurrent === 0) return null;
  const dtcShare = data.channels.find((c) => c.channel === 'DTC')?.sharePct ?? 0;

  return (
    <section className="mb-6 rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center gap-6">
        <div className="relative shrink-0">
          <ChannelDonut channels={data.channels} />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-[9px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              DTC share
            </div>
            <div className="text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              {dtcShare.toFixed(1)}%
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Total all channels ({period}d)
            </span>
            <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              ${data.totalCurrent.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <ChangeChip
              current={data.totalCurrent}
              prior={data.totalPrior}
              label="vs prior"
            />
          </div>
          <ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
            {data.channels.map((c) => {
              const style = CHANNEL_STYLES[c.channel] ?? CHANNEL_STYLES.Other;
              return (
                <li
                  key={c.channel}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
                >
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {c.channel}
                  </span>
                  <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
                    {c.sharePct.toFixed(1)}% · {fmtShort(c.currentRevenue)}
                  </span>
                  <MiniTrend current={c.currentRevenue} prior={c.priorRevenue} />
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
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

function Layer2Table({
  rows,
  metricNoun,
  emptyMessage,
  period,
  brand,
  watchedSet,
  starrable,
  showSessions,
  showRevenue,
}: {
  rows: Layer2Row[];
  metricNoun: 'orders' | 'units' | 'orders attributed';
  emptyMessage: string;
  period: Period;
  brand: Brand;
  watchedSet: Set<string>;
  starrable: boolean;
  showSessions: boolean;
  showRevenue: boolean;
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
          {starrable && <th className="w-10 px-3 py-2 font-medium" aria-label="Star" />}
          <th className="px-5 py-2 font-medium">Name</th>
          {showSessions && <th className="px-5 py-2 text-right font-medium">Sessions</th>}
          {showSessions && <th className="px-5 py-2 text-right font-medium">Conv rate</th>}
          <th className="px-5 py-2 text-right font-medium">{metricNoun}</th>
          {showRevenue && <th className="px-5 py-2 text-right font-medium">Sub</th>}
          {showRevenue && <th className="px-5 py-2 text-right font-medium">Revenue</th>}
          <th className="px-5 py-2 text-right font-medium">vs prior</th>
          {showRevenue && (
            <th className="px-5 py-2 font-medium">{period}-day trend</th>
          )}
          <th className="px-5 py-2 font-medium">Direction</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          // For sessions-only tabs (e.g. Channel Attribution), compute
          // trend on sessions vs prior_sessions rather than revenue.
          const currentForTrend = showRevenue ? r.currentRevenue : r.sessions ?? 0;
          const priorForTrend = showRevenue
            ? r.priorRevenue
            : r.priorSessions ?? 0;
          const tag = trendTagFor(currentForTrend, priorForTrend);
          return (
            <tr key={r.key} className="border-t border-zinc-100 dark:border-zinc-800">
              {starrable && (
                <td className="px-3 py-3">
                  <StarButton
                    brand={brand}
                    path={r.key}
                    initialStarred={watchedSet.has(r.key)}
                  />
                </td>
              )}
              <td className="max-w-md truncate px-5 py-3 text-zinc-900 dark:text-zinc-100">
                <div className="truncate font-medium">{r.label}</div>
                {r.sublabel && (
                  <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {r.sublabel}
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
              <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                {r.currentCount.toLocaleString()}
              </td>
              {showRevenue && (
                <td className="px-5 py-3 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.subCount !== undefined && r.subCount > 0
                    ? `+${r.subCount.toLocaleString()}`
                    : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
              )}
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

function TopProductsTable({ rows }: { rows: TopSubProduct[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        No subscription sign-ups in this period.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Top Subscription Products
        </div>
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Recharge · new sign-ups in selected period
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            <th className="px-5 py-2 font-medium">Product</th>
            <th className="px-5 py-2 text-right font-medium">New subs</th>
            <th className="px-5 py-2 text-right font-medium">First-order rev</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.product} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="px-5 py-2 text-zinc-900 dark:text-zinc-100">{r.product}</td>
              <td className="px-5 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                {r.newSubscriptions.toLocaleString()}
              </td>
              <td className="px-5 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                ${r.firstOrderRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    brand?: string;
    tab?: string;
    source?: string;
  }>;
}) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const brand = parseBrand(sp.brand);
  const tab = parseLayer2Tab(sp.tab);
  const source = parseSource(sp.source);
  const [data, layer2Rows, watchedPaths] = await Promise.all([
    getStoreOverview(brand, period, source),
    getLayer2(brand, period, tab),
    getWatchedPaths(brand),
  ]);
  const watchedSet = new Set(watchedPaths);
  const starrableTabs: ReadonlySet<Layer2Tab> = new Set(['watched', 'pdps', 'collections', 'cms']);
  const metricNounByTab: Record<Layer2Tab, 'orders' | 'units' | 'orders attributed'> = {
    watched: 'orders',
    pdps: 'orders',
    collections: 'orders',
    cms: 'orders',
    products: 'units',
    attribution: 'orders attributed',
  };

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <header className="sticky top-0 z-20 -mx-6 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/85 px-6 py-3 backdrop-blur dark:border-zinc-800 dark:bg-black/85">
          <div className="flex flex-wrap items-center gap-4">
            <h1 className="text-xl font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
              Store Trends
            </h1>
            <PillTabs<Brand>
              items={BRANDS}
              active={brand}
              hrefFor={(b) => `/?brand=${b}&period=${period}&tab=${tab}&source=${source}`}
              ariaLabel="Select brand"
              preserveScroll
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PillTabs<SourceFilter>
              items={SOURCES}
              active={source}
              hrefFor={(s) => `/?brand=${brand}&period=${period}&tab=${tab}&source=${s}`}
              ariaLabel="Filter sales channels"
              labelFor={(s) => (s === 'all' ? 'All channels' : 'DTC only')}
              preserveScroll
            />
            <PillTabs<Period>
              items={PERIODS}
              active={period}
              hrefFor={(p) => `/?brand=${brand}&period=${p}&tab=${tab}&source=${source}`}
              ariaLabel="Select period"
              preserveScroll
            />
          </div>
        </header>

        <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              This month&rsquo;s story
            </div>
            <div className="text-xs text-zinc-400 dark:text-zinc-500">
              AI narrative — pending sessions data
            </div>
          </div>
          <p className="text-zinc-600 dark:text-zinc-400">
            The daily AI narrative will appear here once sessions and customer-event data land in
            Snowflake. Today&rsquo;s view shows the order-side and subscription metrics we have.
          </p>
          <div className="mt-4 border-t border-zinc-100 pt-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
            <span className="font-semibold">Yesterday</span> ·{' '}
            <span className="tabular-nums">{fmt(data.orders.yesterday, 'count')}</span> orders ·{' '}
            <span className="tabular-nums">{fmt(data.revenue.yesterday, 'currency')}</span>{' '}
            revenue · <span className="tabular-nums">{fmt(data.aov.yesterday, 'aov')}</span> AOV
          </div>
        </section>

        <ChannelMix data={data.channelMix} period={data.period} />

        <section className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {data.sessions && (
            <MetricCard
              title="Sessions"
              bucket={data.sessions}
              kind="count"
              sparklineColor="text-sky-600 dark:text-sky-400"
            />
          )}
          {data.convRate && (
            <MetricCard
              title="Conv Rate"
              bucket={data.convRate}
              kind="percent"
              sparklineColor="text-sky-600 dark:text-sky-400"
            />
          )}
          <MetricCard
            title="Orders"
            bucket={data.orders}
            kind="count"
            sparklineColor="text-emerald-600 dark:text-emerald-400"
          />
          <MetricCard
            title="Revenue"
            bucket={data.revenue}
            kind="currency"
            sparklineColor="text-emerald-600 dark:text-emerald-400"
          />
          <MetricCard
            title="AOV"
            bucket={data.aov}
            kind="aov"
            sparklineColor="text-blue-600 dark:text-blue-400"
          />
          <SubMetricCard
            title="Subscription Share"
            bucket={data.subscriptionShare}
            kind="percent"
            sparklineColor="text-purple-600 dark:text-purple-400"
          />
        </section>

        <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <MetricCard
            title="Subscription Revenue"
            bucket={data.subscriptionRevenue}
            kind="currency"
            sparklineColor="text-purple-600 dark:text-purple-400"
          />
          <MetricCard
            title="Recurring Revenue"
            bucket={data.recurringRevenue}
            kind="currency"
            sparklineColor="text-purple-600 dark:text-purple-400"
          />
          <SubMetricCard
            title="New Subscriptions"
            bucket={data.newSubscriptions}
            kind="count"
            sparklineColor="text-purple-600 dark:text-purple-400"
          />
        </section>

        <section className="mb-6">
          <TopProductsTable rows={data.topSubscriptionProducts} />
        </section>

        <section className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div>
              <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Pages, Products &amp; Sources
              </div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                DTC orders only · top 100 by revenue · click-through coming with Layer 3
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href={`/level-2?brand=${brand}&period=${period}&tab=${tab}`}
                className="hidden text-xs text-zinc-500 underline hover:text-zinc-900 sm:inline dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Open as separate page →
              </Link>
              <PillTabs<Layer2Tab>
                items={LAYER2_TABS}
                active={tab}
                hrefFor={(t) => `/?brand=${brand}&period=${period}&tab=${t}`}
                ariaLabel="Select layer 2 tab"
                labelFor={(t) => LAYER2_LABELS[t]}
                preserveScroll
              />
            </div>
          </div>
          {tab === 'watched' && (
            <div className="border-b border-zinc-200 bg-zinc-50/50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/30">
              <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Add a page to watch — paste any URL or path
              </div>
              <AddWatchedInput brand={brand} />
            </div>
          )}
          <Layer2Table
            rows={layer2Rows}
            metricNoun={metricNounByTab[tab]}
            emptyMessage={`No ${LAYER2_LABELS[tab].toLowerCase()} data in this period for ${brand}.`}
            period={period}
            brand={brand}
            watchedSet={watchedSet}
            starrable={starrableTabs.has(tab)}
            showSessions={starrableTabs.has(tab) || tab === 'attribution'}
            showRevenue={tab !== 'attribution'}
          />
        </section>

        <footer className="text-xs text-zinc-400 dark:text-zinc-500">
          Visitors, conversion rate, and channel mix arrive once the data team lands sessions in
          Snowflake. Windows aligned to calendar days; current day excluded (pipeline lag ≈ 12h).
        </footer>
      </div>
    </main>
  );
}
