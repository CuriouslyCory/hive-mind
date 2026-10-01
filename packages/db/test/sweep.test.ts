import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { heartbeatSession, type SweepOptions, sweepCoordination } from "../src/index.ts";
import { agentSession } from "../src/schema/coordination.ts";
import { event } from "../src/schema/event.ts";
import { project as projectTable } from "../src/schema/project.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertTask } from "./support/fixtures.ts";
import {
  eventsOf,
  holdProjectLock,
  later,
  MINUTE,
  onePools,
  sessionAged,
  sessionRow,
  setClaim,
  setupProject,
  taskRow,
  uuid,
  waitForLockWaiters,
} from "./support/lifecycle.ts";

// Each test gets its own database, so the sweep's candidate scan sees only
// that test's Projects.

let testDb: TestDatabase;
let pools: ReturnType<typeof onePools>;

beforeEach(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
  pools = onePools(testDb, 4);
});

afterEach(async () => {
  await pools?.end();
  await testDb?.drop();
});

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    projectBatch: 10,
    sessionBatch: 50,
    deadline: later(new Date(), MINUTE),
    ...overrides,
  };
}

/** A Project with one stale Session holding an expired claim. */
async function staleProject() {
  const base = await setupProject(testDb.db);
  const session = await sessionAged(testDb.db, base.project.id, base.principal, 6 * MINUTE);
  await setClaim(testDb.db, base.task.id, session.id, -MINUTE);
  return { ...base, session };
}

