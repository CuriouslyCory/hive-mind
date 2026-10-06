import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type ReserveAdrOutcome,
  reserveAdr,
  type SyncAdrsOutcome,
  storeAdrContents,
  syncAdrs,
} from "../src/adr.ts";
import type { Db } from "../src/index.ts";
import type { Principal } from "../src/principal.ts";
import { apikey } from "../src/schema/auth.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import {
  type AdrFile,
  adrEvents,
  adrFiles,
  adrRows,
  commitSha,
  projectAdrState,
} from "./support/adr.ts";
import { insertProject, insertProjectKey } from "./support/fixtures.ts";
import { gate, holdProjectLock, onePools, waitForLockWaiters } from "./support/lifecycle.ts";

// Races between ADR reservations and syncs, each on its own connection
// (pattern of test/coordination-races.test.ts and test/project.test.ts).

let testDb: TestDatabase;
let pools: ReturnType<typeof onePools>;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
  pools = onePools(testDb, 7);
});

afterAll(async () => {
  await pools?.end();
  await testDb?.drop();
});

async function setup() {
  const { project, user } = await insertProject(testDb.db);
  const principal: Principal = { kind: "user", userId: user.id };
  return { projectId: project.id, principal };
}

interface Context {
  projectId: string;
  principal: Principal;
}

function reserve(
  db: Db,
  context: Context,
  floor = 0,
  id: string = randomUUID(),
): Promise<ReserveAdrOutcome> {
  return reserveAdr(db, {
    ...context,
    id,
    title: "Concurrent decision",
    slug: "concurrent-decision",
    floor,
  });
}

/**
 * Holds a row lock on the Project row on `db` until released. Every
 * reservation reads the counter, then waits here to write it: without the
 * Project lock, all of them read the same counter first.
 */
async function holdProjectRow(db: Db, projectId: string) {
  const held = gate();
  const released = gate();
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`select id from project where id = ${projectId} for update`);
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

/** A sync of `files` as `sha` on `base`, for `queueBehindRow` and `queueBehindLock`. */
function syncOf(context: Context, sha: string, files: AdrFile[], base: string | null = null) {
  return (db: Db) =>
    syncAdrs(db, {
      ...context,
      commitSha: sha,
      baseCommitSha: base,
      forced: false,
      entries: files.map((f) => f.entry),
    });
}

/**
 * Starts `operations` in order behind a row lock on the Project row (see
 * `holdProjectRow`). The first takes the Project lock and reads before it
 * waits for the row; each later one queues on the Project lock. Without the
 * Project lock, every operation would read before any of them writes.
 */
async function queueBehindRow<T>(
  projectId: string,
  operations: ((db: Db) => Promise<T>)[],
): Promise<T[]> {
  const holder = await holdProjectRow(pools.db(0), projectId);
  const pending: Promise<T>[] = [];
  for (const [index, operation] of operations.entries()) {
    pending.push(operation(pools.db(index + 1)));
    await waitForLockWaiters(testDb, index + 1, "any");
  }
  await holder.release();
  return Promise.all(pending);
}

/** Starts `operations` in order, each queued on the Project lock before the next starts. */
async function queueBehindLock<T>(
  projectId: string,
  operations: ((db: Db) => Promise<T>)[],
): Promise<T[]> {
  const holder = await holdProjectLock(pools.db(0), projectId);
  const pending: Promise<T>[] = [];
  for (const [index, operation] of operations.entries()) {
    pending.push(operation(pools.db(index + 1)));
    await waitForLockWaiters(testDb, index + 1);
  }
  await holder.release();
  return Promise.all(pending);
}

