'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export function StarButton({
  brand,
  path,
  initialStarred,
}: {
  brand: string;
  path: string;
  initialStarred: boolean;
}) {
  const router = useRouter();
  const [starred, setStarred] = useState(initialStarred);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !starred;
    setStarred(next); // optimistic
    startTransition(async () => {
      try {
        const res = await fetch('/api/watched/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            brand,
            path,
            action: next ? 'add' : 'remove',
          }),
        });
        if (!res.ok) {
          // Surface the server's error message — most commonly the
          // "watched list at max" cap so the user knows why nothing
          // happened. alert() is rough but the only star-button signal
          // we have until we add a toast system.
          const body = await res.json().catch(() => ({}));
          const msg = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
          throw new Error(msg);
        }
        router.refresh();
      } catch (err) {
        setStarred(!next); // revert optimistic state
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-alert
        alert(msg);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={starred}
      aria-label={starred ? `Unstar ${path}` : `Star ${path}`}
      title={starred ? 'Unstar (remove from Watched)' : 'Star (add to Watched)'}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-base transition ${
        starred
          ? 'text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300'
          : 'text-zinc-300 hover:text-amber-500 dark:text-zinc-600 dark:hover:text-amber-400'
      } ${pending ? 'opacity-60' : ''}`}
    >
      {starred ? '★' : '☆'}
    </button>
  );
}
