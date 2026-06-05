'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

type PageComment = {
  id: string;
  author: string;
  text: string;
  createdAt: number;
};

// Team commentary thread on a Layer 3 page deep-dive. Lets people record
// the *why* behind a metric (e.g. a redirect bug found in Clarity) so the
// note sits next to the AI summary for whoever reads it next. Persistent
// per page (brand + path). No login, so the author name is a free-text
// field remembered in the browser.
const NAME_STORAGE_KEY = 'dashboard:commentAuthor';

export function PageComments({
  brand,
  path,
  comments,
}: {
  brand: string;
  path: string;
  comments: PageComment[];
}) {
  const router = useRouter();
  // Lazy initializer reads the remembered name on the client (guarded for
  // SSR). suppressHydrationWarning on the input absorbs the resulting
  // server("")-vs-client(saved) value diff. Avoids a setState-in-effect.
  const [author, setAuthor] = useState(() =>
    typeof window === 'undefined' ? '' : localStorage.getItem(NAME_STORAGE_KEY) ?? '',
  );
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const post = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setError(null);
    if (author.trim()) localStorage.setItem(NAME_STORAGE_KEY, author.trim());
    startTransition(async () => {
      try {
        const res = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, action: 'add', text: t, author }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        setText('');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const remove = (id: string) => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brand, path, action: 'delete', id }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const fmtWhen = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  return (
    <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-sm font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Team notes
        </div>
        <div className="text-xs text-zinc-400 dark:text-zinc-500">
          {comments.length} {comments.length === 1 ? 'note' : 'notes'}
        </div>
      </div>

      {comments.length > 0 ? (
        <ul className="mb-4 space-y-3">
          {[...comments].reverse().map((c) => (
            <li key={c.id} className="rounded-md border border-zinc-100 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{c.author}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{fmtWhen(c.createdAt)}</span>
                  <button
                    type="button"
                    onClick={() => remove(c.id)}
                    disabled={pending}
                    title="Delete note"
                    aria-label="Delete note"
                    className="text-[10px] text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
                  >
                    ✕
                  </button>
                </span>
              </div>
              <p className="mt-1 whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-200">{c.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-zinc-400 dark:text-zinc-500">
          No notes yet — add context here (e.g. a redirect or test you spotted in Clarity) so the next person sees the why behind the numbers.
        </p>
      )}

      <form onSubmit={post} className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Your name"
            suppressHydrationWarning
            disabled={pending}
            className="w-40 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
          />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note about this page…"
          rows={2}
          disabled={pending}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || !text.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Add note
          </button>
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </form>
    </section>
  );
}
