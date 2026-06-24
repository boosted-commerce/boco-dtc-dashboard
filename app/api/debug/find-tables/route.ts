import { type NextRequest } from 'next/server';
import { execute } from '@/lib/snowflake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Catalog search + table inspector.
//   /api/debug/find-tables?q=session[&db=DW_ANALYTICS]
//   /api/debug/find-tables?table=FACT.SHOPIFY_CONVERSION_ANALYTICS  (cols + sample)
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const db = (sp.get('db') ?? 'DW_ANALYTICS').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const table = sp.get('table');
  try {
    if (table) {
      const safe = table.toUpperCase().replace(/[^A-Z0-9_.]/g, '');
      const [schema, name] = safe.split('.');
      const columns = await execute(
        `SELECT COLUMN_NAME, DATA_TYPE FROM ${db}.INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${name}' ORDER BY ORDINAL_POSITION`,
      );
      const sample = await execute(
        `WITH x AS (SELECT * FROM ${db}.${schema}.${name} LIMIT 2) SELECT OBJECT_CONSTRUCT(*) AS OBJ FROM x`,
      );
      return Response.json({ db, table: safe, columns, sample });
    }
    const q = (sp.get('q') ?? 'session').toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const tableMatches = await execute(
      `SELECT TABLE_SCHEMA, TABLE_NAME FROM ${db}.INFORMATION_SCHEMA.TABLES
       WHERE TABLE_NAME ILIKE '%${q}%' ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 100`,
    );
    const columnMatches = await execute(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM ${db}.INFORMATION_SCHEMA.COLUMNS
       WHERE COLUMN_NAME ILIKE '%${q}%' ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 200`,
    );
    return Response.json({ db, q, tableMatches, columnMatches });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
