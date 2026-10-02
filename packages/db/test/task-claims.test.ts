import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  blockTask,
  claimTask,
  doneTask,
  EventPayloadTooLargeError,
  endSession,
  heartbeatSession,
  listEvents,
  releaseTask,
  startTask,
} from "../src/index.ts";
import { plan as planTable } from "../src/schema/coordination.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertProjectKey, insertProjectMember, insertTask } from "./support/fixtures.ts";
import {
  eventsOf,
  MINUTE,
  otherUser,
  SECOND,
  sessionAged,
  setClaim,
  setupProject,
  taskRow,
  uuid,
} from "./support/lifecycle.ts";

let testDb: TestDatabase;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

/** A Project with an active Plan, a Task and two live Sessions of one User. */
async function setup() {
  const base = await setupProject(testDb.db);
  const a = await sessionAged(testDb.db, base.project.id, base.principal, MINUTE, {
    intent: "Session A intent",
  });
  const b = await sessionAged(testDb.db, base.project.id, base.principal, MINUTE, {
    intent: "Session B intent",
  });
  const as = (sessionId: string) => ({
    projectId: base.project.id,
    taskId: base.task.id,
    sessionId,
    principal: base.principal,
  });
  return { ...base, a, b, as };
}

describeDb("claimTask", () => {
  it.each([false, true])(
    "claims an unclaimed Task with a 5-minute lease, and a repeat is a no-op (steal=%s)",
    async (steal) => {
      const { project, task, a, as } = await setup();
      const claimed = await claimTask(testDb.db, { ...as(a.id), steal });
      expect(claimed).toMatchObject({ status: "ok", changed: true, stolenFromSessionId: null });
      if (claimed.status !== "ok") return;
      const row = claimed.task;
      expect(row.claimedBySessionId).toBe(a.id);
      expect(row.leaseExpiresAt?.getTime()).toBe((row.claimedAt?.getTime() ?? 0) + 5 * MINUTE);

      expect(await claimTask(testDb.db, { ...as(a.id), steal })).toMatchObject({
        status: "ok",
        changed: false,
      });
      expect((await taskRow(testDb.db, task.id)).leaseExpiresAt).toEqual(row.leaseExpiresAt);
      const events = await eventsOf(testDb.db, project.id);
      expect(events.map((e) => [e.type, e.sessionId, e.actorSessionId, e.taskId])).toEqual([
        ["task.claimed", a.id, a.id, task.id],
      ]);
    },
  );

  it("rejects a live competing claim with the holder's UUID and intent", async () => {
    const { project, a, b, as } = await setup();
    await claimTask(testDb.db, as(a.id));
    const result = await claimTask(testDb.db, as(b.id));
    expect(result).toEqual({
      status: "conflict",
      message: `The Task is claimed by Session ${a.id} (intent: "Session A intent").`,
      holder: { sessionId: a.id, intent: "Session A intent" },
    });
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(1);
  });

  it.each([false, true])(
    "takes over an expired lease, recording when it lapsed (steal=%s)",
    async (steal) => {
      const { project, task, a, b, as } = await setup();
      await setClaim(testDb.db, task.id, a.id, -SECOND);
      const lapsed = (await taskRow(testDb.db, task.id)).leaseExpiresAt;
      expect(await claimTask(testDb.db, { ...as(b.id), steal })).toMatchObject({
        status: "ok",
        changed: true,
        stolenFromSessionId: null,
        task: { claimedBySessionId: b.id },
      });
      const events = await eventsOf(testDb.db, project.id);
      expect(events.map((e) => [e.type, e.actorKind, e.sessionId, e.payload])).toEqual([
        ["task.released", "system", a.id, { reason: "lease_expired" }],
        [
          "task.claimed",
          "user",
          b.id,
          { stolenFromSessionId: null, leaseExpiresAt: expect.any(String) },
        ],
      ]);
      expect(events[0]?.effectiveAt).toEqual(lapsed);
    },
  );

  it.each([false, true])(
    "takes over the unexpired claim of a stale holder (steal=%s)",
    async (steal) => {
      const { project, principal, task, b, as } = await setup();
      const stale = await sessionAged(testDb.db, project.id, principal, 6 * MINUTE);
      await setClaim(testDb.db, task.id, stale.id, MINUTE);
      expect(await claimTask(testDb.db, { ...as(b.id), steal })).toMatchObject({
        status: "ok",
        changed: true,
      });
      const events = await eventsOf(testDb.db, project.id);
      expect(events[0]).toMatchObject({
        type: "task.released",
        payload: { reason: "session_stale" },
        effectiveAt: new Date(stale.lastHeartbeatAt.getTime() + 5 * MINUTE),
      });
      expect(events[1]?.payload).toMatchObject({ stolenFromSessionId: null });
    },
  );

  it("steals a live claim with Events for both holders; the former holder cannot act", async () => {
    const { project, task, a, b, as, principal } = await setup();
    await claimTask(testDb.db, as(a.id));
    const before = await taskRow(testDb.db, task.id);
    const stolen = await claimTask(testDb.db, { ...as(b.id), steal: true });
    expect(stolen).toMatchObject({
      status: "ok",
      changed: true,
      stolenFromSessionId: a.id,
      task: { claimedBySessionId: b.id },
    });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.at(-1)).toMatchObject({
      type: "task.claimed",
      sessionId: b.id,
      actorSessionId: b.id,
      payload: { stolenFromSessionId: a.id, leaseExpiresAt: expect.any(String) },
    });
    expect(events.map((e) => [e.type, e.sessionId])).toEqual([
      ["task.claimed", a.id],
      ["task.released", a.id],
      ["task.claimed", b.id],
    ]);
    expect(events[1]).toMatchObject({
      actorKind: "user",
      actorUserId: principal.kind === "user" ? principal.userId : null,
      actorSessionId: b.id,
      taskId: task.id,
      payload: { reason: "stolen" },
      effectiveAt: events[2]?.effectiveAt,
      createdAt: events[2]?.createdAt,
    });
    const history = await listEvents(testDb.db, {
      projectId: project.id,
      filter: { kind: "session", sessionId: a.id },
      limit: 100,
    });
    expect(history.items.map((e) => e.type)).toEqual(["task.released", "task.claimed"]);
    expect(await claimTask(testDb.db, { ...as(b.id), steal: true })).toMatchObject({
      status: "ok",
      changed: false,
    });
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(3);
    const after = await taskRow(testDb.db, task.id);
    expect(after.claimedAt?.getTime()).toBeGreaterThan(before.claimedAt?.getTime() ?? 0);

    const holderMessage = expect.stringContaining(`Session ${b.id}`);
    expect(await startTask(testDb.db, as(a.id))).toMatchObject({
      status: "conflict",
      message: holderMessage,
    });
    expect(await blockTask(testDb.db, { ...as(a.id), reason: "x" })).toMatchObject({
      status: "conflict",
    });
    expect(await doneTask(testDb.db, as(a.id))).toMatchObject({ status: "conflict" });
    expect(await releaseTask(testDb.db, as(a.id))).toMatchObject({ status: "conflict" });
    const heartbeat = await heartbeatSession(testDb.db, {
      projectId: project.id,
      sessionId: a.id,
      principal,
      collectionId: uuid(),
    });
    expect(heartbeat).toMatchObject({ status: "ok", renewedTaskIds: [] });
    expect(await taskRow(testDb.db, task.id)).toEqual(after);
    expect(
      await endSession(testDb.db, {
        projectId: project.id,
        sessionId: a.id,
        principal,
        summary: "Finished",
      }),
    ).toMatchObject({ status: "ok" });
    expect(
      (await eventsOf(testDb.db, project.id)).filter((e) => e.type === "task.released"),
    ).toHaveLength(1);
    expect(await taskRow(testDb.db, task.id)).toEqual(after);
  });

  it("attributes a Project key's steal to the key and its Session", async () => {
    const { project, task, a, as } = await setup();
    const key = await insertProjectKey(testDb.db, project.id);
    const thief = await sessionAged(testDb.db, project.id, key, MINUTE);
    await claimTask(testDb.db, as(a.id));
    expect(
      await claimTask(testDb.db, { ...as(thief.id), principal: key, steal: true }),
    ).toMatchObject({ status: "ok" });
    expect((await eventsOf(testDb.db, project.id))[1]).toMatchObject({
      type: "task.released",
      sessionId: a.id,
      taskId: task.id,
      actorKind: "project_key",
      actorKeyId: key.keyId,
      actorUserId: null,
      actorSessionId: thief.id,
      payload: { reason: "stolen" },
    });
  });

  it("requires an active Plan, a Task not done, and the caller's own live Session", async () => {
    const { project, principal, plan, task, a, as } = await setup();
    const setPlan = (status: "draft" | "paused") =>
      testDb.db.update(planTable).set({ status }).where(eq(planTable.id, plan.id));
    await setPlan("paused");
    expect(await claimTask(testDb.db, as(a.id))).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("paused"),
    });
    await setPlan("draft");
    expect(await claimTask(testDb.db, as(a.id))).toMatchObject({ status: "conflict" });
    await testDb.db.update(planTable).set({ status: "active" }).where(eq(planTable.id, plan.id));

    const done = await insertTask(testDb.db, project.id, plan.id, principal, { status: "done" });
    expect(await claimTask(testDb.db, { ...as(a.id), taskId: done.id })).toMatchObject({
      status: "conflict",
      message: "The Task is done.",
    });
    const stale = await sessionAged(testDb.db, project.id, principal, 5 * MINUTE + SECOND);
    expect(await claimTask(testDb.db, as(stale.id))).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("stale"),
    });
    const stranger = await insertProjectMember(testDb.db, project.id);
    expect(await claimTask(testDb.db, { ...as(a.id), principal: otherUser(stranger.id) })).toEqual({
      status: "forbidden",
    });
    const other = await setupProject(testDb.db);
    expect(await claimTask(testDb.db, { ...as(a.id), taskId: other.task.id })).toEqual({
      status: "not_found",
    });
    expect(await taskRow(testDb.db, task.id)).toMatchObject({ claimedBySessionId: null });
    expect(await eventsOf(testDb.db, project.id)).toEqual([]);
  });
});

