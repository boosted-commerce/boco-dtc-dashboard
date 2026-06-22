'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

// Clears the cached Intelligems data for the brand and reloads, so a
// just-created/changed test shows up without waiting out the 30-min cache.
export function RefreshIntelligems({ brand }: { brand: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  const run = () => {
    setDone(false);
    startTransition(async () => {
      try {
        const res = await fetch('/api/intelligems/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        setDone(true);
        router.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={pending}
      title="Clear the cached Intelligems data and pull the latest tests now"
      className="text-xs text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900 disabled:opacity-50 dark:text-sky-400 dark:hover:text-sky-200"
    >
      {pending ? 'Syncing…' : done ? '↻ Synced' : '↻ Sync from Intelligems'}
    </button>
  );
}
