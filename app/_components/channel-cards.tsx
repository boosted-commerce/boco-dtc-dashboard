'use client';

import { useState } from 'react';
import { Sparkline, type SparklineBand } from '@/app/_components/sparkline';
import { fmt, type Format } from '@/lib/format';
import type { Bucket } from '@/lib/queries/orders';
import type { ChannelCard } from '@/lib/queries/page-deep-dive';

type AllBuckets = {
  sessions: Bucket;
  convRate: Bucket;
  orders: Bucket;
  revenue: Bucket;
  aov: Bucket;
  subRevenue: Bucket;
};

function pctChange(current: number, prior: number) {
  if (prior === 0) return null;
  const p = ((current - prior) / prior) * 100;
  if (Math.abs(p) < 0.05) return { text: '→ flat', color: 'text-zinc-500 dark:text-zinc-400' };
  const arrow = p > 0 ? '↑' : '↓';
  const color = p > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  const disp = Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.round(Math.abs(p)).toString();
  return { text: `${arrow} ${disp}%`, color };
}

function Card({
  title,
  bucket,
  kind,
  color,
  bands,
  channelMode,
  source,
}: {
  title: string;
  bucket: Bucket;
  kind: Format;
  color: string;
  bands?: SparklineBand[];
  channelMode: boolean;
  source?: string;
}) {
  const change = pctChange(bucket.current, bucket.prior);
  // AOV and conversion are rates — the 7-day bucket already holds the
  // weighted rate, so show it directly (don't divide by 7 like a count).
  const isRate = kind === 'aov' || kind === 'percent';
  const sevenDayAvg = isRate ? bucket.sevenDayTotal : bucket.sevenDayTotal / 7;
  const sevenDayLabel = kind === 'aov' ? '7-DAY AOV' : kind === 'percent' ? '7-DAY AVG' : '7-DAY AVG/DAY';
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{title}</div>
        {source && (
          <div className="text-[9px] uppercase tracking-wider text-zinc-300 dark:text-zinc-600" title="Data source">
            {source}
          </div>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {fmt(bucket.current, kind)}
      </div>
      <div className="mt-1 text-xs">
        {change ? (
          <span className={`font-medium ${change.color}`}>
            {change.text} <span className="text-zinc-500 dark:text-zinc-400">vs prior</span>
          </span>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-500">new (no prior comparison)</span>
        )}
      </div>
      <div className={`mt-3 ${color}`}>
        <Sparkline points={bucket.daily} kind={kind} bands={bands} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
        <Tiny label="Yesterday" value={fmt(bucket.yesterday, kind)} />
        <Tiny label={sevenDayLabel} value={fmt(sevenDayAvg, kind)} />
        {/* Year-ago isn't available per channel. */}
        <Tiny label="Year ago" value={channelMode ? '—' : fmt(bucket.yearAgo, kind)} />
      </div>
    </div>
  );
}

function Tiny({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  );
}

// Cards section with a channel filter. "All channels" shows the page totals
// (with real year-ago + subscription rev). Picking a channel re-scopes the
// cards: sessions/conv/orders are exact per channel; revenue/AOV are the
// page's revenue allocated by converting-session share; the sparkline shape
// follows the page trend at the channel's volume; year-ago shows "—".
export function ChannelCards({
  all,
  channels,
  period,
  bands,
}: {
  all: AllBuckets;
  channels: ChannelCard[];
  period: number;
  bands?: SparklineBand[];
}) {
  const [sel, setSel] = useState('');
  const active = channels.find((c) => c.channel === sel) ?? null;
  const channelMode = active !== null;
  const suffix = channelMode ? ` · ${active!.channel}` : '';
  const allocated = channelMode ? ' (allocated)' : '';

  const sessions = active ? active.sessions : all.sessions;
  const convRate = active ? active.convRate : all.convRate;
  const orders = active ? active.orders : all.orders;
  const revenue = active ? active.revenue : all.revenue;
  const aov = active ? active.aov : all.aov;

  return (
    <div className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Filter cards by channel
        </span>
        <select
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          <option value="">All channels</option>
          {channels.map((c) => (
            <option key={c.channel} value={c.channel}>
              {c.channel}
            </option>
          ))}
        </select>
        {channelMode && (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            sessions &amp; conversion trends are per-channel · orders/revenue allocated by each day&rsquo;s session share
          </span>
        )}
      </div>

      <section className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card title={`Sessions · ${period}d${suffix}`} bucket={sessions} kind="count" color="text-sky-600 dark:text-sky-400" bands={bands} channelMode={channelMode} source="Shopify" />
        <Card title={`Conversion · ${period}d${suffix}`} bucket={convRate} kind="percent" color="text-indigo-600 dark:text-indigo-400" bands={bands} channelMode={channelMode} source="Shopify" />
      </section>
      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card title={`Orders · ${period}d${suffix}`} bucket={orders} kind="count" color="text-emerald-600 dark:text-emerald-400" bands={bands} channelMode={channelMode} source="Snowflake" />
        <Card title={`Revenue${allocated} · ${period}d${suffix}`} bucket={revenue} kind="currency" color="text-emerald-600 dark:text-emerald-400" bands={bands} channelMode={channelMode} source="Snowflake" />
        <Card title={`AOV${allocated} · ${period}d${suffix}`} bucket={aov} kind="aov" color="text-blue-600 dark:text-blue-400" bands={bands} channelMode={channelMode} source="Snowflake" />
        {!channelMode && (
          <Card title={`Subscription rev (landed here) · ${period}d`} bucket={all.subRevenue} kind="currency" color="text-purple-600 dark:text-purple-400" bands={bands} channelMode={false} source="Snowflake" />
        )}
      </section>
      {channelMode && (
        <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-500">
          Subscription revenue isn&rsquo;t attributable by channel — switch to <span className="font-medium">All channels</span> to see it.
        </p>
      )}
    </div>
  );
}
