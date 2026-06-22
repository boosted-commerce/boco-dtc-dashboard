'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

type TestOption = { id: string; name: string; type: string };

// Dropdown to manually attach an Intelligems test to this page — for
// template/product-targeted tests auto-detection can't locate by URL.
export function AttachTestPicker({
  brand,
  path,
  options,
}: {
  brand: string;
  path: string;
  options: TestOption[];
}) {
  const router = useRouter();
  const [sel, setSel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (options.length === 0) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sel) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/intelligems/attach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, testId: sel, action: 'add' }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(typeof b?.error === 'string' ? b.error : `HTTP ${res.status}`);
        }
        setSel('');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2 border-t border-amber-100 pt-2 dark:border-amber-900/40">
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Test missing? Attach it:</span>
      <select
        value={sel}
        onChange={(e) => setSel(e.target.value)}
        disabled={pending}
        className="max-w-[260px] rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
      >
        <option value="">Select an Intelligems test…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending || !sel}
        className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? 'Attaching…' : 'Attach'}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </form>
  );
}

// Small "remove" control for a manually-attached test.
export function DetachButton({ brand, path, testId }: { brand: string; path: string; testId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/intelligems/attach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, testId, action: 'remove' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      className="text-[10px] text-zinc-400 underline underline-offset-2 hover:text-red-500 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-red-400"
    >
      remove
    </button>
  );
}
