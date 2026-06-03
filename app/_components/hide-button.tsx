'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

// Per-row "hide" control on the auto-discovered Layer 2 page tabs
// (PDPs / Collections / CMS). Hides a stale/deleted/parked page from the
// list — reversible from the "N hidden · manage" footer (HiddenManager).
export function HideButton({ brand, path }: { brand: string; path: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const hide = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/hidden/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, action: 'add' }),
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
    <button
      type="button"
      onClick={hide}
      disabled={pending}
      title="Hide this page from the list (reversible)"
      aria-label={`Hide ${path} from the list`}
      className={`shrink-0 text-zinc-300 transition hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 ${
        pending ? 'opacity-50' : ''
      }`}
    >
      {/* eye-off icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
        <line x1="2" x2="22" y1="2" y2="22" />
      </svg>
    </button>
  );
}
