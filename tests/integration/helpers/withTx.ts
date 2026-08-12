// ============================================================
// withTx — Transactional Savepoint Helper (Layer A Isolation)
// ============================================================
// Wraps a test callback in a Postgres transaction with a savepoint.
// All DB writes made inside the callback are rolled back when it
// completes (or throws), leaving the DB state unchanged.
//
// WHEN TO USE:
//   Layer A is the fastest isolation strategy (~2ms overhead).
//   Use it when:
//     • The test code uses a pg.PoolClient directly (e.g. via the
//       client argument passed to the callback).
//     • You're testing helper functions or SQL queries that accept
//       a connection parameter.
//
// WHEN NOT TO USE:
//   Layer A cannot catch writes made by Server Actions, because
//   Server Actions use the Supabase JS client which manages its
//   own connection pool. Writes on a separate connection are
//   invisible to this transaction until committed.
//
//   For Server Action tests, use Layer B (truncate.ts afterEach)
//   or Layer C (supabase db reset between suite files in CI).
//
// NOTE ON SERIAL EXECUTION:
//   Integration tests run with fileParallelism: false (one file at
//   a time). withTx's pool is sized accordingly (max: 3).
//   The pool captures this comment's context: singleFork is NOT
//   a Vitest 4.x option; fileParallelism: false achieves the same.
//
// USAGE:
//   import { withTx } from "../helpers/withTx";
//
//   it("inserts and reads in the same connection", async () => {
//     await withTx(async (db) => {
//       await db.query("INSERT INTO profiles ...");
//       const { rows } = await db.query("SELECT * FROM profiles WHERE ...");
//       expect(rows).toHaveLength(1);
//       // All writes rolled back after this callback returns.
//     });
//   });
// ============================================================

import pg from "pg";

// Lazy singleton pool — created on first withTx() call.
// Closed automatically when the process exits.
let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "[withTx] DATABASE_URL is not set.\n" +
          "Add it to tests/integration/.env:\n" +
          "  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres"
      );
    }
    _pool = new pg.Pool({
      connectionString,
      // Single connection is intentional — tests run serially
      // (singleFork: true) and we only ever need one savepoint scope.
      max: 3,
      idleTimeoutMillis: 10_000,
    });

    // Clean up when the worker process exits
    process.on("exit", () => {
      _pool?.end().catch(() => {});
    });
  }
  return _pool;
}

/**
 * Runs `fn` inside a Postgres savepoint transaction.
 * All writes made by `fn` via the provided client are rolled back
 * when `fn` completes (whether it resolves or rejects).
 *
 * @param fn - Test callback that receives a connected pg.PoolClient.
 *             Use this client for all DB operations you want rolled back.
 * @returns The value returned by `fn` (useful for assertions).
 */
export async function withTx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SAVEPOINT integration_test");

    let result: T;
    try {
      result = await fn(client);
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT integration_test");
      await client.query("ROLLBACK");
      throw err;
    }

    // Always roll back regardless of test outcome — isolation is the point.
    await client.query("ROLLBACK TO SAVEPOINT integration_test");
    await client.query("ROLLBACK");

    return result;
  } finally {
    client.release();
  }
}

/**
 * Runs a single statement OUTSIDE any transaction, so the write COMMITS and is
 * therefore visible to Server Actions — which use the Supabase JS client on its
 * own connection pool and cannot see anything withTx does.
 *
 * This is the escape hatch for the few columns the typed Supabase client refuses
 * to write. `matches.created_at` is not in `MatchUpdate` (by design — nothing in
 * the app backdates a row), and backdating it is the only way to age a held
 * cross-court draft past CROSS_COURT_MAX_HOLD_MINUTES without faking the clock
 * for the server action under test.
 *
 * Writes to tables on truncate.ts's list are cleaned up by Layer B
 * (truncateTracked in afterEach), exactly like the factories' writes. That list
 * is fixed and does not cover the whole schema, and it deliberately preserves
 * the bootstrap rows — so a write outside it survives the test and is yours to
 * undo.
 *
 * ⚠️ Not an isolation helper — it is the opposite of withTx. Reach for withTx
 * first; use this only when the write must survive the callback.
 */
export async function queryCommitted(
  text: string,
  params: unknown[] = []
): Promise<pg.QueryResult> {
  return getPool().query(text, params);
}

/**
 * Closes the shared pg.Pool. Call this in a globalTeardown if
 * you want clean shutdown rather than relying on process exit.
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
