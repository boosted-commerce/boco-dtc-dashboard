'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

type TestOption = { id: string; name: string; type: string };

// Attach any of the brand's Intelligems tests to a page, from the Layer 2
// A/B Tests tab. Unlike the deep-dive picker (which knows its own path),
// this needs an explicit page path. Posts to the same /api/intelligems/attach.
export function AttachTestToPage({ brand, tests }: { brand: string; tests: TestOption[] }) {
  const router = useRouter();
  const [testId, setTestId] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (tests.length === 0) {
    return (
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
        No active Intelligems tests found for {brand} (check the API token / that tests are started).
      </p>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!testId || !path.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/intelligems/attach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path: path.trim(), testId, action: 'add' }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(typeof b?.error === 'string' ? b.error : `HTTP ${res.status}`);
        }
        setTestId('');
        setPath('');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <select
        value={testId}
        onChange={(e) => setTestId(e.target.value)}
        disabled={pending}
        className="max-w-[320px] rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
      >
        <option value="">Select an Intelligems test…</option>
        {tests.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="/products/some-page"
        spellCheck={false}
        autoCorrect="off"
        disabled={pending}
        className="min-w-[220px] flex-1 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm tabular-nums text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
      />
      <button
        type="submit"
        disabled={pending || !testId || !path.trim()}
        className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? 'Attaching…' : 'Attach to page'}
      </button>
      {error && <span className="w-full text-xs text-red-600 dark:text-red-400">{error}</span>}
    </form>
  );
}
