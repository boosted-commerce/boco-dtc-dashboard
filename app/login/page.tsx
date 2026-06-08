import { ALLOWED_DOMAIN, isMicrosoftConfigured, isPasscodeConfigured } from '@/lib/auth';
import { PasscodeForm } from '@/app/_components/passcode-form';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  domain: `That account isn't an @${ALLOWED_DOMAIN} account. Use your Boosted Microsoft account, or enter the passcode below.`,
  state: 'Sign-in expired or was interrupted. Please try again.',
  microsoft: 'Microsoft sign-in failed. Please try again.',
  config: 'Microsoft sign-in isn’t configured yet. Use the passcode.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === 'string' && sp.next.startsWith('/') ? sp.next : '/';
  const errorMsg = sp.error ? ERRORS[sp.error] ?? 'Sign-in failed. Please try again.' : null;
  const microsoftOn = isMicrosoftConfigured();
  const passcodeOn = isPasscodeConfigured();

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">BOCO DTC Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to continue. Boosted accounts get in with Microsoft; others can use the shared passcode.
        </p>

        {errorMsg && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {errorMsg}
          </p>
        )}

        {microsoftOn && (
          <a
            href={`/api/auth/microsoft/start?next=${encodeURIComponent(next)}`}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <span aria-hidden="true">⊞</span>
            Continue with Microsoft
          </a>
        )}

        {microsoftOn && passcodeOn && (
          <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            or
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
        )}

        {passcodeOn ? (
          <div className={microsoftOn ? '' : 'mt-5'}>
            <PasscodeForm next={next} />
          </div>
        ) : (
          !microsoftOn && (
            <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400">
              No sign-in method is configured. Set <code>MS_CLIENT_ID</code>/<code>MS_CLIENT_SECRET</code> or
              {' '}<code>DASHBOARD_PASSCODE</code> in the environment.
            </p>
          )
        )}
      </div>
    </main>
  );
}
