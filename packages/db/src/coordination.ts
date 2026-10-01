import { sql } from "drizzle-orm";
import type { Db } from "./index.ts";

// The transaction every M2 coordination mutation runs in (issue #12,
// "Transaction, identity and Event invariants"; ADR-0014).
//
// Each one takes a transaction-level advisory lock for its Project before it
// reads any mutable coordination record, so a Project's claims, heartbeats,
// sweeps and multi-record updates run one at a time and see each other's
// committed results. This is a deliberate throughput limit: every coordination
// write in a Project waits for the one before it, which is fine for the
// handful of concurrent agents of initial dogfooding and avoids several
// competing row-lock orders. Different Projects proceed independently. Two
// Projects whose ids hash alike share a lock, which only serializes them.
//
// While holding the lock, do database work only: no network, git, embedding
// or auth-plugin calls.

/** A Drizzle transaction from `db.transaction`. */
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * First key of the two-key advisory lock form, `pg_advisory_xact_lock(int4,
 * int4)`; the second is `hashtext(project_id::text)`. The value ("HM2C" in
 * ASCII) is arbitrary but must never change: a writer using another value
 * would not wait for one using this. The two-key form occupies a different
 * key space from the single-bigint form used by the migrator (src/migrate.ts)
 * and the personal-organization lock (apps/web/src/server/auth.ts), so it
 * cannot collide with them.
 */
export const COORDINATION_LOCK_NAMESPACE = 0x484d3243;

export interface CoordinationContext {
  tx: Transaction;
  /**
   * Database time, read once with `clock_timestamp()` after the lock was
   * acquired and truncated to milliseconds so it round-trips through a
   * JavaScript Date exactly. Use it for every timestamp the transaction writes
   * or compares (heartbeats, leases, eligibility), never `now()` (the
   * transaction's start, before the lock wait) or the application's clock.
   */
  now: Date;
}

const lockStatement = (projectId: string) =>
  sql`select pg_advisory_xact_lock(${COORDINATION_LOCK_NAMESPACE}::int4, hashtext(${projectId}::uuid::text))`;

const tryLockStatement = (projectId: string) =>
  sql`select pg_try_advisory_xact_lock(${COORDINATION_LOCK_NAMESPACE}::int4, hashtext(${projectId}::uuid::text)) as acquired`;

async function readNow(tx: Transaction): Promise<Date> {
  // Epoch milliseconds, since Drizzle's driver session returns timestamps
  // from raw SQL as text in the server's format.
  const result = await tx.execute<{ ms: string }>(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as ms`,
  );
  const ms = Number(result.rows[0]?.ms);
  if (!Number.isSafeInteger(ms)) throw new Error("clock_timestamp() returned no time.");
  return new Date(ms);
}

/**
 * Runs `fn` in a new transaction holding the Project's coordination lock.
 * The lock is released when the transaction commits or rolls back; if `fn`
 * throws, nothing it wrote (state or Events) is kept.
 *
 * The transaction uses the default READ COMMITTED isolation, which this
 * relies on: each statement after the lock wait sees what earlier lock
 * holders committed. Under REPEATABLE READ the snapshot would predate the
 * wait. `db` must be the client, not a transaction, so the lock is held only
 * as long as this unit of work. An invalid UUID fails the lock statement.
 */
export async function withCoordinationLock<T>(
  db: Db,
  projectId: string,
  fn: (context: CoordinationContext) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(lockStatement(projectId));
    const now = await readNow(tx);
    return fn({ tx, now });
  });
}

export type TryCoordinationLockResult<T> =
  | { acquired: true; result: T }
  /** Another transaction holds the Project's lock; nothing ran. */
  | { acquired: false };

/**
 * Like `withCoordinationLock`, but returns `{ acquired: false }` at once if
 * another transaction holds the Project's lock, instead of waiting. For the
 * sweep, which skips a busy Project and leaves it eligible for a later run.
 */
export async function tryWithCoordinationLock<T>(
  db: Db,
  projectId: string,
  fn: (context: CoordinationContext) => Promise<T>,
): Promise<TryCoordinationLockResult<T>> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ acquired: boolean }>(tryLockStatement(projectId));
    if (lock.rows[0]?.acquired !== true) return { acquired: false };
    const now = await readNow(tx);
    return { acquired: true, result: await fn({ tx, now }) };
  });
}

/**
 * Allocates the Project's next Plan number (the N of PLAN-N) and returns it.
 * Call it inside `withCoordinationLock`; the update is atomic regardless, and
 * a rolled-back transaction gives the number back. Written in raw SQL so the
 * Project's updated_at, which its DTO shows, is left alone.
 */
export async function allocatePlanNumber(tx: Transaction, projectId: string): Promise<number> {
  const result = await tx.execute<{ number: number }>(sql`
    update project set next_plan_number = next_plan_number + 1
    where id = ${projectId}
    returning next_plan_number - 1 as number
  `);
  const number = result.rows[0]?.number;
  if (number === undefined) throw new Error(`Project ${projectId} does not exist.`);
  return number;
}
