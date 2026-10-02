import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accessLostFrameSchema,
  compareFeedPositions,
  cursorSchema,
  decodeFeedCursor,
  EVENT_STREAM_BATCH_MAX_BYTES,
  EVENT_STREAM_BATCH_MAX_EVENTS,
  EVENT_STREAM_BATCH_MIN_EVENTS,
  EVENT_STREAM_HEARTBEAT_INTERVAL_MS,
  EVENT_STREAM_MAX_BUFFERED_BYTES,
  EVENT_STREAM_MAX_DURATION_SECONDS,
  EVENT_STREAM_POLL_INTERVAL_MS,
  EVENT_STREAM_RECONNECT_MAX_MS,
  EVENT_STREAM_RECONNECT_MIN_MS,
  EVENT_STREAM_ROTATE_AFTER_MS,
  type Event,
  encodeFeedCursor,
  eventFrameSchema,
  eventStreamFrameSchema,
  eventStreamReconnectDelay,
  FEED_ORIGIN,
  type FeedPosition,
  feedOriginCursor,
  heartbeatFrameSchema,
  isFeedFence,
  MAX_CURSOR_LENGTH,
  MAX_EVENT_BYTES,
  MAX_EVENT_STREAM_FRAME_BYTES,
  MAX_FEED_SEQ,
  MAX_FEED_XID,
  readyFrameSchema,
  streamProjectEventsInputSchema,
  utf8ByteLength,
} from "../src/index.ts";

