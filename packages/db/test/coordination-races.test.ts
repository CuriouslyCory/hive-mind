import { afterAll, beforeAll, expect, it } from "vitest";
import {
  blockTask,
  claimTask,
  doneTask,
  endSession,
  heartbeatSession,
  releaseTask,
  startTask,
} from "../src/index.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import {
  eventsOf,
  holdProjectLock,
  MINUTE,
  onePools,
  SECOND,
  sessionAged,
  setClaim,
  setupProject,
  taskRow,
  uuid,
  waitForLockWaiters,
} from "./support/lifecycle.ts";

// Races between coordination operations, each on its own connection. A
// holder transaction keeps the Project lock while the contenders queue
// behind it (the lock grants waiters in arrival order), then lets them run.

let testDb: TestDatabase;
let pools: ReturnType<typeof onePools>;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
  pools = onePools(testDb, 10);
});

afterAll(async () => {
  await pools?.end();
  await testDb?.drop();
});

async function setup(sessions: number) {
  const base = await setupProject(testDb.db);
  const rows = [];
  for (let index = 0; index < sessions; index++) {
    rows.push(
      await sessionAged(testDb.db, base.project.id, base.principal, MINUTE, {
        intent: `Session ${index}`,
      }),
    );
  }
  const as = (sessionId: string) => ({
    projectId: base.project.id,
    taskId: base.task.id,
    sessionId,
    principal: base.principal,
  });
  const heartbeat = (sessionId: string) => ({
    projectId: base.project.id,
    sessionId,
    principal: base.principal,
    collectionId: uuid(),
  });
  return { ...base, sessions: rows, as, heartbeat };
}

/** Starts `operations` in order, each queued on the lock before the next starts. */
async function queueBehindLock<T>(
  projectId: string,
  operations: ((index: number) => Promise<T>)[],
): Promise<T[]> {
  const holder = await holdProjectLock(pools.db(0), projectId);
  const pending: Promise<T>[] = [];
  for (const [index, operation] of operations.entries()) {
    pending.push(operation(index + 1));
    await waitForLockWaiters(testDb, index + 1);
  }
  await holder.release();
  return Promise.all(pending);
}

