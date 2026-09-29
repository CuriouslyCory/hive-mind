import { createDb, type Db } from "@hivemind/db";
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { env } from "../env";

let db: Db | undefined;

/**
 * The app's Drizzle client, over a `pg` pool on the pooled `DATABASE_URL`.
 *
 * The pool is created on first call, not at import, so `next build` can
 * evaluate modules that import this one without database credentials.
 * `attachDatabasePool` keeps a Vercel Fluid compute instance alive until the
 * pool has closed its idle connections, so suspended instances don't leak them.
 *
 * The pooler runs PgBouncer in transaction mode, so code using this client
 * cannot rely on `LISTEN` or session-level advisory locks.
 */
export function getDb(): Db {
  if (!db) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
    attachDatabasePool(pool);
    db = createDb(pool);
  }
  return db;
}
