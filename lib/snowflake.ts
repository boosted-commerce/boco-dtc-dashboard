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
    authenticator: 'SNOWFLAKE_JWT',
    privateKey: process.env.SNOWFLAKE_PRIVATE_KEY!,
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

function runQuery<T>(connection: Connection, sqlText: string, binds?: Bind[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds: binds as unknown as snowflake.Binds | undefined,
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve((rows ?? []) as T[]);
      },
    });
  });
}

const isDeadConnectionError = (err: unknown): boolean => {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('terminated connection') ||
    msg.includes('connection has been terminated') ||
    msg.includes('connection is closed') ||
    msg.includes('socket') // network drop
  );
};

export async function execute<T = Record<string, unknown>>(
  sqlText: string,
  binds?: Bind[],
): Promise<T[]> {
  let connection = await getConnection();
  try {
    return await runQuery<T>(connection, sqlText, binds);
  } catch (err) {
    if (!isDeadConnectionError(err)) throw err;
    // Discard the dead cached connection and reconnect once.
    globalThis.__snowflakeConnection = undefined;
    connection = await getConnection();
    return runQuery<T>(connection, sqlText, binds);
  }
}
