import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type ReserveAdrOutcome, reserveAdr, storeAdrContents, syncAdrs } from "../src/adr.ts";
import type { Db } from "../src/index.ts";
import type { Principal } from "../src/principal.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { adrEvents, adrFiles, adrRows, commitSha, projectAdrState } from "./support/adr.ts";
import { insertProject } from "./support/fixtures.ts";
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

type Context = Awaited<ReturnType<typeof setup>>;

function reserve(db: Db, context: Context, floor = 0): Promise<ReserveAdrOutcome> {
  return reserveAdr(db, {
    ...context,
    id: randomUUID(),
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
