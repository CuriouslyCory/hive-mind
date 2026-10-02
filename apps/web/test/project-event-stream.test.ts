import { randomUUID } from "node:crypto";
import { encodeFeedCursor, MAX_EVENT_STREAM_FRAME_BYTES } from "@hivemind/contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { os, withEventMeta } from "@orpc/server";
import { decodeEventMessage, encodeEventMessage } from "@orpc/standard-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  affectsPlan,
  affectsSession,
  isKnownEventType,
  shouldRefreshFor,
} from "../src/lib/project-event-filters";
import {
  BoundedSseDecoder,
  createProjectEventStream,
  interpretSseMessage,
  type ProjectEventStreamOptions,
  SseMessageTooLargeError,
  type StreamEvent,
} from "../src/lib/project-event-stream";

const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();
const URL_ = "http://test.local/stream";

const cursorAt = (xid: number, seq: number, projectId = PROJECT) =>
  encodeFeedCursor({ projectId, xid: String(xid), seq: String(seq) });
const FENCE = cursorAt(100, 0);

function makeEvent(xid: number, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    projectId: PROJECT,
    seq: String(seq),
    writerXid: String(xid),
    payloadVersion: 1,
    type: "plan.updated",
    actor: { kind: "user", userId: "u1" },
    actorSessionId: null,
    planId: randomUUID(),
    taskId: null,
    sessionId: null,
    payload: { title: "Grüße 🐝", bodyChanged: false },
    effectiveAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

type TestEvent = ReturnType<typeof makeEvent>;

/** oRPC's own encoder, as the server's OpenAPI handler writes each yielded frame. */
const eventMessage = (event: TestEvent) =>
  encodeEventMessage({
    event: "message",
    id: cursorAt(Number(event.writerXid), Number(event.seq), event.projectId),
    data: JSON.stringify({ type: "event", event }),
  });
const frameMessage = (frame: unknown, id?: string) =>
  encodeEventMessage({ event: "message", id, data: JSON.stringify(frame) });
const heartbeat = (withheld = false) =>
  frameMessage({ type: "heartbeat", serverTime: "2026-10-01T00:00:00.000Z", withheld });

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Connection {
  lastEventId: string | null;
  signal: AbortSignal;
  send(text: string | Uint8Array): void;
  end(): void;
  fail(): void;
}

type Responder = (connection: Connection) => Response | Error;

class FakeServer {
  readonly connections: Connection[] = [];
  readonly responders: Responder[] = [];

  readonly fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? new AbortController().signal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const safely = (action: () => void) => {
      try {
        action();
      } catch {
        // Already closed or errored.
      }
    };
    signal.addEventListener("abort", () =>
      safely(() => controller.error(new DOMException("aborted", "AbortError"))),
    );
    const connection: Connection = {
      lastEventId: headers.get("last-event-id"),
      signal,
      send: (data) =>
        safely(() => controller.enqueue(typeof data === "string" ? encoder.encode(data) : data)),
      end: () => safely(() => controller.close()),
      fail: () => safely(() => controller.error(new TypeError("network"))),
    };
    this.connections.push(connection);
    const responder = this.responders.shift();
    const result = responder
      ? responder(connection)
      : new Response(body, { headers: { "content-type": "text/event-stream" } });
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;

  get last(): Connection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error("no connection");
    return connection;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeWindow extends EventTarget {
  navigator = { onLine: true };
  setOnline(onLine: boolean) {
    this.navigator.onLine = onLine;
    this.dispatchEvent(new Event(onLine ? "online" : "offline"));
  }
}

/** Lets fetch, stream reads and promise chains run (timers stay fake). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Advances fake time, then lets what the timers started run. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

function setup(overrides: Partial<ProjectEventStreamOptions> = {}) {
  const server = new FakeServer();
  const doc = new FakeDocument();
  const win = new FakeWindow();
  const resolvers: (() => void)[] = [];
  const refresh = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
  const onAccessLost = vi.fn();
  const stream = createProjectEventStream({
    projectId: PROJECT,
    initialCursor: FENCE,
    url: URL_,
    fetch: server.fetch,
    refresh,
    onAccessLost,
    random: () => 1,
    document: doc,
    window: win,
    ...overrides,
  });
  const finishRefresh = async () => {
    resolvers.shift()?.();
    await flush();
  };
  return { server, doc, win, refresh, finishRefresh, onAccessLost, stream };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

describe("BoundedSseDecoder", () => {
  const wire = `${encodeEventMessage({ comments: [""] })}${eventMessage(makeEvent(101, 1))}${heartbeat()}`;
  const expected = wire
    .split("\n\n")
    .filter((part) => part !== "")
    .map((part) => decodeEventMessage(part));

  it("decodes every split of the bytes, including inside UTF-8 sequences, as oRPC does", () => {
    const bytes = encoder.encode(wire);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new BoundedSseDecoder();
      const messages = [
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
      ];
      expect(messages).toEqual(expected);
      expect(decoder.end()).toBe(true);
    }
  });

  it("decodes byte-by-byte delivery and CR, LF and CRLF delimiters", () => {
    const decoder = new BoundedSseDecoder();
    const text = "data: a\r\n\r\ndata: b\r\rdata: c\n\n: comment\r\n\r\n";
    const messages = [...encoder.encode(text)].flatMap((byte) => decoder.push(Uint8Array.of(byte)));
    expect(messages.map((message) => message.data)).toEqual(["a", "b", "c", undefined]);
    expect(messages[3]?.comments).toEqual(["comment"]);
    expect(decoder.end()).toBe(true);
  });

  it("reports a truncated final message", () => {
    const decoder = new BoundedSseDecoder();
    decoder.push(encoder.encode("data: partial"));
    expect(decoder.end()).toBe(false);
  });

  it("rejects an unterminated message over the cap before buffering it", () => {
    const decoder = new BoundedSseDecoder(1024);
    decoder.push(encoder.encode(`data: ${"x".repeat(1000)}`));
    expect(() => decoder.push(encoder.encode("x".repeat(100)))).toThrow(SseMessageTooLargeError);
  });

  it("rejects an oversized complete message inside one chunk", () => {
    const decoder = new BoundedSseDecoder(1024);
    const text = `data: small\n\ndata: ${"y".repeat(2000)}\n\ndata: after\n\n`;
    expect(() => decoder.push(encoder.encode(text))).toThrow(SseMessageTooLargeError);
  });

  it("bounds the default cap by the contract's frame limit", () => {
    const decoder = new BoundedSseDecoder();
    expect(() =>
      decoder.push(encoder.encode(`data: ${"z".repeat(MAX_EVENT_STREAM_FRAME_BYTES)}`)),
    ).toThrow(SseMessageTooLargeError);
  });
});

describe("interpretSseMessage", () => {
  const read = (text: string) => interpretSseMessage(decodeEventMessage(text), PROJECT);

  it("accepts a known Event and an unknown Event type with a matching cursor", () => {
    expect(read(eventMessage(makeEvent(101, 1))).kind).toBe("event");
    expect(read(eventMessage(makeEvent(101, 2, { type: "plan.archived_v9" })))).toMatchObject({
      kind: "event",
      event: { type: "plan.archived_v9" },
    });
  });

  it("unwraps oRPC's RPC serializer envelope", () => {
    const event = makeEvent(101, 1);
    const text = encodeEventMessage({
      event: "message",
      id: cursorAt(101, 1),
      data: JSON.stringify({ json: { type: "event", event }, meta: [] }),
    });
    expect(read(text).kind).toBe("event");
  });

  it.each([
    [
      "no id",
      encodeEventMessage({ data: JSON.stringify({ type: "event", event: makeEvent(1, 1) }) }),
    ],
    [
      "a cursor of another Project",
      frameMessage({ type: "event", event: makeEvent(101, 1) }, cursorAt(101, 1, OTHER_PROJECT)),
    ],
    [
      "a cursor that is not the Event's position",
      frameMessage({ type: "event", event: makeEvent(101, 1) }, cursorAt(101, 2)),
    ],
    ["an Event of another Project", eventMessage(makeEvent(101, 1, { projectId: OTHER_PROJECT }))],
    [
      "an Event without affected ids",
      frameMessage(
        { type: "event", event: { ...makeEvent(101, 1), planId: undefined } },
        cursorAt(101, 1),
      ),
    ],
    ["invalid JSON", "event: message\ndata: {nope\n\n"],
    ["a heartbeat without withheld", frameMessage({ type: "heartbeat" })],
  ])("treats a frame with %s as malformed", (_name, text) => {
    expect(read(text).kind).toBe("malformed");
  });

  it("treats an oversized data line as malformed", () => {
    const text = `data: "${"q".repeat(MAX_EVENT_STREAM_FRAME_BYTES)}"\n\n`;
    expect(read(text)).toMatchObject({ kind: "malformed", reason: "frame too large" });
  });

  it("reads oRPC done and error messages", () => {
    expect(read("event: done\n\n").kind).toBe("ignored");
    expect(read("event: done\ndata: null\n\n").kind).toBe("end");
    expect(
      read(`event: error\ndata: ${JSON.stringify({ status: 401, code: "UNAUTHORIZED" })}\n\n`),
    ).toEqual({
      kind: "server-error",
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("ignores comments and unknown control frames, with or without an id", () => {
    expect(read(": keepalive\n\n").kind).toBe("ignored");
    expect(read(frameMessage({ type: "progress" })).kind).toBe("ignored");
    expect(read(frameMessage({ type: "progress" }, cursorAt(999, 9))).kind).toBe("ignored");
  });
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

describe("createProjectEventStream", () => {
  it("reads frames produced by oRPC's OpenAPI handler", async () => {
    const event = makeEvent(101, 1);
    const eventCursor = cursorAt(101, 1);
    const router = {
      stream: os.route({ method: "GET", path: "/stream" }).handler(async function* () {
        yield withEventMeta({ type: "ready" }, { id: FENCE });
        yield withEventMeta({ type: "event", event }, { id: eventCursor });
        yield { type: "heartbeat", serverTime: "2026-10-01T00:00:00.000Z", withheld: true };
      }),
    };
    const handler = new OpenAPIHandler(router, { eventIteratorKeepAliveEnabled: false });
    const lastEventIds: (string | null)[] = [];
    const fetchViaOrpc = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(input), init);
      lastEventIds.push(request.headers.get("last-event-id"));
      const { response } = await handler.handle(request);
      if (!response) throw new Error("no route");
      return response;
    }) as typeof fetch;
    const { refresh, stream } = setup({ fetch: fetchViaOrpc });

    stream.start();
    for (let i = 0; i < 10; i++) await flush();

    expect(lastEventIds).toEqual([FENCE]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot()).toMatchObject({ cursor: eventCursor, withheld: true });

    // The generator ended within a moment, so the client backs off and then
    // resumes from the Event it processed.
    expect(stream.getSnapshot().status).toMatchObject({ kind: "reconnecting", attempt: 1 });
    await advance(1000);
    expect(lastEventIds).toEqual([FENCE, eventCursor]);
    stream.close();
  });

  it("sends Last-Event-ID on every connect, from the last processed cursor", async () => {
    const { server, stream } = setup();
    stream.start();
    await flush();
    expect(server.last.lastEventId).toBe(FENCE);

    server.last.send(eventMessage(makeEvent(101, 1)) + eventMessage(makeEvent(102, 3)));
    await flush();
    server.last.fail();
    await flush();
    await advance(1000);
    expect(server.connections).toHaveLength(2);
    expect(server.last.lastEventId).toBe(cursorAt(102, 3));
    stream.close();
  });

  it("applies a redelivered Event once and never moves the cursor back", async () => {
    const { server, refresh, finishRefresh, stream } = setup();
    stream.start();
    await flush();
    const first = makeEvent(101, 1);
    const second = makeEvent(101, 2);
    server.last.send(eventMessage(first) + eventMessage(second));
    await flush();
    // The second Event arrived during the first refresh.
    await finishRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    await finishRefresh();

    // At-least-once replay after a reconnect.
    server.last.fail();
    await flush();
    await advance(1000);
    // Going live again reconciles once (time-based state may have changed).
    server.last.send(heartbeat());
    await flush();
    expect(refresh).toHaveBeenCalledTimes(3);
    await finishRefresh();
    server.last.send(eventMessage(first) + eventMessage(second) + eventMessage(first));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(stream.getSnapshot().cursor).toBe(cursorAt(101, 2));
    stream.close();
  });

  it("decodes Events split across chunks at every byte, including inside UTF-8", async () => {
    const { server, refresh, stream } = setup();
    stream.start();
    await flush();
    for (const byte of encoder.encode(eventMessage(makeEvent(101, 1)))) {
      server.last.send(Uint8Array.of(byte));
    }
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot().cursor).toBe(cursorAt(101, 1));
    stream.close();
  });

  it("does not move the cursor for comments, heartbeats, ready without id or unknown control frames", async () => {
    const { server, refresh, stream } = setup();
    stream.start();
    await flush();
    server.last.send(
      `: \n\n: keepalive\n\n${heartbeat(true)}${frameMessage({ type: "ready" })}` +
        `${frameMessage({ type: "progress" })}${frameMessage({ type: "progress" }, cursorAt(999, 1))}`,
    );
    await flush();
    expect(stream.getSnapshot()).toMatchObject({
      cursor: FENCE,
      withheld: true,
      status: { kind: "live" },
    });
    expect(refresh).not.toHaveBeenCalled();

    server.last.fail();
    await flush();
    await advance(1000);
    expect(server.last.lastEventId).toBe(FENCE);
    stream.close();
  });

  it("adopts the ready frame's id as the resume cursor and goes live", async () => {
    const { server, stream } = setup();
    stream.start();
    await flush();
    expect(stream.getSnapshot().status.kind).toBe("connecting");
    server.last.send(frameMessage({ type: "ready" }, cursorAt(100, 0)));
    await flush();
    expect(stream.getSnapshot()).toMatchObject({ status: { kind: "live" }, cursor: FENCE });
    stream.close();
  });

  it("refreshes exactly once more for Events that arrive during a refresh", async () => {
    const { server, refresh, finishRefresh, stream } = setup();
    stream.start();
    await flush();
    server.last.send(eventMessage(makeEvent(101, 1)));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot().refreshing).toBe(true);

    server.last.send(
      eventMessage(makeEvent(101, 2)) +
        eventMessage(makeEvent(101, 3)) +
        eventMessage(makeEvent(102, 1)),
    );
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    await finishRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    await finishRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(stream.getSnapshot()).toMatchObject({ refreshing: false, cursor: cursorAt(102, 1) });
    stream.close();
  });

  it("advances the cursor past filtered Events without refreshing, and refreshes for unknown types", async () => {
    const planId = randomUUID();
    const { server, refresh, stream } = setup({
      shouldRefresh: (event) => shouldRefreshFor({ kind: "plan", planId }, event),
    });
    stream.start();
    await flush();
    server.last.send(eventMessage(makeEvent(101, 1)));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    expect(stream.getSnapshot().cursor).toBe(cursorAt(101, 1));

    server.last.send(eventMessage(makeEvent(101, 2, { type: "plan.renamed_later", planId: null })));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot().cursor).toBe(cursorAt(101, 2));
    stream.close();
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ] as const)("stops for good on HTTP %i", async (status, code) => {
    const { server, onAccessLost, stream } = setup();
    server.responders.push(() => new Response('{"code":"x"}', { status }));
    stream.start();
    await flush();
    expect(stream.getSnapshot().status).toEqual({ kind: "access-lost", code });
    expect(onAccessLost).toHaveBeenCalledWith(code);
    await advance(120_000);
    expect(server.connections).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops for good on an access_lost frame without moving the cursor", async () => {
    const { server, refresh, onAccessLost, stream } = setup();
    stream.start();
    await flush();
    server.last.send(frameMessage({ type: "access_lost", code: "NOT_FOUND" }));
    await flush();
    expect(stream.getSnapshot()).toMatchObject({
      status: { kind: "access-lost", code: "NOT_FOUND" },
      cursor: FENCE,
    });
    expect(onAccessLost).toHaveBeenCalledWith("NOT_FOUND");
    expect(server.last.signal.aborted).toBe(true);
    await advance(120_000);
    expect(server.connections).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  const badRequest = () => new Response('{"code":"BAD_REQUEST"}', { status: 400 });

  it("on HTTP 400 refreshes the page once and resumes from its fresh fence, never from the latest Event", async () => {
    const { server, refresh, finishRefresh, stream } = setup();
    server.responders.push(badRequest);
    stream.start();
    await flush();
    expect(stream.getSnapshot().status).toMatchObject({ kind: "reconnecting" });
    expect(refresh).toHaveBeenCalledTimes(1);
    // It waits for the fresh render rather than reconnecting without a cursor.
    await advance(30_000);
    expect(server.connections).toHaveLength(1);
    // The rejected cursor itself is not a fresh fence.
    expect(stream.adoptFence(FENCE)).toBe(false);

    // The refreshed page registers the fence of its new snapshot.
    const fresh = cursorAt(90, 0);
    expect(stream.adoptFence(fresh)).toBe(true);
    await flush();
    expect(server.connections).toHaveLength(2);
    expect(server.last.lastEventId).toBe(fresh);
    expect(stream.getSnapshot().cursor).toBe(fresh);
    server.last.send(eventMessage(makeEvent(91, 1)));
    await flush();
    expect(stream.getSnapshot()).toMatchObject({
      status: { kind: "live" },
      cursor: cursorAt(91, 1),
    });
    await finishRefresh();
    expect(stream.getSnapshot().status).toEqual({ kind: "live" });
    // Outside a resnapshot, a page's fence is not adopted.
    expect(stream.adoptFence(cursorAt(95, 0))).toBe(false);
    stream.close();
  });

  it("stops with an error when the fresh fence is rejected too", async () => {
    const { server, stream } = setup();
    server.responders.push(badRequest, badRequest);
    stream.start();
    await flush();
    expect(stream.adoptFence(cursorAt(90, 0))).toBe(true);
    await flush();
    expect(stream.getSnapshot().status).toEqual({ kind: "error", reason: "bad-request" });
    await advance(120_000);
    expect(server.connections).toHaveLength(2);
  });

  it("stops with an error when the resnapshot refresh brings no fresh fence", async () => {
    const { server, finishRefresh, stream } = setup();
    server.responders.push(badRequest);
    stream.start();
    await flush();
    await finishRefresh();
    expect(stream.getSnapshot().status).toEqual({ kind: "error", reason: "bad-request" });
    expect(stream.adoptFence(cursorAt(90, 0))).toBe(false);
    await advance(120_000);
    expect(server.connections).toHaveLength(1);
  });

  it("adopts only the fence of a refresh started after the rejection", async () => {
    const { server, refresh, finishRefresh, stream } = setup();
    stream.start();
    await flush();
    server.last.send(eventMessage(makeEvent(101, 1)));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    // The connection is rejected on resume while that refresh is in flight.
    server.responders.push(badRequest);
    server.last.end();
    await advance(1_000);
    expect(stream.getSnapshot().status).toMatchObject({ kind: "reconnecting" });
    // A render read before the rejection is not fresh.
    expect(stream.adoptFence(cursorAt(90, 0))).toBe(false);
    await finishRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(stream.getSnapshot().status).toMatchObject({ kind: "reconnecting" });
    expect(stream.adoptFence(cursorAt(92, 0))).toBe(true);
    await flush();
    expect(server.last.lastEventId).toBe(cursorAt(92, 0));
    stream.close();
  });

  it("does not connect with a cursor that is not this Project's", async () => {
    const { server, stream } = setup({ initialCursor: cursorAt(5, 0, OTHER_PROJECT) });
    stream.start();
    await flush();
    expect(stream.getSnapshot().status).toEqual({ kind: "error", reason: "invalid-cursor" });
    expect(server.connections).toHaveLength(0);
  });

  it("backs off from 1 s to a 30 s cap on server and network failures", async () => {
    const { server, stream } = setup();
    for (let i = 0; i < 4; i++) server.responders.push(() => new Response("oops", { status: 500 }));
    server.responders.push(() => new TypeError("network"));
    server.responders.push(
      () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    server.responders.push(() => new Response("oops", { status: 503 }));
    stream.start();
    await flush();

    const delays: number[] = [];
    for (const _ of [1, 2, 3, 4, 5, 6, 7]) {
      const status = stream.getSnapshot().status;
      if (status.kind !== "reconnecting" || status.nextAttemptAt === null) {
        throw new Error(`expected a scheduled reconnect, got ${status.kind}`);
      }
      const delay = status.nextAttemptAt - Date.now();
      delays.push(delay);
      const before = server.connections.length;
      await advance(delay - 1);
      expect(server.connections).toHaveLength(before);
      await advance(1);
      expect(server.connections).toHaveLength(before + 1);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    stream.close();
  });

  it("treats a malformed frame as a failure: it reconnects without crashing or moving the cursor", async () => {
    const { server, refresh, stream } = setup();
    stream.start();
    await flush();
    server.last.send("event: message\ndata: {not json\n\n");
    await flush();
    expect(stream.getSnapshot().status).toMatchObject({ kind: "reconnecting" });
    await advance(1000);
    expect(server.last.lastEventId).toBe(FENCE);
    expect(refresh).not.toHaveBeenCalled();
    stream.close();
  });

  it("reconnects after an oversized undecoded message", async () => {
    const { server, stream } = setup();
    stream.start();
    await flush();
    server.last.send(`data: ${"x".repeat(MAX_EVENT_STREAM_FRAME_BYTES)}`);
    await flush();
    expect(stream.getSnapshot()).toMatchObject({ status: { kind: "reconnecting" }, cursor: FENCE });
    stream.close();
  });

  it("reconnects at once after a planned end of a healthy stream, resetting the backoff", async () => {
    const { server, stream } = setup();
    server.responders.push(() => new Response("oops", { status: 500 }));
    stream.start();
    await flush();
    await advance(1000);
    expect(server.connections).toHaveLength(2);

    server.last.send(frameMessage({ type: "ready" }, FENCE) + eventMessage(makeEvent(101, 1)));
    await flush();
    await advance(50_000);
    server.last.end();
    await flush();
    expect(server.connections).toHaveLength(3);
    expect(server.last.lastEventId).toBe(cursorAt(101, 1));
    expect(stream.getSnapshot().status.kind).toBe("live");

    // The backoff starts over after the healthy connection.
    server.last.fail();
    await flush();
    const status = stream.getSnapshot().status;
    expect(status).toMatchObject({ kind: "reconnecting", attempt: 1 });
    expect(status.kind === "reconnecting" && status.nextAttemptAt).toBe(Date.now() + 1000);
    stream.close();
  });

  it("closes the old Project's stream; the next Project starts from its own cursor", async () => {
    const a = setup();
    a.stream.start();
    await flush();
    a.server.last.send(eventMessage(makeEvent(101, 1)));
    await flush();
    a.stream.close();
    expect(a.server.last.signal.aborted).toBe(true);
    expect(a.stream.getSnapshot().status.kind).toBe("closed");

    const otherFence = cursorAt(7, 0, OTHER_PROJECT);
    const b = setup({ projectId: OTHER_PROJECT, initialCursor: otherFence, fetch: a.server.fetch });
    b.stream.start();
    await flush();
    expect(a.server.last.lastEventId).toBe(otherFence);
    b.stream.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers refreshes while hidden and reconciles when visible again", async () => {
    const { server, doc, refresh, stream } = setup();
    stream.start();
    await flush();
    doc.setVisibility("hidden");
    server.last.send(eventMessage(makeEvent(101, 1)));
    await flush();
    await advance(120_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(stream.getSnapshot().cursor).toBe(cursorAt(101, 1));

    doc.setVisibility("visible");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("reconnects immediately when visible again during a backoff", async () => {
    const { server, doc, stream } = setup();
    for (let i = 0; i < 5; i++) server.responders.push(() => new Response("", { status: 502 }));
    stream.start();
    await flush();
    await advance(1000);
    await advance(2000);
    await advance(4000);
    expect(server.connections).toHaveLength(4);
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    await flush();
    expect(server.connections).toHaveLength(5);
    stream.close();
  });

  it("goes offline without retrying, then reconnects and refreshes when back online", async () => {
    const { server, win, refresh, finishRefresh, stream } = setup();
    stream.start();
    await flush();
    server.last.send(eventMessage(makeEvent(101, 1)));
    await flush();
    await finishRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    win.setOnline(false);
    await flush();
    expect(server.last.signal.aborted).toBe(true);
    expect(stream.getSnapshot().status.kind).toBe("offline");
    await advance(119_000);
    expect(server.connections).toHaveLength(1);

    win.setOnline(true);
    await flush();
    expect(server.connections).toHaveLength(2);
    expect(server.last.lastEventId).toBe(cursorAt(101, 1));
    expect(refresh).toHaveBeenCalledTimes(2);
    stream.close();
  });

  it("dates the data on screen from the page's snapshot, or claims no time until a refresh", async () => {
    const dated = setup({ lastSyncAt: 1_234 });
    expect(dated.stream.getSnapshot().lastSyncAt).toBe(1_234);

    const { finishRefresh, stream } = setup();
    stream.start();
    await flush();
    expect(stream.getSnapshot().lastSyncAt).toBeNull();
    stream.invalidate();
    await finishRefresh();
    expect(stream.getSnapshot().lastSyncAt).toBe(Date.now());
    stream.close();
  });

  it("refreshes every 60 s while visible and clears its timers and listeners on close", async () => {
    const { doc, win, refresh, finishRefresh, stream } = setup();
    stream.start();
    await flush();
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await finishRefresh();
    expect(stream.getSnapshot().lastSyncAt).toBe(Date.now());
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await finishRefresh();

    stream.close();
    expect(vi.getTimerCount()).toBe(0);
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    win.setOnline(true);
    await advance(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("maps an oRPC error message with a 401 status to lost access", async () => {
    const { server, stream } = setup();
    stream.start();
    await flush();
    server.last.send(
      `event: error\ndata: ${JSON.stringify({ status: 401, code: "UNAUTHORIZED" })}\n\n`,
    );
    await flush();
    expect(stream.getSnapshot().status).toEqual({ kind: "access-lost", code: "UNAUTHORIZED" });
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("live update filters", () => {
  const planId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const asStream = (overrides: Record<string, unknown>) =>
    makeEvent(1, 1, { planId: null, ...overrides }) as unknown as StreamEvent;

  it("knows the contract's Event types", () => {
    expect(isKnownEventType("task.claimed")).toBe(true);
    expect(isKnownEventType("task.reassigned")).toBe(false);
  });

  it("refreshes the overview for every Event", () => {
    expect(shouldRefreshFor({ kind: "project" }, asStream({ type: "scope.touched" }))).toBe(true);
  });

  it("refreshes a Plan page for its Plan, Tasks, shown Sessions and detaching Sessions", () => {
    const scope = { planId, taskIds: [taskId], sessionIds: [sessionId] };
    expect(affectsPlan(asStream({ type: "task.claimed", planId, taskId }), scope)).toBe(true);
    expect(affectsPlan(asStream({ type: "task.done", taskId }), scope)).toBe(true);
    expect(affectsPlan(asStream({ type: "scope.added", sessionId }), scope)).toBe(true);
    expect(affectsPlan(asStream({ type: "session.heartbeat", sessionId }), scope)).toBe(true);
    expect(
      affectsPlan(
        asStream({
          type: "session.attached",
          sessionId: randomUUID(),
          payload: { previousPlanId: planId, previousTaskId: null },
        }),
        scope,
      ),
    ).toBe(true);
    expect(affectsPlan(asStream({ type: "plan.updated", planId: randomUUID() }), scope)).toBe(
      false,
    );
    expect(affectsPlan(asStream({ type: "scope.added", sessionId: randomUUID() }), scope)).toBe(
      false,
    );
    expect(affectsPlan(asStream({ type: "brand.new" }), scope)).toBe(true);
  });

  it("refreshes a Session page for Events it acted through or that affected it", () => {
    const scope = { sessionId, taskId };
    expect(affectsSession(asStream({ type: "session.updated", sessionId }), scope)).toBe(true);
    expect(affectsSession(asStream({ type: "task.added", actorSessionId: sessionId }), scope)).toBe(
      true,
    );
    expect(affectsSession(asStream({ type: "task.blocked", taskId }), scope)).toBe(true);
    // It shows only its Plan's key, which never changes.
    expect(affectsSession(asStream({ type: "plan.status_changed", planId }), scope)).toBe(false);
    expect(affectsSession(asStream({ type: "task.added", planId }), scope)).toBe(false);
    expect(
      affectsSession(asStream({ type: "session.started", sessionId: randomUUID() }), scope),
    ).toBe(false);
    expect(affectsSession(asStream({ type: "brand.new" }), scope)).toBe(true);
  });
});