describeDb("coordination races", () => {
  it("simultaneous claims have exactly one winner", async () => {
    const { project, task, sessions, as } = await setup(6);
    const results = await queueBehindLock(
      project.id,
      sessions.map((session) => (pool: number) => claimTask(pools.db(pool), as(session.id))),
    );
    const winners = results.filter((result) => result.status === "ok");
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(5);
    expect((await taskRow(testDb.db, task.id)).claimedBySessionId).toBe(sessions[0]?.id);
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => e.type)).toEqual(["task.claimed"]);
  });

  it("simultaneous claims without a queue still have exactly one winner", async () => {
    const { project, sessions, as } = await setup(8);
    const results = await Promise.all(
      sessions.map((session, index) => claimTask(pools.db(index + 1), as(session.id))),
    );
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(1);
  });

  it("a heartbeat racing a claim at lease expiry cannot clear the new claim", async () => {
    // A's lease has expired. B claims the Task while A heartbeats. A third
    // transaction holds the Task's row lock so B's claim waits inside its
    // transaction while A's heartbeat starts; without the Project lock, the
    // heartbeat would read A's expired claim before B commits and then clear
    // B's claim.
    const { project, task, sessions, as, heartbeat } = await setup(2);
    const [a, b] = sessions;
    if (!a || !b) throw new Error("setup");
    await setClaim(testDb.db, task.id, a.id, -SECOND);

    const rowLock = await pools.db(0).$client.connect();
    await rowLock.query("begin");
    await rowLock.query("select id from task where id = $1 for update", [task.id]);
    const claim = claimTask(pools.db(1), as(b.id));
    await waitForLockWaiters(testDb, 1, "any");
    const beat = heartbeatSession(pools.db(2), heartbeat(a.id));
    await waitForLockWaiters(testDb, 2, "any");
    await rowLock.query("commit");
    rowLock.release();

    expect(await claim).toMatchObject({ status: "ok", changed: true });
    expect(await beat).toMatchObject({ status: "ok", renewedTaskIds: [], releasedTaskIds: [] });
    expect((await taskRow(testDb.db, task.id)).claimedBySessionId).toBe(b.id);
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.sessionId])).toEqual([
      ["task.released", a.id],
      ["task.claimed", b.id],
      ["session.heartbeat", a.id],
    ]);
  });

  it("a heartbeat that wins the race at expiry releases, and the claim then succeeds", async () => {
    const { project, task, sessions, as, heartbeat } = await setup(2);
    const [a, b] = sessions;
    if (!a || !b) throw new Error("setup");
    await setClaim(testDb.db, task.id, a.id, -SECOND);
    const [beat, claim] = await queueBehindLock<unknown>(project.id, [
      (pool) => heartbeatSession(pools.db(pool), heartbeat(a.id)),
      (pool) => claimTask(pools.db(pool), as(b.id)),
    ]);
    expect(beat).toMatchObject({ status: "ok", releasedTaskIds: [task.id], renewedTaskIds: [] });
    expect(claim).toMatchObject({ status: "ok", changed: true });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => e.type)).toEqual([
      "task.released",
      "session.heartbeat",
      "task.claimed",
    ]);
  });

  it("commands from the former holder queued after a steal cannot alter the new claim", async () => {
    const { project, task, sessions, as, heartbeat } = await setup(2);
    const [a, b] = sessions;
    if (!a || !b) throw new Error("setup");
    await claimTask(testDb.db, as(a.id));
    const results = await queueBehindLock<{ status: string; task?: unknown }>(project.id, [
      (pool) => claimTask(pools.db(pool), { ...as(b.id), steal: true }),
      (pool) => startTask(pools.db(pool), as(a.id)),
      (pool) => blockTask(pools.db(pool), { ...as(a.id), reason: "mine" }),
      (pool) => doneTask(pools.db(pool), as(a.id)),
      (pool) => releaseTask(pools.db(pool), as(a.id)),
      (pool) => heartbeatSession(pools.db(pool), heartbeat(a.id)),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "ok",
      "conflict",
      "conflict",
      "conflict",
      "conflict",
      "ok",
    ]);
    expect(results[0]).toMatchObject({ stolenFromSessionId: a.id });
    expect(results[5]).toMatchObject({ renewedTaskIds: [] });
    const stolen = results[0];
    expect(stolen?.status === "ok" && "task" in stolen ? stolen.task : null).toEqual(
      await taskRow(testDb.db, task.id),
    );
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => e.type)).toEqual(["task.claimed", "task.stolen", "session.heartbeat"]);
  });

  it("Session end and a competing claim resolve in either order", async () => {
    for (const endFirst of [true, false]) {
      const { project, task, sessions, as } = await setup(2);
      const [a, b] = sessions;
      if (!a || !b) throw new Error("setup");
      await claimTask(testDb.db, as(a.id));
      const end = (pool: number) =>
        endSession(pools.db(pool), {
          projectId: project.id,
          sessionId: a.id,
          principal: as(a.id).principal,
          summary: "Bye",
        });
      const claim = (pool: number) => claimTask(pools.db(pool), as(b.id));
      const results = await queueBehindLock<{ status: string }>(
        project.id,
        endFirst ? [end, claim] : [claim, end],
      );
      const [endResult, claimResult] = endFirst ? results : [results[1], results[0]];
      expect(endResult).toMatchObject({ status: "ok", releasedTaskIds: [task.id] });
      expect(claimResult?.status).toBe(endFirst ? "ok" : "conflict");
      const row = await taskRow(testDb.db, task.id);
      expect(row.claimedBySessionId).toBe(endFirst ? b.id : null);
      const released = (await eventsOf(testDb.db, project.id)).filter(
        (e) => e.type === "task.released",
      );
      expect(released).toHaveLength(1);
    }
  });
});
