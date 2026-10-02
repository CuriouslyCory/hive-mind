import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { Transaction } from "../src/coordination.ts";
import { insertEvent } from "../src/event.ts";
import {
  compareFeedPositions,
  FEED_EVENT_OVERHEAD_BYTES,
  FEED_ORIGIN,
  type FeedPosition,
  feedBatchStatement,
  feedPositionOf,
  isFeedPosition,
  isIssuableFeedPosition,
  MAX_FEED_BATCH_EVENTS,
  pollEventFeed,
  readFeedHorizon,
  withFeedSnapshot,
} from "../src/event-feed.ts";
import type { Db } from "../src/index.ts";
import { type Event, event } from "../src/schema/event.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertProject } from "./support/fixtures.ts";

// The safe-horizon feed against real concurrent transactions (issue #11,
// "Acceptance and failure-focused tests"). Every writer below is its own
// transaction on its own pooled connection.
//
// The horizon is cluster-wide: a transaction in another test file's database
// holds it back as much as one here. So assertions that something is withheld
// rely only on transactions this file holds open, and assertions that
// something arrives poll until it does, with a deadline.

let testDb: TestDatabase;

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

const DELIVERY_DEADLINE_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step =
  | { kind: "run"; fn: (tx: Transaction) => Promise<unknown>; done: PromiseWithResolvers<unknown> }
  | { kind: "commit" | "rollback" };

