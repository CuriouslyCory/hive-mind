import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachSession,
  endSession,
  getSession,
  heartbeatSession,
  listSessionClaims,
  listSessions,
  nextCollectionGeneration,
  startSession,
  updateSession,
} from "../src/index.ts";
import { agentSession, task as taskTable } from "../src/schema/coordination.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertPlan, insertSession, insertTask, insertUser } from "./support/fixtures.ts";
import {
  ago,
  dbNow,
  eventsOf,
  MINUTE,
  otherUser,
  SECOND,
  sessionAged,
  sessionRow,
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

const metadata = { machine: "laptop", gitBranch: "main", gitCommit: null, worktreePath: null };

describe("nextCollectionGeneration", () => {
  const base = {
    collectionId: null,
    collectionExpectedBatches: null,
    collectionPathCount: null,
    collectionContentHash: null,
    collectionComplete: false,
    scopeHistoryIncomplete: false,
  };

  it("starts the first generation without marking history incomplete", () => {
    expect(nextCollectionGeneration(base, "c1")).toEqual({
      newGeneration: true,
      columns: { ...base, collectionId: "c1" },
    });
  });

  it("marks history incomplete when the previous generation never completed", () => {
    const stored = { ...base, collectionId: "c1", collectionExpectedBatches: 2 };
    expect(nextCollectionGeneration(stored, "c2").columns).toMatchObject({
      collectionId: "c2",
      collectionExpectedBatches: null,
      collectionComplete: false,
      scopeHistoryIncomplete: true,
    });
  });

  it("keeps history complete after a complete generation, and keeps a sticky flag", () => {
    const complete = {
      ...base,
      collectionId: "c1",
      collectionExpectedBatches: 1,
      collectionPathCount: 3,
      collectionContentHash: "h",
      collectionComplete: true,
    };
    expect(nextCollectionGeneration(complete, "c2").columns?.scopeHistoryIncomplete).toBe(false);
    expect(
      nextCollectionGeneration({ ...complete, scopeHistoryIncomplete: true }, "c2").columns
        ?.scopeHistoryIncomplete,
    ).toBe(true);
  });

  it("resumes the same generation without changing anything", () => {
    expect(nextCollectionGeneration({ ...base, collectionId: "c1" }, "c1")).toEqual({
      newGeneration: false,
      columns: null,
    });
  });
});

describeDb("startSession", () => {
  it("creates an active Session with its first heartbeat, once", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const id = uuid();
    const input = {
      projectId: project.id,
      id,
      principal,
      agent: "claude",
      intent: "Fix",
      ...metadata,
    };

    const created = await startSession(testDb.db, input);
    expect(created).toMatchObject({ status: "ok", created: true });
    if (created.status !== "ok") return;
    expect(created.session).toMatchObject({ status: "active", effectiveStatus: "active" });
    expect(created.session.lastHeartbeatAt).toEqual(created.session.createdAt);
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.actorSessionId, e.sessionId])).toEqual([
      ["session.started", id, id],
    ]);

    expect(await startSession(testDb.db, input)).toMatchObject({ status: "ok", created: false });
    expect(await startSession(testDb.db, { ...input, intent: "Other" })).toMatchObject({
      status: "conflict",
    });
    const stranger = await insertUser(testDb.db);
    expect(
      await startSession(testDb.db, { ...input, principal: otherUser(stranger.id) }),
    ).toMatchObject({ status: "conflict" });
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(1);

    const other = await setupProject(testDb.db);
    expect(
      await startSession(testDb.db, {
        ...input,
        projectId: other.project.id,
        principal: other.principal,
      }),
    ).toEqual({ status: "not_found" });
  });
});

