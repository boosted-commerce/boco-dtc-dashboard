import { type NextRequest } from 'next/server';
import { execute } from '@/lib/snowflake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Locate tables/columns by keyword to find where (store-level) session
// data is stored. /api/debug/find-tables?q=session&db=DW_ANALYTICS
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const q = (sp.get('q') ?? 'session').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const db = (sp.get('db') ?? 'DW_ANALYTICS').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  try {
    const tables = await execute(
      `SELECT TABLE_SCHEMA, TABLE_NAME, ROW_COUNT
       FROM ${db}.INFORMATION_SCHEMA.TABLES
       WHERE TABLE_NAME ILIKE '%${q}%'
       ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 100`,
    );
    const columns = await execute(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
       FROM ${db}.INFORMATION_SCHEMA.COLUMNS
       WHERE COLUMN_NAME ILIKE '%${q}%'
       ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 200`,
    );
    return Response.json({ db, q, tableMatches: tables, columnMatches: columns });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
