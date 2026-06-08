'use client';

import { useState, useTransition } from 'react';

// Passcode sign-in form. On success it navigates to `next` (validated
// server-side to be an internal path).
export function PasscodeForm({ next }: { next: string }) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = passcode.trim();
    if (!v) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/auth/passcode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ passcode: v }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        const dest = next.startsWith('/') && !next.startsWith('//') ? next : '/';
        window.location.assign(dest);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <input
        type="password"
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
        placeholder="Passcode"
        autoComplete="off"
        disabled={pending}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
      />
      <button
        type="submit"
        disabled={pending || !passcode.trim()}
        className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? 'Checking…' : 'Enter with passcode'}
      </button>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
