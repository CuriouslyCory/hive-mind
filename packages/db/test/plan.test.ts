import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { listEvents, projectHasSession } from "../src/event-read.ts";
import { createDb, type Db } from "../src/index.ts";
import {
  addTask,
  appendPlanLog,
  createPlan,
  getPlan,
  listPlans,
  listPlanTasks,
  type PlanWriter,
  resolvePlan,
  setPlanStatus,
  UnstorableTextError,
  updatePlan,
} from "../src/plan.ts";
import type { Principal } from "../src/principal.ts";
import { task } from "../src/schema/coordination.ts";
import { event } from "../src/schema/event.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertProject, insertProjectKey, insertSession } from "./support/fixtures.ts";

let testDb: TestDatabase;
let pools: pg.Pool[];
let dbs: Db[];

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
  // One connection each, so concurrent calls run in separate transactions.
  pools = Array.from({ length: 6 }, () => new pg.Pool({ connectionString: testDb.url, max: 1 }));
  dbs = pools.map((pool) => createDb(pool));
});

afterAll(async () => {
  await Promise.all((pools ?? []).map((pool) => pool.end()));
  await testDb?.drop();
});

async function setup() {
  const { project, user } = await insertProject(testDb.db);
  const principal: Principal = { kind: "user", userId: user.id };
  const writer: PlanWriter = { projectId: project.id, principal };
  return { project, user, principal, writer };
}

async function newPlan(
  writer: PlanWriter,
  values: { title?: string; status?: "draft" | "active" } = {},
) {
  const outcome = await createPlan(testDb.db, {
    ...writer,
    id: randomUUID(),
    title: "Plan",
    ...values,
  });
  if (outcome.status !== "created") throw new Error(`createPlan: ${outcome.status}`);
  return outcome.plan.plan;
}

async function eventTypes(projectId: string) {
  const rows = await testDb.db
    .select({ type: event.type })
    .from(event)
    .where(eq(event.projectId, projectId))
    .orderBy(event.seq);
  return rows.map((row) => row.type);
}

