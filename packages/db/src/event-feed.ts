import { getTableColumns, type SQL, sql } from "drizzle-orm";
import {
  type CoordinationContext,
  clockMillisSql,
  dateFromMillis,
  withReadSnapshot,
} from "./coordination.ts";
import { MAX_EVENT_DTO_BYTES, MAX_EVENT_PAYLOAD_BYTES } from "./event.ts";
import { isSeq } from "./event-read.ts";
import type { Db } from "./index.ts";
import type { DbOrTransaction } from "./project.ts";
import { type Event, event } from "./schema/event.ts";

// The safe-horizon Event feed behind M3's live updates (issue #11, "Lossless
// ordering" and "Snapshot handoff"; ADR-0010).
//
// `seq` is allocated at insert, not at commit, so a reader that resumes after
// the greatest `seq` it saw skips an Event whose transaction commits later
// with a smaller `seq`. The feed instead orders Events by (writer_xid, seq)
// and returns only those whose writing transaction is older than every
// transaction still running: `writer_xid < pg_snapshot_xmin(pg_current_snapshot())`,
// the horizon. A transaction that has not finished has an id at or above the
// horizon, and every transaction that starts writing later gets a larger id,
// so no Event can ever appear below a horizon that a poll has passed. Events
// of one transaction share writer_xid and keep their insert order through seq.
//
// The cost: one long-running transaction that holds a transaction id, in any
// database of the cluster, holds back newer Events of every Project until it
// ends. Delivery waits; it never skips (`withheld` reports it).

/**
 * A position in a Project's feed: after the Event whose (writer_xid, seq) it
 * is, or the fence `(H, "0")` a snapshot issues. Both are decimal strings
 * (xid8 and bigint exceed JavaScript's safe integers); compare positions with
 * `compareFeedPositions`, never as numbers.
 */
export interface FeedPosition {
  xid: string;
  seq: string;
}

/** The start of every feed: replays a Project's whole history. */
export const FEED_ORIGIN: FeedPosition = { xid: "0", seq: "0" };

/** The most Events one poll returns (issue #11, "Stream lifecycle"). */
export const MAX_FEED_BATCH_EVENTS = 100;

/**
 * The bytes a poll charges each Event for its fields other than the payload:
 * the part of `MAX_EVENT_DTO_BYTES` that M2 reserves for them.
 */
export const FEED_EVENT_OVERHEAD_BYTES = MAX_EVENT_DTO_BYTES - MAX_EVENT_PAYLOAD_BYTES;

const MAX_XID8 = 18_446_744_073_709_551_615n;
const XID8_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;

/**
 * Whether `position` has the shape of a feed position: `xid` a decimal an
 * unsigned 64-bit xid8 can hold and `seq` one a bigint can hold, with no sign,
 * leading zero or fraction, so casting either cannot fail. Says nothing about
 * whether the position was ever issued (`isIssuableFeedPosition`).
 */
export function isFeedPosition(position: FeedPosition): boolean {
  const { xid, seq } = position;
  return (
    typeof xid === "string" &&
    typeof seq === "string" &&
    XID8_DECIMAL.test(xid) &&
    BigInt(xid) <= MAX_XID8 &&
    isSeq(seq)
  );
}

function assertFeedPosition(position: FeedPosition): void {
  if (!isFeedPosition(position)) {
    throw new Error("A feed position must be a decimal xid8 and a decimal bigint.");
  }
}

