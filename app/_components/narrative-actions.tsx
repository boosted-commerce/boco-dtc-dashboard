'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

// Triggers on-demand page-narrative generation. Non-watched pages render
// this instead of auto-spending tokens on load. `force` regenerates an
// existing summary (the "refresh" affordance). On success it refreshes
// the route so the server re-reads the now-cached summary.
export function GenerateNarrativeButton({
  brand,
  path,
  period,
  force = false,
  label,
  subtle = false,
}: {
  brand: string;
  path: string;
  period: number;
  force?: boolean;
  label: string;
  subtle?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/narrative', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, period, force }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  if (subtle) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="text-xs text-zinc-400 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-200"
        >
          {pending ? 'Generating…' : label}
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? 'Generating…' : label}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
