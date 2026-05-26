import { execute } from '@/lib/snowflake';
import type { Brand } from '@/lib/queries/orders';

// Reads from BOCO_DASHBOARD.PROMOS.PROMOS (daily-synced from the
// SharePoint promo sheet by scripts/sync-promos.mjs).
//
// "Active" = today is between START_DATE and END_DATE inclusive. We
// also surface promos that ended within the last 7 days (so the team
// can spot a "we just ended a sale" effect in metrics) and ones that
// start within the next 7 days (so they can pre-flight messaging).

export type Promo = {
  brand: string;
  name: string;
  description: string | null;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  code: string | null;
  discountType: string | null;
  appliesTo: string | null;
  /** -1 = upcoming, 0 = active, 1 = recently ended (within last 7d) */
  state: 'upcoming' | 'active' | 'recent';
};

type Row = {
  BRAND: string;
  PROMO_NAME: string;
  PROMO_DESCRIPTION: string | null;
  START_DATE: string;
  END_DATE: string;
  PROMO_CODE: string | null;
  DISCOUNT_TYPE: string | null;
  APPLIES_TO: string | null;
};

const fmtDate = (raw: string | null): string => {
  if (!raw) return '';
  // Snowflake returns dates as YYYY-MM-DD already; defend against any
  // trailing time component just in case.
  return String(raw).slice(0, 10);
};

// Wider query for sparkline annotations: returns every promo whose
// window overlaps the last `days` days. Used to render vertical
// markers on Layer 1 sparklines so metric shifts can be visually
// correlated with promos that ran during the chart's window.
export async function getPromosInWindow(brand: Brand, days: number): Promise<Promo[]> {
  const rows = await execute<Row>(
    `
      SELECT
        BRAND, PROMO_NAME, PROMO_DESCRIPTION,
        TO_VARCHAR(START_DATE, 'YYYY-MM-DD') AS START_DATE,
        TO_VARCHAR(END_DATE,   'YYYY-MM-DD') AS END_DATE,
        PROMO_CODE, DISCOUNT_TYPE, APPLIES_TO
      FROM BOCO_DASHBOARD.PROMOS.PROMOS
      WHERE BRAND = ?
        AND END_DATE   >= DATEADD(day, -?, CURRENT_DATE())
        AND START_DATE <= CURRENT_DATE()
      ORDER BY START_DATE
    `,
    [brand, days],
  );
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => {
    const start = fmtDate(r.START_DATE);
    const end = fmtDate(r.END_DATE);
    const state: Promo['state'] = start > today ? 'upcoming' : end < today ? 'recent' : 'active';
    return {
      brand: r.BRAND,
      name: r.PROMO_NAME,
      description: r.PROMO_DESCRIPTION || null,
      startDate: start,
      endDate: end,
      code: r.PROMO_CODE || null,
      discountType: r.DISCOUNT_TYPE || null,
      appliesTo: r.APPLIES_TO || null,
      state,
    };
  });
}

export async function getActivePromos(brand: Brand): Promise<Promo[]> {
  const rows = await execute<Row>(
    `
      SELECT
        BRAND, PROMO_NAME, PROMO_DESCRIPTION,
        TO_VARCHAR(START_DATE, 'YYYY-MM-DD') AS START_DATE,
        TO_VARCHAR(END_DATE,   'YYYY-MM-DD') AS END_DATE,
        PROMO_CODE, DISCOUNT_TYPE, APPLIES_TO
      FROM BOCO_DASHBOARD.PROMOS.PROMOS
      WHERE BRAND = ?
        AND START_DATE <= DATEADD(day,  7, CURRENT_DATE())  -- include upcoming within 7d
        AND END_DATE   >= DATEADD(day, -7, CURRENT_DATE())  -- include recently ended within 7d
      ORDER BY START_DATE
    `,
    [brand],
  );

  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => {
    const start = fmtDate(r.START_DATE);
    const end = fmtDate(r.END_DATE);
    let state: Promo['state'] = 'active';
    if (start > today) state = 'upcoming';
    else if (end < today) state = 'recent';
    return {
      brand: r.BRAND,
      name: r.PROMO_NAME,
      description: r.PROMO_DESCRIPTION || null,
      startDate: start,
      endDate: end,
      code: r.PROMO_CODE || null,
      discountType: r.DISCOUNT_TYPE || null,
      appliesTo: r.APPLIES_TO || null,
      state,
    };
  });
}
