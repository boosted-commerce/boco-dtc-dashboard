import { execute } from '@/lib/snowflake';
import { withCache } from '@/lib/cache';
import type { Brand, Period } from '@/lib/queries/orders';

// Reads from BOCO_DASHBOARD.NORTHBEAM.DAILY_CHANNEL_METRICS (daily
// snapshots written by scripts/sync-northbeam.mjs).
//
// Aggregates current-period vs prior-period sums per platform. Filters
// to platforms with spend > 0 in either window so organic-only rows
// (Facebook Organic, etc.) don't clutter the paid-attribution panel.

export type NorthbeamChannelRow = {
  platform: string;
  spend: number;
  revAttributed: number;
  roas: number | null; // null when spend = 0
  newVisits: number;
  priorSpend: number;
  priorRevAttributed: number;
  priorRoas: number | null;
};

export type NorthbeamSummary = {
  channels: NorthbeamChannelRow[];
  totalSpend: number;
  totalRevAttributed: number;
  totalRoas: number | null;
  totalNewVisits: number;
  priorTotalSpend: number;
  priorTotalRevAttributed: number;
  priorTotalRoas: number | null;
};

type Row = {
  PLATFORM: string;
  CUR_SPEND: string;
  CUR_REV: string;
  CUR_VISITS: string;
  PRIOR_SPEND: string;
  PRIOR_REV: string;
};

const n = (v: string | number | null | undefined): number => {
  if (v == null || v === '') return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

export async function getNorthbeamSummary(
  brand: Brand,
  period: Period,
): Promise<NorthbeamSummary | null> {
  return withCache(`northbeam:${brand}:${period}:v1`, 30 * 60, () =>
    getNorthbeamSummaryUncached(brand, period),
  );
}

async function getNorthbeamSummaryUncached(
  brand: Brand,
  period: Period,
): Promise<NorthbeamSummary | null> {
  const rows = await execute<Row>(
    `
      WITH cur AS (
        SELECT
          PLATFORM,
          SUM(SPEND)          AS CUR_SPEND,
          SUM(REV_ATTRIBUTED) AS CUR_REV,
          SUM(NEW_VISITS)     AS CUR_VISITS
        FROM BOCO_DASHBOARD.NORTHBEAM.DAILY_CHANNEL_METRICS
        WHERE BRAND = ?
          AND PLATFORM NOT ILIKE '%amazon%'
          AND SNAPSHOT_DATE >= DATEADD(day, -?, CURRENT_DATE())
          AND SNAPSHOT_DATE < CURRENT_DATE()
        GROUP BY PLATFORM
      ),
      prior AS (
        SELECT
          PLATFORM,
          SUM(SPEND)          AS PRIOR_SPEND,
          SUM(REV_ATTRIBUTED) AS PRIOR_REV
        FROM BOCO_DASHBOARD.NORTHBEAM.DAILY_CHANNEL_METRICS
        WHERE BRAND = ?
          AND PLATFORM NOT ILIKE '%amazon%'
          AND SNAPSHOT_DATE >= DATEADD(day, -?, CURRENT_DATE())
          AND SNAPSHOT_DATE <  DATEADD(day, -?, CURRENT_DATE())
        GROUP BY PLATFORM
      )
      SELECT
        COALESCE(cur.PLATFORM, prior.PLATFORM) AS PLATFORM,
        COALESCE(cur.CUR_SPEND,   0) AS CUR_SPEND,
        COALESCE(cur.CUR_REV,     0) AS CUR_REV,
        COALESCE(cur.CUR_VISITS,  0) AS CUR_VISITS,
        COALESCE(prior.PRIOR_SPEND, 0) AS PRIOR_SPEND,
        COALESCE(prior.PRIOR_REV,   0) AS PRIOR_REV
      FROM cur FULL OUTER JOIN prior
        ON cur.PLATFORM = prior.PLATFORM
      WHERE COALESCE(cur.CUR_SPEND, 0) + COALESCE(prior.PRIOR_SPEND, 0) > 0
      ORDER BY CUR_SPEND DESC
    `,
    [brand, period, brand, period * 2, period],
  );

  if (rows.length === 0) return null;

  const channels: NorthbeamChannelRow[] = rows.map((r) => {
    const spend = n(r.CUR_SPEND);
    const rev = n(r.CUR_REV);
    const priorSpend = n(r.PRIOR_SPEND);
    const priorRev = n(r.PRIOR_REV);
    return {
      platform: r.PLATFORM,
      spend,
      revAttributed: rev,
      roas: spend > 0 ? rev / spend : null,
      newVisits: n(r.CUR_VISITS),
      priorSpend,
      priorRevAttributed: priorRev,
      priorRoas: priorSpend > 0 ? priorRev / priorSpend : null,
    };
  });

  const totalSpend = channels.reduce((s, c) => s + c.spend, 0);
  const totalRev = channels.reduce((s, c) => s + c.revAttributed, 0);
  const priorTotalSpend = channels.reduce((s, c) => s + c.priorSpend, 0);
  const priorTotalRev = channels.reduce((s, c) => s + c.priorRevAttributed, 0);

  return {
    channels,
    totalSpend,
    totalRevAttributed: totalRev,
    totalRoas: totalSpend > 0 ? totalRev / totalSpend : null,
    totalNewVisits: channels.reduce((s, c) => s + c.newVisits, 0),
    priorTotalSpend,
    priorTotalRevAttributed: priorTotalRev,
    priorTotalRoas: priorTotalSpend > 0 ? priorTotalRev / priorTotalSpend : null,
  };
}
