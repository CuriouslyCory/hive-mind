import { z } from "zod";
import { cursorSchema, idSchema, timestampSchema } from "./common.ts";
import { eventSchema, MAX_EVENT_BYTES } from "./event.ts";

// The live Event feed of a Project (ADR-0010, issue #11): its resumable
// cursor, the frames it sends and the bounds every implementation keeps.
// `GET /projects/{id}/events/stream` (router.ts) and the dashboard's cookie
// adapter share all of it.

// ---------------------------------------------------------------------------
// Positions and cursors
// ---------------------------------------------------------------------------

/**
 * A position in a Project's feed: the writing transaction's ID (`xid8`) and
 * the Event's `seq`, both as decimal strings. The feed delivers Events
 * strictly after a position in `(writerXid, seq)` order. `seq` 0 is never an
 * Event's (sequences start at 1), so `(H, 0)` is a fence: everything written
 * by transaction H or later, nothing from earlier transactions.
 */
export interface FeedPosition {
  xid: string;
  seq: string;
}

/** Largest PostgreSQL `xid8`: an unsigned 64-bit integer. */
export const MAX_FEED_XID = 2n ** 64n - 1n;

/** Largest Event `seq`: a PostgreSQL `bigint`. */
export const MAX_FEED_SEQ = 2n ** 63n - 1n;

/**
 * The origin `(0, 0)`. Every Event is after it, since every transaction ID
 * that can write a row is at least 3. A client passes `feedOriginCursor` to
 * replay a Project's whole retained history; omitting a cursor tails from
 * the current safe boundary instead.
 */
export const FEED_ORIGIN: FeedPosition = Object.freeze({ xid: "0", seq: "0" });

/** Why a cursor was rejected. Each one is a 400 on the stream route. */
export type FeedCursorFailure =
  /** Too long, not base64url, or not the cursor's structure. */
  | "malformed"
  /** Structurally a feed cursor, from a version this server does not read. */
  | "unsupported_version"
  /** Issued for another Project. */
  | "wrong_project"
  /** A number outside its column's range, or not in canonical decimal form. */
  | "out_of_range";

export type FeedCursorResult =
  | { ok: true; position: FeedPosition }
  | { ok: false; failure: FeedCursorFailure };

const FEED_CURSOR_VERSION = "f1";
const SEPARATOR = ".";
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `value` as canonical decimal if it is an integer in `[0, max]`, else null. */
function canonicalDecimal(value: string | bigint, max: bigint): string | null {
  if (typeof value === "string") {
    // The digit bound keeps BigInt() off huge strings.
    if (!CANONICAL_DECIMAL.test(value) || value.length > max.toString().length) return null;
  }
  const number = BigInt(value);
  return number >= 0n && number <= max ? number.toString() : null;
}

// btoa/atob over ASCII text, so the module runs unchanged in browsers and
// Node without Buffer.
function toBase64Url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (text.length % 4 === 1) return null;
  try {
    return atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
}

/**
 * The opaque cursor for `position` in `projectId`'s feed: versioned, bound
 * to the Project, at most `MAX_CURSOR_LENGTH` characters of base64url (it
 * matches the contract's `cursorSchema`). Throws on an out-of-range
 * position, which only a server bug can produce.
 */
export function encodeFeedCursor(input: {
  projectId: string;
  xid: string | bigint;
  seq: string | bigint;
}): string {
  const projectId = input.projectId.toLowerCase();
  const xid = canonicalDecimal(input.xid, MAX_FEED_XID);
  const seq = canonicalDecimal(input.seq, MAX_FEED_SEQ);
  if (!UUID.test(projectId) || xid === null || seq === null) {
    throw new RangeError("A feed cursor needs a Project UUID, an xid8 and a bigint seq.");
  }
  return toBase64Url([FEED_CURSOR_VERSION, projectId, xid, seq].join(SEPARATOR));
}

/** The cursor for `FEED_ORIGIN`: replay the Project's whole retained history. */
export function feedOriginCursor(projectId: string): string {
  return encodeFeedCursor({ projectId, ...FEED_ORIGIN });
}

/**
 * The position in `cursor` if it is a feed cursor for `projectId`, or why
 * not. This checks structure and ranges only; the server also rejects a
 * position whose transaction ID was never allocated (beyond the database's
 * next transaction ID), which needs the database.
 */