describeDb("updateSession", () => {
  it("changes supplied fields with an Event, and repeats as a no-op", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    const ref = { projectId: project.id, sessionId: session.id, principal };

    const changed = await updateSession(testDb.db, {
      ...ref,
      changes: { intent: "New intent", machine: null, status: "idle", agent: session.agent },
    });
    expect(changed).toMatchObject({ status: "ok", changed: true });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["session.updated", { intent: "New intent", status: "idle" }],
    ]);

    expect(
      await updateSession(testDb.db, { ...ref, changes: { intent: "New intent", status: "idle" } }),
    ).toMatchObject({ status: "ok", changed: false });
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(1);
  });

  it("separates foreign, absent and terminal Sessions", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    const stranger = await insertUser(testDb.db);
    const changes = { intent: "x" };

    expect(
      await updateSession(testDb.db, {
        projectId: project.id,
        sessionId: session.id,
        principal: otherUser(stranger.id),
        changes,
      }),
    ).toEqual({ status: "forbidden" });
    const other = await setupProject(testDb.db);
    expect(
      await updateSession(testDb.db, {
        projectId: other.project.id,
        sessionId: session.id,
        principal,
        changes,
      }),
    ).toEqual({ status: "not_found" });

    // Stored active, but 30 minutes without a heartbeat.
    const abandoned = await sessionAged(testDb.db, project.id, principal, 30 * MINUTE + SECOND);
    expect(
      await updateSession(testDb.db, {
        projectId: project.id,
        sessionId: abandoned.id,
        principal,
        changes,
      }),
    ).toMatchObject({ status: "conflict", message: expect.stringContaining("abandoned") });
    expect(await eventsOf(testDb.db, project.id)).toEqual([]);
  });
});

describeDb("attachSession", () => {
  it("attaches a Plan by number and a Task of that Plan, without claiming", async () => {
    const { project, principal, plan, task } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    const ref = { projectId: project.id, sessionId: session.id, principal };

    const attached = await attachSession(testDb.db, {
      ...ref,
      plan: { number: plan.number },
      taskId: task.id,
    });
    expect(attached).toMatchObject({
      status: "ok",
      changed: true,
      session: { attachedPlanId: plan.id, attachedTaskId: task.id },
    });
    expect((await taskRow(testDb.db, task.id)).claimedBySessionId).toBeNull();
    expect(
      await attachSession(testDb.db, { ...ref, plan: { id: plan.id }, taskId: task.id }),
    ).toMatchObject({ status: "ok", changed: false });
    expect(await attachSession(testDb.db, { ...ref, plan: null })).toMatchObject({
      status: "ok",
      changed: true,
      session: { attachedPlanId: null, attachedTaskId: null },
    });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => e.type)).toEqual(["session.attached", "session.attached"]);
  });

  it("rejects a Task of another Plan and a Plan of another Project as not found", async () => {
    const { project, principal, plan } = await setupProject(testDb.db);
    const otherPlan = await insertPlan(testDb.db, project.id, principal);
    const otherTask = await insertTask(testDb.db, project.id, otherPlan.id, principal);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    const ref = { projectId: project.id, sessionId: session.id, principal };
    expect(
      await attachSession(testDb.db, { ...ref, plan: { id: plan.id }, taskId: otherTask.id }),
    ).toEqual({ status: "not_found" });
    const foreign = await setupProject(testDb.db);
    expect(await attachSession(testDb.db, { ...ref, plan: { id: foreign.plan.id } })).toEqual({
      status: "not_found",
    });
    expect(await eventsOf(testDb.db, project.id)).toEqual([]);
  });
});

