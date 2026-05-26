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
import { getActivePromos, getPromosInWindow, type Promo } from '@/lib/queries/promos';
import { getNorthbeamSummary, type NorthbeamSummary } from '@/lib/queries/northbeam';
import { clarityHeatmapUrl } from '@/lib/clarity';
import { getClarityMetrics, type ClarityMetricsMap } from '@/lib/clarity-metrics';
import { findIntelligemsTest } from '@/lib/intelligems-tests';
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

// Vertical date markers rendered over the sparkline, used to show
// promo start/end dates so the team can visually correlate metric
// shifts with what's running.
type SparklineMarker = { date: string; kind: 'start' | 'end'; label: string };

function Sparkline({
  points,
  className = '',
  width = 240,
  height = 48,
  markers,
}: {
  points: DailyPoint[];
  className?: string;
  width?: number;
  height?: number;
  markers?: SparklineMarker[];
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

  // Map promo-date markers to x-positions by matching against the
  // sparkline's date axis. Markers for dates outside the window are
  // skipped silently.
  const markerLines = (markers ?? []).flatMap((m) => {
    const idx = points.findIndex((p) => p.date === m.date);
    if (idx < 0) return [];
    const x = pad + idx * stepX;
    return [{ x, kind: m.kind, label: m.label }];
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
      aria-hidden="true"
    >
      <path d={areaPath} fill="currentColor" opacity="0.08" />
      {/* Promo markers — vertical amber dashed line + small flag at
          the top of the chart. Render BEFORE the line path so the
          metric trend sits on top of the markers visually. */}
      {markerLines.map((m, i) => (
        <g key={`marker-${i}`}>
          <line
            x1={m.x.toFixed(1)}
            x2={m.x.toFixed(1)}
            y1={pad}
            y2={height - pad}
            stroke={m.kind === 'start' ? '#f59e0b' : '#a8a29e'}
            strokeWidth="1"
            strokeDasharray="2,2"
            opacity="0.6"
          >
            <title>{m.label}</title>
          </line>
        </g>
      ))}
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

// Convert the brand's promo list into sparkline markers (start + end
// dates within the daily-point window get a vertical line).
function promosToMarkers(promos: Promo[]): SparklineMarker[] {
  const out: SparklineMarker[] = [];
  for (const p of promos) {
    out.push({
      date: p.startDate,
      kind: 'start',
      label: `${p.name} started`,
    });
    out.push({
      date: p.endDate,
      kind: 'end',
      label: `${p.name} ended`,
    });
  }
  return out;
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
  markers,
}: {
  title: string;
  bucket: Bucket;
  kind: Format;
  sparklineColor?: string;
  markers?: SparklineMarker[];
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
        <Sparkline points={bucket.daily} markers={markers} />
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
  markers,
}: {
  title: string;
  bucket: SubBucket;
  kind: Format;
  sparklineColor?: string;
  markers?: SparklineMarker[];
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
        <Sparkline points={bucket.daily} markers={markers} />
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
  accent,
}: {
  items: readonly T[];
  active: T;
  hrefFor: (item: T) => string;
  ariaLabel: string;
  labelFor?: (item: T) => string;
  preserveScroll?: boolean;
  // Optionally style one specific item with different colors (used for
  // visually distinguishing tabs that are categorically different — e.g.
  // Channel Attribution among the page-data tabs).
  accent?: { item: T; activeClass: string; inactiveClass: string };
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
        const isAccent = accent?.item === item;
        const activeCls = isAccent
          ? accent!.activeClass
          : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';
        const inactiveCls = isAccent
          ? accent!.inactiveClass
          : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100';
        return (
          <Link
            key={String(item)}
            href={hrefFor(item)}
            scroll={!preserveScroll}
            role="tab"
            aria-selected={isActive}
            className={`rounded-full px-3 py-1 transition ${
              isActive ? activeCls : inactiveCls
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
  Subscription: {
    stroke: 'stroke-purple-500',
    dot: 'bg-purple-500',
    text: 'text-purple-700 dark:text-purple-400',
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
  Manual: {
    stroke: 'stroke-sky-500',
    dot: 'bg-sky-500',
    text: 'text-sky-700 dark:text-sky-400',
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

function NorthbeamPanel({
  data,
  period,
}: {
  data: NorthbeamSummary;
  period: Period;
}) {
  // Hide entirely if no paid spend in either window — the panel only
  // exists to monitor paid efficiency. Brands without paid spend get no
  // empty panel cluttering the page.
  if (data.totalSpend === 0 && data.priorTotalSpend === 0) return null;

  return (
    <section className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div>
          <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Paid Attribution · Northbeam
          </div>
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Last {period} days · Clicks + Modeled Views (MTA)
          </div>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            <th className="px-5 py-2 font-medium">Channel</th>
            <th className="px-5 py-2 text-right font-medium">Spend</th>
            <th className="px-5 py-2 text-right font-medium">Attr Rev</th>
            <th className="px-5 py-2 text-right font-medium">ROAS</th>
            <th className="px-5 py-2 text-right font-medium">New Visits</th>
            <th className="px-5 py-2 text-right font-medium">vs prior (ROAS)</th>
          </tr>
        </thead>
        <tbody>
          {data.channels
            .filter((c) => c.spend > 0 || c.priorSpend > 0)
            .map((c) => (
              <tr key={c.platform} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-5 py-3 text-zinc-900 dark:text-zinc-100">{c.platform}</td>
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {c.spend > 0
                    ? fmtShort(c.spend)
                    : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {c.revAttributed > 0
                    ? fmtShort(c.revAttributed)
                    : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {c.roas != null
                    ? `${c.roas.toFixed(1)}x`
                    : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {c.newVisits > 0
                    ? c.newVisits.toLocaleString()
                    : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {c.roas != null && c.priorRoas != null
                    ? <MiniTrend current={c.roas} prior={c.priorRoas} />
                    : <span className="text-xs text-zinc-400 dark:text-zinc-500">new</span>}
                </td>
              </tr>
            ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-200 bg-zinc-50 font-medium dark:border-zinc-700 dark:bg-zinc-900">
            <td className="px-5 py-3 text-zinc-700 dark:text-zinc-300">TOTAL</td>
            <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
              {fmtShort(data.totalSpend)}
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
              {fmtShort(data.totalRevAttributed)}
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
              {data.totalRoas != null ? `${data.totalRoas.toFixed(1)}x` : '—'}
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
              {data.totalNewVisits.toLocaleString()}
            </td>
            <td className="px-5 py-3 text-right tabular-nums">
              {data.totalRoas != null && data.priorTotalRoas != null
                ? <MiniTrend current={data.totalRoas} prior={data.priorTotalRoas} />
                : <span className="text-xs text-zinc-400 dark:text-zinc-500">new</span>}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function ActivePromosPanel({ promos }: { promos: Promo[] }) {
  // Hide entirely if no promos within the upcoming/active/recent window
  // for this brand — the panel exists to surface context, not clutter
  // the page with empty state.
  if (promos.length === 0) return null;

  const stateStyle: Record<Promo['state'], { dot: string; label: string; text: string }> = {
    active: {
      dot: 'bg-emerald-500',
      label: 'Active now',
      text: 'text-emerald-700 dark:text-emerald-400',
    },
    upcoming: {
      dot: 'bg-sky-500',
      label: 'Upcoming',
      text: 'text-sky-700 dark:text-sky-400',
    },
    recent: {
      dot: 'bg-zinc-400 dark:bg-zinc-500',
      label: 'Recently ended',
      text: 'text-zinc-500 dark:text-zinc-400',
    },
  };

  const counts = promos.reduce(
    (acc, p) => ({ ...acc, [p.state]: (acc[p.state] ?? 0) + 1 }),
    {} as Record<Promo['state'], number>,
  );

  return (
    <section className="mb-6 overflow-hidden rounded-lg border-2 border-amber-300 bg-amber-50/40 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/10">
      {/* Visual accent: amber top stripe distinguishes Promos from the
          neutral cards above/below so the team's eye lands here when
          they're trying to explain a metric shift. */}
      <div className="h-1.5 w-full bg-gradient-to-r from-amber-400 via-amber-500 to-orange-500" />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 px-5 py-3 dark:border-amber-900/60">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            <span aria-hidden="true">🏷️</span>
            <span>Promo Schedule</span>
          </div>
          <div className="text-[11px] text-zinc-600 dark:text-zinc-400">
            ±7 days from today · synced daily from the team promo sheet
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {counts.active ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              {counts.active} active
            </span>
          ) : null}
          {counts.upcoming ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden="true" />
              {counts.upcoming} upcoming
            </span>
          ) : null}
          {counts.recent ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" aria-hidden="true" />
              {counts.recent} recently ended
            </span>
          ) : null}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-amber-100/50 text-left text-[11px] uppercase tracking-wider text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <tr>
            <th className="px-5 py-2 font-medium">Status</th>
            <th className="px-5 py-2 font-medium">Promo</th>
            <th className="px-5 py-2 font-medium">Code</th>
            <th className="px-5 py-2 font-medium">Discount</th>
            <th className="px-5 py-2 font-medium">Applies To</th>
            <th className="px-5 py-2 font-medium">Window</th>
          </tr>
        </thead>
        <tbody>
          {promos.map((p) => {
            const s = stateStyle[p.state];
            return (
              <tr key={`${p.name}-${p.startDate}`} className="border-t border-amber-200/60 dark:border-amber-900/40">
                <td className="whitespace-nowrap px-5 py-3">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
                    {s.label}
                  </span>
                </td>
                <td className="px-5 py-3 text-zinc-900 dark:text-zinc-100">
                  <div className="font-medium">{p.name}</div>
                  {p.description && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{p.description}</div>
                  )}
                </td>
                <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                  {p.code || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-zinc-700 dark:text-zinc-300">
                  {p.discountType || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="px-5 py-3 text-zinc-700 dark:text-zinc-300">
                  {p.appliesTo || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {p.startDate} → {p.endDate}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
  showClarityMetrics,
  clarityMetrics,
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
  showClarityMetrics: boolean;
  clarityMetrics: ClarityMetricsMap;
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
          {showSessions && (
            <th
              className="px-5 py-2 text-right font-medium"
              title="% of sessions that reached the checkout step (Shopify metric — not the same as completed orders)"
            >
              Checkout rate
            </th>
          )}
          {showSessions && (
            <th
              className="px-5 py-2 text-right font-medium"
              title="Completed orders ÷ sessions (our calculation from Snowflake). Differs from Checkout rate when customers reach checkout but don't pay, or when orders attribute to a different first-touch page."
            >
              Order rate
            </th>
          )}
          <th className="px-5 py-2 text-right font-medium">{metricNoun}</th>
          {showRevenue && <th className="px-5 py-2 text-right font-medium">Sub</th>}
          {showRevenue && <th className="px-5 py-2 text-right font-medium">Revenue</th>}
          {showClarityMetrics && (
            <>
              <th
                className="px-5 py-2 text-right font-medium"
                title="Sessions in the last 3 days where Clarity recorded rapid repeated clicks indicating user frustration"
              >
                Rage
              </th>
              <th
                className="px-5 py-2 text-right font-medium"
                title="Sessions in the last 3 days where Clarity recorded clicks on non-interactive elements"
              >
                Dead clicks
              </th>
              <th
                className="px-5 py-2 text-right font-medium"
                title="Average scroll depth across recent sessions (0-100)"
              >
                Scroll %
              </th>
              <th
                className="px-5 py-2 text-right font-medium"
                title="Average time on page across recent sessions"
              >
                Avg time
              </th>
            </>
          )}
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
          const heatmapUrl = starrable ? clarityHeatmapUrl(brand, r.key) : null;
          const intelligemsMatch = starrable ? findIntelligemsTest(brand, r.key) : null;
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
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{r.label}</span>
                  {heatmapUrl && (
                    <a
                      href={heatmapUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open heatmap in Microsoft Clarity"
                      className="shrink-0 text-zinc-400 hover:text-sky-600 dark:text-zinc-500 dark:hover:text-sky-400"
                      aria-label="Open heatmap in Microsoft Clarity"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </a>
                  )}
                  {intelligemsMatch && (
                    <a
                      href={intelligemsMatch.test.testUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={
                        intelligemsMatch.role === 'origin'
                          ? `In Intelligems test (origin URL) — "${intelligemsMatch.test.name}". Heads-up: numbers on this row may look low because this dashboard credits orders to the SESSION's landing page only. Intelligems uses cohort attribution (counts ALL downstream orders from anyone who entered the test via this URL — including orders placed in later sessions on different pages). Click to view the test's cohort-attributed conversion rate.`
                          : `In Intelligems test (destination URL) — "${intelligemsMatch.test.name}". Test traffic redirects here client-side; ShopifyQL credits the session's landing_page to the origin URL, so this row shows mostly organic / direct traffic. Click for the test's cohort view.`
                      }
                      className="shrink-0 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
                      aria-label={`In Intelligems test ${intelligemsMatch.test.name}`}
                    >
                      A/B
                    </a>
                  )}
                </div>
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
              {showClarityMetrics && (() => {
                const m = clarityMetrics.get(r.key);
                const dash = <span className="text-zinc-300 dark:text-zinc-600">—</span>;
                const fmtSecs = (s: number) => (s >= 60 ? `${Math.round(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
                return (
                  <>
                    <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                      {m?.rageClicks != null ? m.rageClicks.toLocaleString() : dash}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                      {m?.deadClicks != null ? m.deadClicks.toLocaleString() : dash}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                      {m?.scrollDepthPct != null ? `${Math.round(m.scrollDepthPct)}%` : dash}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                      {m?.avgTimeSeconds != null ? fmtSecs(m.avgTimeSeconds) : dash}
                    </td>
                  </>
                );
              })()}
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
    expanded?: string;
  }>;
}) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const brand = parseBrand(sp.brand);
  const tab = parseLayer2Tab(sp.tab);
  const source = parseSource(sp.source);
  const expanded = sp.expanded === 'true';
  const [data, layer2Rows, watchedPaths, northbeam, clarityMetrics, promos, sparkPromos] = await Promise.all([
    getStoreOverview(brand, period, source),
    getLayer2(brand, period, tab),
    getWatchedPaths(brand),
    getNorthbeamSummary(brand, period).catch(() => null),
    // Only fetched on Watched tab — the only tab that renders the columns.
    tab === 'watched' ? getClarityMetrics(brand).catch(() => new Map() as ClarityMetricsMap) : Promise.resolve(new Map() as ClarityMetricsMap),
    getActivePromos(brand).catch(() => [] as Promo[]),
    // Wider window than active-promos panel; used for sparkline markers
    // so the Layer 1 cards show start/end ticks for any promo that
    // overlaps the chart's date axis.
    getPromosInWindow(brand, period).catch(() => [] as Promo[]),
  ]);
  const sparkMarkers = promosToMarkers(sparkPromos);
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
  // Noun used in the "Show all N <noun>" expand link, per tab.
  const rowNounByTab: Record<Layer2Tab, string> = {
    watched: 'watched pages',
    pdps: 'product pages',
    collections: 'collections',
    cms: 'pages',
    products: 'products',
    attribution: 'sources',
  };
  const COLLAPSED_ROWS = 10;

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
              Last {period} days · story
            </div>
            <div className="text-xs text-zinc-400 dark:text-zinc-500">
              AI narrative — pending sessions data
            </div>
          </div>
          <p className="text-zinc-600 dark:text-zinc-400">
            The AI narrative for the last {period} days will appear here once
            sessions and customer-event data land in Snowflake.
            Today&rsquo;s view shows the order-side and subscription metrics
            we have over this window.
          </p>
          <div className="mt-4 border-t border-zinc-100 pt-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
            <span className="font-semibold">Yesterday</span> ·{' '}
            <span className="tabular-nums">{fmt(data.orders.yesterday, 'count')}</span> orders ·{' '}
            <span className="tabular-nums">{fmt(data.revenue.yesterday, 'currency')}</span>{' '}
            revenue · <span className="tabular-nums">{fmt(data.aov.yesterday, 'aov')}</span> AOV
          </div>
        </section>

        <ActivePromosPanel promos={promos} />

        <h2 className="mt-10 mb-3 text-xl font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
          Layer 1 · Store Overview
        </h2>
        <ChannelMix data={data.channelMix} period={data.period} />

        {northbeam && <NorthbeamPanel data={northbeam} period={period} />}

        {/* Row 1: Funnel — Sessions, Conv Rate, Orders */}
        <section className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          {data.sessions && (
            <MetricCard
              title="Sessions"
              bucket={data.sessions}
              kind="count"
              sparklineColor="text-sky-600 dark:text-sky-400"
              markers={sparkMarkers}
            />
          )}
          {data.convRate && (
            <MetricCard
              title="Conv Rate"
              bucket={data.convRate}
              kind="percent"
              sparklineColor="text-sky-600 dark:text-sky-400"
              markers={sparkMarkers}
            />
          )}
          <MetricCard
            title="Orders"
            bucket={data.orders}
            kind="count"
            sparklineColor="text-emerald-600 dark:text-emerald-400"
            markers={sparkMarkers}
          />
        </section>

        {/* Row 2: Revenue & monetization */}
        <section className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <MetricCard
            title="Revenue"
            bucket={data.revenue}
            kind="currency"
            sparklineColor="text-emerald-600 dark:text-emerald-400"
            markers={sparkMarkers}
          />
          <MetricCard
            title="AOV"
            bucket={data.aov}
            kind="aov"
            sparklineColor="text-blue-600 dark:text-blue-400"
            markers={sparkMarkers}
          />
          <SubMetricCard
            title="Subscription Share"
            bucket={data.subscriptionShare}
            kind="percent"
            sparklineColor="text-purple-600 dark:text-purple-400"
            markers={sparkMarkers}
          />
        </section>

        {/* Row 3: Subscription business */}
        <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <MetricCard
            title="Subscription Revenue"
            bucket={data.subscriptionRevenue}
            kind="currency"
            sparklineColor="text-purple-600 dark:text-purple-400"
            markers={sparkMarkers}
          />
          <MetricCard
            title="Recurring Revenue"
            bucket={data.recurringRevenue}
            kind="currency"
            sparklineColor="text-purple-600 dark:text-purple-400"
            markers={sparkMarkers}
          />
          <SubMetricCard
            title="New Subscriptions"
            bucket={data.newSubscriptions}
            kind="count"
            sparklineColor="text-purple-600 dark:text-purple-400"
            markers={sparkMarkers}
          />
        </section>

        <section className="mb-6">
          <TopProductsTable rows={data.topSubscriptionProducts} />
        </section>

        <h2 className="mt-10 mb-3 text-xl font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
          Layer 2 · Pages, Products &amp; Sources
        </h2>
        <section className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            {/* Top row: tabs anchored right, doesn't shift with subtitle text changes */}
            <div className="flex items-center justify-end gap-3">
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
                accent={{
                  item: 'attribution',
                  activeClass:
                    'bg-amber-500 text-white dark:bg-amber-500 dark:text-zinc-900',
                  inactiveClass:
                    'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60',
                }}
              />
            </div>
            {/* Subtitle on its own row below — text length differences between tabs can't push the tab strip around */}
            <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              {tab === 'attribution'
                ? 'Traffic sources · session-level data from ShopifyQL · top 10 by volume (expand for more)'
                : 'DTC orders only · top 10 by revenue (expand for more) · click-through coming with Layer 3'}
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
          {/* overflow-x-auto wrapper lets the wide table (esp. Watched
              tab with up to 14 columns) scroll horizontally inside the
              section while the tabs + footnote stay put */}
          <div className="overflow-x-auto">
            <Layer2Table
              rows={expanded ? layer2Rows : layer2Rows.slice(0, COLLAPSED_ROWS)}
              metricNoun={metricNounByTab[tab]}
              emptyMessage={`No ${LAYER2_LABELS[tab].toLowerCase()} data in this period for ${brand}.`}
              period={period}
              brand={brand}
              watchedSet={watchedSet}
              starrable={starrableTabs.has(tab)}
              showSessions={starrableTabs.has(tab) || tab === 'attribution'}
              showRevenue={tab !== 'attribution'}
              showClarityMetrics={tab === 'watched'}
              clarityMetrics={clarityMetrics}
            />
          </div>
          {layer2Rows.length > COLLAPSED_ROWS && (
            <div className="flex justify-center border-t border-zinc-100 bg-zinc-50/50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/30">
              <Link
                href={`/?brand=${brand}&period=${period}&tab=${tab}&source=${source}${expanded ? '' : '&expanded=true'}`}
                scroll={false}
                className="text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {expanded
                  ? `↑ Show top ${COLLAPSED_ROWS}`
                  : `↓ Show all ${layer2Rows.length} ${rowNounByTab[tab]}`}
              </Link>
            </div>
          )}
          {starrableTabs.has(tab) && layer2Rows.length > 0 && (
            <div className="border-t border-zinc-100 bg-zinc-50/50 px-5 py-3 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-400">
              <span className="font-medium">Reading this table:</span>{' '}
              <span className="font-medium">Checkout rate</span> = % of sessions
              that reached the checkout step (Shopify metric — counts visitors
              who hit checkout, not just those who paid).{' '}
              <span className="font-medium">Order rate</span> = completed orders
              &divide; sessions (our calculation). The two diverge when
              customers reach checkout but don&rsquo;t pay, or when orders
              attribute to a different first-touch page (e.g. a discovery row
              with 0% checkout rate but orders &gt; 0 means visitors landed
              here, left, and later converted elsewhere). Sub = subscription
              orders that don&rsquo;t generate sessions.
            </div>
          )}
        </section>

        <footer className="text-xs text-zinc-400 dark:text-zinc-500">
          Visitors, conversion rate, and channel mix arrive once the data team lands sessions in
          Snowflake. Windows aligned to calendar days; current day excluded (pipeline lag ≈ 12h).
        </footer>
      </div>
    </main>
  );
}