export function decodeFeedCursor(cursor: string, projectId: string): FeedCursorResult {
  const fail = (failure: FeedCursorFailure): FeedCursorResult => ({ ok: false, failure });
  if (!cursorSchema.safeParse(cursor).success) return fail("malformed");
  const text = fromBase64Url(cursor);
  // Re-encoding must give the same text, so one position has one cursor.
  if (text === null || toBase64Url(text) !== cursor) return fail("malformed");
  const parts = text.split(SEPARATOR);
  if (parts.length !== 4) return fail("malformed");
  const [version, boundProject, xidText, seqText] = parts as [string, string, string, string];
  if (!/^f[0-9]+$/.test(version)) return fail("malformed");
  if (version !== FEED_CURSOR_VERSION) return fail("unsupported_version");
  if (!UUID.test(boundProject)) return fail("malformed");
  if (boundProject !== projectId.toLowerCase()) return fail("wrong_project");
  const xid = canonicalDecimal(xidText, MAX_FEED_XID);
  const seq = canonicalDecimal(seqText, MAX_FEED_SEQ);
  if (xid === null || seq === null) return fail("out_of_range");
  return { ok: true, position: { xid, seq } };
}

/** Orders positions as the feed does: by `xid`, then `seq`, as integers. */
export function compareFeedPositions(a: FeedPosition, b: FeedPosition): -1 | 0 | 1 {
  const [left, right] =
    a.xid === b.xid ? [BigInt(a.seq), BigInt(b.seq)] : [BigInt(a.xid), BigInt(b.xid)];
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Whether `position` is a fence (`seq` 0) rather than an Event's position. */
export function isFeedFence(position: FeedPosition): boolean {
  return position.seq === "0";
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How often a stream polls for newly safe Events. */
export const EVENT_STREAM_POLL_INTERVAL_MS = 1000;

/** Most Events one poll reads; the byte budget below may stop it earlier. */
export const EVENT_STREAM_BATCH_MAX_EVENTS = 100;

/**
 * Worst-case bytes one Event frame adds to an SSE response. The Event is at
 * most `MAX_EVENT_BYTES` (64 KiB) of JSON: M2 bounds every field and payload
 * (the largest are a `scope.touched` batch of 16 touched paths of 256 bytes,
 * whose control characters escape to 6 bytes each, about 24 KiB; and 8 KiB
 * markdown whose quotes JSON escapes to 16 KiB), contract tests check a
 * maximal Event of each type against the limit, and the server refuses to
 * serialize a larger one (apps/web/src/server/api/coordination-dto.ts). The
 * frame adds `{"type":"event","event":…}`, the `id:` line with a cursor of at
 * most `MAX_CURSOR_LENGTH` characters, the `event:` and `data:` field names
 * and line breaks, all well under the 1 KiB allowed here. JSON has no raw
 * line breaks, so the data is one `data:` line.
 */
export const MAX_EVENT_STREAM_FRAME_BYTES = MAX_EVENT_BYTES + 1024;

/**
 * Cap on a stream's Event bytes held in memory: a batch read from the
 * database (in flight) plus frames waiting for the client (queued). A
 * consumer that does not drain them in time is disconnected and resumes from
 * the last Event it processed.
 */
export const EVENT_STREAM_MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Byte budget of one batch: half the buffer cap, so one batch in flight and
 * one queued fit together. A batch stops before the Event that would exceed
 * it, but always takes at least one Event, which fits since a frame is at
 * most `MAX_EVENT_STREAM_FRAME_BYTES`. At least
 * `EVENT_STREAM_BATCH_MIN_EVENTS` maximal Events fit; typical Events are a
 * few hundred bytes, so the 100-Event limit is what usually applies.
 */
export const EVENT_STREAM_BATCH_MAX_BYTES = EVENT_STREAM_MAX_BUFFERED_BYTES / 2;

/** Maximal Events that always fit in one batch's byte budget. */
export const EVENT_STREAM_BATCH_MIN_EVENTS = Math.floor(
  EVENT_STREAM_BATCH_MAX_BYTES / MAX_EVENT_STREAM_FRAME_BYTES,
);

/** Interval between heartbeat frames. */
export const EVENT_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/** A stream ends itself this long after it opened; the client reconnects. */
export const EVENT_STREAM_ROTATE_AFTER_MS = 50_000;

/**
 * The stream routes' function `maxDuration`, in seconds. Next.js reads route
 * segment config statically, so each stream route exports the literal `60`,
 * which must equal this.
 */
export const EVENT_STREAM_MAX_DURATION_SECONDS = 60;

/** First reconnect delay, and the floor of every later one. */
export const EVENT_STREAM_RECONNECT_MIN_MS = 1000;

/** Longest reconnect delay. */
export const EVENT_STREAM_RECONNECT_MAX_MS = 30_000;

/**
 * Delay before reconnect attempt `attempt` (0 for the first): exponential
 * from 1 s, capped at 30 s, uniformly jittered over the upper half of the
 * step so clients that dropped together do not return together.
 */
export function eventStreamReconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  // 2^5 s already passes the cap; the bound keeps 2 ** exponent finite.
  const exponent = Math.min(16, Math.max(0, Math.floor(attempt) || 0));
  const ceiling = Math.min(
    EVENT_STREAM_RECONNECT_MAX_MS,
    EVENT_STREAM_RECONNECT_MIN_MS * 2 ** exponent,
  );
  const jittered = ceiling * (0.5 + 0.5 * Math.min(Math.max(random(), 0), 1));
  return Math.round(Math.max(EVENT_STREAM_RECONNECT_MIN_MS, jittered));
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * A persisted Event. Its SSE `id` is the feed cursor of the Event's position
 * (`encodeFeedCursor` of its `writerXid` and `seq`), which the server attaches
 * with oRPC's `withEventMeta`; a reconnecting client sends it back as
 * `Last-Event-ID`. The same Event can arrive more than once (delivery is at
 * least once), and feed order is not necessarily commit order.
 */
export const eventFrameSchema = z.strictObject({
  type: z.literal("event"),
  event: eventSchema,
});

/**
 * Sent every `EVENT_STREAM_HEARTBEAT_INTERVAL_MS`. It has no SSE `id` and
 * moves no cursor. `withheld` is true while newer Events exist that an older
 * open transaction holds back: the feed waits for it rather than risk
 * skipping an Event that transaction might still write (ADR-0010).
 */
export const heartbeatFrameSchema = z.strictObject({
  type: z.literal("heartbeat"),
  serverTime: timestampSchema,
  withheld: z.boolean(),
});

/**
 * The last frame of a stream whose credential or Project access failed a
 * check after the stream opened. It has no SSE `id`; `code` is what the same
 * request would get before the stream opened. The client clears what it
 * showed from this Project and does not reconnect until a fresh, authorized
 * navigation.
 */
export const accessLostFrameSchema = z.strictObject({
  type: z.literal("access_lost"),
  code: z.enum(["UNAUTHORIZED", "NOT_FOUND"]),
});

/**
 * One frame of the Event stream. Only `event` frames carry an SSE `id`.
 * Later versions may add frame types; a client ignores a type it does not
 * know, and treats an `event` frame whose Event type it does not know as a
 * change to the whole Project.
 */
export const eventStreamFrameSchema = z.discriminatedUnion("type", [
  eventFrameSchema,
  heartbeatFrameSchema,
  accessLostFrameSchema,
]);

export type EventFrame = z.infer<typeof eventFrameSchema>;
export type HeartbeatFrame = z.infer<typeof heartbeatFrameSchema>;
export type AccessLostFrame = z.infer<typeof accessLostFrameSchema>;
export type EventStreamFrame = z.infer<typeof eventStreamFrameSchema>;

// ---------------------------------------------------------------------------
// Route input
// ---------------------------------------------------------------------------

/**
 * `GET /projects/{id}/events/stream`. Where the feed starts, first match:
 * the `Last-Event-ID` header (a reconnect; oRPC passes it to the handler as
 * `lastEventId`, outside this input), the `cursor` query parameter, else the
 * current safe boundary (only Events that become safe from now on). An
 * invalid cursor in either place is 400; the stream never silently restarts
 * elsewhere. `feedOriginCursor` replays from the beginning.
 */
export const streamProjectEventsInputSchema = z.strictObject({
  id: idSchema,
  cursor: cursorSchema.optional(),
});

export type StreamProjectEventsInput = z.input<typeof streamProjectEventsInputSchema>;