describeDb("heartbeatSession", () => {
  it("revives a stale Session: records stale, releases expired claims, renews the rest", async () => {
    const { project, principal, plan, task } = await setupProject(testDb.db);
    const unexpired = await insertTask(testDb.db, project.id, plan.id, principal);
    const session = await sessionAged(testDb.db, project.id, principal, 6 * MINUTE);
    await setClaim(testDb.db, task.id, session.id, -MINUTE);
    await setClaim(testDb.db, unexpired.id, session.id, MINUTE);
    const expiredLease = (await taskRow(testDb.db, task.id)).leaseExpiresAt;

    const result = await heartbeatSession(testDb.db, {
      projectId: project.id,
      sessionId: session.id,
      principal,
      collectionId: uuid(),
    });
    expect(result).toMatchObject({
      status: "ok",
      previousStatus: "stale",
      renewedTaskIds: [unexpired.id],
      releasedTaskIds: [task.id],
      newCollection: true,
      session: { status: "active", effectiveStatus: "active" },
    });
    if (result.status !== "ok") return;
    expect(result.session.lastHeartbeatAt).toEqual(result.session.updatedAt);
    expect(result.leaseExpiresAt?.getTime()).toBe(
      result.session.lastHeartbeatAt.getTime() + 5 * MINUTE,
    );
    expect((await taskRow(testDb.db, unexpired.id)).leaseExpiresAt).toEqual(result.leaseExpiresAt);
    expect((await taskRow(testDb.db, task.id)).claimedBySessionId).toBeNull();

    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.actorKind, e.payload])).toEqual([
      ["session.status_changed", "system", { from: "active", to: "stale" }],
      ["task.released", "system", { reason: "lease_expired" }],
      [
        "session.heartbeat",
        "user",
        {
          status: "active",
          previousStatus: "stale",
          collectionId: expect.any(String),
          newCollection: true,
        },
      ],
    ]);
    expect(events[0]?.effectiveAt).toEqual(
      new Date(session.lastHeartbeatAt.getTime() + 5 * MINUTE),
    );
    expect(events[1]?.effectiveAt).toEqual(expiredLease);
    expect(events[1]?.createdAt.getTime()).toBeGreaterThan(events[1]?.effectiveAt.getTime() ?? 0);
  });

  it("keeps an idle Session idle, sets a supplied status, and leaves others' claims alone", async () => {
    const { project, principal, task } = await setupProject(testDb.db);
    const idle = await sessionAged(testDb.db, project.id, principal, MINUTE, { status: "idle" });
    const other = await sessionAged(testDb.db, project.id, principal, MINUTE);
    await setClaim(testDb.db, task.id, other.id, MINUTE);
    const lease = (await taskRow(testDb.db, task.id)).leaseExpiresAt;
    const ref = { projectId: project.id, sessionId: idle.id, principal };

    expect(await heartbeatSession(testDb.db, { ...ref, collectionId: uuid() })).toMatchObject({
      status: "ok",
      previousStatus: "idle",
      renewedTaskIds: [],
      leaseExpiresAt: null,
      session: { status: "idle" },
    });
    expect(
      await heartbeatSession(testDb.db, { ...ref, collectionId: uuid(), sessionStatus: "active" }),
    ).toMatchObject({ status: "ok", session: { status: "active" } });
    expect((await taskRow(testDb.db, task.id)).leaseExpiresAt).toEqual(lease);
  });

  it("cannot revive an effectively abandoned Session even if its row says active", async () => {
    const { project, principal, task } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, 31 * MINUTE);
    await setClaim(testDb.db, task.id, session.id, -MINUTE);
    const result = await heartbeatSession(testDb.db, {
      projectId: project.id,
      sessionId: session.id,
      principal,
      collectionId: uuid(),
    });
    expect(result).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("abandoned"),
    });
    expect(await sessionRow(testDb.db, session.id)).toMatchObject({ status: "active" });
    expect(await eventsOf(testDb.db, project.id)).toEqual([]);
  });

  it("applies the collection generation rule", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    const ref = { projectId: project.id, sessionId: session.id, principal };
    const first = uuid();
    await heartbeatSession(testDb.db, { ...ref, collectionId: first });
    expect(await sessionRow(testDb.db, session.id)).toMatchObject({
      collectionId: first,
      scopeHistoryIncomplete: false,
    });
    // Resume: same id, manifest untouched.
    await testDb.db
      .update(agentSession)
      .set({ collectionExpectedBatches: 1, collectionPathCount: 2, collectionContentHash: "h" })
      .where(eq(agentSession.id, session.id));
    expect(await heartbeatSession(testDb.db, { ...ref, collectionId: first })).toMatchObject({
      newCollection: false,
    });
    expect(await sessionRow(testDb.db, session.id)).toMatchObject({
      collectionExpectedBatches: 1,
      collectionComplete: false,
    });
    // New generation while the previous one is incomplete: coverage lost.
    const second = uuid();
    await heartbeatSession(testDb.db, { ...ref, collectionId: second });
    expect(await sessionRow(testDb.db, session.id)).toMatchObject({
      collectionId: second,
      collectionExpectedBatches: null,
      collectionContentHash: null,
      scopeHistoryIncomplete: true,
    });
  });

  it("is owner-only", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    const stranger = await insertUser(testDb.db);
    expect(
      await heartbeatSession(testDb.db, {
        projectId: project.id,
        sessionId: session.id,
        principal: { kind: "project_key", keyId: stranger.id },
        collectionId: uuid(),
      }),
    ).toEqual({ status: "forbidden" });
  });
});