describeDb("releaseTask", () => {
  it("releases the caller's claim keeping progress; repeating it is a no-op", async () => {
    const { project, task, a, as } = await setup();
    await claimTask(testDb.db, as(a.id));
    await startTask(testDb.db, as(a.id));
    expect(await releaseTask(testDb.db, as(a.id))).toMatchObject({
      status: "ok",
      changed: true,
      task: { status: "in_progress", claimedBySessionId: null },
    });
    expect(await releaseTask(testDb.db, as(a.id))).toMatchObject({ status: "ok", changed: false });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["task.claimed", { stolenFromSessionId: null, leaseExpiresAt: expect.any(String) }],
      ["task.started", { from: "todo" }],
      ["task.released", { reason: "released" }],
    ]);
    expect(await taskRow(testDb.db, task.id)).toMatchObject({ status: "in_progress" });
  });

  it("recognizes an unclaimed replay before the liveness check", async () => {
    const { project, principal, as } = await setup();
    const abandoned = await sessionAged(testDb.db, project.id, principal, 31 * MINUTE);
    expect(await releaseTask(testDb.db, as(abandoned.id))).toMatchObject({
      status: "ok",
      changed: false,
    });
  });

  it("conflicts on another Session's live claim and records the caller's expired claim", async () => {
    const { project, task, a, b, as } = await setup();
    await claimTask(testDb.db, as(b.id));
    expect(await releaseTask(testDb.db, as(a.id))).toMatchObject({ status: "conflict" });
    await setClaim(testDb.db, task.id, a.id, -SECOND);
    expect(await releaseTask(testDb.db, as(a.id))).toMatchObject({ status: "ok", changed: true });
    expect((await eventsOf(testDb.db, project.id)).at(-1)).toMatchObject({
      type: "task.released",
      actorKind: "system",
      payload: { reason: "lease_expired" },
    });
  });
});

