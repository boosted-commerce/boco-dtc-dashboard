import snowflake, { type Connection } from 'snowflake-sdk';

type Bind = string | number | boolean | null;

declare global {
  // eslint-disable-next-line no-var
  var __snowflakeConnection: Promise<Connection> | undefined;
}

function createConnection(): Promise<Connection> {
  const connection = snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT!,
    username: process.env.SNOWFLAKE_USERNAME!,
    password: process.env.SNOWFLAKE_PASSWORD!,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA,
  });
  return new Promise((resolve, reject) => {
    connection.connect((err, conn) => {
      if (err) reject(err);
      else resolve(conn);
    });
  });
}

function getConnection(): Promise<Connection> {
  if (!globalThis.__snowflakeConnection) {
    globalThis.__snowflakeConnection = createConnection().catch((err) => {
      globalThis.__snowflakeConnection = undefined;
      throw err;
    });
  }
  return globalThis.__snowflakeConnection;
}

export async function execute<T = Record<string, unknown>>(
  sqlText: string,
  binds?: Bind[],
): Promise<T[]> {
  const connection = await getConnection();
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      // @types/snowflake-sdk's Binds type is overly narrow; cast and move on.
      binds: binds as unknown as snowflake.Binds | undefined,
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve((rows ?? []) as T[]);
      },
    });
  });
}