describeDb("endSession", () => {
  it("ends with a summary, releases claims keeping progress, and replays as a no-op", async () => {
    const { project, principal, task } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    await setClaim(testDb.db, task.id, session.id, MINUTE);
    const ref = { projectId: project.id, sessionId: session.id, principal };
    await testDb.db
      .update(taskTable)
      .set({ status: "in_progress" })
      .where(eq(taskTable.id, task.id));

    const ended = await endSession(testDb.db, { ...ref, summary: "Done for now" });
    expect(ended).toMatchObject({
      status: "ok",
      changed: true,
      releasedTaskIds: [task.id],
      session: { status: "ended", effectiveStatus: "ended", summary: "Done for now" },
    });
    expect(await taskRow(testDb.db, task.id)).toMatchObject({
      status: "in_progress",
      claimedBySessionId: null,
    });
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["task.released", { reason: "session_ended" }],
      ["session.ended", { summary: "Done for now", status: "ended" }],
    ]);

    expect(await endSession(testDb.db, { ...ref, summary: "Done for now" })).toMatchObject({
      status: "ok",
      changed: false,
    });
    expect(await endSession(testDb.db, { ...ref, summary: "Different" })).toMatchObject({
      status: "conflict",
    });
    expect(await eventsOf(testDb.db, project.id)).toHaveLength(2);
    expect(await updateSession(testDb.db, { ...ref, changes: { intent: "x" } })).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("ended"),
    });
  });

  it("lets an abandoned Session accept its first summary and stay abandoned", async () => {
    const { project, principal, task } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, 40 * MINUTE);
    await setClaim(testDb.db, task.id, session.id, -MINUTE);
    const ref = { projectId: project.id, sessionId: session.id, principal };

    const ended = await endSession(testDb.db, { ...ref, summary: "Late summary" });
    expect(ended).toMatchObject({
      status: "ok",
      changed: true,
      session: { status: "abandoned", summary: "Late summary" },
    });
    if (ended.status !== "ok") return;
    expect(ended.session.endedAt).toEqual(
      new Date(session.lastHeartbeatAt.getTime() + 30 * MINUTE),
    );
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => [e.type, e.actorKind, e.payload])).toEqual([
      ["session.status_changed", "system", { from: "active", to: "stale" }],
      ["session.status_changed", "system", { from: "stale", to: "abandoned" }],
      ["task.released", "system", { reason: "lease_expired" }],
      ["session.ended", "user", { summary: "Late summary", status: "abandoned" }],
    ]);
    expect(await endSession(testDb.db, { ...ref, summary: "Another" })).toMatchObject({
      status: "conflict",
    });
    expect(await endSession(testDb.db, { ...ref, summary: "Late summary" })).toMatchObject({
      status: "ok",
      changed: false,
    });
  });
});

