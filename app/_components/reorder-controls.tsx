'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

// Up/down controls to reposition a watched page in the display order.
// Shown only on the Watched tab. Arrows disable at the list ends.
export function ReorderControls({
  brand,
  path,
  isFirst,
  isLast,
}: {
  brand: string;
  path: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const move = (dir: 'up' | 'down') => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/watched/reorder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, dir }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(typeof b?.error === 'string' ? b.error : `HTTP ${res.status}`);
        }
        router.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const btn =
    'inline-flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-200';

  return (
    <span className="inline-flex flex-col leading-none">
      <button
        type="button"
        onClick={() => move('up')}
        disabled={pending || isFirst}
        title="Move up"
        aria-label={`Move ${path} up`}
        className={btn}
      >
        ▲
      </button>
      <button
        type="button"
        onClick={() => move('down')}
        disabled={pending || isLast}
        title="Move down"
        aria-label={`Move ${path} down`}
        className={btn}
      >
        ▼
      </button>
    </span>
  );
}
