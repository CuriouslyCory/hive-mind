import pg from "pg";

// Imported by migrate.ts, which Node runs directly, so the same rules apply
// here: only packages and Node builtins, and only erasable TypeScript syntax.

/**
 * Creates a `pg` pool that survives Postgres closing one of its idle
 * connections.
 *
 * Connections sitting idle in the pool can be closed from the server side at
 * any time: Neon ends idle connections and suspends its compute, PgBouncer and
 * failovers drop them, and the browser tests force-drop the app's database.
 * pg-pool then removes the dead client (the next query opens a new connection)
 * and emits `error` on the pool. An `error` event without a listener is thrown
 * as an uncaughtException, which kills the whole server, so every pool gets a
 * listener that only logs.
 */
export function createPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on("error", (error) => {
    console.error(
      `Postgres closed an idle pooled connection; the pool discarded it. ${describeConnectionError(error)}`,
    );
  });
  return pool;
}

/**
 * Creates a single `pg` client (not yet connected) that does not crash the
 * process if its connection is lost.
 *
 * On an unexpected disconnect pg fails the query in flight, and every later
 * one, and also emits `error` on the client. The failed query is what the
 * caller sees and handles; the event would only be an uncaughtException, so
 * it is logged instead.
 */
export function createClient(config: pg.ClientConfig): pg.Client {
  const client = new pg.Client(config);
  client.on("error", (error) => {
    console.error(`Lost a Postgres connection. ${describeConnectionError(error)}`);
  });
  return client;
}

/**
 * The parts of a connection error that are safe to log: its code (a Postgres
 * SQLSTATE such as 57P01, or a Node code such as ECONNRESET) and its message.
 * Never log the error object itself: pg-pool attaches the client to it, and
 * the client holds the connection parameters, password included.
 */
export function describeConnectionError(error: Error): string {
  const code = "code" in error && typeof error.code === "string" ? error.code : "no code";
  return `(${code}) ${error.message}`;
}

/**
 * A loggable description of any thrown value: `describeConnectionError` for
 * an Error and for the Error it wraps (Drizzle wraps pg's in `cause`), never
 * the object itself, which for pg can carry connection parameters.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown failure";
  const { cause } = error;
  const described = describeConnectionError(error);
  return cause instanceof Error
    ? `${described}; cause: ${describeConnectionError(cause)}`
    : described;
}