const PROJECT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER_PROJECT_ID = "2c9e8b71-5d4a-4f3e-8a1b-6c7d8e9f0a1b";
const ABOVE_SAFE_INTEGER = (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString();

/** A cursor whose decoded text is `text`, built the way the module builds one. */
function rawCursor(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function failure(cursor: string, projectId = PROJECT_ID) {
  const result = decodeFeedCursor(cursor, projectId);
  return result.ok ? null : result.failure;
}

describe("feed cursors", () => {
  it("round-trip a position as decimal strings", () => {
    const cursor = encodeFeedCursor({ projectId: PROJECT_ID, xid: "754", seq: "12" });
    expect(cursorSchema.safeParse(cursor).success).toBe(true);
    expect(decodeFeedCursor(cursor, PROJECT_ID)).toEqual({
      ok: true,
      position: { xid: "754", seq: "12" },
    });
  });

  it("keep integers above Number.MAX_SAFE_INTEGER exact", () => {
    for (const position of [
      { xid: ABOVE_SAFE_INTEGER, seq: ABOVE_SAFE_INTEGER },
      { xid: MAX_FEED_XID.toString(), seq: MAX_FEED_SEQ.toString() },
    ]) {
      const cursor = encodeFeedCursor({ projectId: PROJECT_ID, ...position });
      expect(decodeFeedCursor(cursor, PROJECT_ID)).toEqual({ ok: true, position });
    }
    // A JavaScript number would have rounded this one.
    expect(Number(ABOVE_SAFE_INTEGER).toString()).not.toBe(ABOVE_SAFE_INTEGER);
  });

  it("accept bigints and canonicalize the Project ID", () => {
    const cursor = encodeFeedCursor({
      projectId: PROJECT_ID.toUpperCase(),
      xid: 2n ** 60n,
      seq: 0n,
    });
    expect(cursor).toBe(
      encodeFeedCursor({ projectId: PROJECT_ID, xid: (2n ** 60n).toString(), seq: "0" }),
    );
    expect(decodeFeedCursor(cursor, PROJECT_ID.toUpperCase()).ok).toBe(true);
  });

  it("accept (H, 0) fences, the origin among them", () => {
    const fence = decodeFeedCursor(
      encodeFeedCursor({ projectId: PROJECT_ID, xid: "9001", seq: "0" }),
      PROJECT_ID,
    );
    expect(fence).toEqual({ ok: true, position: { xid: "9001", seq: "0" } });
    expect(fence.ok && isFeedFence(fence.position)).toBe(true);
    expect(isFeedFence({ xid: "9001", seq: "1" })).toBe(false);

    expect(decodeFeedCursor(feedOriginCursor(PROJECT_ID), PROJECT_ID)).toEqual({
      ok: true,
      position: FEED_ORIGIN,
    });
    expect(FEED_ORIGIN).toEqual({ xid: "0", seq: "0" });
  });

  it("stay within the shared 512-character cursor limit", () => {
    expect(MAX_CURSOR_LENGTH).toBe(512);
    const longest = encodeFeedCursor({
      projectId: PROJECT_ID,
      xid: MAX_FEED_XID,
      seq: MAX_FEED_SEQ,
    });
    expect(longest.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
    expect(failure("A".repeat(MAX_CURSOR_LENGTH + 1))).toBe("malformed");
  });

  it("reject malformed cursors", () => {
    const valid = encodeFeedCursor({ projectId: PROJECT_ID, xid: "754", seq: "12" });
    for (const cursor of [
      "",
      "not a cursor",
      `${valid}=`,
      `${valid}+`,
      `${valid}A`.slice(0, 4 * Math.floor(valid.length / 4) + 1),
      rawCursor(`f1.${PROJECT_ID}.754`),
      rawCursor(`f1.${PROJECT_ID}.754.12.0`),
      rawCursor(`f1|${PROJECT_ID}|754|12`),
      rawCursor(`f1.not-a-uuid.754.12`),
      rawCursor(`v1.${PROJECT_ID}.754.12`),
      rawCursor(`c1.${PROJECT_ID}.754.12`),
      rawCursor(`f1.${PROJECT_ID.toUpperCase()}.754.12`),
    ]) {
      expect([cursor, failure(cursor)]).toEqual([cursor, "malformed"]);
    }
  });

  it("reject cursors of another version", () => {
    expect(failure(rawCursor(`f2.${PROJECT_ID}.754.12`))).toBe("unsupported_version");
    expect(failure(rawCursor(`f0.${PROJECT_ID}.754.12`))).toBe("unsupported_version");
  });

  it("reject cursors issued for another Project", () => {
    const cursor = encodeFeedCursor({ projectId: OTHER_PROJECT_ID, xid: "754", seq: "12" });
    expect(failure(cursor)).toBe("wrong_project");
    expect(failure(feedOriginCursor(OTHER_PROJECT_ID))).toBe("wrong_project");
  });

  it("reject positions outside xid8 and bigint, or not canonical", () => {
    for (const [xid, seq] of [
      [(MAX_FEED_XID + 1n).toString(), "1"],
      ["1", (MAX_FEED_SEQ + 1n).toString()],
      ["9".repeat(21), "1"],
      ["1", "9".repeat(40)],
      ["-1", "1"],
      ["1", "-1"],
      ["007", "1"],
      ["1", "01"],
      ["1e3", "1"],
      ["", "1"],
      ["1", " 1"],
    ]) {
      const cursor = rawCursor(`f1.${PROJECT_ID}.${xid}.${seq}`);
      expect([xid, seq, failure(cursor)]).toEqual([xid, seq, "out_of_range"]);
    }
  });

  it("refuse to encode an impossible position", () => {
    for (const position of [
      { xid: MAX_FEED_XID + 1n, seq: 1n },
      { xid: 1n, seq: MAX_FEED_SEQ + 1n },
      { xid: -1n, seq: 1n },
      { xid: "1.5", seq: "1" },
      { xid: "01", seq: "1" },
    ]) {
      expect(() => encodeFeedCursor({ projectId: PROJECT_ID, ...position })).toThrow(RangeError);
    }
    expect(() => encodeFeedCursor({ projectId: "project", xid: "1", seq: "1" })).toThrow(
      RangeError,
    );
  });
});

describe("feed positions", () => {
  it("order by xid, then seq, as integers", () => {
    const sorted: FeedPosition[] = [
      FEED_ORIGIN,
      { xid: "9", seq: "0" },
      { xid: "9", seq: "2" },
      { xid: "9", seq: "10" },
      { xid: "10", seq: "1" },
      { xid: ABOVE_SAFE_INTEGER, seq: "1" },
      { xid: ABOVE_SAFE_INTEGER, seq: ABOVE_SAFE_INTEGER },
      { xid: MAX_FEED_XID.toString(), seq: MAX_FEED_SEQ.toString() },
    ];
    const shuffled = [...sorted].reverse();
    expect(shuffled.sort(compareFeedPositions)).toEqual(sorted);
    expect(compareFeedPositions({ xid: "9", seq: "2" }, { xid: "9", seq: "2" })).toBe(0);
    // Positions a number cannot tell apart.
    const a = { xid: (2n ** 53n).toString(), seq: "1" };
    const b = { xid: (2n ** 53n + 1n).toString(), seq: "1" };
    expect(compareFeedPositions(a, b)).toBe(-1);
    expect(compareFeedPositions(b, a)).toBe(1);
  });
});

function fixtureEvent(): Event {
  const page = JSON.parse(
    readFileSync(new URL("./fixtures/v1/event-page.json", import.meta.url), "utf8"),
  ) as { items: Event[] };
  const event = page.items[0];
  if (!event) throw new Error("event-page.json has no Events.");
  return event;
}

describe("stream frames", () => {
  it("open every stream with one bare ready frame", () => {
    const frame = { type: "ready" };
    expect(readyFrameSchema.parse(frame)).toEqual(frame);
    expect(eventStreamFrameSchema.parse(frame)).toEqual(frame);
    for (const invalid of [
      { ...frame, cursor: feedOriginCursor(PROJECT_ID) },
      { ...frame, id: "abc" },
    ]) {
      expect(eventStreamFrameSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("carry a whole contract Event in event frames", () => {
    const frame = { type: "event", event: fixtureEvent() };
    expect(eventFrameSchema.parse(frame)).toEqual(frame);
    expect(eventStreamFrameSchema.parse(frame)).toEqual(frame);
    expect(eventStreamFrameSchema.safeParse({ type: "event" }).success).toBe(false);
    expect(
      eventStreamFrameSchema.safeParse({ type: "event", event: { ...frame.event, extra: 1 } })
        .success,
    ).toBe(false);
    expect(eventStreamFrameSchema.safeParse({ ...frame, cursor: "abc" }).success).toBe(false);
  });

  it("send bounded heartbeats with withheld diagnostics and no cursor", () => {
    const frame = { type: "heartbeat", serverTime: "2026-10-01T12:00:00.000Z", withheld: true };
    expect(heartbeatFrameSchema.parse(frame)).toEqual(frame);
    expect(eventStreamFrameSchema.parse(frame)).toEqual(frame);
    for (const invalid of [
      { type: "heartbeat", serverTime: "2026-10-01T12:00:00.000Z" },
      { type: "heartbeat", serverTime: "yesterday", withheld: false },
      { ...frame, cursor: "abc" },
      { ...frame, id: "abc" },
    ]) {
      expect(eventStreamFrameSchema.safeParse(invalid).success).toBe(false);
    }
    expect(utf8ByteLength(JSON.stringify(frame))).toBeLessThan(128);
  });

  it("end a stream with a typed access_lost frame", () => {
    for (const code of ["UNAUTHORIZED", "NOT_FOUND"]) {
      const frame = { type: "access_lost", code };
      expect(accessLostFrameSchema.parse(frame)).toEqual(frame);
      expect(eventStreamFrameSchema.parse(frame)).toEqual(frame);
    }
    for (const invalid of [
      { type: "access_lost" },
      { type: "access_lost", code: "INTERNAL_SERVER_ERROR" },
      { type: "access_lost", code: "NOT_FOUND", cursor: "abc" },
    ]) {
      expect(eventStreamFrameSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("reject unknown frame types", () => {
    expect(eventStreamFrameSchema.safeParse({ type: "rotate" }).success).toBe(false);
  });
});

describe("stream input", () => {
  it("takes a Project and an optional bounded cursor", () => {
    const cursor = feedOriginCursor(PROJECT_ID);
    expect(streamProjectEventsInputSchema.parse({ id: PROJECT_ID })).toEqual({ id: PROJECT_ID });
    expect(streamProjectEventsInputSchema.parse({ id: PROJECT_ID, cursor })).toEqual({
      id: PROJECT_ID,
      cursor,
    });
    for (const invalid of [
      { id: "project" },
      { id: PROJECT_ID, cursor: "" },
      { id: PROJECT_ID, cursor: "a".repeat(MAX_CURSOR_LENGTH + 1) },
      { id: PROJECT_ID, cursor: "not/base64url" },
      { id: PROJECT_ID, lastEventId: cursor },
    ]) {
      expect(streamProjectEventsInputSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("stream bounds", () => {
  it("match issue #11", () => {
    expect(EVENT_STREAM_POLL_INTERVAL_MS).toBe(1000);
    expect(EVENT_STREAM_BATCH_MAX_EVENTS).toBe(100);
    expect(EVENT_STREAM_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(EVENT_STREAM_ROTATE_AFTER_MS).toBe(50_000);
    expect(EVENT_STREAM_MAX_DURATION_SECONDS).toBe(60);
    expect(EVENT_STREAM_MAX_BUFFERED_BYTES).toBe(1024 * 1024);
    expect(EVENT_STREAM_RECONNECT_MIN_MS).toBe(1000);
    expect(EVENT_STREAM_RECONNECT_MAX_MS).toBe(30_000);
  });

  it("rotate before the function's maximum duration", () => {
    expect(EVENT_STREAM_ROTATE_AFTER_MS).toBeLessThan(EVENT_STREAM_MAX_DURATION_SECONDS * 1000);
    expect(EVENT_STREAM_HEARTBEAT_INTERVAL_MS).toBeLessThan(EVENT_STREAM_ROTATE_AFTER_MS);
  });

  it("size frames and batches from the largest Event", () => {
    expect(MAX_EVENT_STREAM_FRAME_BYTES).toBeGreaterThan(MAX_EVENT_BYTES);
    // The frame wrapper and SSE fields of a maximal Event fit in the allowance.
    const sseOverhead =
      utf8ByteLength(`id: ${"A".repeat(MAX_CURSOR_LENGTH)}\nevent: message\ndata: \n\n`) +
      utf8ByteLength(JSON.stringify({ type: "event", event: null })) -
      "null".length;
    expect(MAX_EVENT_BYTES + sseOverhead).toBeLessThanOrEqual(MAX_EVENT_STREAM_FRAME_BYTES);
    // One maximal Event always fits a batch, and an in-flight batch plus a
    // queued one fit the memory cap.
    expect(EVENT_STREAM_BATCH_MIN_EVENTS).toBeGreaterThanOrEqual(1);
    expect(EVENT_STREAM_BATCH_MIN_EVENTS * MAX_EVENT_STREAM_FRAME_BYTES).toBeLessThanOrEqual(
      EVENT_STREAM_BATCH_MAX_BYTES,
    );
    expect(2 * EVENT_STREAM_BATCH_MAX_BYTES).toBeLessThanOrEqual(EVENT_STREAM_MAX_BUFFERED_BYTES);
  });

  it("back off reconnects from 1 s to 30 s with jitter", () => {
    const lowest = () => 0;
    const highest = () => 1;
    expect(eventStreamReconnectDelay(0, lowest)).toBe(1000);
    expect(eventStreamReconnectDelay(0, highest)).toBe(1000);
    expect(eventStreamReconnectDelay(1, lowest)).toBe(1000);
    expect(eventStreamReconnectDelay(1, highest)).toBe(2000);
    expect(eventStreamReconnectDelay(3, () => 0.5)).toBe(6000);
    for (const attempt of [5, 6, 50, 10_000, Number.POSITIVE_INFINITY]) {
      expect(eventStreamReconnectDelay(attempt, highest)).toBe(30_000);
      expect(eventStreamReconnectDelay(attempt, lowest)).toBe(15_000);
    }
    for (let attempt = -1; attempt < 20; attempt++) {
      const delay = eventStreamReconnectDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });
});