/** Negative, zero or positive as `a` is before, at or after `b` in feed order. */
export function compareFeedPositions(a: FeedPosition, b: FeedPosition): number {
  assertFeedPosition(a);
  assertFeedPosition(b);
  const byXid = BigInt(a.xid) - BigInt(b.xid);
  const difference = byXid === 0n ? BigInt(a.seq) - BigInt(b.seq) : byXid;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** The position just after `row`: where a poll that delivered it resumes. */
export function feedPositionOf(row: Pick<Event, "writerXid" | "seq">): FeedPosition {
  return { xid: row.writerXid, seq: row.seq };
}

const horizonSql = sql`pg_snapshot_xmin(pg_current_snapshot())`;

/**
 * The feed's current horizon, `pg_snapshot_xmin(pg_current_snapshot())`, as
 * a decimal string: every Event below it is committed or rolled back for good.
 * As the first statement of a REPEATABLE READ transaction it is the
 * transaction snapshot's horizon; `withFeedSnapshot` uses it that way.
 */
export async function readFeedHorizon(executor: DbOrTransaction): Promise<string> {
  const result = await executor.execute<{ horizon: string }>(
    sql`select ${horizonSql}::text as horizon`,
  );
  const horizon = result.rows[0]?.horizon;
  if (horizon === undefined) throw new Error("pg_current_snapshot() returned no horizon.");
  return horizon;
}

/** What `withFeedSnapshot` passes to its callback. */
export interface FeedSnapshotContext extends CoordinationContext {
  /**
   * `(H, "0")`, where H is the snapshot's horizon. Every Event below H is
   * already visible to `tx`; polling from the fence delivers every Event at
   * or above H, including ones the snapshot also saw (delivery is at least
   * once, so readers apply Events idempotently).
   */
  fence: FeedPosition;
}

/**
 * Runs `fn` in the same short REPEATABLE READ, READ ONLY transaction as
 * `withCoordinationRead`, whose first statement reads both the database time
 * and the feed horizon H from the transaction's snapshot. A page renders its
 * projection with `tx` and hands the fence to the browser, which resumes the
 * feed from it once the transaction has ended: nothing committed after the
 * snapshot is missed (issue #11, "Snapshot handoff"). `db` must be the
 * client; never keep the transaction open while streaming.
 */
export async function withFeedSnapshot<T>(
  db: Db,
  fn: (context: FeedSnapshotContext) => Promise<T>,
): Promise<T> {
  return withReadSnapshot(db, async (tx) => {
    const result = await tx.execute<{ ms: string; horizon: string }>(
      sql`select ${clockMillisSql} as ms, ${horizonSql}::text as horizon`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("The feed snapshot read nothing.");
    return fn({ tx, now: dateFromMillis(row.ms), fence: { xid: row.horizon, seq: "0" } });
  });
}

/**
 * Whether the feed could have issued `position`: it is well-formed
 * (`isFeedPosition`), its xid is at most `pg_snapshot_xmax(pg_current_snapshot())`
 * (no transaction id above it has been assigned, and every horizon is at most
 * it) and its seq at most the last value the Event sequence handed out. A
 * fence `(H, "0")` passes even when the Project has no Events. A false result
 * means the position is forged or from another database; never silently
 * resume such a cursor from the latest Event.
 */
export async function isIssuableFeedPosition(
  executor: DbOrTransaction,
  position: FeedPosition,
): Promise<boolean> {
  if (!isFeedPosition(position)) return false;
  const result = await executor.execute<{ issuable: boolean }>(sql`
    select
      ${position.xid}::xid8 <= pg_snapshot_xmax(pg_current_snapshot())
      and ${position.seq}::bigint <= coalesce(
        pg_sequence_last_value(pg_get_serial_sequence('event', 'seq')),
        0
      ) as issuable
  `);
  return result.rows[0]?.issuable === true;
}

export interface FeedBatch {
  /** The Events after the requested position, in (writer_xid, seq) order. */
  events: Event[];
  /** Where the next poll resumes: the last Event's position, or the requested one. */
  next: FeedPosition;
  /** The horizon this poll used, as a decimal string. */
  horizon: string;
  /**
   * Whether the Project has committed Events at or above the horizon, which
   * this poll held back until older transactions end (a diagnostic, not an
   * error).
   */
  withheld: boolean;
  /** The batch's size in the poll's byte measure (see `pollEventFeed`). */
  bytes: number;
  /**
   * Whether the byte budget cut the batch: the poll read safe Events after
   * the last one it returned. Poll again at once, as after a batch of
   * `limit` Events.
   */
  truncated: boolean;
}

/** The select list of every Event column, aliased to its property name. */
function eventColumns(): SQL {
  return sql.join(
    Object.entries(getTableColumns(event)).map(
      ([key, column]) => sql`${column} as ${sql.identifier(key)}`,
    ),
    sql`, `,
  );
}

/** The Event in a row that `feedBatchStatement` aliased by property name. */
function decodeEvent(row: Record<string, unknown>): Event {
  const decoded: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(event))) {
    const value = row[key];
    decoded[key] = value === null || value === undefined ? null : column.mapFromDriverValue(value);
  }
  return decoded as Event;
}

