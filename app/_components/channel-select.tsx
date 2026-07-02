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

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      Channel
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
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
