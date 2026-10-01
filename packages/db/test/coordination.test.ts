import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  allocatePlanNumber,
  type Transaction,
  tryWithCoordinationLock,
  withCoordinationLock,
} from "../src/coordination.ts";
import { type CreationRequest, createOnce } from "../src/creation.ts";
import { insertEvent } from "../src/event.ts";
import { creationFingerprint } from "../src/fingerprint.ts";
import { createDb, type Db } from "../src/index.ts";
import { creatorColumns, type Principal, sessionOwnerColumns } from "../src/principal.ts";
import { agentSession, plan } from "../src/schema/coordination.ts";
import { event } from "../src/schema/event.ts";
import { project } from "../src/schema/project.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertPlan, insertProject, insertUser } from "./support/fixtures.ts";

let testDb: TestDatabase;
/** Pools of one connection each, so concurrent transactions use separate connections. */
let pools: pg.Pool[];
let dbs: Db[];

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
  pools = Array.from({ length: 8 }, () => new pg.Pool({ connectionString: testDb.url, max: 1 }));
  dbs = pools.map((pool) => createDb(pool));
});

afterAll(async () => {
  await Promise.all((pools ?? []).map((pool) => pool.end()));
  await testDb?.drop();
});

function db(index: number): Db {
  const found = dbs[index];
  if (!found) throw new Error(`no pool ${index}`);
  return found;
}

/** A promise and the function that resolves it. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * Waits until a backend of the test database is blocked on a lock of this
 * kind: `advisory` (the coordination lock) or `transactionid` (another
 * transaction's uncommitted row).
 */
