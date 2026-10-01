import { randomUUID } from "node:crypto";
import {
  attachSession,
  blockTask,
  claimTask,
  creatorColumns,
  doneTask,
  endSession,
  heartbeatSession,
  type Principal,
  releaseTask,
  schema,
  startSession,
  startTask,
  sweepCoordination,
  updateSession,
} from "@hivemind/db";
import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { toEventDto } from "../src/server/api/coordination-dto";

// Every Event the Session, Task-claim and sweep helpers of @hivemind/db write
// must read back as a valid contract Event; a mismatch would make Event reads
// fail with 500.

let testDb: TestDatabase;

describeDb("lifecycle Events", () => {
  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it("match the contract's eventSchema", async () => {
    const db = testDb.db;
    const slug = `org-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(schema.organization).values({ name: slug, slug }).returning();
    const [user] = await db
      .insert(schema.user)
      .values({ name: slug, email: `${slug}@example.com`, githubLogin: slug })
      .returning();
    if (!org || !user) throw new Error("setup");
    const [project] = await db
      .insert(schema.project)
      .values({ organizationId: org.id, slug: "app", name: "App" })
      .returning();
    if (!project) throw new Error("setup");
    const principal: Principal = { kind: "user", userId: user.id };
    const [plan] = await db
      .insert(schema.plan)
      .values({
        projectId: project.id,
        number: 1,
        title: "Plan",
        status: "active",
        ...creatorColumns(principal),
        creationFingerprint: "0".repeat(64),
      })
      .returning();
    if (!plan) throw new Error("setup");
    const newTask = async () => {
      const [row] = await db
        .insert(schema.task)
        .values({
          projectId: project.id,
          planId: plan.id,
          title: "Task",
          position: 1,
          ...creatorColumns(principal),
          creationFingerprint: "0".repeat(64),
        })
        .returning();
      if (!row) throw new Error("setup");
      return row;
    };
    const first = await newTask();
    const second = await newTask();
    const start = async () => {
      const id = randomUUID();
      const started = await startSession(db, {
        projectId: project.id,
        id,
        principal,
        agent: "claude-code",
        intent: "Work",
        machine: "laptop",
        gitBranch: "main",
        gitCommit: null,
        worktreePath: null,
      });
      expect(started.status).toBe("ok");
      return id;
    };
    const a = await start();
    const b = await start();
    const own = (sessionId: string) => ({ projectId: project.id, sessionId, principal });
    const work = (sessionId: string, taskId: string) => ({ ...own(sessionId), taskId });

    const ok = { status: "ok" };
    expect(
      await updateSession(db, { ...own(a), changes: { intent: "Other", machine: null } }),
    ).toMatchObject(ok);
    expect(
      await attachSession(db, { ...own(a), plan: { id: plan.id }, taskId: first.id }),
    ).toMatchObject(ok);
    expect(await heartbeatSession(db, { ...own(a), collectionId: randomUUID() })).toMatchObject(ok);
    expect(await claimTask(db, work(a, first.id))).toMatchObject(ok);
    expect(await startTask(db, work(a, first.id))).toMatchObject(ok);
    expect(await blockTask(db, { ...work(a, first.id), reason: "Waiting" })).toMatchObject(ok);
    expect(await claimTask(db, { ...work(b, first.id), steal: true })).toMatchObject(ok);
    expect(await releaseTask(db, work(b, first.id))).toMatchObject(ok);
    expect(await claimTask(db, work(a, second.id))).toMatchObject(ok);
    expect(await doneTask(db, work(a, second.id))).toMatchObject(ok);
    expect(await claimTask(db, work(a, first.id))).toMatchObject(ok);
    expect(await endSession(db, { ...own(a), summary: "Done" })).toMatchObject(ok);

    // B lapses with a claim: the sweep records stale, abandoned and the release.
    expect(await claimTask(db, work(b, first.id))).toMatchObject(ok);
    await db
      .update(schema.agentSession)
      .set({ lastHeartbeatAt: sql`clock_timestamp() - interval '45 minutes'` })
      .where(eq(schema.agentSession.id, b));
    await db
      .update(schema.task)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '40 minutes'` })
      .where(eq(schema.task.id, first.id));
    expect(
      await sweepCoordination(db, {
        projectBatch: 10,
        sessionBatch: 10,
        deadline: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ sessionsAbandoned: 1, claimsReleased: 1 });
    expect(await endSession(db, { ...own(b), summary: "Late" })).toMatchObject(ok);

    const rows = await db
      .select()
      .from(schema.event)
      .where(eq(schema.event.projectId, project.id))
      .orderBy(asc(schema.event.seq));
    const types = rows.map((row) => toEventDto(row).type);
    expect(new Set(types)).toEqual(
      new Set([
        "session.started",
        "session.updated",
        "session.attached",
        "session.heartbeat",
        "task.claimed",
        "task.started",
        "task.blocked",
        "task.released",
        "task.done",
        "session.ended",
        "session.status_changed",
      ]),
    );
  });
});
