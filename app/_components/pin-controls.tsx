'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

// Add a page to the current page tab's list by URL/path — force-includes
// it (pins) even if it isn't top-by-revenue, without adding it to the
// Watch list. Mirrors AddWatchedInput.
export function AddPinnedInput({ brand }: { brand: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/pinned/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path: v, action: 'add' }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        setValue('');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="/pages/some-landing-page"
        spellCheck={false}
        autoCorrect="off"
        disabled={pending}
        className="flex-1 min-w-[260px] rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm tabular-nums text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
      />
      <button
        type="submit"
        disabled={pending || !value.trim()}
        className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        📌 Add to list
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </form>
  );
}

// Small "pinned" badge + unpin control shown on a force-included row.
export function UnpinButton({ brand, path }: { brand: string; path: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const unpin = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/pinned/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, action: 'remove' }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        router.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <button
      type="button"
      onClick={unpin}
      disabled={pending}
      title="Pinned to this list — click to unpin"
      aria-label={`Unpin ${path}`}
      className={`shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60 ${
        pending ? 'opacity-50' : ''
      }`}
    >
      📌 pinned ✕
    </button>
  );
}
