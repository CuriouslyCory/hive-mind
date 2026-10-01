import { randomUUID } from "node:crypto";
import { EVENT_TYPES } from "@hivemind/contract";
import {
  addDeclaredScope,
  addTask,
  appendPlanLog,
  attachSession,
  blockTask,
  claimTask,
  createPlan,
  creatorColumns,
  doneTask,
  EVENT_PAYLOAD_VERSIONS,
  endSession,
  finalizeCollection,
  heartbeatSession,
  type Principal,
  recordCollectionManifest,
  releaseTask,
  removeScope,
  schema,
  setPlanStatus,
  startSession,
  startTask,
  sweepCoordination,
  touchedPathsContentHash,
  updatePlan,
  updateSession,
  uploadCollectionBatch,
} from "@hivemind/db";
import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { toEventDto } from "../src/server/api/coordination-dto";

// The Event catalog of @hivemind/db (src/event.ts) and the contract's
// `eventSchema` must name the same types with the same payloads: Event reads
// return stored rows as they are, so a mismatch would make them fail with
// 500. This produces one Event of every type through the db helpers and reads
// each back through the API's DTO, which validates it against the contract.

let testDb: TestDatabase;

describeDb("the Event catalog", () => {
  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it("has the contract's types, and every written Event matches eventSchema", async () => {
    expect(Object.keys(EVENT_PAYLOAD_VERSIONS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("writes Events that match the contract's eventSchema, one of every type", async () => {
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
    const created = await createPlan(db, {
      projectId: project.id,
      principal,
      id: randomUUID(),
      title: "Plan",
      status: "active",
    });
    if (created.status !== "created") throw new Error("setup");
    const { plan } = created.plan;
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

    // Plans and Tasks.
    const writer = { projectId: project.id, principal };
    const planId = randomUUID();
    expect(await createPlan(db, { ...writer, id: planId, title: "Second" })).toMatchObject({
      status: "created",
    });
    expect(await updatePlan(db, { ...writer, ref: planId, title: "Renamed" })).toMatchObject({
      status: "ok",
      changed: true,
    });
    expect(
      await appendPlanLog(db, { ...writer, ref: planId, eventId: randomUUID(), message: "Note" }),
    ).toMatchObject({ status: "created" });
    expect(
      await addTask(db, { ...writer, ref: planId, taskId: randomUUID(), title: "More" }),
    ).toMatchObject({ status: "created" });
    expect(await setPlanStatus(db, { ...writer, ref: planId, status: "active" })).toMatchObject({
      status: "ok",
      changed: true,
    });

    // Scopes and a touched-path collection, then a collection superseded
    // before it was finalized, which loses coverage for good.
    const c = await start();
    const added = await addDeclaredScope(db, { ...own(c), pattern: "apps/web/**" });
    if (added.status !== "ok") throw new Error(`addDeclaredScope: ${added.status}`);
    expect(await removeScope(db, { ...own(c), scopeId: added.scope.id })).toMatchObject({
      status: "ok",
      removed: true,
    });
    const collectionId = randomUUID();
    expect(await heartbeatSession(db, { ...own(c), collectionId })).toMatchObject(ok);
    const paths = ["README.md"];
    const collection = { ...own(c), collectionId };
    expect(
      await recordCollectionManifest(db, {
        ...collection,
        expectedBatches: 1,
        pathCount: 1,
        contentHash: touchedPathsContentHash(paths),
      }),
    ).toMatchObject(ok);
    expect(await uploadCollectionBatch(db, { ...collection, batchIndex: 0, paths })).toMatchObject(
      ok,
    );
    expect(await finalizeCollection(db, collection)).toMatchObject(ok);
    expect(await heartbeatSession(db, { ...own(c), collectionId: randomUUID() })).toMatchObject(ok);
    expect(await heartbeatSession(db, { ...own(c), collectionId: randomUUID() })).toMatchObject(ok);

    const rows = await db
      .select()
      .from(schema.event)
      .where(eq(schema.event.projectId, project.id))
      .orderBy(asc(schema.event.seq));
    const types = rows.map((row) => toEventDto(row).type);
    expect([...new Set(types)].sort()).toEqual(Object.keys(EVENT_PAYLOAD_VERSIONS).sort());
    expect(rows.find((row) => row.type === "scope.coverage_lost")?.payload).toMatchObject({
      reason: "collection_superseded",
    });
  });
});