describeDb("ADR races", () => {
  it("gives five concurrent reservations distinct, consecutive numbers", async () => {
    const context = await setup();
    const holder = await holdProjectRow(pools.db(0), context.projectId);
    const pending = [1, 2, 3, 4, 5].map((index) => reserve(pools.db(index), context));
    // One reservation waits for the row, the others for the Project lock.
    await waitForLockWaiters(testDb, 5, "any");
    await holder.release();

    const results = await Promise.all(pending);

    const numbers = results.map((result) => (result.status === "created" ? result.adr.number : 0));
    expect(numbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect((await projectAdrState(testDb.db, context.projectId)).nextAdrNumber).toBe(6);
    expect(await adrEvents(testDb.db, context.projectId)).toHaveLength(5);
  });

  it("gives a replaying sixth contender its reservation's number, and takes no number for it", async () => {
    const context = await setup();
    const ids = [1, 2, 3, 4, 5].map(() => randomUUID());
    const repeated = ids[2] ?? "";
    const holder = await holdProjectRow(pools.db(0), context.projectId);
    const pending = [...ids, repeated].map((id, index) =>
      reserve(pools.db(index + 1), context, 0, id),
    );
    await waitForLockWaiters(testDb, 6, "any");
    await holder.release();

    const results = await Promise.all(pending);

    const outcomes = results.map((result) =>
      result.status === "created" || result.status === "replay"
        ? { status: result.status, id: result.adr.id, number: result.adr.number }
        : { status: result.status, id: null, number: null },
    );
    const twins = outcomes.filter((outcome) => outcome.id === repeated);
    expect(outcomes.filter((outcome) => outcome.status === "created")).toHaveLength(5);
    expect(twins.map((outcome) => outcome.status).sort()).toEqual(["created", "replay"]);
    expect(twins[0]?.number).toBe(twins[1]?.number);
    const events = await adrEvents(testDb.db, context.projectId);
    expect(events.map((e) => (e.payload as { number: number }).number).sort()).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(await reserve(testDb.db, context)).toMatchObject({
      status: "created",
      adr: { number: 6 },
    });
  });

  it.each(["the reservation", "the sync"] as const)(
    "orders a reservation without a floor and a sync of 0001-0014 when %s takes the Project lock first",
    async (first) => {
      const context = await setup();
      const files = adrFiles(14);
      await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
      const reservation = (db: Db) => reserve(db, context, 0);
      const sync = syncOf(context, commitSha(), files);

      const results = await queueBehindRow<unknown>(
        context.projectId,
        first === "the reservation" ? [reservation, sync] : [sync, reservation],
      );
      const reserved = results[first === "the reservation" ? 0 : 1] as ReserveAdrOutcome;
      const synced = results[first === "the reservation" ? 1 : 0] as SyncAdrsOutcome;

      const rows = await adrRows(testDb.db, context.projectId);
      expect((await projectAdrState(testDb.db, context.projectId)).nextAdrNumber).toBe(
        first === "the reservation" ? 15 : 16,
      );
      if (first === "the reservation") {
        // The file 0001 took the reserved number; the reservation is kept.
        expect(reserved).toMatchObject({ status: "created", adr: { number: 1 } });
        expect(synced).toMatchObject({
          status: "ok",
          summary: {
            added: 14,
            nextNumber: 15,
            notices: expect.arrayContaining([
              expect.objectContaining({ code: "ADR_RESERVATION_TAKEN", number: 1 }),
            ]),
          },
        });
        expect(rows).toHaveLength(14);
        expect(rows[0]).toMatchObject({
          number: 1,
          state: "published",
          slug: "decision-1",
          reservedTitle: "Concurrent decision",
          reservedSlug: "concurrent-decision",
        });
      } else {
        expect(synced).toMatchObject({ status: "ok", summary: { added: 14, nextNumber: 15 } });
        expect(reserved).toMatchObject({ status: "created", adr: { number: 15 } });
        expect(rows.map((row) => [row.number, row.state])).toEqual([
          ...files.map((f) => [f.entry.number, "published"]),
          [15, "reserved"],
        ]);
      }
    },
  );

  it.each(["the reservation", "the sync"] as const)(
    "gives a reservation racing a sync of 0001-0014 at least 15 when %s runs first",
    async (first) => {
      const context = await setup();
      const files = adrFiles(14);
      await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
      // `adr new` sends the highest number it saw on the default branch.
      const reservation = (db: Db) => reserve(db, context, 14);
      const sync = (db: Db) =>
        syncAdrs(db, {
          ...context,
          commitSha: commitSha(),
          baseCommitSha: null,
          forced: false,
          entries: files.map((f) => f.entry),
        });

      const [a, b] =
        first === "the reservation"
          ? await queueBehindLock<unknown>(context.projectId, [reservation, sync])
          : await queueBehindLock<unknown>(context.projectId, [sync, reservation]);
      const reserved = (first === "the reservation" ? a : b) as ReserveAdrOutcome;
      const synced = (first === "the reservation" ? b : a) as Awaited<ReturnType<typeof sync>>;

      expect(synced).toMatchObject({ status: "ok", summary: { added: 14 } });
      expect(reserved).toMatchObject({ status: "created", adr: { number: 15 } });
      const rows = await adrRows(testDb.db, context.projectId);
      expect(rows.map((row) => [row.number, row.state])).toEqual([
        ...files.map((f) => [f.entry.number, "published"]),
        [15, "reserved"],
      ]);
      expect((await projectAdrState(testDb.db, context.projectId)).nextAdrNumber).toBe(16);
    },
  );

  it("lets exactly one of two syncs on the same base apply, behind a row lock", async () => {
    const context = await setup();
    const files = adrFiles(3);
    await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
    const shas = [commitSha(), commitSha()];

    const results = await queueBehindRow(context.projectId, [
      syncOf(context, shas[0] ?? "", files),
      syncOf(context, shas[1] ?? "", files.slice(0, 2)),
    ]);

    expect(results.map((result) => result.status)).toEqual(["ok", "stale_base"]);
    expect(results[1]).toEqual({ status: "stale_base", currentCommitSha: shas[0] });
    expect((await projectAdrState(testDb.db, context.projectId)).adrSyncedCommitSha).toBe(shas[0]);
    const events = await adrEvents(testDb.db, context.projectId);
    expect(events.map((event) => event.type)).toEqual(["adr.synced"]);
    expect((await adrRows(testDb.db, context.projectId)).map((row) => row.state)).toEqual([
      "published",
      "published",
      "published",
    ]);
  });

  it("answers the second of two identical syncs as a replay", async () => {
    const context = await setup();
    const files = adrFiles(3);
    await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
    const sha = commitSha();

    const results = await queueBehindRow(context.projectId, [
      syncOf(context, sha, files),
      syncOf(context, sha, files),
    ]);

    expect(results.map((result) => [result.status, "replay" in result && result.replay])).toEqual([
      ["ok", false],
      ["ok", true],
    ]);
    expect((await adrEvents(testDb.db, context.projectId)).map((event) => event.type)).toEqual([
      "adr.synced",
    ]);
    expect((await projectAdrState(testDb.db, context.projectId)).adrSyncedCommitSha).toBe(sha);
  });

  it("re-checks a Project key under the Project lock, writing nothing once it is disabled", async () => {
    const context = await setup();
    const key = await insertProjectKey(testDb.db, context.projectId);
    const asKey = { projectId: context.projectId, principal: key };
    const files = adrFiles(2);
    await storeAdrContents(testDb.db, { ...asKey, items: files.map((f) => f.content) });
    const before = await projectAdrState(testDb.db, context.projectId);

    const holder = await holdProjectLock(pools.db(0), context.projectId);
    const pending = [
      syncOf(asKey, commitSha(), files)(pools.db(1)).catch((error: unknown) => error),
      reserve(pools.db(2), asKey).catch((error: unknown) => error),
    ];
    await waitForLockWaiters(testDb, 2);
    await testDb.db.update(apikey).set({ enabled: false }).where(eq(apikey.id, key.keyId));
    await holder.release();

    const lost = expect.objectContaining({
      name: "ProjectAccessLostError",
      reason: "key_unusable",
    });
    expect(await Promise.all(pending)).toEqual([lost, lost]);
    expect(await adrRows(testDb.db, context.projectId)).toEqual([]);
    expect(await adrEvents(testDb.db, context.projectId)).toEqual([]);
    expect(await projectAdrState(testDb.db, context.projectId)).toEqual(before);
  });

  it("lets exactly one of two syncs on the same base apply", async () => {
    const context = await setup();
    const files = adrFiles(3);
    await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
    const shas = [commitSha(), commitSha()];
    const sync = (sha: string, entries: typeof files) => (db: Db) =>
      syncAdrs(db, {
        ...context,
        commitSha: sha,
        baseCommitSha: null,
        forced: false,
        entries: entries.map((f) => f.entry),
      });

    const results = await queueBehindLock(context.projectId, [
      sync(shas[0] ?? "", files),
      sync(shas[1] ?? "", files.slice(0, 2)),
    ]);

    expect(results.map((result) => result.status)).toEqual(["ok", "stale_base"]);
    expect(results[1]).toEqual({ status: "stale_base", currentCommitSha: shas[0] });
    expect((await projectAdrState(testDb.db, context.projectId)).adrSyncedCommitSha).toBe(shas[0]);
    const events = await adrEvents(testDb.db, context.projectId);
    expect(events.map((event) => event.type)).toEqual(["adr.synced"]);
    expect((await adrRows(testDb.db, context.projectId)).map((row) => row.state)).toEqual([
      "published",
      "published",
      "published",
    ]);
  });
});
