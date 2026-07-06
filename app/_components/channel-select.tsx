'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

// Channel filter for the Layer 2 page tabs. Sets/clears the `channel` URL
// param (server re-queries per channel); preserves all other params.
export function ChannelSelect({ channels }: { channels: readonly string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = sp.get('channel') ?? '';

  const onChange = (v: string) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set('channel', v);
    else p.delete('channel');
    startTransition(() => router.push(`${pathname}?${p.toString()}`, { scroll: false }));
  };

  // Sky accent (matching the "deep-dive view" pill) so the filter reads as
  // an interactive highlight; goes solid when a channel is active.
  const active = current !== '';
  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold transition ${
        active
          ? 'border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200'
          : 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300'
      }`}
    >
      <span aria-hidden="true">📊</span>
      Channel
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        className="rounded-md border border-sky-200 bg-white px-2 py-0.5 text-sm font-medium text-sky-800 focus:border-sky-400 focus:outline-none disabled:opacity-50 dark:border-sky-800 dark:bg-zinc-900 dark:text-sky-200"
      >
        <option value="">All channels</option>
        {channels.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}