describeDb("Session reads", () => {
  it("compute effective status from database time without writing", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const stale = await sessionAged(testDb.db, project.id, principal, 6 * MINUTE);
    const before = await sessionRow(testDb.db, stale.id);
    expect(
      await getSession(testDb.db, { projectId: project.id, sessionId: stale.id }),
    ).toMatchObject({ status: "ok", session: { status: "active", effectiveStatus: "stale" } });
    expect(await sessionRow(testDb.db, stale.id)).toEqual(before);
    expect(await eventsOf(testDb.db, project.id)).toEqual([]);
    const other = await setupProject(testDb.db);
    expect(
      await getSession(testDb.db, { projectId: other.project.id, sessionId: stale.id }),
    ).toEqual({ status: "not_found" });
  });

  it("list by effective status, newest first, in keyset pages", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const live = await sessionAged(testDb.db, project.id, principal, 3 * MINUTE);
    const stale = await sessionAged(testDb.db, project.id, principal, 10 * MINUTE);
    const abandoned = await sessionAged(testDb.db, project.id, principal, 40 * MINUTE);
    const idle = await sessionAged(testDb.db, project.id, principal, 2 * MINUTE, {
      status: "idle",
    });
    const ids = async (filter?: Parameters<typeof listSessions>[1]["filter"]) => {
      const page = await listSessions(testDb.db, { projectId: project.id, filter });
      return page.status === "ok" ? page.items.map((s) => s.id) : page;
    };
    expect(await ids()).toEqual([idle.id, live.id, stale.id, abandoned.id]);
    expect(await ids("live")).toEqual([idle.id, live.id]);
    expect(await ids("stale")).toEqual([stale.id]);
    expect(await ids("terminal")).toEqual([abandoned.id]);

    const first = await listSessions(testDb.db, { projectId: project.id, limit: 3 });
    expect(first).toMatchObject({ status: "ok", next: stale.id });
    const second = await listSessions(testDb.db, {
      projectId: project.id,
      limit: 3,
      after: stale.id,
    });
    expect(second).toMatchObject({ status: "ok", next: null, items: [{ id: abandoned.id }] });
    expect(await listSessions(testDb.db, { projectId: project.id, after: uuid() })).toEqual({
      status: "invalid_cursor",
    });
  });

  it("list only usable claims", async () => {
    const { project, principal, plan, task } = await setupProject(testDb.db);
    const expiredTask = await insertTask(testDb.db, project.id, plan.id, principal);
    const session = await sessionAged(testDb.db, project.id, principal, MINUTE);
    const staleSession = await sessionAged(testDb.db, project.id, principal, 6 * MINUTE);
    const staleTask = await insertTask(testDb.db, project.id, plan.id, principal);
    await setClaim(testDb.db, task.id, session.id, MINUTE);
    await setClaim(testDb.db, expiredTask.id, session.id, -SECOND);
    await setClaim(testDb.db, staleTask.id, staleSession.id, MINUTE);
    const claims = (sessionId: string) =>
      listSessionClaims(testDb.db, { projectId: project.id, sessionId });
    expect(await claims(session.id)).toMatchObject({ items: [{ id: task.id }], next: null });
    expect(await claims(staleSession.id)).toMatchObject({ items: [], next: null });
    expect(await claims(uuid())).toEqual({ status: "not_found" });
  });
});

describeDb("Session liveness boundaries through the public functions", () => {
  // The exact boundaries (at 5 and 30 minutes, inclusive) are tested with a
  // fixed `now` in lifecycle-boundaries.test.ts; these use a margin around
  // database time because each call reads its own `now`.
  async function heartbeatAt(age: number) {
    const { project, principal } = await setupProject(testDb.db);
    const session = await sessionAged(testDb.db, project.id, principal, age);
    return heartbeatSession(testDb.db, {
      projectId: project.id,
      sessionId: session.id,
      principal,
      collectionId: uuid(),
    });
  }

  it("is live just before 5 minutes and stale just after", async () => {
    expect(await heartbeatAt(5 * MINUTE - 3 * SECOND)).toMatchObject({ previousStatus: "active" });
    expect(await heartbeatAt(5 * MINUTE)).toMatchObject({ previousStatus: "stale" });
    expect(await heartbeatAt(5 * MINUTE + SECOND)).toMatchObject({ previousStatus: "stale" });
  });

  it("is revivable just before 30 minutes and abandoned at and after", async () => {
    expect(await heartbeatAt(30 * MINUTE - 3 * SECOND)).toMatchObject({
      status: "ok",
      previousStatus: "stale",
    });
    expect(await heartbeatAt(30 * MINUTE)).toMatchObject({ status: "conflict" });
    expect(await heartbeatAt(30 * MINUTE + SECOND)).toMatchObject({ status: "conflict" });
  });

  it("uses the stored heartbeat, not a stale stored status", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const now = await dbNow(testDb.db);
    const session = await insertSession(testDb.db, project.id, principal, {
      status: "stale",
      lastHeartbeatAt: ago(now, 20 * MINUTE),
    });
    expect(
      await heartbeatSession(testDb.db, {
        projectId: project.id,
        sessionId: session.id,
        principal,
        collectionId: uuid(),
      }),
    ).toMatchObject({ status: "ok", previousStatus: "stale", session: { status: "active" } });
    // Stored stale already, so no second stale Event.
    const events = await eventsOf(testDb.db, project.id);
    expect(events.map((e) => e.type)).toEqual(["session.heartbeat"]);
  });
});
