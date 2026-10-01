import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import pg from "pg";
import { withCoordinationLock } from "../../src/coordination.ts";
import { createDb, type Db } from "../../src/index.ts";
import type { Principal } from "../../src/principal.ts";
import { agentSession, task } from "../../src/schema/coordination.ts";
import { event } from "../../src/schema/event.ts";
import type { TestDatabase } from "../../src/testing/harness.ts";
import { insertPlan, insertProject, insertSession, insertTask } from "./fixtures.ts";

// Helpers for the lifecycle, claim and sweep tests. Times are set relative to
// the database clock, never by sleeping.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** The database's current time, truncated to milliseconds like `CoordinationContext.now`. */
export async function dbNow(db: Db): Promise<Date> {
  const result = await db.execute<{ ms: string }>(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as ms`,
  );
  return new Date(Number(result.rows[0]?.ms));
}

export function ago(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

export function later(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

/** A Project with a User principal, an active Plan and one Task. */
export async function setupProject(db: Db) {
  const { project, user, organization } = await insertProject(db);
  const principal: Principal = { kind: "user", userId: user.id };
  const plan = await insertPlan(db, project.id, principal);
  const firstTask = await insertTask(db, project.id, plan.id, principal);
  return { project, user, organization, principal, plan, task: firstTask };
}

/** A Session whose last heartbeat was `age` ago in database time. */
export async function sessionAged(
  db: Db,
  projectId: string,
  principal: Principal,
  age: number,
  overrides: Parameters<typeof insertSession>[3] = {},
) {
  const now = await dbNow(db);
  return insertSession(db, projectId, principal, {
    lastHeartbeatAt: ago(now, age),
    createdAt: ago(now, age),
    ...overrides,
  });
}

/** Stores a claim directly, with its lease `leaseIn` from database now (negative = expired). */
export async function setClaim(db: Db, taskId: string, sessionId: string, leaseIn: number) {
  const now = await dbNow(db);
  await db
    .update(task)
    .set({
      claimedBySessionId: sessionId,
      claimedAt: ago(now, MINUTE),
      leaseExpiresAt: later(now, leaseIn),
    })
    .where(eq(task.id, taskId));
}

export async function eventsOf(db: Db, projectId: string) {
  return db.select().from(event).where(eq(event.projectId, projectId)).orderBy(asc(event.seq));
}

export async function taskRow(db: Db, id: string) {
  const [row] = await db.select().from(task).where(eq(task.id, id));
  if (!row) throw new Error(`no task ${id}`);
  return row;
}

export async function sessionRow(db: Db, id: string) {
  const [row] = await db.select().from(agentSession).where(eq(agentSession.id, id));
  if (!row) throw new Error(`no session ${id}`);
  return row;
}

/** A second User principal. */
export function otherUser(userId: string): Principal {
  return { kind: "user", userId };
}

export function uuid(): string {
  return randomUUID();
}

/** Pools of one connection each, so concurrent operations use separate connections. */
export function onePools(testDb: TestDatabase, count: number) {
  const pools = Array.from(
    { length: count },
    () => new pg.Pool({ connectionString: testDb.url, max: 1 }),
  );
  const dbs = pools.map((pool) => createDb(pool));
  return {
    db(index: number): Db {
      const found = dbs[index];
      if (!found) throw new Error(`no pool ${index}`);
      return found;
    },
    end: () => Promise.all(pools.map((pool) => pool.end())),
  };
}

/** A promise and the function that resolves it. */
export function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * Waits until at least `count` backends of the test database are blocked on
 * a lock: `advisory` (the coordination lock) or, with `any`, any heavyweight
 * lock (advisory, row or transaction).
 */
export async function waitForLockWaiters(
  testDb: TestDatabase,
  count = 1,
  kind: "advisory" | "any" = "advisory",
): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = await testDb.pool.query<{ count: string }>(
      `select count(*) from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'
         and ($1 = 'any' or wait_event = $1)`,
      [kind],
    );
    if (Number(result.rows[0]?.count) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fewer than ${count} connections waited on a ${kind} lock.`);
}

/**
 * Holds the Project's coordination lock on `db` (use its own pool) until
 * `release` is called, so operations started meanwhile queue behind it in
 * the order they were started.
 */
export async function holdProjectLock(db: Db, projectId: string) {
  const held = gate();
  const released = gate();
  const done = withCoordinationLock(db, projectId, async () => {
    held.open();
    await released.opened;
  });
  await held.opened;
  return {
    release: async () => {
      released.open();
      await done;
    },
  };
}
