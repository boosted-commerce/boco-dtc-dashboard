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

// Diagnostic: returns the raw breakdowns response from Northbeam so we
// can inspect the actual shape before committing to a parser. Used by
// /api/northbeam/test.
export async function rawBreakdowns(
  brand: Brand,
  period: Period,
): Promise<{
  ok: boolean;
  status?: number;
  endpoint?: string;
  requestBody?: unknown;
  body?: unknown;
  error?: string;
}> {
  const creds = getNorthbeamCredentials(brand);
  if (!creds) return { ok: false, error: `No Northbeam credentials for ${brand}` };

  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - period);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // Best guess at Northbeam's v2 exports/breakdowns shape. If this 404s
  // or 400s, we'll iterate on the request body based on the error
  // response — that's the point of this diagnostic.
  const endpoint = `${NORTHBEAM_API_BASE}/v2/exports/breakdowns`;
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

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Data-Client-ID': creds.clientId,
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      cache: 'no-store',
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep as text */ }
    return { ok: res.ok, status: res.status, endpoint, requestBody, body };
  } catch (err) {
    return {
      ok: false,
      endpoint,
      requestBody,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
