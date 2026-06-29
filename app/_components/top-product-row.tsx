'use client';

import { useState } from 'react';

type DailyPoint = { date: string; value: number };
type Metrics = { units: number; revenue: number; priorRevenue: number; daily: DailyPoint[] };
type Variant = Metrics & { variantId: string; title: string; revenueShare: number };

function pct(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

function MiniSparkline({ points }: { points: DailyPoint[] }) {
  const width = 128;
  const height = 28;
  if (points.length < 2) return <div style={{ height }} aria-hidden="true" />;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = innerW / (values.length - 1);
  const coords = values.map((v, i) => [pad + i * stepX, pad + innerH - ((v - min) / range) * innerH] as const);
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden="true">
      <path d={`${line} L${lx.toFixed(1)},${height - pad} L${coords[0][0].toFixed(1)},${height - pad} Z`} fill="currentColor" opacity="0.08" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx.toFixed(1)} cy={ly.toFixed(1)} r="2.5" fill="currentColor" />
    </svg>
  );
}

function MiniTrend({ current, prior }: { current: number; prior: number }) {
  const p = pct(current, prior);
  if (p === null) return <span className="text-xs text-zinc-400 dark:text-zinc-500">new</span>;
  const abs = Math.abs(p);
  if (abs < 0.05) return <span className="text-xs text-zinc-500 dark:text-zinc-400">→ flat</span>;
  const arrow = p > 0 ? '↑' : '↓';
  const color = p > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return <span className={`text-xs font-medium ${color}`}>{arrow} {abs < 10 ? abs.toFixed(1) : Math.round(abs)}%</span>;
}

function directionTag(current: number, prior: number) {
  const p = pct(current, prior);
  if (p === null) return { label: 'new', className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' };
  const abs = Math.abs(p);
  if (abs < 5) return { label: '→ stable', className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' };
  if (p > 0) return { label: '↑ trending up', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400' };
  return { label: '↓ watch', className: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400' };
}

// A Top Products row whose whole metric set (units, revenue, vs-prior, trend
// sparkline, direction) swaps to a selected variant. Renders the full <tr>
// so the dropdown (name cell) and the metric cells share selection state.
export function TopProductRow({
  label,
  product,
  variants,
}: {
  label: string;
  product: Metrics;
  variants: Variant[];
}) {
  const [sel, setSel] = useState('');
  const active = variants.find((v) => v.variantId === sel) ?? null;
  const m: Metrics = active ?? product;
  const tag = directionTag(m.revenue, m.priorRevenue);

  return (
    <tr
      className={
        'border-t border-zinc-100 transition-colors dark:border-zinc-800 ' +
        (active ? 'bg-sky-50/70 dark:bg-sky-950/20' : '')
      }
    >
      <td className="max-w-md px-5 py-3 text-zinc-900 dark:text-zinc-100">
        <div className="truncate font-medium">{label}</div>
        <div className="mt-1 flex items-center gap-2">
          <select
            value={sel}
            onChange={(e) => setSel(e.target.value)}
            className="max-w-[240px] rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            aria-label="View metrics by variant"
          >
            <option value="">All variants ({variants.length}) — product totals</option>
            {variants.map((v) => (
              <option key={v.variantId} value={v.variantId}>
                {v.title}
              </option>
            ))}
          </select>
          {active && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
              viewing: {active.title} · {(active.revenueShare * 100).toFixed(0)}%
              <button type="button" onClick={() => setSel('')} className="hover:text-sky-900 dark:hover:text-sky-100" aria-label="Reset to product totals">
                ✕
              </button>
            </span>
          )}
        </div>
      </td>
      <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
        {Math.round(m.units).toLocaleString()}
      </td>
      <td className="px-5 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
        ${m.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </td>
      <td className="px-5 py-3 text-right tabular-nums">
        <MiniTrend current={m.revenue} prior={m.priorRevenue} />
      </td>
      <td className="px-5 py-3">
        <div className={`w-32 ${active ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
          <MiniSparkline points={m.daily} />
        </div>
      </td>
      <td className="px-5 py-3">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tag.className}`}>{tag.label}</span>
      </td>
    </tr>
  );
}
