import pg from "pg";
import { env } from "./env.js";

// A single pool for the process. Postgres runs in a sibling container on the
// same host, so connections are cheap, but an unbounded pool under load still
// exhausts the server's max_connections and takes the database down with it.
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  // An idle client failing is not fatal — the pool replaces it — but it must
  // be visible, because a stream of these means the database is unhealthy.
  console.error("[db] idle client error:", err.message);
});

/** Any object shape a query can return. Deliberately not an index signature:
 *  requiring one would force every result interface to widen. */
export type Row = object;

/**
 * Runs a parameterised query.
 *
 * `text` must always be a literal with $1/$2 placeholders. String-built SQL
 * is the one thing this module exists to prevent: every user-supplied value
 * travels in `params`, never in the statement.
 */
export async function query<T extends Row = Row>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params as unknown[]);
  return result.rows;
}

/** Runs a query expected to return at most one row. */
export async function queryOne<T extends Row = Row>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Used wherever a partial write would leave the account in a state the user
 * cannot reach or repair — account deletion, publishing, quota release.
 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[db] rollback failed:", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}
