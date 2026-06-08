'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

// Compact date picker for the page-summary history. "latest" → the live
// summary; a date → that day's read-only snapshot (?asOf=YYYY-MM-DD).
export function HistoryPicker({
  brand,
  path,
  period,
  options,
  active,
}: {
  brand: string;
  path: string;
  period: number;
  options: { value: string; label: string }[];
  active: string; // 'latest' or a YYYY-MM-DD
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const base = `/details/${brand}${path === '/' ? '' : path}?period=${period}`;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    const href = v === 'latest' ? base : `${base}&asOf=${v}`;
    startTransition(() => router.push(href, { scroll: false }));
  };

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
      <span className="uppercase tracking-wider">History</span>
      <select
        value={active}
        onChange={onChange}
        disabled={pending}
        className={`rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 ${
          pending ? 'opacity-50' : ''
        }`}
      >
        <option value="latest">Latest</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
