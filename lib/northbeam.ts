import type { Brand, Period } from '@/lib/queries/orders';

// Northbeam Data Export API client. Per-brand credentials in
// Vercel env vars: NORTHBEAM_CLIENT_ID_<BRAND>, NORTHBEAM_API_KEY_<BRAND>.
//
// Endpoints documented at:
//   https://docs.northbeam.io/docs/northbeam-api-data-export-1
//
// The data export is async: POST kicks off a job (returns id), then
// poll GET /result/<id> until the export is ready.

const NORTHBEAM_API_BASE = 'https://api.northbeam.io';

type NorthbeamCreds = { clientId: string; apiKey: string };

function getNorthbeamCredentials(brand: Brand): NorthbeamCreds | null {
  const clientId = process.env[`NORTHBEAM_CLIENT_ID_${brand}`];
  const apiKey = process.env[`NORTHBEAM_API_KEY_${brand}`];
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

function authHeaders(creds: NorthbeamCreds): Record<string, string> {
  return {
    'Data-Client-ID': creds.clientId,
    // Per Northbeam docs: "Authorization: Basic <api_key>" — the literal
    // string "Basic " plus the raw key, NOT a base64-encoded user:pass.
    Authorization: `Basic ${creds.apiKey}`,
    Accept: 'application/json',
  };
}

// Diagnostic: hits the three sync GET endpoints (metrics, attribution
// models, breakdowns) so we can confirm auth works and see exactly
// what fields are askable for in a subsequent data-export POST. Used
// by /api/northbeam/test.
export async function probeDataExport(
  brand: Brand,
  _period: Period,
): Promise<{
  attempts: {
    endpoint: string;
    status: number | 'error';
    body: unknown;
  }[];
  error?: string;
}> {
  const creds = getNorthbeamCredentials(brand);
  if (!creds) return { attempts: [], error: `No Northbeam credentials for ${brand}` };

  const headers = authHeaders(creds);
  const endpoints = [
    `${NORTHBEAM_API_BASE}/v1/exports/metrics`,
    `${NORTHBEAM_API_BASE}/v1/exports/attribution-models`,
    `${NORTHBEAM_API_BASE}/v1/exports/breakdowns`,
  ];

  const attempts = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const res = await fetch(endpoint, { method: 'GET', headers, cache: 'no-store' });
        const text = await res.text();
        let body: unknown = text.slice(0, 2000);
        try { body = JSON.parse(text); } catch { /* keep text */ }
        return { endpoint, status: res.status, body };
      } catch (err) {
        return {
          endpoint,
          status: 'error' as const,
          body: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return { attempts };
}
