'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

// Add a page to the manually-curated Social list by URL/path.
// Mirrors AddLPInput but targets /api/social/toggle.
export function AddSocialInput({ brand }: { brand: string }) {
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
        const res = await fetch('/api/social/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path: v, action: 'add' }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(typeof b?.error === 'string' ? b.error : `HTTP ${res.status}`);
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
        placeholder="/products/some-page or full URL"
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
        + Add social page
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </form>
  );
}

// Per-row remove control shown on Social rows.
export function RemoveSocialButton({ brand, path }: { brand: string; path: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const remove = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/social/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, action: 'remove' }),
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

  return (
    <button
      type="button"
      onClick={remove}
      disabled={pending}
      title="Remove from Social list"
      aria-label={`Remove ${path} from Social`}
      className={`shrink-0 inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-400 ${
        pending ? 'opacity-50' : ''
      }`}
    >
      ✕ remove
    </button>
  );
}
