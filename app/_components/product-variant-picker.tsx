'use client';

import { useState } from 'react';

type VariantSplit = {
  variantId: string;
  title: string;
  sku: string | null;
  units: number;
  revenue: number;
  revenueShare: number;
};

// "View by variant" dropdown for a Top Products row. Selecting a variant
// shows its units + revenue + share below the product name. Default shows
// the product totals (the row's own numbers), nothing extra.
export function ProductVariantPicker({ variants }: { variants: VariantSplit[] }) {
  const [sel, setSel] = useState('');
  const v = variants.find((x) => x.variantId === sel) ?? null;

  return (
    <div className="mt-1 flex flex-col gap-1">
      <select
        value={sel}
        onChange={(e) => setSel(e.target.value)}
        className="max-w-[260px] rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        aria-label="View metrics by variant"
      >
        <option value="">All variants ({variants.length}) — by variant…</option>
        {variants.map((x) => (
          <option key={x.variantId} value={x.variantId}>
            {x.title}
          </option>
        ))}
      </select>
      {v && (
        <div className="text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">
          <span className="font-medium text-zinc-800 dark:text-zinc-200">{v.title}</span>
          {' — '}
          {Math.round(v.units).toLocaleString()} units · $
          {v.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} ·{' '}
          {(v.revenueShare * 100).toFixed(0)}% of revenue
        </div>
      )}
    </div>
  );
}
