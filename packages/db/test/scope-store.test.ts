import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCoordinationRead } from "../src/coordination.ts";
import type { Db } from "../src/index.ts";
import type { Principal } from "../src/principal.ts";
import { agentSession } from "../src/schema/coordination.ts";
import { event } from "../src/schema/event.ts";
import { scope } from "../src/schema/scope.ts";
import {
  addDeclaredScope,
  canonicalTouchedPaths,
  checkScopeOverlap,
  finalizeCollection,
  listScopes,
  MAX_DECLARED_SCOPES_PER_SESSION,
  MAX_TOUCHED_SCOPES_PER_SESSION,
  type OverlapCursor,
  recordCollectionManifest,
  removeScope,
  type ScopeOverlapItem,
  summarizeProjectOverlaps,
  touchedPathsContentHash,
  uploadCollectionBatch,
} from "../src/scope-store.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertProject, insertSession, insertUser } from "./support/fixtures.ts";

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("touchedPathsContentHash", () => {
  it("matches the fixed test vector: distinct paths in code point order, each NUL-terminated", () => {
    const paths = ["b", "a/x.ts", "�", "\u{1F600}", "a/x.ts", ".env", "src/*.ts"];
    // Code point order puts U+FFFD before U+1F600; UTF-16 order would not.
    expect(canonicalTouchedPaths(paths)).toEqual([
      ".env",
      "a/x.ts",
      "b",
      "src/*.ts",
      "�",
      "\u{1F600}",
    ]);
    expect([...new Set(paths)].sort()).not.toEqual(canonicalTouchedPaths(paths));
    expect(touchedPathsContentHash(paths)).toBe(
      "6bf5b43e2c256e15f0fae101a3ec0fd06c0f42903f21c7daffb0bfd4e8061b12",
    );
  });

  it("hashes no paths as the empty string", () => {
    expect(touchedPathsContentHash([])).toBe(EMPTY_HASH);
  });
});

let testDb: TestDatabase;
let db: Db;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.drop();
});

const asUser = (userId: string): Principal => ({ kind: "user", userId });

/** A Project with a User acting in it and a helper that starts that User's Sessions. */
async function setup() {
  const { project, user } = await insertProject(db);
  const principal = asUser(user.id);
  const start = (overrides: Parameters<typeof insertSession>[3] = {}) =>
    insertSession(db, project.id, principal, overrides);
  return { projectId: project.id, principal, start };
}

/**
 * What heartbeat does when it opens a collection (the lifecycle rule): an
 * unfinished previous generation makes history incomplete, then the new
 * generation starts with no manifest.
 */
async function openCollection(sessionId: string): Promise<string> {
  const [row] = await db.select().from(agentSession).where(eq(agentSession.id, sessionId));
  if (!row) throw new Error("no session");
  const lost = row.collectionId !== null && !row.collectionComplete;
  const collectionId = randomUUID();
  await db
    .update(agentSession)
    .set({
      collectionId,
      collectionExpectedBatches: null,
      collectionPathCount: null,
      collectionContentHash: null,
      collectionComplete: false,
      ...(lost ? { scopeHistoryIncomplete: true } : {}),
    })
    .where(eq(agentSession.id, sessionId));
  return collectionId;
}

function batchesOf(paths: readonly string[]): string[][] {
  const sorted = canonicalTouchedPaths(paths);
  const batches: string[][] = [];
  for (let i = 0; i < sorted.length; i += 16) batches.push(sorted.slice(i, i + 16));
  return batches;
}

/** Runs a whole collection: open, manifest, every batch, finalize. */
async function collect(
  base: { projectId: string; principal: Principal },
  sessionId: string,
  paths: readonly string[],
) {
  const collectionId = await openCollection(sessionId);
  const input = { ...base, sessionId, collectionId };
  const batches = batchesOf(paths);
  const manifest = await recordCollectionManifest(db, {
    ...input,
    expectedBatches: batches.length,
    pathCount: canonicalTouchedPaths(paths).length,
    contentHash: touchedPathsContentHash(paths),
  });
  expect(manifest.status).toBe("ok");
  for (const [batchIndex, batch] of batches.entries()) {
    const uploaded = await uploadCollectionBatch(db, { ...input, batchIndex, paths: batch });
    expect(uploaded.status).toBe("ok");
  }
  const finalized = await finalizeCollection(db, input);
  expect(finalized.status).toBe("ok");
  return { collectionId, finalized };
}

/** Starts a Session whose last heartbeat was `ago` (a Postgres interval) before database now. */
async function startAgo(start: () => ReturnType<typeof insertSession>, ago: string) {
  const session = await start();
  await db
    .update(agentSession)
    .set({ lastHeartbeatAt: sql`now() - ${ago}::interval` })
    .where(eq(agentSession.id, session.id));
  return session;
}