/** A transaction kept open on its own connection until the test ends it. */
interface HeldTransaction {
  run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

const openTransactions = new Set<HeldTransaction>();

// A failed assertion must not leave a transaction holding the horizon back
// for every other test file on the server.
afterEach(async () => {
  for (const held of openTransactions) await held.rollback();
});

async function holdTransaction(db: Db): Promise<HeldTransaction> {
  let next = Promise.withResolvers<Step>();
  const started = Promise.withResolvers<void>();
  const finished = db.transaction(async (tx) => {
    // A bug must fail the run, not hang it.
    await tx.execute(sql`set local statement_timeout = '10s'`);
    await tx.execute(sql`set local lock_timeout = '5s'`);
    started.resolve();
    for (;;) {
      const step = await next.promise;
      next = Promise.withResolvers<Step>();
      if (step.kind !== "run") {
        // Throws, which rolls back.
        if (step.kind === "rollback") tx.rollback();
        return;
      }
      try {
        step.done.resolve(await step.fn(tx));
      } catch (error) {
        step.done.reject(error);
      }
    }
  });
  // Surfaces a failure to start; `commit` and `rollback` await `finished`.
  await Promise.race([started.promise, finished]);
  const end = async (kind: "commit" | "rollback") => {
    if (!openTransactions.delete(held)) return;
    next.resolve({ kind });
    try {
      await finished;
    } catch (error) {
      if (kind === "commit") throw error;
    }
  };
  const held: HeldTransaction = {
    run: async <T>(fn: (tx: Transaction) => Promise<T>) => {
      const done = Promise.withResolvers<unknown>();
      next.resolve({ kind: "run", fn, done });
      return (await done.promise) as T;
    },
    commit: () => end("commit"),
    rollback: () => end("rollback"),
  };
  openTransactions.add(held);
  return held;
}

/** Inserts an Event through M2's writer, inside `tx`. */
function writeEvent(tx: Transaction, projectId: string, message: string): Promise<Event> {
  return insertEvent(tx, {
    projectId,
    type: "plan.log_appended",
    payload: { message },
    actor: { kind: "system" },
    now: new Date(),
  });
}

/** Writes and commits one Event in its own transaction. */
function commitEvent(projectId: string, message: string): Promise<Event> {
  return testDb.db.transaction((tx) => writeEvent(tx, projectId, message));
}

async function newProject(): Promise<string> {
  return (await insertProject(testDb.db)).project.id;
}

async function currentXid(tx: Transaction): Promise<string> {
  const result = await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`);
  const xid = result.rows[0]?.xid;
  if (xid === undefined) throw new Error("no xid");
  return xid;
}

/**
 * Polls from `from`, as a stream would, until `done` holds for everything
 * delivered so far. Fails on a duplicate delivery or the deadline.
 */
async function drain(
  projectId: string,
  from: FeedPosition,
  done: (events: Event[]) => boolean,
  options: { limit?: number; maxBytes?: number } = {},
) {
  const events: Event[] = [];
  const batchSizes: number[] = [];
  let position = from;
  const deadline = Date.now() + DELIVERY_DEADLINE_MS;
  for (;;) {
    const batch = await pollEventFeed(testDb.db, {
      projectId,
      after: position,
      limit: options.limit ?? MAX_FEED_BATCH_EVENTS,
      maxBytes: options.maxBytes,
    });
    for (const delivered of batch.events) {
      expect(compareFeedPositions(feedPositionOf(delivered), position)).toBe(1);
      position = feedPositionOf(delivered);
    }
    expect(batch.next).toEqual(position);
    events.push(...batch.events);
    if (batch.events.length > 0) batchSizes.push(batch.events.length);
    const ids = events.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    if (done(events)) return { events, position, batchSizes };
    if (Date.now() > deadline) {
      throw new Error(`The feed delivered ${events.length} Events before the deadline.`);
    }
    if (batch.events.length === 0) await sleep(20);
  }
}

const hasAll = (wanted: Event[]) => (events: Event[]) =>
  wanted.every((row) => events.some((delivered) => delivered.id === row.id));

/** A seq-only reader's poll: Events with a greater seq than the cursor (ADR-0010's hazard). */
function naivePoll(projectId: string, afterSeq: string) {
  return testDb.db
    .select()
    .from(event)
    .where(and(eq(event.projectId, projectId), sql`${event.seq} > ${afterSeq}::bigint`))
    .orderBy(asc(event.seq));
}

describeDb("event feed: commit order", () => {
  it("withholds a later commit until an earlier writer ends, then delivers both", async () => {
    const projectId = await newProject();
    const fence = await withFeedSnapshot(testDb.db, async ({ fence }) => fence);

    // A writes first, so it has the smaller seq and transaction id, and stays open.
    const a = await holdTransaction(testDb.db);
    const eventA = await a.run((tx) => writeEvent(tx, projectId, "A"));
    // B writes later and commits first.
    const eventB = await commitEvent(projectId, "B");
    expect(BigInt(eventA.seq)).toBeLessThan(BigInt(eventB.seq));
    expect(BigInt(eventA.writerXid)).toBeLessThan(BigInt(eventB.writerXid));

    // B is committed, but A could still commit below it: nothing is safe yet.
    const early = await pollEventFeed(testDb.db, { projectId, after: fence, limit: 100 });
    expect(early.events).toEqual([]);
    expect(early.next).toEqual(fence);
    expect(BigInt(early.horizon)).toBeLessThanOrEqual(BigInt(eventA.writerXid));
    expect(early.withheld).toBe(true);

    await a.commit();
    const { events } = await drain(projectId, early.next, hasAll([eventA, eventB]));
    expect(events.map((row) => row.id)).toEqual([eventA.id, eventB.id]);
  });

  it("break-it: a seq-only cursor loses the earlier writer's Event", async () => {
    const projectId = await newProject();
    const a = await holdTransaction(testDb.db);
    const eventA = await a.run((tx) => writeEvent(tx, projectId, "A"));
    const eventB = await commitEvent(projectId, "B");

    // The seq-only reader sees B, and its cursor moves past A's seq.
    const first = await naivePoll(projectId, "0");
    expect(first.map((row) => row.id)).toEqual([eventB.id]);
    const cursor = eventB.seq;

    await a.commit();
    // A is committed now, but below the cursor: the seq-only reader never sends it.
    expect(await naivePoll(projectId, cursor)).toEqual([]);
    const all = await naivePoll(projectId, "0");
    expect(all.map((row) => row.id)).toEqual([eventA.id, eventB.id]);

    // The feed, resumed from where it was, delivers A.
    const { events } = await drain(projectId, FEED_ORIGIN, hasAll([eventA, eventB]));
    expect(events.map((row) => row.id)).toEqual([eventA.id, eventB.id]);
  });

  it("resumes by (writer_xid, seq), not seq, when an older transaction writes the later seq", async () => {
    const projectId = await newProject();
    const otherProject = await newProject();
    // `older` takes its transaction id first, writing elsewhere.
    const older = await holdTransaction(testDb.db);
    await older.run((tx) => writeEvent(tx, otherProject, "first write"));
    // `younger` then writes the smaller seq in this Project and stays open.
    const younger = await holdTransaction(testDb.db);
    const low = await younger.run((tx) => writeEvent(tx, projectId, "low seq"));
    const high = await older.run((tx) => writeEvent(tx, projectId, "high seq"));
    await older.commit();
    expect(BigInt(high.writerXid)).toBeLessThan(BigInt(low.writerXid));
    expect(BigInt(high.seq)).toBeGreaterThan(BigInt(low.seq));

    // `high` is safe while `younger` runs; a seq cursor would now pass `low`.
    const first = await drain(projectId, FEED_ORIGIN, hasAll([high]));
    expect(first.events.map((row) => row.id)).toEqual([high.id]);

    await younger.commit();
    const rest = await drain(projectId, first.position, hasAll([low]));
    expect(rest.events.map((row) => row.id)).toEqual([low.id]);
  });

  it("skips rolled-back Events and their seq gaps", async () => {
    const projectId = await newProject();
    const before = await commitEvent(projectId, "before");
    const rolledBack = await holdTransaction(testDb.db);
    const lost = await rolledBack.run((tx) => writeEvent(tx, projectId, "lost"));
    const after = await commitEvent(projectId, "after");
    await rolledBack.rollback();

    const { events } = await drain(projectId, FEED_ORIGIN, hasAll([before, after]));
    expect(events.map((row) => row.id)).toEqual([before.id, after.id]);
    expect(BigInt(lost.seq)).toBeGreaterThan(BigInt(before.seq));
    expect(BigInt(lost.seq)).toBeLessThan(BigInt(after.seq));
  });

  it("orders a transaction's Events by seq, across polls", async () => {
    const projectId = await newProject();
    const written = await testDb.db.transaction(async (tx) => {
      const rows = [];
      for (let index = 0; index < 5; index++)
        rows.push(await writeEvent(tx, projectId, `${index}`));
      return rows;
    });
    expect(new Set(written.map((row) => row.writerXid)).size).toBe(1);

    const { events, batchSizes } = await drain(projectId, FEED_ORIGIN, hasAll(written), {
      limit: 2,
    });
    expect(events.map((row) => row.id)).toEqual(written.map((row) => row.id));
    expect(batchSizes).toEqual([2, 2, 1]);
  });

  it("delivers more than one batch of Events across polls without loss or duplicates", async () => {
    const projectId = await newProject();
    const written: Event[] = [];
    // Interleave two writers so seq order and (writer_xid, seq) order differ.
    for (let round = 0; round < 5; round++) {
      const first = await holdTransaction(testDb.db);
      const second = await holdTransaction(testDb.db);
      const firstRows: Event[] = [];
      const secondRows: Event[] = [];
      for (let index = 0; index < 25; index++) {
        firstRows.push(await first.run((tx) => writeEvent(tx, projectId, `${round}a${index}`)));
        secondRows.push(await second.run((tx) => writeEvent(tx, projectId, `${round}b${index}`)));
      }
      await second.commit();
      await first.commit();
      written.push(...firstRows, ...secondRows);
    }
    expect(written).toHaveLength(250);

    // Asking for more than the cap returns at most the cap.
    const { events, batchSizes } = await drain(projectId, FEED_ORIGIN, hasAll(written), {
      limit: 500,
    });
    expect(events).toHaveLength(250);
    expect(Math.max(...batchSizes)).toBe(MAX_FEED_BATCH_EVENTS);
    expect(batchSizes.length).toBeGreaterThanOrEqual(3);
    const sorted = [...written].sort((x, y) =>
      compareFeedPositions(feedPositionOf(x), feedPositionOf(y)),
    );
    expect(events.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
  });

  it("stops a batch at the byte budget, always delivering at least one Event", async () => {
    const projectId = await newProject();
    const message = "x".repeat(1000);
    const written: Event[] = [];
    for (let index = 0; index < 4; index++) written.push(await commitEvent(projectId, message));
    // `{"message": "xxx…"}` in jsonb's text form.
    const perEvent = 1000 + 15 + FEED_EVENT_OVERHEAD_BYTES;
    await drain(projectId, FEED_ORIGIN, hasAll(written));

    const two = await pollEventFeed(testDb.db, {
      projectId,
      after: FEED_ORIGIN,
      limit: 100,
      maxBytes: perEvent * 2 + perEvent - 1,
    });
    expect(two.events.map((row) => row.id)).toEqual(written.slice(0, 2).map((row) => row.id));
    expect(two.bytes).toBe(perEvent * 2);

    const one = await pollEventFeed(testDb.db, {
      projectId,
      after: FEED_ORIGIN,
      limit: 100,
      maxBytes: 1,
    });
    expect(one.events.map((row) => row.id)).toEqual([written[0]?.id]);
    expect(one.bytes).toBe(perEvent);
  });

  it("orders and resumes exactly above Number.MAX_SAFE_INTEGER", async () => {
    const projectId = await newProject();
    // The next two seqs are 2^53 and 2^53 + 1, equal as JavaScript numbers.
    await testDb.pool.query(
      "select setval(pg_get_serial_sequence('event', 'seq'), 9007199254740991)",
    );
    const written = await testDb.db.transaction(async (tx) => [
      await writeEvent(tx, projectId, "low"),
      await writeEvent(tx, projectId, "high"),
    ]);
    expect(written.map((row) => row.seq)).toEqual(["9007199254740992", "9007199254740993"]);

    const { events } = await drain(projectId, FEED_ORIGIN, hasAll(written), { limit: 1 });
    expect(events.map((row) => row.seq)).toEqual(["9007199254740992", "9007199254740993"]);

    // A writer_xid above every assigned transaction id is never below the horizon.
    const highXid = "18446744073709551615";
    const forged = await commitEvent(projectId, "forged");
    await testDb.pool.query("update event set writer_xid = $1::xid8 where id = $2", [
      highXid,
      forged.id,
    ]);
    const batch = await pollEventFeed(testDb.db, {
      projectId,
      after: feedPositionOf(events.at(-1) as Event),
      limit: 100,
    });
    expect(batch.events).toEqual([]);
    expect(batch.withheld).toBe(true);

    expect(
      compareFeedPositions(
        { xid: "9007199254740993", seq: "1" },
        { xid: "9007199254740992", seq: "9007199254740993" },
      ),
    ).toBe(1);
    expect(
      compareFeedPositions(
        { xid: highXid, seq: "9007199254740992" },
        { xid: highXid, seq: "9007199254740993" },
      ),
    ).toBe(-1);
  });

  it("delivers Events from old INSERT shapes that omit writer_xid and seq", async () => {
    const projectId = await newProject();
    const client = await testDb.pool.connect();
    let xid: string | undefined;
    let id: string | undefined;
    try {
      await client.query("begin");
      const inserted = await client.query<{ id: string; writer_xid: string }>(
        `insert into event (project_id, type, payload_version, payload, actor_kind, effective_at)
         values ($1, 'plan.log_appended', 1, '{"message": "old writer"}', 'system', now())
         returning id, writer_xid::text`,
        [projectId],
      );
      const current = await client.query<{ xid: string }>(
        "select pg_current_xact_id()::text as xid",
      );
      await client.query("commit");
      id = inserted.rows[0]?.id;
      expect(inserted.rows[0]?.writer_xid).toBe(current.rows[0]?.xid);
      xid = current.rows[0]?.xid;
    } finally {
      client.release();
    }
    const { events } = await drain(projectId, FEED_ORIGIN, (rows) => rows.length === 1);
    expect(events[0]).toMatchObject({ id, writerXid: xid, payload: { message: "old writer" } });
  });

  it("scans the (project_id, writer_xid, seq) index", async () => {
    const projectId = await newProject();
    const plan = await testDb.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const result = await tx.execute<{ "QUERY PLAN": string }>(
        sql`explain ${feedBatchStatement({ projectId, after: FEED_ORIGIN, limit: 100 })}`,
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(
      /Index Scan using event_project_id_writer_xid_seq_idx on event[\s\S]*Index Cond: \(\(project_id = .*\) AND \(writer_xid < \(InitPlan/,
    );
  });
});

describeDb("event feed: snapshot handoff", () => {
  it("delivers what commits during and after the snapshot, from its fence", async () => {
    const projectId = await newProject();
    const old = await commitEvent(projectId, "old");
    let during: Event | undefined;
    const { fence, seenBefore, seenAfter } = await withFeedSnapshot(
      testDb.db,
      async ({ tx, fence }) => {
        const count = async () =>
          (await tx.select({ id: event.id }).from(event).where(eq(event.projectId, projectId)))
            .length;
        const seenBefore = await count();
        // Another connection commits a mutation while the projection is read.
        during = await commitEvent(projectId, "during");
        return { fence, seenBefore, seenAfter: await count() };
      },
    );
    // The projection saw the snapshot only.
    expect(seenBefore).toBe(1);
    expect(seenAfter).toBe(1);
    expect(fence.seq).toBe("0");
    expect(await isIssuableFeedPosition(testDb.db, fence)).toBe(true);

    // Committed between the snapshot and attaching the stream.
    const between = await commitEvent(projectId, "between");
    if (!during) throw new Error("unreachable");
    const { events } = await drain(projectId, fence, hasAll([during, between]));
    const ids = events.map((row) => row.id);
    expect(ids.indexOf(during.id)).toBeLessThan(ids.indexOf(between.id));
    // The snapshot already showed `old`; it is redelivered only if a transaction
    // older than it was still running when the snapshot was taken.
    expect(ids.includes(old.id)).toBe(BigInt(old.writerXid) >= BigInt(fence.xid));
  });

  it("issues a valid fence for a Project with no Events", async () => {
    const projectId = await newProject();
    const fence = await withFeedSnapshot(testDb.db, async ({ fence }) => fence);
    expect(isFeedPosition(fence)).toBe(true);
    expect(await isIssuableFeedPosition(testDb.db, fence)).toBe(true);

    const empty = await pollEventFeed(testDb.db, { projectId, after: fence, limit: 100 });
    expect(empty.events).toEqual([]);
    expect(empty.next).toEqual(fence);

    const first = await commitEvent(projectId, "first");
    const { events } = await drain(projectId, fence, hasAll([first]));
    expect(events.map((row) => row.id)).toEqual([first.id]);
  });

  it("delivers a concurrent writer whose transaction id equals the fence", async () => {
    const projectId = await newProject();
    const writer = await holdTransaction(testDb.db);
    const written = await writer.run((tx) => writeEvent(tx, projectId, "at the fence"));
    const xid = await writer.run(currentXid);

    // The fence is the oldest running transaction id; wait until other test
    // files' transactions older than the writer have ended.
    let fence: FeedPosition | undefined;
    const deadline = Date.now() + DELIVERY_DEADLINE_MS;
    while (fence?.xid !== xid) {
      if (Date.now() > deadline) throw new Error(`The fence stayed below ${xid}.`);
      fence = await withFeedSnapshot(testDb.db, async (context) => context.fence);
      expect(BigInt(fence.xid)).toBeLessThanOrEqual(BigInt(xid));
      if (fence.xid !== xid) await sleep(20);
    }
    expect(fence).toEqual({ xid: written.writerXid, seq: "0" });

    const pending = await pollEventFeed(testDb.db, { projectId, after: fence, limit: 100 });
    expect(pending.events).toEqual([]);

    await writer.commit();
    const { events } = await drain(projectId, fence, hasAll([written]));
    expect(events.map((row) => row.id)).toEqual([written.id]);
  });

  it("reads the horizon as the snapshot's first statement", async () => {
    const holder = await holdTransaction(testDb.db);
    const otherProject = await newProject();
    await holder.run((tx) => writeEvent(tx, otherProject, "held"));
    const fence = await withFeedSnapshot(testDb.db, async ({ tx, fence }) => {
      // The snapshot keeps its horizon even after the holder commits.
      await holder.commit();
      expect(await readFeedHorizon(tx)).toBe(fence.xid);
      return fence;
    });
    expect(BigInt(await readFeedHorizon(testDb.db))).toBeGreaterThanOrEqual(BigInt(fence.xid));
  });
});

describeDb("event feed: an unrelated open transaction", () => {
  it.each(["commit", "rollback"] as const)(
    "withholds newer Events until it ends (%s)",
    async (ending) => {
      const projectId = await newProject();
      const otherProject = await newProject();
      const fence = await withFeedSnapshot(testDb.db, async ({ fence }) => fence);

      // Holds a transaction id while writing elsewhere.
      const unrelated = await holdTransaction(testDb.db);
      await unrelated.run((tx) => writeEvent(tx, otherProject, "elsewhere"));
      const newer = await commitEvent(projectId, "newer");

      for (let poll = 0; poll < 3; poll++) {
        const batch = await pollEventFeed(testDb.db, { projectId, after: fence, limit: 100 });
        expect(batch.events).toEqual([]);
        expect(batch.withheld).toBe(true);
        await sleep(20);
      }

      await (ending === "commit" ? unrelated.commit() : unrelated.rollback());
      const { events } = await drain(projectId, fence, hasAll([newer]));
      expect(events.map((row) => row.id)).toEqual([newer.id]);
    },
  );
});

describeDb("event feed: position validation", () => {
  it("range-checks positions before any cast", async () => {
    const valid: FeedPosition[] = [
      FEED_ORIGIN,
      { xid: "18446744073709551615", seq: "9223372036854775807" },
      { xid: "9007199254740993", seq: "1" },
    ];
    const invalid: FeedPosition[] = [
      { xid: "18446744073709551616", seq: "0" },
      { xid: "0", seq: "9223372036854775808" },
      { xid: "-1", seq: "0" },
      { xid: "01", seq: "0" },
      { xid: "1.5", seq: "0" },
      { xid: "", seq: "0" },
      { xid: "1", seq: " 1" },
      { xid: "1e3", seq: "0" },
      { xid: "1", seq: "-0" },
    ];
    for (const position of valid) expect(isFeedPosition(position), position.xid).toBe(true);
    for (const position of invalid) {
      expect(isFeedPosition(position), JSON.stringify(position)).toBe(false);
      expect(await isIssuableFeedPosition(testDb.db, position)).toBe(false);
      await expect(
        pollEventFeed(testDb.db, { projectId: await newProject(), after: position, limit: 1 }),
      ).rejects.toThrow(/feed position/);
    }
  });

  it("rejects positions no transaction or Event could have issued", async () => {
    const projectId = await newProject();
    const written = await commitEvent(projectId, "issued");
    const result = await testDb.pool.query<{ xmax: string }>(
      "select pg_snapshot_xmax(pg_current_snapshot())::text as xmax",
    );
    const xmax = result.rows[0]?.xmax;
    if (!xmax) throw new Error("no xmax");

    expect(await isIssuableFeedPosition(testDb.db, FEED_ORIGIN)).toBe(true);
    expect(await isIssuableFeedPosition(testDb.db, feedPositionOf(written))).toBe(true);
    expect(await isIssuableFeedPosition(testDb.db, { xid: xmax, seq: "0" })).toBe(true);
    // Never compared with the greatest stored Event: a fence above it is valid.
    expect(BigInt(xmax)).toBeGreaterThan(BigInt(written.writerXid));

    const future = (BigInt(xmax) + 1_000_000n).toString();
    expect(await isIssuableFeedPosition(testDb.db, { xid: future, seq: "0" })).toBe(false);
    expect(await isIssuableFeedPosition(testDb.db, { xid: "18446744073709551615", seq: "0" })).toBe(
      false,
    );
    const unissuedSeq = (BigInt(written.seq) + 1_000_000n).toString();
    expect(
      await isIssuableFeedPosition(testDb.db, { xid: written.writerXid, seq: unissuedSeq }),
    ).toBe(false);
  });

  it("rejects a malformed limit or byte budget", async () => {
    const projectId = await newProject();
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        pollEventFeed(testDb.db, { projectId, after: FEED_ORIGIN, limit }),
      ).rejects.toThrow(/limit/);
    }
    await expect(
      pollEventFeed(testDb.db, { projectId, after: FEED_ORIGIN, limit: 1, maxBytes: 0 }),
    ).rejects.toThrow(/maxBytes/);
  });
});
