'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

// Always-visible bar above the Layer 2 page tables listing the brand's
// hidden pages, each with a Restore button. Pairs with HideButton — the
// reversible half of the hide feature. Shows even when nothing is hidden
// so the control is discoverable, with a one-line hint in that case.
export function HiddenManager({ brand, paths }: { brand: string; paths: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const count = paths.length;

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
    <div className="border-b border-zinc-200 bg-zinc-50/50 px-5 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/30">
      {count === 0 ? (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
          <span aria-hidden="true">🚫</span>
          No hidden pages — click the eye-off icon on a row to hide a stale or parked page.
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          <span aria-hidden="true">🚫</span>
          {count} hidden page{count > 1 ? 's' : ''} · {open ? 'close' : 'manage / restore'}
        </button>
      )}
      {open && count > 0 && (
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