async function sessionRow(sessionId: string) {
  const [row] = await db.select().from(agentSession).where(eq(agentSession.id, sessionId));
  if (!row) throw new Error("no session");
  return row;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ type: event.type })
    .from(event)
    .where(eq(event.sessionId, sessionId))
    .orderBy(event.seq);
  return rows.map((row) => row.type);
}

async function insertScopes(
  projectId: string,
  sessionId: string,
  source: "declared" | "touched",
  values: string[],
) {
  if (values.length === 0) return;
  await db.insert(scope).values(values.map((value) => ({ projectId, sessionId, source, value })));
}

/** Marks a Session's coverage complete, as a finalized collection would. */
async function markComplete(sessionId: string) {
  await db
    .update(agentSession)
    .set({
      collectionId: randomUUID(),
      collectionExpectedBatches: 0,
      collectionPathCount: 0,
      collectionContentHash: EMPTY_HASH,
      collectionComplete: true,
    })
    .where(eq(agentSession.id, sessionId));
}

describeDb("declared Scopes", () => {
  it("adds a normalized pattern once, with one Event, and ignores an equal repeat", async () => {
    const { projectId, principal, start } = await setup();
    const session = await start();
    const input = { projectId, sessionId: session.id, principal, pattern: "packages/**/**/db" };

    const first = await addDeclaredScope(db, input);
    expect(first).toMatchObject({
      status: "ok",
      created: true,
      scope: { value: "packages/**/db" },
    });
    const again = await addDeclaredScope(db, { ...input, pattern: "packages/**/db" });
    expect(again).toMatchObject({ status: "ok", created: false });
    if (first.status === "ok" && again.status === "ok") expect(again.scope.id).toBe(first.scope.id);
    expect(await eventTypes(session.id)).toEqual(["scope.added"]);
  });

  it("rejects invalid patterns before touching the database", async () => {
    const { projectId, principal, start } = await setup();
    const session = await start();
    for (const pattern of ["/abs", "a/../b", "{a,b}", "!a", "a\\b", "x".repeat(257)]) {
      const outcome = await addDeclaredScope(db, {
        projectId,
        sessionId: session.id,
        principal,
        pattern,
      });
      expect(outcome.status, pattern).toBe("invalid");
    }
    expect(await eventTypes(session.id)).toEqual([]);
  });

  it("is not_found for another Project's Session and forbidden for another owner's", async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await b.start();
    const other = await insertUser(db);
    const mine = await a.start();

    expect(
      await addDeclaredScope(db, {
        projectId: a.projectId,
        sessionId: foreign.id,
        principal: a.principal,
        pattern: "a",
      }),
    ).toEqual({ status: "not_found" });
    expect(
      await addDeclaredScope(db, {
        projectId: a.projectId,
        sessionId: mine.id,
        principal: asUser(other.id),
        pattern: "a",
      }),
    ).toEqual({ status: "forbidden" });
    expect(
      await addDeclaredScope(db, {
        projectId: a.projectId,
        sessionId: mine.id,
        principal: { kind: "project_key", keyId: randomUUID() },
        pattern: "a",
      }),
    ).toEqual({ status: "forbidden" });
  });

  it("rejects changes on stale, ended and abandoned Sessions", async () => {
    const { projectId, principal, start } = await setup();
    const sessions = [
      await startAgo(start, "5 minutes"),
      await start({ status: "ended", endedAt: new Date() }),
      await start({ status: "abandoned", endedAt: new Date() }),
    ];
    for (const session of sessions) {
      const outcome = await addDeclaredScope(db, {
        projectId,
        sessionId: session.id,
        principal,
        pattern: "a",
      });
      expect(outcome).toMatchObject({ status: "conflict", reason: "session_not_live" });
    }
  });

  it("allows 32 declared Scopes and refuses the 33rd without an Event", async () => {
    const { projectId, principal, start } = await setup();
    const session = await start();
    const values = Array.from({ length: MAX_DECLARED_SCOPES_PER_SESSION }, (_, i) => `d${i}/**`);
    await insertScopes(projectId, session.id, "declared", values);
    // A touched Scope does not count toward the declared limit.
    await insertScopes(projectId, session.id, "touched", ["t.ts"]);
    const input = { projectId, sessionId: session.id, principal };

    expect(await addDeclaredScope(db, { ...input, pattern: "extra" })).toMatchObject({
      status: "conflict",
      reason: "declared_capacity",
    });
    expect(await addDeclaredScope(db, { ...input, pattern: "d0/**" })).toMatchObject({
      status: "ok",
      created: false,
    });
    expect(await eventTypes(session.id)).toEqual([]);
  });

  it("removes a declared Scope once and treats repeats and other Sessions' ids as no-ops", async () => {
    const { projectId, principal, start } = await setup();
    const session = await start();
    const other = await start();
    const added = await addDeclaredScope(db, {
      projectId,
      sessionId: session.id,
      principal,
      pattern: "src/*",
    });
    const theirs = await addDeclaredScope(db, {
      projectId,
      sessionId: other.id,
      principal,
      pattern: "src/*",
    });
    if (added.status !== "ok" || theirs.status !== "ok") throw new Error("add failed");
    const input = { projectId, sessionId: session.id, principal };

    expect(await removeScope(db, { ...input, scopeId: theirs.scope.id })).toMatchObject({
      status: "ok",
      removed: false,
    });
    expect(await removeScope(db, { ...input, scopeId: added.scope.id })).toMatchObject({
      status: "ok",
      removed: true,
    });
    expect(await removeScope(db, { ...input, scopeId: added.scope.id })).toMatchObject({
      status: "ok",
      removed: false,
    });
    expect(await eventTypes(session.id)).toEqual(["scope.added", "scope.removed"]);
    const remaining = await db.select().from(scope).where(eq(scope.id, theirs.scope.id));
    expect(remaining).toHaveLength(1);
  });

  it("refuses to remove a touched Scope", async () => {
    const { projectId, principal, start } = await setup();
    const session = await start();
    await insertScopes(projectId, session.id, "touched", ["a.ts"]);
    const [row] = await db.select().from(scope).where(eq(scope.sessionId, session.id));
    if (!row) throw new Error("no scope");
    expect(
      await removeScope(db, { projectId, sessionId: session.id, principal, scopeId: row.id }),
    ).toMatchObject({ status: "conflict", reason: "touched_scope" });
  });
});