describeDb("sweepCoordination", () => {
  it("records thresholds with effectiveAt when they were crossed, once", async () => {
    const { project, principal, task } = await setupProject(testDb.db);
    // Delayed: the sweep runs 45 minutes after the last heartbeat.
    const session = await sessionAged(testDb.db, project.id, principal, 45 * MINUTE);
    await setClaim(testDb.db, task.id, session.id, -40 * MINUTE);
    const lease = (await taskRow(testDb.db, task.id)).leaseExpiresAt;

    expect(await sweepCoordination(testDb.db, options())).toEqual({
      projectsSwept: 1,
      projectsSkipped: 0,
      sessionsStale: 1,
      sessionsAbandoned: 1,
      claimsReleased: 1,
      moreWork: false,
    });
    const row = await sessionRow(testDb.db, session.id);
    const abandonedAt = new Date(session.lastHeartbeatAt.getTime() + 30 * MINUTE);
    expect(row).toMatchObject({ status: "abandoned", endedAt: abandonedAt });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.actorKind, e.payload, e.effectiveAt])).toEqual([
      [
        "session.status_changed",
        "system",
        { from: "active", to: "stale" },
        new Date(session.lastHeartbeatAt.getTime() + 5 * MINUTE),
      ],
      ["session.status_changed", "system", { from: "stale", to: "abandoned" }, abandonedAt],
      ["task.released", "system", { reason: "lease_expired" }, lease],
    ]);
    for (const e of events) expect(e.createdAt.getTime()).toBeGreaterThan(e.effectiveAt.getTime());
    const [swept] = await testDb.db
      .select({ at: projectTable.coordinationSweptAt, updatedAt: projectTable.updatedAt })
      .from(projectTable)
      .where(eq(projectTable.id, project.id));
    expect(swept?.at).toEqual(events[0]?.createdAt);
    expect(swept?.updatedAt).toEqual(project.updatedAt);

    // A duplicate invocation finds nothing to do.
    expect(await sweepCoordination(testDb.db, options())).toMatchObject({
      projectsSwept: 0,
      claimsReleased: 0,
    });
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(3);
    expect(
      await heartbeatSession(testDb.db, {
        projectId: project.id,
        sessionId: session.id,
        principal,
        collectionId: uuid(),
      }),
    ).toMatchObject({ status: "conflict" });
  });

  it("leaves live Sessions and unexpired claims alone", async () => {
    const { project, principal, task } = await setupProject(testDb.db);
    const live = await sessionAged(testDb.db, project.id, principal, 4 * MINUTE);
    await setClaim(testDb.db, task.id, live.id, MINUTE);
    expect(await sweepCoordination(testDb.db, options())).toMatchObject({ projectsSwept: 0 });
    expect(await sessionRow(testDb.db, live.id)).toMatchObject({ status: "active" });
    expect((await taskRow(testDb.db, task.id)).claimedBySessionId).toBe(live.id);
  });

  it("skips a busy Project, rotates through the rest and eventually cleans everything", async () => {
    const projects = [];
    for (let index = 0; index < 5; index++) {
      const base = await setupProject(testDb.db);
      const sessions = [];
      for (let n = 0; n < 3; n++) {
        const session = await sessionAged(testDb.db, base.project.id, base.principal, 6 * MINUTE);
        const claimed = await insertTask(testDb.db, base.project.id, base.plan.id, base.principal);
        await setClaim(testDb.db, claimed.id, session.id, -MINUTE);
        sessions.push(session.id);
      }
      projects.push({ id: base.project.id, sessions });
    }
    const order = projects.map((p) => p.id).sort();
    const busy = await holdProjectLock(pools.db(0), order[0] ?? "");

    const first = await sweepCoordination(
      pools.db(1),
      options({ projectBatch: 3, sessionBatch: 2 }),
    );
    expect(first).toMatchObject({ projectsSwept: 2, projectsSkipped: 1, moreWork: true });
    const sweptAt = async () =>
      new Map(
        (
          await testDb.db
            .select({ id: projectTable.id, at: projectTable.coordinationSweptAt })
            .from(projectTable)
        ).map((row) => [row.id, row.at]),
      );
    const afterFirst = await sweptAt();
    expect(order.map((id) => afterFirst.get(id) !== null)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);

    // The next invocation takes the never-swept Projects first, even though
    // the two swept ones still have work; the busy one is skipped again.
    const second = await sweepCoordination(
      pools.db(1),
      options({ projectBatch: 3, sessionBatch: 2 }),
    );
    expect(second).toMatchObject({ projectsSwept: 2, projectsSkipped: 1, moreWork: true });
    const afterSecond = await sweptAt();
    expect(order.map((id) => afterSecond.get(id) !== null)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(afterSecond.get(order[1] ?? "")).toEqual(afterFirst.get(order[1] ?? ""));
    await busy.release();

    let calls = 2;
    for (;;) {
      const result = await sweepCoordination(
        pools.db(1),
        options({ projectBatch: 2, sessionBatch: 2 }),
      );
      calls++;
      if (!result.moreWork) break;
      expect(calls).toBeLessThan(20);
    }
    const all = projects.flatMap((p) => p.sessions);
    const rows = await testDb.db
      .select({ status: agentSession.status })
      .from(agentSession)
      .where(inArray(agentSession.id, all));
    expect(rows.every((row) => row.status === "stale")).toBe(true);
    const events = await testDb.db
      .select({ type: event.type, sessionId: event.sessionId, taskId: event.taskId })
      .from(event);
    // Exactly one stale transition per Session and one release per claim.
    expect(events.filter((e) => e.type === "session.status_changed")).toHaveLength(15);
    expect(events.filter((e) => e.type === "task.released")).toHaveLength(15);
    expect(new Set(events.map((e) => `${e.type}:${e.sessionId}:${e.taskId}`)).size).toBe(30);
  });

  it("overlapping sweeps write each transition once", async () => {
    const projects = [];
    for (let index = 0; index < 6; index++) projects.push(await staleProject());
    const results = await Promise.all(
      [1, 2, 3].map((pool) =>
        sweepCoordination(pools.db(pool), options({ projectBatch: 6, sessionBatch: 10 })),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.sessionsStale, 0)).toBe(6);
    expect(results.reduce((sum, result) => sum + result.claimsReleased, 0)).toBe(6);
    for (const { project } of projects) {
      const events = await eventsOf(testDb.db, project.id);
      expect(events.map((e) => e.type)).toEqual(["session.status_changed", "task.released"]);
    }
  });

  it("serializes with a heartbeat on the same Session in either order", async () => {
    for (const heartbeatFirst of [true, false]) {
      const { project, principal, session } = await staleProject();
      const beat = (pool: number) =>
        heartbeatSession(pools.db(pool), {
          projectId: project.id,
          sessionId: session.id,
          principal,
          collectionId: uuid(),
        });
      const sweep = (pool: number) => sweepCoordination(pools.db(pool), options());
      if (heartbeatFirst) {
        // The heartbeat holds the lock; the sweep skips the Project.
        const busy = await holdProjectLock(pools.db(0), project.id);
        const pending = beat(1);
        await waitForLockWaiters(testDb, 1);
        expect(await sweep(2)).toMatchObject({ projectsSwept: 0, projectsSkipped: 1 });
        await busy.release();
        expect(await pending).toMatchObject({ status: "ok", previousStatus: "stale" });
        expect(await sweep(2)).toMatchObject({ projectsSwept: 0 });
      } else {
        expect(await sweep(2)).toMatchObject({ projectsSwept: 1 });
        expect(await beat(1)).toMatchObject({ status: "ok", previousStatus: "stale" });
      }
      const events = await eventsOf(testDb.db, project.id);
      expect(events.map((e) => e.type)).toEqual([
        "session.status_changed",
        "task.released",
        "session.heartbeat",
      ]);
      expect(await sessionRow(testDb.db, session.id)).toMatchObject({ status: "active" });
    }
  });

  it("stops at the deadline and leaves the work for later", async () => {
    await staleProject();
    expect(
      await sweepCoordination(testDb.db, options({ deadline: new Date(Date.now() - 1) })),
    ).toMatchObject({ projectsSwept: 0, moreWork: true });
  });
});
