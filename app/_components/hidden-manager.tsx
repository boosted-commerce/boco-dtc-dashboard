'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

// Collapsible footer listing the brand's hidden pages, each with a
// Restore button. Pairs with HideButton — the reversible half of the
// Layer 2 hide feature. Rendered only when the brand has hidden paths.
export function HiddenManager({ brand, paths }: { brand: string; paths: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (paths.length === 0) return null;

  const restore = (path: string) => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/hidden/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, action: 'remove' }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
          throw new Error(msg);
        }
        router.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="border-t border-zinc-100 bg-zinc-50/50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        🚫 {paths.length} hidden page{paths.length > 1 ? 's' : ''} · {open ? 'close' : 'manage'}
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {paths.map((p) => (
            <li
              key={p}
              className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400"
            >
              <span className="truncate tabular-nums">{p}</span>
              <button
                type="button"
                onClick={() => restore(p)}
                disabled={pending}
                className={`shrink-0 font-medium text-sky-700 hover:text-sky-900 dark:text-sky-400 dark:hover:text-sky-200 ${
                  pending ? 'opacity-50' : ''
                }`}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