describeDb("start, block and done", () => {
  it("move a claimed Task through its statuses", async () => {
    const { project, task, a, as } = await setup();
    expect(await startTask(testDb.db, as(a.id))).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("does not hold"),
    });
    await claimTask(testDb.db, as(a.id));
    const lease = (await taskRow(testDb.db, task.id)).leaseExpiresAt;
    expect(await blockTask(testDb.db, { ...as(a.id), reason: "Waiting" })).toMatchObject({
      status: "ok",
      changed: true,
      task: { status: "blocked", blockReason: "Waiting", leaseExpiresAt: lease },
    });
    expect(await blockTask(testDb.db, { ...as(a.id), reason: "Waiting" })).toMatchObject({
      changed: false,
    });
    expect(await startTask(testDb.db, as(a.id))).toMatchObject({
      status: "ok",
      changed: true,
      task: { status: "in_progress", blockReason: null },
    });
    expect(await startTask(testDb.db, as(a.id))).toMatchObject({ changed: false });
    expect(await doneTask(testDb.db, as(a.id))).toMatchObject({
      status: "ok",
      changed: true,
      task: { status: "done", claimedBySessionId: null, leaseExpiresAt: null },
    });
    expect(await doneTask(testDb.db, as(a.id))).toMatchObject({ status: "ok", changed: false });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => e.type)).toEqual([
      "task.claimed",
      "task.blocked",
      "task.started",
      "task.done",
    ]);
  });

  it("need an unexpired claim", async () => {
    const { task, a, as } = await setup();
    await setClaim(testDb.db, task.id, a.id, -SECOND);
    expect(await startTask(testDb.db, as(a.id))).toMatchObject({ status: "conflict" });
    expect(await blockTask(testDb.db, { ...as(a.id), reason: "r" })).toMatchObject({
      status: "conflict",
    });
    expect(await doneTask(testDb.db, as(a.id))).toMatchObject({ status: "conflict" });
  });

  it("allow holders to block and finish but not start in a paused Plan", async () => {
    const { plan, a, as } = await setup();
    await claimTask(testDb.db, as(a.id));
    await testDb.db.update(planTable).set({ status: "paused" }).where(eq(planTable.id, plan.id));
    expect(await startTask(testDb.db, as(a.id))).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("paused"),
    });
    expect(await blockTask(testDb.db, { ...as(a.id), reason: "Paused" })).toMatchObject({
      status: "ok",
    });
    expect(await doneTask(testDb.db, as(a.id))).toMatchObject({ status: "ok", changed: true });
  });

  it("roll back the state change when its Event cannot be written", async () => {
    const { project, task, a, as } = await setup();
    await claimTask(testDb.db, as(a.id));
    const before = await taskRow(testDb.db, task.id);
    await expect(
      blockTask(testDb.db, { ...as(a.id), reason: "x".repeat(70 * 1024) }),
    ).rejects.toBeInstanceOf(EventPayloadTooLargeError);
    expect(await taskRow(testDb.db, task.id)).toEqual(before);
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(1);
  });
});