describeDb("listScopes", () => {
  it("pages one Session's Scopes oldest first", async () => {
    const { projectId, principal, start } = await setup();
    const session = await start();
    for (const pattern of ["e", "d", "c", "b", "a"]) {
      await addDeclaredScope(db, { projectId, sessionId: session.id, principal, pattern });
    }
    const seen: string[] = [];
    let after = null;
    for (let page = 0; page < 5; page++) {
      const result = await listScopes(db, { projectId, sessionId: session.id, limit: 2, after });
      if (result.status !== "ok") throw new Error(result.status);
      seen.push(...result.items.map((item) => item.value));
      after = result.nextCursor;
      if (!after) break;
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("lists only the live Sessions' Scopes of the Project and hides foreign Sessions", async () => {
    const a = await setup();
    const b = await setup();
    const live = await a.start();
    const stale = await startAgo(a.start, "5 minutes");
    const foreign = await b.start();
    await insertScopes(a.projectId, live.id, "declared", ["live"]);
    await insertScopes(a.projectId, stale.id, "declared", ["stale"]);
    await insertScopes(b.projectId, foreign.id, "declared", ["foreign"]);

    const result = await listScopes(db, { projectId: a.projectId });
    expect(result.status === "ok" && result.items.map((item) => item.value)).toEqual(["live"]);
    expect(await listScopes(db, { projectId: a.projectId, sessionId: foreign.id })).toEqual({
      status: "not_found",
    });
    const staleList = await listScopes(db, { projectId: a.projectId, sessionId: stale.id });
    expect(staleList.status === "ok" && staleList.items.map((item) => item.value)).toEqual([
      "stale",
    ]);
  });
});

describeDb("touched-path collections", () => {
  it("accepts a whole collection and makes coverage complete", async () => {
    const base = await setup();
    const session = await base.start();
    const paths = Array.from({ length: 20 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`);
    const { finalized } = await collect(base, session.id, paths);

    expect(finalized).toMatchObject({
      status: "ok",
      changed: true,
      collection: {
        expectedBatches: 2,
        pathCount: 20,
        omittedPathCount: 0,
        receivedBatchCount: 2,
        collectionComplete: true,
        scopeComplete: true,
      },
    });
    const touched = await db
      .select()
      .from(scope)
      .where(and(eq(scope.sessionId, session.id), eq(scope.source, "touched")));
    expect(touched).toHaveLength(20);
    expect(await eventTypes(session.id)).toEqual([
      "scope.touched",
      "scope.touched",
      "scope.collection_finalized",
    ]);
  });

  it("finishes an empty collection with the same explicit finalize", async () => {
    const base = await setup();
    const session = await base.start();
    const collectionId = await openCollection(session.id);
    const input = { ...base, sessionId: session.id, collectionId };
    expect((await sessionRow(session.id)).collectionComplete).toBe(false);
    expect(
      await recordCollectionManifest(db, {
        ...input,
        expectedBatches: 0,
        pathCount: 0,
        contentHash: EMPTY_HASH,
      }),
    ).toMatchObject({ status: "ok", changed: true });
    expect(await finalizeCollection(db, input)).toMatchObject({
      status: "ok",
      changed: true,
      collection: { scopeComplete: true },
    });
    expect(await finalizeCollection(db, input)).toMatchObject({ status: "ok", changed: false });
    expect(await eventTypes(session.id)).toEqual(["scope.collection_finalized"]);
  });

  it("replays an identical manifest and batch as no-ops and refuses changed ones", async () => {
    const base = await setup();
    const session = await base.start();
    const collectionId = await openCollection(session.id);
    const input = { ...base, sessionId: session.id, collectionId };
    const paths = ["a.ts", "b.ts"];
    const manifest = {
      ...input,
      expectedBatches: 1,
      pathCount: 2,
      contentHash: touchedPathsContentHash(paths),
    };

    expect(await recordCollectionManifest(db, manifest)).toMatchObject({ changed: true });
    expect(await recordCollectionManifest(db, manifest)).toMatchObject({
      status: "ok",
      changed: false,
    });
    for (const changed of [
      { pathCount: 1, expectedBatches: 1 },
      { contentHash: EMPTY_HASH },
      { omittedPathCount: 1 },
    ]) {
      expect(await recordCollectionManifest(db, { ...manifest, ...changed })).toMatchObject({
        status: "conflict",
        reason: "manifest_conflict",
      });
    }

    const batch = { ...input, batchIndex: 0, paths };
    expect(await uploadCollectionBatch(db, batch)).toMatchObject({
      status: "ok",
      changed: true,
      storedPathCount: 2,
    });
    expect(await uploadCollectionBatch(db, batch)).toMatchObject({
      status: "ok",
      changed: false,
      storedPathCount: 2,
      overCapacityPathCount: 0,
    });
    expect(await uploadCollectionBatch(db, { ...batch, paths: ["a.ts", "c.ts"] })).toMatchObject({
      status: "conflict",
      reason: "batch_conflict",
    });
    expect(await eventTypes(session.id)).toEqual(["scope.touched"]);
    const touched = await db.select().from(scope).where(eq(scope.sessionId, session.id));
    expect(touched.map((row) => row.value).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("resumes an interrupted collection with the same id", async () => {
    const base = await setup();
    const session = await base.start();
    const collectionId = await openCollection(session.id);
    const input = { ...base, sessionId: session.id, collectionId };
    const paths = Array.from({ length: 17 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const [first, second] = batchesOf(paths);
    if (!first || !second) throw new Error("expected two batches");
    await recordCollectionManifest(db, {
      ...input,
      expectedBatches: 2,
      pathCount: 17,
      contentHash: touchedPathsContentHash(paths),
    });
    await uploadCollectionBatch(db, { ...input, batchIndex: 0, paths: first });

    expect(await finalizeCollection(db, input)).toMatchObject({
      status: "conflict",
      reason: "batches_missing",
    });
    expect((await sessionRow(session.id)).collectionComplete).toBe(false);

    // The retry repeats everything; accepted steps are no-ops.
    await recordCollectionManifest(db, {
      ...input,
      expectedBatches: 2,
      pathCount: 17,
      contentHash: touchedPathsContentHash(paths),
    });
    expect(
      await uploadCollectionBatch(db, { ...input, batchIndex: 0, paths: first }),
    ).toMatchObject({ changed: false });
    await uploadCollectionBatch(db, { ...input, batchIndex: 1, paths: second });
    expect(await finalizeCollection(db, input)).toMatchObject({
      status: "ok",
      collection: { scopeComplete: true },
    });
  });

  it("refuses an obsolete collection, so a delayed finalize cannot clear a newer warning", async () => {
    const base = await setup();
    const session = await base.start();
    const old = await openCollection(session.id);
    const oldInput = { ...base, sessionId: session.id, collectionId: old };
    const paths = ["a.ts"];
    await recordCollectionManifest(db, {
      ...oldInput,
      expectedBatches: 1,
      pathCount: 1,
      contentHash: touchedPathsContentHash(paths),
    });
    await uploadCollectionBatch(db, { ...oldInput, batchIndex: 0, paths });

    // A newer heartbeat supersedes the unfinished collection.
    const current = await openCollection(session.id);
    expect(current).not.toBe(old);

    expect(await finalizeCollection(db, oldInput)).toMatchObject({
      status: "conflict",
      reason: "obsolete_collection",
    });
    expect(await uploadCollectionBatch(db, { ...oldInput, batchIndex: 0, paths })).toMatchObject({
      status: "conflict",
      reason: "obsolete_collection",
    });
    expect(
      await recordCollectionManifest(db, {
        ...oldInput,
        expectedBatches: 1,
        pathCount: 1,
        contentHash: touchedPathsContentHash(paths),
      }),
    ).toMatchObject({ status: "conflict", reason: "obsolete_collection" });
    const row = await sessionRow(session.id);
    expect(row.collectionComplete).toBe(false);
    expect(row.scopeHistoryIncomplete).toBe(true);
    expect(await eventTypes(session.id)).toEqual(["scope.touched"]);
  });

  it("is a conflict without a collection or manifest, and for an out-of-range batch", async () => {
    const base = await setup();
    const session = await base.start();
    const input = { ...base, sessionId: session.id, collectionId: randomUUID() };
    expect(await finalizeCollection(db, input)).toMatchObject({ reason: "no_collection" });

    const collectionId = await openCollection(session.id);
    const current = { ...input, collectionId };
    expect(
      await uploadCollectionBatch(db, { ...current, batchIndex: 0, paths: ["a"] }),
    ).toMatchObject({ reason: "manifest_missing" });
    expect(await finalizeCollection(db, current)).toMatchObject({ reason: "manifest_missing" });
    await recordCollectionManifest(db, {
      ...current,
      expectedBatches: 1,
      pathCount: 1,
      contentHash: touchedPathsContentHash(["a"]),
    });
    expect(
      await uploadCollectionBatch(db, { ...current, batchIndex: 1, paths: ["b"] }),
    ).toMatchObject({ reason: "batch_out_of_range" });
  });

  it("refuses to finalize when the accepted paths do not match the manifest", async () => {
    const base = await setup();
    const session = await base.start();
    const collectionId = await openCollection(session.id);
    const input = { ...base, sessionId: session.id, collectionId };
    await recordCollectionManifest(db, {
      ...input,
      expectedBatches: 2,
      pathCount: 2,
      contentHash: touchedPathsContentHash(["a", "b"]),
    });
    // The same path in both batches: right count of batches, wrong content.
    await uploadCollectionBatch(db, { ...input, batchIndex: 0, paths: ["a"] });
    await uploadCollectionBatch(db, { ...input, batchIndex: 1, paths: ["a"] });
    expect(await finalizeCollection(db, input)).toMatchObject({
      status: "conflict",
      reason: "manifest_mismatch",
    });
    expect((await sessionRow(session.id)).collectionComplete).toBe(false);
  });

  it("keeps lost history sticky across later complete and empty collections", async () => {
    const base = await setup();
    const session = await base.start();
    // An unfinished collection is superseded: its missing paths are unknown.
    await openCollection(session.id);
    const { finalized } = await collect(base, session.id, ["a.ts"]);
    expect(finalized).toMatchObject({
      collection: { collectionComplete: true, scopeHistoryIncomplete: true, scopeComplete: false },
    });
    const empty = await collect(base, session.id, []);
    expect(empty.finalized).toMatchObject({
      collection: { collectionComplete: true, scopeComplete: false },
    });
  });

  it("deduplicates touched paths across collections, apart from declared Scopes", async () => {
    const base = await setup();
    const session = await base.start();
    await addDeclaredScope(db, { ...base, sessionId: session.id, pattern: "a.ts" });
    await collect(base, session.id, ["a.ts", "b.ts"]);
    await collect(base, session.id, ["b.ts", "c.ts"]);
    const rows = await db.select().from(scope).where(eq(scope.sessionId, session.id));
    expect(rows.map((row) => `${row.source}:${row.value}`).sort()).toEqual([
      "declared:a.ts",
      "touched:a.ts",
      "touched:b.ts",
      "touched:c.ts",
    ]);
  });

  it("stores touched paths up to the limit, then reports the rest and loses coverage once", async () => {
    const base = await setup();
    const session = await base.start();
    await insertScopes(
      base.projectId,
      session.id,
      "touched",
      Array.from({ length: MAX_TOUCHED_SCOPES_PER_SESSION - 6 }, (_, i) => `old/${i}`),
    );
    const collectionId = await openCollection(session.id);
    const input = { ...base, sessionId: session.id, collectionId };
    // Ten paths, one already stored: nine new, six fit.
    const paths = canonicalTouchedPaths([
      "old/0",
      ...Array.from({ length: 9 }, (_, i) => `new/${i}`),
    ]);
    await recordCollectionManifest(db, {
      ...input,
      expectedBatches: 1,
      pathCount: 10,
      contentHash: touchedPathsContentHash(paths),
    });
    const batch = { ...input, batchIndex: 0, paths };
    expect(await uploadCollectionBatch(db, batch)).toMatchObject({
      status: "ok",
      storedPathCount: 7,
      overCapacityPathCount: 3,
      collection: { scopeHistoryIncomplete: true, scopeComplete: false },
    });
    expect(await uploadCollectionBatch(db, batch)).toMatchObject({
      changed: false,
      storedPathCount: 7,
      overCapacityPathCount: 3,
    });
    expect(await finalizeCollection(db, input)).toMatchObject({
      status: "ok",
      collection: { collectionComplete: true, scopeComplete: false },
    });
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(scope)
      .where(and(eq(scope.sessionId, session.id), eq(scope.source, "touched")));
    expect(n).toBe(MAX_TOUCHED_SCOPES_PER_SESSION);
    expect(await eventTypes(session.id)).toEqual([
      "scope.touched",
      "scope.coverage_lost",
      "scope.collection_finalized",
    ]);
  });

  it("loses coverage for omitted and unrepresentable paths and rejects invalid ones", async () => {
    const base = await setup();
    const omitted = await base.start();
    const collectionId = await openCollection(omitted.id);
    expect(
      await recordCollectionManifest(db, {
        ...base,
        sessionId: omitted.id,
        collectionId,
        expectedBatches: 0,
        pathCount: 0,
        omittedPathCount: 2,
        contentHash: EMPTY_HASH,
      }),
    ).toMatchObject({ collection: { omittedPathCount: 2, scopeHistoryIncomplete: true } });

    for (const bad of ["a/\uD800", "x".repeat(257)]) {
      const session = await base.start();
      const id = await openCollection(session.id);
      const input = { ...base, sessionId: session.id, collectionId: id };
      await recordCollectionManifest(db, {
        ...input,
        expectedBatches: 1,
        pathCount: 2,
        contentHash: touchedPathsContentHash(["a", bad]),
      });
      expect(
        await uploadCollectionBatch(db, { ...input, batchIndex: 0, paths: ["a", bad] }),
      ).toMatchObject({ status: "conflict", reason: "unrepresentable_paths" });
      const row = await sessionRow(session.id);
      expect(row.scopeHistoryIncomplete).toBe(true);
      expect(await eventTypes(session.id)).toEqual(["scope.coverage_lost"]);
    }

    const session = await base.start();
    const id = await openCollection(session.id);
    for (const paths of [["../x"], ["/abs"], ["a//b"], ["b", "a"], ["a", "a"], []]) {
      const outcome = await uploadCollectionBatch(db, {
        ...base,
        sessionId: session.id,
        collectionId: id,
        batchIndex: 0,
        paths,
      });
      expect(outcome.status, JSON.stringify(paths)).toBe("invalid");
    }
    expect((await sessionRow(session.id)).scopeHistoryIncomplete).toBe(false);
  });

  it("applies owner and liveness checks to every collection step", async () => {
    const base = await setup();
    const session = await base.start();
    const collectionId = await openCollection(session.id);
    const other = await insertUser(db);
    const input = { ...base, sessionId: session.id, collectionId, principal: asUser(other.id) };
    expect(await finalizeCollection(db, input)).toEqual({ status: "forbidden" });

    await db
      .update(agentSession)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(agentSession.id, session.id));
    expect(await finalizeCollection(db, { ...input, principal: base.principal })).toMatchObject({
      status: "conflict",
      reason: "session_not_live",
    });
  });
});

/** Overlap items as `selected value ~ other value @ witness`. */
function describeItems(items: readonly ScopeOverlapItem[]): string[] {
  return items.map(
    (item) =>
      `${item.scope.source}:${item.scope.value} ~ ${item.otherScope.source}:${item.otherScope.value} @ ${item.witness}`,
  );
}

describeDb("checkScopeOverlap", () => {
  /** Two complete live Sessions with the given Scopes, compared from the first. */
  async function pair(
    mine: { declared?: string[]; touched?: string[] },
    theirs: { declared?: string[]; touched?: string[] },
  ) {
    const { projectId, start } = await setup();
    const selected = await start();
    const other = await start();
    for (const [session, values] of [
      [selected, mine],
      [other, theirs],
    ] as const) {
      await insertScopes(projectId, session.id, "declared", values.declared ?? []);
      await insertScopes(projectId, session.id, "touched", values.touched ?? []);
      await markComplete(session.id);
    }
    const result = await checkScopeOverlap(db, { projectId, sessionId: selected.id });
    if (result.status !== "ok") throw new Error(result.status);
    return { result, projectId, selected, other };
  }

  it.each([
    [
      "declared/declared",
      { declared: ["packages/**"] },
      { declared: ["packages/db/**"] },
      ["declared:packages/** ~ declared:packages/db/** @ packages/db"],
    ],
    [
      "declared/touched",
      { declared: ["src/*.ts"] },
      { touched: ["src/a.ts"] },
      ["declared:src/*.ts ~ touched:src/a.ts @ src/a.ts"],
    ],
    [
      "touched/declared",
      { touched: ["src/a.ts"] },
      { declared: ["src/**"] },
      ["touched:src/a.ts ~ declared:src/** @ src/a.ts"],
    ],
    [
      "touched/touched",
      { touched: ["a.ts", "b.ts"] },
      { touched: ["b.ts", "c.ts"] },
      ["touched:b.ts ~ touched:b.ts @ b.ts"],
    ],
    ["disjoint suffixes", { declared: ["src/*.ts"] }, { declared: ["src/*.tsx"] }, []],
    ["dotfiles", { declared: ["*"] }, { touched: [".env"] }, ["declared:* ~ touched:.env @ .env"]],
    [
      "Unicode",
      { declared: ["docs/ü*.md"] },
      { touched: ["docs/über.md", "docs/uber.md"] },
      ["declared:docs/ü*.md ~ touched:docs/über.md @ docs/über.md"],
    ],
    ["literal wildcard names", { touched: ["src/*.ts"] }, { touched: ["src/a.ts"] }, []],
    [
      "glob vs literal wildcard name",
      { declared: ["src/*.ts"] },
      { touched: ["src/*.ts"] },
      ["declared:src/*.ts ~ touched:src/*.ts @ src/*.ts"],
    ],
    [
      "zero-directory **",
      { declared: ["**/x.ts"] },
      { touched: ["x.ts"] },
      ["declared:**/x.ts ~ touched:x.ts @ x.ts"],
    ],
    [
      "valid alternative to . and ..",
      { declared: ["*", "*/x"] },
      { declared: [".*", "..*/x"] },
      ["declared:* ~ declared:.* @ .a", "declared:*/x ~ declared:..*/x @ ..a/x"],
    ],
  ])("%s", async (_, mine, theirs, expected) => {
    const { result } = await pair(mine, theirs);
    expect(describeItems(result.items).sort()).toEqual([...expected].sort());
    expect(result).toMatchObject({ complete: true, reasons: [], warning: null, nextCursor: null });
  });

  it("never compares another Project's Sessions", async () => {
    const a = await setup();
    const b = await setup();
    const selected = await a.start();
    const foreign = await b.start();
    await insertScopes(a.projectId, selected.id, "declared", ["**"]);
    await insertScopes(b.projectId, foreign.id, "touched", ["a.ts"]);
    await markComplete(selected.id);
    const result = await checkScopeOverlap(db, { projectId: a.projectId, sessionId: selected.id });
    expect(result).toMatchObject({ status: "ok", items: [], complete: true });
    expect(await checkScopeOverlap(db, { projectId: a.projectId, sessionId: foreign.id })).toEqual({
      status: "not_found",
    });
  });

  it("leaves out stale, ended and abandoned Sessions from the five-minute boundary", async () => {
    const { projectId, start } = await setup();
    const selected = await start();
    await insertScopes(projectId, selected.id, "declared", ["**"]);
    await markComplete(selected.id);
    const live = await startAgo(start, "4 minutes 50 seconds");
    const excluded = [
      await startAgo(start, "5 minutes"),
      await start({ status: "ended", endedAt: new Date() }),
      await start({ status: "abandoned", endedAt: new Date() }),
      await start({ status: "stale" }),
    ];
    for (const session of [live, ...excluded]) {
      await insertScopes(projectId, session.id, "touched", [`${session.id}.ts`]);
      await markComplete(session.id);
    }
    const result = await checkScopeOverlap(db, { projectId, sessionId: selected.id });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.items.map((item) => item.otherSessionId)).toEqual([live.id]);
    expect(result.complete).toBe(true);
  });

  it("is incomplete with a warning when any compared Session's coverage is incomplete", async () => {
    const { projectId, start } = await setup();
    const selected = await start();
    const other = await start();
    await markComplete(selected.id);
    // `other` never finalized a collection.
    const result = await checkScopeOverlap(db, { projectId, sessionId: selected.id });
    expect(result).toMatchObject({
      status: "ok",
      items: [],
      complete: false,
      reasons: [{ kind: "scope_incomplete", sessionIds: [other.id] }],
      incompleteSessionIds: [other.id],
    });
    if (result.status === "ok") expect(result.warning).toMatch(/not an all-clear/);
  });

  it("is incomplete when a finalized Session lost historical coverage", async () => {
    const { projectId, start } = await setup();
    const selected = await start();
    await markComplete(selected.id);
    await db
      .update(agentSession)
      .set({ scopeHistoryIncomplete: true })
      .where(eq(agentSession.id, selected.id));
    await markComplete((await start()).id);
    const result = await checkScopeOverlap(db, { projectId, sessionId: selected.id });
    expect(result).toMatchObject({
      complete: false,
      reasons: [{ kind: "scope_incomplete", sessionIds: [selected.id] }],
    });
  });

  it("pages candidates and results independently and is complete only at the clean end", async () => {
    const { projectId, start } = await setup();
    const selected = await start();
    await insertScopes(projectId, selected.id, "declared", ["**"]);
    await markComplete(selected.id);
    for (let i = 0; i < 3; i++) {
      const other = await start();
      await insertScopes(projectId, other.id, "touched", ["a.ts", "b.ts"]);
      await markComplete(other.id);
    }

    const pages: { items: number; complete: boolean; reasons: string[] }[] = [];
    let cursor: OverlapCursor | null = null;
    for (let i = 0; i < 10; i++) {
      const result = await checkScopeOverlap(db, {
        projectId,
        sessionId: selected.id,
        cursor,
        candidateLimit: 2,
        resultLimit: 3,
      });
      if (result.status !== "ok") throw new Error(result.status);
      pages.push({
        items: result.items.length,
        complete: result.complete,
        reasons: result.reasons.map((reason) => reason.kind),
      });
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(pages).toEqual([
      { items: 3, complete: false, reasons: ["results_continued", "candidates_continued"] },
      { items: 1, complete: false, reasons: ["candidates_continued"] },
      { items: 2, complete: true, reasons: [] },
    ]);
  });

  it("carries an earlier page's gap to the last page", async () => {
    const { projectId, start } = await setup();
    const selected = await start();
    await markComplete(selected.id);
    await start(); // incomplete coverage
    const complete = await start();
    await markComplete(complete.id);

    let cursor: OverlapCursor | null = null;
    let last = null;
    for (let i = 0; i < 5; i++) {
      const result = await checkScopeOverlap(db, {
        projectId,
        sessionId: selected.id,
        cursor,
        candidateLimit: 1,
      });
      if (result.status !== "ok") throw new Error(result.status);
      last = result;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(last?.complete).toBe(false);
  });

  it("reports comparison budget exhaustion as incomplete, never as all-clear", async () => {
    const { projectId, start } = await setup();
    const selected = await start();
    const other = await start();
    for (const session of [selected, other]) {
      await insertScopes(
        projectId,
        session.id,
        "declared",
        Array.from({ length: 32 }, (_, i) => `${session.id}/d${i}/*.ts`),
      );
      await insertScopes(
        projectId,
        session.id,
        "touched",
        Array.from({ length: 96 }, (_, i) => `${session.id}/t${i}.ts`),
      );
      await markComplete(session.id);
    }
    const result = await checkScopeOverlap(db, { projectId, sessionId: selected.id });
    expect(result).toMatchObject({
      status: "ok",
      items: [],
      complete: false,
      reasons: [{ kind: "comparison_budget_exhausted", sessionIds: [other.id] }],
    });
  });

  it("reports a stored invalid Scope as incomplete", async () => {
    const { projectId, start } = await setup();
    const selected = await start();
    const other = await start();
    await insertScopes(projectId, other.id, "declared", ["{a,b}"]);
    await markComplete(selected.id);
    await markComplete(other.id);
    const result = await checkScopeOverlap(db, { projectId, sessionId: selected.id });
    expect(result).toMatchObject({
      complete: false,
      reasons: [{ kind: "invalid_scope", sessionId: other.id }],
    });
  });
});

describeDb("summarizeProjectOverlaps", () => {
  it("reports each overlapping pair once and caps the Sessions it compares", async () => {
    const { projectId, start } = await setup();
    const sessions = [await start(), await start(), await start()];
    for (const session of sessions) {
      await insertScopes(projectId, session.id, "touched", ["shared.ts"]);
      await markComplete(session.id);
    }
    const all = await withCoordinationRead(db, (context) =>
      summarizeProjectOverlaps(context, { projectId }),
    );
    expect(all.overlaps).toHaveLength(3);
    expect(all.complete).toBe(true);

    const capped = await withCoordinationRead(db, (context) =>
      summarizeProjectOverlaps(context, { projectId, sessionLimit: 2, overlapLimit: 100 }),
    );
    expect(capped.overlaps).toHaveLength(1);
    expect(capped).toMatchObject({
      complete: false,
      reasons: [{ kind: "sessions_capped", limit: 2 }],
    });
  });
});
