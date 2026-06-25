'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

function useDismissAction(brand: string, path: string, testId: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (action: 'add' | 'remove') => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/intelligems/dismiss', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, testId, action }),
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
  return { run, pending };
}

// Hide an auto-located test from the page's active list.
export function DismissTestButton(props: { brand: string; path: string; testId: string }) {
  const { run, pending } = useDismissAction(props.brand, props.path, props.testId);
  return (
    <button
      type="button"
      onClick={() => run('add')}
      disabled={pending}
      title="Hide this test from this page (reversible in Prior tests)"
      className="text-[10px] text-zinc-400 underline underline-offset-2 hover:text-red-500 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-red-400"
    >
      dismiss
    </button>
  );
}

// Restore a previously-dismissed test back into the active list.
export function RestoreTestButton(props: { brand: string; path: string; testId: string }) {
  const { run, pending } = useDismissAction(props.brand, props.path, props.testId);
  return (
    <button
      type="button"
      onClick={() => run('remove')}
      disabled={pending}
      title="Restore this test to the active list"
      className="text-[10px] text-sky-600 underline underline-offset-2 hover:text-sky-800 disabled:opacity-50 dark:text-sky-400 dark:hover:text-sky-300"
    >
      restore
    </button>
  );
}
