import type { Brand, Period } from '@/lib/queries/orders';

// Northbeam Customer/Exports API client. Per-brand credentials in
// Vercel env vars: NORTHBEAM_CLIENT_ID_<BRAND>, NORTHBEAM_API_KEY_<BRAND>.
//
// All returns are tolerant of missing creds or upstream errors — they
// yield empty arrays so the dashboard renders with "—" placeholders
// instead of 500-ing the page.

const NORTHBEAM_API_BASE = 'https://api.northbeam.io';

type NorthbeamCreds = { clientId: string; apiKey: string };

function getNorthbeamCredentials(brand: Brand): NorthbeamCreds | null {
  const clientId = process.env[`NORTHBEAM_CLIENT_ID_${brand}`];
  const apiKey = process.env[`NORTHBEAM_API_KEY_${brand}`];
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

// Diagnostic: probes multiple candidate Northbeam endpoint URLs +
// auth header conventions in parallel so we narrow down the correct
// shape on the first call. Used by /api/northbeam/test.
export async function rawBreakdowns(
  brand: Brand,
  period: Period,
): Promise<{
  attempts: {
    endpoint: string;
    authStyle: string;
    status: number | 'error';
    body: unknown;
  }[];
  error?: string;
}> {
  const creds = getNorthbeamCredentials(brand);
  if (!creds) return { attempts: [], error: `No Northbeam credentials for ${brand}` };

  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - period);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const requestBody = {
    period_type: 'FIXED',
    period_options: {
      period_starting_at: `${fmt(start)}T00:00:00Z`,
      period_ending_at: `${fmt(now)}T23:59:59Z`,
    },
    breakdowns: ['platform'],
    options: {
      attribution_models: ['northbeam_mta'],
      accounting_modes: ['accrual'],
      include_kinds: ['paid'],
    },
    metrics: [
      { name: 'spend' },
      { name: 'attributed_rev' },
      { name: 'roas' },
      { name: 'transactions' },
      { name: 'new_visits' },
    ],
  };

  // Candidate (endpoint, auth-header) combos to probe in parallel.
  // First one to return ok=true tells us the real shape.
  const candidates: { endpoint: string; headers: () => Record<string, string>; authStyle: string }[] = [
    {
      endpoint: `${NORTHBEAM_API_BASE}/v1/exports/breakdowns`,
      headers: () => ({ 'Data-Client-ID': creds.clientId, Authorization: `Bearer ${creds.apiKey}` }),
      authStyle: 'Bearer + Data-Client-ID',
    },
    {
      endpoint: `${NORTHBEAM_API_BASE}/v2/data-export/breakdowns`,
      headers: () => ({ 'Data-Client-ID': creds.clientId, Authorization: `Bearer ${creds.apiKey}` }),
      authStyle: 'Bearer + Data-Client-ID',
    },
    {
      endpoint: `${NORTHBEAM_API_BASE}/v1/breakdowns`,
      headers: () => ({ 'Data-Client-ID': creds.clientId, Authorization: `Bearer ${creds.apiKey}` }),
      authStyle: 'Bearer + Data-Client-ID',
    },
    {
      endpoint: `${NORTHBEAM_API_BASE}/v2/exports/breakdowns`,
      headers: () => ({ 'Data-Client-ID': creds.clientId, 'Authorization': creds.apiKey }),
      authStyle: 'raw key (no Bearer)',
    },
  ];

  const attempts = await Promise.all(
    candidates.map(async ({ endpoint, headers, authStyle }) => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify(requestBody),
          cache: 'no-store',
        });
        const text = await res.text();
        let body: unknown = text.slice(0, 500); // cap to keep diag readable
        try { body = JSON.parse(text); } catch { /* keep as truncated text */ }
        return { endpoint, authStyle, status: res.status, body };
      } catch (err) {
        return {
          endpoint,
          authStyle,
          status: 'error' as const,
          body: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return { attempts };
}