export interface FeedPollInput {
  projectId: string;
  /** Return only Events after this position. */
  after: FeedPosition;
  /** At most this many Events; capped at `MAX_FEED_BATCH_EVENTS`. */
  limit: number;
  /** Stop before the batch's bytes would exceed this; at least one Event is always returned. */
  maxBytes?: number;
}

/**
 * The statement `pollEventFeed` runs. Exported for tests that inspect its
 * plan; call `pollEventFeed` instead.
 */
export function feedBatchStatement(input: FeedPollInput): SQL {
  const { projectId, after } = input;
  assertFeedPosition(after);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new Error("limit must be a positive integer.");
  }
  const limit = Math.min(input.limit, MAX_FEED_BATCH_EVENTS);
  const { maxBytes } = input;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new Error("maxBytes must be a positive integer.");
  }
  const withinBudget =
    maxBytes === undefined ? sql`true` : sql`costed."feedRunningBytes" <= ${maxBytes}::bigint`;

  // One statement, so the horizon and the rows come from the same snapshot.
  // `batch` is limited before the window sums sizes, so a poll never reads
  // more than `limit` rows past the cursor. The horizon is an InitPlan
  // parameter, so the scan is a range of (project_id, writer_xid, seq).
  return sql`
    with feed_horizon as materialized (
      select ${horizonSql} as h
    ),
    batch as (
      select ${eventColumns()},
        octet_length(${event.payload}::text) + ${FEED_EVENT_OVERHEAD_BYTES}::int as "feedBytes"
      from ${event}
      where ${event.projectId} = ${projectId}::uuid
        and ${event.writerXid} < (select h from feed_horizon)
        and (${event.writerXid}, ${event.seq}) > (${after.xid}::xid8, ${after.seq}::bigint)
      order by ${event.writerXid}, ${event.seq}
      limit ${limit}::int
    ),
    costed as (
      select batch.*,
        sum("feedBytes") over w as "feedRunningBytes",
        row_number() over w as "feedRow",
        count(*) over () as "feedBatchRows"
      from batch
      window w as (order by "writerXid", "seq" rows between unbounded preceding and current row)
    )
    select
      feed_horizon.h::text as "feedHorizon",
      exists (
        select 1 from ${event}
        where ${event.projectId} = ${projectId}::uuid and ${event.writerXid} >= feed_horizon.h
      ) as "feedWithheld",
      costed.*
    from feed_horizon
    left join costed on costed."feedRow" = 1 or ${withinBudget}
    order by costed."writerXid", costed."seq"
  `;
}

/**
 * The Project's next Events after `input.after` that are safe to deliver:
 * written by transactions older than every running one (the horizon), in
 * (writer_xid, seq) order. Resume the next poll from `next`, which advances
 * only through returned Events; an empty batch leaves it where it was.
 *
 * Bytes: an Event costs `octet_length(payload::text)`, the UTF-8 length of
 * Postgres' text form of the jsonb payload, plus `FEED_EVENT_OVERHEAD_BYTES`
 * for its other fields. The jsonb text form is never shorter than
 * `JSON.stringify` of the same value (it adds a space after each `:` and `,`),
 * so the charge bounds the Event's encoded DTO. With `maxBytes`, the batch
 * stops at the last Event whose running total fits, but always includes the
 * first Event, so a poll can make progress past a large one; `truncated`
 * then says that more safe Events were read than returned.
 *
 * The caller authorizes the Project first. Throws on a malformed `after`; use
 * `isIssuableFeedPosition` to reject impossible ones before polling.
 */
export async function pollEventFeed(db: DbOrTransaction, input: FeedPollInput): Promise<FeedBatch> {
  const result = await db.execute<Record<string, unknown>>(feedBatchStatement(input));
  const [first] = result.rows;
  if (!first) throw new Error("The feed poll returned no horizon.");
  const events: Event[] = [];
  let bytes = 0;
  for (const row of result.rows) {
    if (row.id === null || row.id === undefined) continue;
    events.push(decodeEvent(row));
    bytes += Number(row.feedBytes);
  }
  const last = events.at(-1);
  return {
    events,
    next: last ? feedPositionOf(last) : input.after,
    horizon: String(first.feedHorizon),
    withheld: first.feedWithheld === true,
    bytes,
    truncated: events.length < Number(first.feedBatchRows ?? 0),
  };
}