async function waitForLockWait(kind: "advisory" | "transactionid"): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await testDb.pool.query<{ count: string }>(
      `select count(*) from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and wait_event = $1`,
      [kind],
    );
    if (Number(result.rows[0]?.count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No connection waited on a ${kind} lock.`);
}

async function eventCount(projectId: string): Promise<number> {
  const [row] = await testDb.db
    .select({ n: count() })
    .from(event)
    .where(eq(event.projectId, projectId));
  return row?.n ?? 0;
}

/** Creates a Plan the way a handler will: number allocation and Event in one transaction. */
async function createPlan(tx: Transaction, now: Date, projectId: string, principal: Principal) {
  const number = await allocatePlanNumber(tx, projectId);
  const [row] = await tx
    .insert(plan)
    .values({
      projectId,
      number,
      title: `Plan ${number}`,
      ...creatorColumns(principal),
      creationFingerprint: creationFingerprint({ title: `Plan ${number}` }),
    })
    .returning();
  if (!row) throw new Error("plan insert returned no row");
  await insertEvent(tx, {
    projectId,
    type: "plan.created",
    payload: { number, title: row.title, status: row.status },
    actor: principal,
    planId: row.id,
    now,
  });
  return row;
}

describeDb("withCoordinationLock", () => {
  it("serializes transactions on the same Project but not on different Projects", async () => {
    const [{ project: first }, { project: second }] = [
      await insertProject(testDb.db),
      await insertProject(testDb.db),
    ];
    const holding = gate();
    const release = gate();
    const order: string[] = [];

    const holder = withCoordinationLock(db(0), first.id, async ({ now }) => {
      holding.open();
      await release.opened;
      order.push("holder");
      return now;
    });
    await holding.opened;

    const waiter = withCoordinationLock(db(1), first.id, async ({ now }) => {
      order.push("waiter");
      return now;
    });
    await waitForLockWait("advisory");

    // Another Project's lock is free, so this commits while the holder waits.
    await withCoordinationLock(db(2), second.id, async () => {
      order.push("other project");
    });
    expect(await tryWithCoordinationLock(db(3), first.id, async () => "ran")).toEqual({
      acquired: false,
    });
    expect(await tryWithCoordinationLock(db(3), second.id, async () => "ran")).toEqual({
      acquired: true,
      result: "ran",
    });

    release.open();
    const [holderNow, waiterNow] = await Promise.all([holder, waiter]);
    expect(order).toEqual(["other project", "holder", "waiter"]);
    // The waiter reads the time after acquiring the lock.
    expect(waiterNow.getTime()).toBeGreaterThan(holderNow.getTime());
  });

  it("rolls back state and Events when the callback throws", async () => {
    const { project: target, user } = await insertProject(testDb.db);
    const principal: Principal = { kind: "user", userId: user.id };

    await expect(
      withCoordinationLock(testDb.db, target.id, async ({ tx, now }) => {
        await createPlan(tx, now, target.id, principal);
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");

    expect(await testDb.db.select().from(plan).where(eq(plan.projectId, target.id))).toEqual([]);
    expect(await eventCount(target.id)).toBe(0);
    const [row] = await testDb.db.select().from(project).where(eq(project.id, target.id));
    expect(row?.nextPlanNumber).toBe(1);
  });

  it("rejects a malformed Project id", async () => {
    await expect(
      withCoordinationLock(testDb.db, "not-a-uuid", async () => {}),
    ).rejects.toMatchObject({ cause: { code: "22P02" } });
  });
});

describeDb("allocatePlanNumber", () => {
  it("gives concurrent transactions on separate connections distinct, consecutive numbers", async () => {
    const { project: target, user } = await insertProject(testDb.db);
    const principal: Principal = { kind: "user", userId: user.id };
    const start = gate();

    const created = Promise.all(
      dbs.map(async (client) => {
        await start.opened;
        return withCoordinationLock(client, target.id, ({ tx, now }) =>
          createPlan(tx, now, target.id, principal),
        );
      }),
    );
    start.open();
    const plans = await created;

    expect(plans.map((row) => row.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const [row] = await testDb.db.select().from(project).where(eq(project.id, target.id));
    expect(row?.nextPlanNumber).toBe(9);
    // Allocation leaves the Project's own updated_at alone.
    expect(row?.updatedAt).toEqual(target.updatedAt);
    expect(await eventCount(target.id)).toBe(8);
  });
});

describeDb("createOnce", () => {
  async function setup() {
    const seeded = await insertProject(testDb.db);
    const principal: Principal = { kind: "user", userId: seeded.user.id };
    return { ...seeded, principal };
  }

  function planRequest(
    projectId: string,
    principal: Principal,
    id: string,
    title: string,
  ): CreationRequest<"plan"> {
    return { kind: "plan", projectId, id, principal, fingerprint: creationFingerprint({ title }) };
  }

  /** createOnce for a Plan, inside the Project's lock, creating it with `request`'s id and fingerprint. */
  function createPlanOnce(client: Db, request: CreationRequest<"plan">, title: string) {
    return withCoordinationLock(client, request.projectId, ({ tx, now }) =>
      createOnce(tx, request, async (savepoint) => {
        const number = await allocatePlanNumber(savepoint, request.projectId);
        const [row] = await savepoint
          .insert(plan)
          .values({
            id: request.id,
            projectId: request.projectId,
            number,
            title,
            ...creatorColumns(request.principal),
            creationFingerprint: request.fingerprint,
          })
          .returning();
        if (!row) throw new Error("plan insert returned no row");
        await insertEvent(savepoint, {
          projectId: request.projectId,
          type: "plan.created",
          payload: { number, title, status: row.status },
          actor: request.principal,
          planId: row.id,
          now,
        });
        return row;
      }),
    );
  }

  it("creates once, then replays the original even after an edit, without a second Event", async () => {
    const { project: target, principal } = await setup();
    const id = randomUUID();
    const request = planRequest(target.id, principal, id, "Ship M2");

    const created = await createPlanOnce(testDb.db, request, "Ship M2");
    expect(created).toMatchObject({ status: "created", row: { id, number: 1 } });

    await testDb.db.update(plan).set({ title: "Renamed" }).where(eq(plan.id, id));
    const replayed = await createPlanOnce(testDb.db, request, "Ship M2");
    expect(replayed).toMatchObject({ status: "replay", row: { id, title: "Renamed", number: 1 } });

    expect(await eventCount(target.id)).toBe(1);
    const [row] = await testDb.db.select().from(project).where(eq(project.id, target.id));
    expect(row?.nextPlanNumber).toBe(2);
  });

  it("conflicts on different input or a different principal in the same Project", async () => {
    const { project: target, principal } = await setup();
    const id = randomUUID();
    await createPlanOnce(testDb.db, planRequest(target.id, principal, id, "One"), "One");
    const otherUser = await insertUser(testDb.db);

    const differentInput = planRequest(target.id, principal, id, "Two");
    const differentUser = planRequest(target.id, { kind: "user", userId: otherUser.id }, id, "One");
    const projectKey = planRequest(
      target.id,
      { kind: "project_key", keyId: randomUUID() },
      id,
      "One",
    );
    for (const request of [differentInput, differentUser, projectKey]) {
      expect(await createPlanOnce(testDb.db, request, "Two")).toEqual({ status: "conflict" });
    }
    expect(await eventCount(target.id)).toBe(1);
  });

  it("answers not_found for a UUID taken in another Project", async () => {
    const [a, b] = [await setup(), await setup()];
    const id = randomUUID();
    await createPlanOnce(testDb.db, planRequest(a.project.id, a.principal, id, "Mine"), "Mine");

    // Even the identical principal and input do not reveal the other Project's record.
    const sameEverything = planRequest(b.project.id, a.principal, id, "Mine");
    expect(await createPlanOnce(testDb.db, sameEverything, "Mine")).toEqual({
      status: "not_found",
    });
    expect(await eventCount(b.project.id)).toBe(0);
  });

  it("answers not_found when another Project creates the same UUID concurrently", async () => {
    const [a, b] = [await setup(), await setup()];
    const id = randomUUID();
    const inserted = gate();
    const commit = gate();

    const first = withCoordinationLock(db(0), a.project.id, async ({ tx }) => {
      const result = await createOnce(
        tx,
        planRequest(a.project.id, a.principal, id, "A"),
        async (savepoint) => {
          const [row] = await savepoint
            .insert(plan)
            .values({
              id,
              projectId: a.project.id,
              number: await allocatePlanNumber(savepoint, a.project.id),
              title: "A",
              ...creatorColumns(a.principal),
              creationFingerprint: creationFingerprint({ title: "A" }),
            })
            .returning();
          if (!row) throw new Error("plan insert returned no row");
          return row;
        },
      );
      inserted.open();
      await commit.opened;
      return result;
    });
    await inserted.opened;

    // B's insert waits on A's uncommitted row, then fails on the primary key.
    const second = createPlanOnce(db(1), planRequest(b.project.id, b.principal, id, "B"), "B");
    await waitForLockWait("transactionid");
    commit.open();

    expect(await first).toMatchObject({ status: "created" });
    expect(await second).toEqual({ status: "not_found" });
    // B's savepoint was rolled back: its Plan number and Event are gone.
    const [row] = await testDb.db.select().from(project).where(eq(project.id, b.project.id));
    expect(row?.nextPlanNumber).toBe(1);
    expect(await eventCount(b.project.id)).toBe(0);
  });

  it("replays a Session by owner and a Plan log entry by actor", async () => {
    const { project: target, principal } = await setup();
    const keyPrincipal: Principal = { kind: "project_key", keyId: randomUUID() };
    const sessionId = randomUUID();
    const sessionFingerprint = creationFingerprint({ agent: "claude-code", intent: "Test" });

    const startSession = (owner: Principal) =>
      withCoordinationLock(testDb.db, target.id, ({ tx }) =>
        createOnce(
          tx,
          {
            kind: "session",
            projectId: target.id,
            id: sessionId,
            principal: owner,
            fingerprint: sessionFingerprint,
          },
          async (savepoint) => {
            const [row] = await savepoint
              .insert(agentSession)
              .values({
                id: sessionId,
                projectId: target.id,
                ...sessionOwnerColumns(owner),
                agent: "claude-code",
                intent: "Test",
                creationFingerprint: sessionFingerprint,
              })
              .returning();
            if (!row) throw new Error("session insert returned no row");
            return row;
          },
        ),
      );
    expect(await startSession(keyPrincipal)).toMatchObject({ status: "created" });
    expect(await startSession(keyPrincipal)).toMatchObject({
      status: "replay",
      row: { id: sessionId },
    });
    expect(await startSession(principal)).toEqual({ status: "conflict" });

    const targetPlan = await insertPlan(testDb.db, target.id, principal);
    const logId = randomUUID();
    const logFingerprint = creationFingerprint({ plan: targetPlan.id, message: "Progress" });
    const appendLog = (actor: Principal, id: string = logId) =>
      withCoordinationLock(testDb.db, target.id, ({ tx, now }) =>
        createOnce(
          tx,
          {
            kind: "plan_log",
            projectId: target.id,
            id,
            principal: actor,
            fingerprint: logFingerprint,
          },
          (savepoint) =>
            insertEvent(savepoint, {
              id,
              projectId: target.id,
              type: "plan.logged",
              payload: { message: "Progress" },
              actor,
              planId: targetPlan.id,
              creationFingerprint: logFingerprint,
              now,
            }),
        ),
      );
    expect(await appendLog(principal)).toMatchObject({ status: "created", row: { id: logId } });
    expect(await appendLog(principal)).toMatchObject({ status: "replay", row: { id: logId } });
    expect(await appendLog({ kind: "user", userId: (await insertUser(testDb.db)).id })).toEqual({
      status: "conflict",
    });

    // A log id equal to another kind of Event's id conflicts.
    const other = await withCoordinationLock(testDb.db, target.id, ({ tx, now }) =>
      insertEvent(tx, {
        projectId: target.id,
        type: "plan.status_changed",
        payload: { from: "active", to: "paused" },
        actor: principal,
        planId: targetPlan.id,
        now,
      }),
    );
    expect(await appendLog(principal, other.id)).toEqual({ status: "conflict" });
  });
});
