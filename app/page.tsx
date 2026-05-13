import Link from 'next/link';
import {
  BRANDS,
  getStoreOverview,
  parseBrand,
  parsePeriod,
  PERIODS,
  type Brand,
  type Bucket,
  type DailyPoint,
  type Period,
  type SubBucket,
  type TopSubProduct,
} from '@/lib/queries/orders';

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
  const rounded = Math.round(pct);
  const arrow = rounded > 0 ? '↑' : rounded < 0 ? '↓' : '→';
  const color =
    rounded > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : rounded < 0
        ? 'text-red-600 dark:text-red-400'
        : 'text-zinc-500 dark:text-zinc-400';
  return (
    <span className={`text-sm font-medium ${color}`}>
      {arrow} {Math.abs(rounded)}% {label}
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
}: {
  items: readonly T[];
  active: T;
  hrefFor: (item: T) => string;
  ariaLabel: string;
}) {
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
            role="tab"
            aria-selected={isActive}
            className={`rounded-full px-3 py-1 transition ${
              isActive
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            {String(item)}
            {typeof item === 'number' ? ' days' : ''}
          </Link>
        );
      })}
    </div>
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
  searchParams: Promise<{ period?: string; brand?: string }>;
}) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const brand = parseBrand(sp.brand);
  const data = await getStoreOverview(brand, period);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
              Store Trends
            </h1>
            <PillTabs<Brand>
              items={BRANDS}
              active={brand}
              hrefFor={(b) => `/?brand=${b}&period=${period}`}
              ariaLabel="Select brand"
            />
          </div>
          <PillTabs<Period>
            items={PERIODS}
            active={period}
            hrefFor={(p) => `/?brand=${brand}&period=${p}`}
            ariaLabel="Select period"
          />
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

        <section className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-4">
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

        <footer className="text-xs text-zinc-400 dark:text-zinc-500">
          Visitors, conversion rate, and channel mix arrive once the data team lands sessions in
          Snowflake. Windows aligned to calendar days; current day excluded (pipeline lag ≈ 12h).
        </footer>
      </div>
    </main>
  );
}