describeDb("Plan helpers", () => {
  it("creates, replays and refuses Plan ids", async () => {
    const { project, writer } = await setup();
    const other = await setup();
    const id = randomUUID();
    const input = { ...writer, id, title: "First", body: "Body" };
    const created = await createPlan(testDb.db, input);
    expect(created).toMatchObject({
      status: "created",
      plan: { plan: { number: 1, status: "draft" } },
    });
    const replay = await createPlan(testDb.db, input);
    expect(replay).toMatchObject({ status: "replay", plan: { plan: { id, number: 1 } } });
    expect(await createPlan(testDb.db, { ...input, title: "Other" })).toEqual({
      status: "conflict",
    });
    expect(
      await createPlan(testDb.db, {
        ...input,
        principal: await insertProjectKey(testDb.db, project.id),
      }),
    ).toEqual({ status: "conflict" });
    expect(
      await createPlan(testDb.db, { ...other.writer, id, title: "First", body: "Body" }),
    ).toEqual({
      status: "id_not_found",
    });
    // Replays and refusals consumed no Plan number and wrote no Event.
    expect((await newPlan(writer)).number).toBe(2);
    expect(await eventTypes(project.id)).toEqual(["plan.created", "plan.created"]);
  });

  it("refuses NUL before the database", async () => {
    const { writer } = await setup();
    await expect(
      createPlan(testDb.db, { ...writer, id: randomUUID(), title: "a\u0000" }),
    ).rejects.toThrow(UnstorableTextError);
  });

  it("allocates distinct numbers to concurrent creations", async () => {
    const { project, writer } = await setup();
    const outcomes = await Promise.all(
      dbs.map((db) => createPlan(db, { ...writer, id: randomUUID(), title: "Race" })),
    );
    const numbers = outcomes.map((outcome) =>
      outcome.status === "created" ? outcome.plan.plan.number : 0,
    );
    expect(numbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const page = await listPlans(testDb.db, { projectId: project.id, limit: 4 });
    expect(page.hasMore).toBe(true);
    expect(page.items.map((view) => view.plan.number)).toEqual([6, 5, 4, 3]);
    const rest = await listPlans(testDb.db, { projectId: project.id, limit: 4, beforeNumber: 3 });
    expect(rest).toMatchObject({ hasMore: false });
    expect(rest.items.map((view) => view.plan.number)).toEqual([2, 1]);
  });

  it("resolves Plan references only within their Project", async () => {
    const { project, writer } = await setup();
    const other = await setup();
    const plan = await newPlan(writer);
    expect((await resolvePlan(testDb.db, project.id, "PLAN-1"))?.id).toBe(plan.id);
    expect((await resolvePlan(testDb.db, project.id, plan.id.toUpperCase()))?.id).toBe(plan.id);
    expect(await resolvePlan(testDb.db, other.project.id, plan.id)).toBeUndefined();
    expect(await resolvePlan(testDb.db, other.project.id, "PLAN-1")).toBeUndefined();
    expect(await resolvePlan(testDb.db, project.id, "PLAN-01")).toBeUndefined();
    expect(await resolvePlan(testDb.db, project.id, "not-a-ref")).toBeUndefined();
  });

  it("edits open Plans only, without an Event for a no-op", async () => {
    const { project, writer } = await setup();
    await newPlan(writer, { title: "Title" });
    expect(await updatePlan(testDb.db, { ...writer, ref: "PLAN-1", title: "Title" })).toMatchObject(
      {
        status: "ok",
        changed: false,
      },
    );
    expect(
      await updatePlan(testDb.db, { ...writer, ref: "PLAN-1", title: "New", body: "B" }),
    ).toMatchObject({
      status: "ok",
      changed: true,
      plan: { plan: { title: "New", body: "B" } },
    });
    await setPlanStatus(testDb.db, { ...writer, ref: "PLAN-1", status: "abandoned" });
    expect(await updatePlan(testDb.db, { ...writer, ref: "PLAN-1", title: "Late" })).toEqual({
      status: "plan_closed",
      planStatus: "abandoned",
    });
    expect(await updatePlan(testDb.db, { ...writer, ref: "PLAN-2", title: "X" })).toEqual({
      status: "plan_not_found",
    });
    expect(await eventTypes(project.id)).toEqual([
      "plan.created",
      "plan.updated",
      "plan.status_changed",
    ]);
  });

  it("enforces the transition table and the done precondition", async () => {
    const { writer, project } = await setup();
    const plan = await newPlan(writer, { status: "active" });
    const ref = plan.id;
    expect(await setPlanStatus(testDb.db, { ...writer, ref, status: "active" })).toMatchObject({
      status: "ok",
      changed: false,
    });
    const added = await addTask(testDb.db, { ...writer, ref, taskId: randomUUID(), title: "T" });
    if (added.status !== "created") throw new Error(added.status);
    expect(await setPlanStatus(testDb.db, { ...writer, ref, status: "done" })).toEqual({
      status: "unfinished_tasks",
      count: 1,
    });
    await testDb.db.update(task).set({ status: "done" }).where(eq(task.id, added.task.task.id));
    expect(await setPlanStatus(testDb.db, { ...writer, ref, status: "done" })).toMatchObject({
      status: "ok",
      changed: true,
      plan: { progress: { total: 1, done: 1 } },
    });
    expect(await setPlanStatus(testDb.db, { ...writer, ref, status: "active" })).toEqual({
      status: "invalid_transition",
      from: "done",
      to: "active",
    });
    // Log entries are still accepted on a terminal Plan.
    const logged = await appendPlanLog(testDb.db, {
      ...writer,
      ref,
      eventId: randomUUID(),
      message: "Retro",
    });
    expect(logged).toMatchObject({
      status: "created",
      event: { type: "plan.log_appended", planId: plan.id },
    });
    expect(
      await addTask(testDb.db, { ...writer, ref, taskId: randomUUID(), title: "Late" }),
    ).toEqual({
      status: "plan_closed",
      planStatus: "done",
    });
    // A replay of the earlier addition is still recognized.
    expect(
      await addTask(testDb.db, { ...writer, ref, taskId: added.task.task.id, title: "T" }),
    ).toMatchObject({ status: "replay" });
    expect(await eventTypes(project.id)).toEqual([
      "plan.created",
      "task.added",
      "plan.status_changed",
      "plan.log_appended",
    ]);
  });

  it("releases every claim with an Event when a Plan is abandoned", async () => {
    const { project, writer, principal } = await setup();
    const plan = await newPlan(writer, { status: "active" });
    const holder = await insertSession(testDb.db, project.id, principal);
    const ids = [];
    for (const title of ["a", "b", "c"]) {
      const added = await addTask(testDb.db, {
        ...writer,
        ref: plan.id,
        taskId: randomUUID(),
        title,
      });
      if (added.status !== "created") throw new Error(added.status);
      ids.push(added.task.task.id);
    }
    await testDb.db
      .update(task)
      .set({
        claimedBySessionId: holder.id,
        claimedAt: sql`now()`,
        leaseExpiresAt: sql`now() + interval '5 minutes'`,
      })
      .where(sql`${task.id} in (${ids[0]}::uuid, ${ids[1]}::uuid)`);
    const outcome = await setPlanStatus(testDb.db, {
      ...writer,
      sessionId: holder.id,
      ref: "PLAN-1",
      status: "abandoned",
    });
    expect(outcome).toMatchObject({ status: "ok", releasedClaimCount: 2 });
    const released = await testDb.db.select().from(event).where(eq(event.type, "task.released"));
    expect(released.filter((row) => row.planId === plan.id)).toHaveLength(2);
    for (const row of released.filter((row) => row.planId === plan.id)) {
      expect(row).toMatchObject({
        sessionId: holder.id,
        actorSessionId: holder.id,
        payload: { reason: "plan_abandoned" },
      });
    }
    const page = await listPlanTasks(testDb.db, { projectId: project.id, ref: plan.id, limit: 10 });
    expect(page?.items.map((view) => view.claim)).toEqual([null, null, null]);
  });

  it("judges claims at one database time, with inclusive boundaries", async () => {
    const { project, writer, principal } = await setup();
    const plan = await newPlan(writer, { status: "active" });
    const live = await insertSession(testDb.db, project.id, principal);
    const ids: string[] = [];
    for (const title of ["usable", "expired"]) {
      const added = await addTask(testDb.db, {
        ...writer,
        ref: plan.id,
        taskId: randomUUID(),
        title,
      });
      if (added.status !== "created") throw new Error(added.status);
      ids.push(added.task.task.id);
    }
    await testDb.db
      .update(task)
      .set({
        claimedBySessionId: live.id,
        claimedAt: sql`now()`,
        leaseExpiresAt: sql`now() + interval '5 minutes'`,
      })
      .where(eq(task.id, ids[0] ?? ""));
    // A lease that ended in the past (the boundary itself counts as expired).
    await testDb.db
      .update(task)
      .set({
        claimedBySessionId: live.id,
        claimedAt: sql`now()`,
        leaseExpiresAt: sql`now() - interval '1 millisecond'`,
      })
      .where(eq(task.id, ids[1] ?? ""));
    const page = await listPlanTasks(testDb.db, { projectId: project.id, ref: "PLAN-1", limit: 1 });
    expect(page?.hasMore).toBe(true);
    expect(page?.items[0]?.claim?.sessionId).toBe(live.id);
    const rest = await listPlanTasks(testDb.db, {
      projectId: project.id,
      ref: "PLAN-1",
      limit: 1,
      after: { position: 1, id: ids[0] ?? "" },
    });
    expect(rest?.items.map((view) => [view.task.title, view.claim])).toEqual([["expired", null]]);
    expect(
      await listPlanTasks(testDb.db, { projectId: randomUUID(), ref: "PLAN-1", limit: 1 }),
    ).toBeUndefined();
  });

  it("checks the actor Session's owner, Project and liveness", async () => {
    const { project, writer, principal } = await setup();
    const other = await setup();
    const own = await insertSession(testDb.db, project.id, principal);
    const foreign = await insertSession(testDb.db, other.project.id, principal);
    const someoneElses = await insertSession(testDb.db, project.id, {
      kind: "project_key",
      keyId: randomUUID(),
    });
    const ended = await insertSession(testDb.db, project.id, principal, {
      status: "ended",
      endedAt: new Date(),
    });
    const attempt = (sessionId: string) =>
      createPlan(testDb.db, { ...writer, sessionId, id: randomUUID(), title: "T" });
    expect(await attempt(foreign.id)).toEqual({ status: "session_not_found" });
    expect(await attempt(someoneElses.id)).toEqual({ status: "session_forbidden" });
    expect(await attempt(ended.id)).toEqual({ status: "session_ended" });
    expect(await attempt(own.id)).toMatchObject({
      status: "created",
      plan: { plan: { number: 1 } },
    });
  });

  it("lists Events by Project, Plan and Session, newest first", async () => {
    const { project, writer, principal } = await setup();
    const session = await insertSession(testDb.db, project.id, principal);
    const first = await newPlan(writer);
    const second = await newPlan({ ...writer, sessionId: session.id });
    await appendPlanLog(testDb.db, {
      ...writer,
      ref: first.id,
      eventId: randomUUID(),
      message: "M",
    });
    const all = await listEvents(testDb.db, {
      projectId: project.id,
      filter: { kind: "project" },
      limit: 2,
    });
    expect(all.hasMore).toBe(true);
    expect(all.items.map((row) => row.type)).toEqual(["plan.log_appended", "plan.created"]);
    const older = await listEvents(testDb.db, {
      projectId: project.id,
      filter: { kind: "project" },
      limit: 2,
      beforeSeq: all.items[1]?.seq,
    });
    expect(older).toMatchObject({ hasMore: false });
    // Past the bigint range: refused before the query, never a cast error.
    await expect(
      listEvents(testDb.db, {
        projectId: project.id,
        filter: { kind: "project" },
        limit: 2,
        beforeSeq: "9223372036854775808",
      }),
    ).rejects.toThrow("beforeSeq must be a decimal bigint.");
    expect(older.items.map((row) => row.planId)).toEqual([first.id]);
    const ofPlan = await listEvents(testDb.db, {
      projectId: project.id,
      filter: { kind: "plan", planId: first.id },
      limit: 10,
    });
    expect(ofPlan.items.map((row) => row.type)).toEqual(["plan.log_appended", "plan.created"]);
    const ofSession = await listEvents(testDb.db, {
      projectId: project.id,
      filter: { kind: "session", sessionId: session.id },
      limit: 10,
    });
    expect(ofSession.items.map((row) => row.planId)).toEqual([second.id]);
    expect(await projectHasSession(testDb.db, project.id, session.id)).toBe(true);
    expect(await projectHasSession(testDb.db, randomUUID(), session.id)).toBe(false);
    expect((await getPlan(testDb.db, project.id, "PLAN-2"))?.plan.id).toBe(second.id);
  });
});
