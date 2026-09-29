import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// This file runs directly under Node (`node src/migrate.ts`, using Node 24's
// type stripping), so it imports only packages and Node builtins, and uses no
// TypeScript syntax that needs transforming (such as enums).

/** The committed SQL migrations and `meta/_journal.json`, written by `drizzle-kit generate`. */
export const migrationsFolder = path.join(import.meta.dirname, "..", "migrations");

/**
 * Key for the session-level advisory lock that serializes migration runs.
 * Drizzle's migrator takes no lock of its own, so two deployments building at
 * once could otherwise apply the same migration twice. The value is arbitrary
 * but must never change: a migrator using a different key would not wait for
 * one using the old key.
 */
export const MIGRATION_LOCK_KEY = "7264193851066320745";

/**
 * Applies every pending migration in `migrationsFolder`.
 *
 * `connectionString` must be a direct (unpooled) connection. Session-level
 * advisory locks do not work through PgBouncer in transaction mode, which is
 * how Neon's pooled URL runs. The lock is released when the session ends, so a
 * crashed run cannot leave it held.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client, casing: "snake_case" }), { migrationsFolder });
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL_UNPOOLED;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL_UNPOOLED is not set; it must be a direct Postgres connection URL.",
    );
  }
  await runMigrations(connectionString);
  console.log("migrations applied");
}
