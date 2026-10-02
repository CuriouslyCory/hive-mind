import {
  compareFeedPositions,
  decodeFeedCursor,
  eventStreamReconnectDelay,
  type FeedPosition,
  MAX_EVENT_STREAM_FRAME_BYTES,
} from "@hivemind/contract";
import { decodeEventMessage, type EventMessage } from "@orpc/standard-server";

// The dashboard's subscription to one Project's live Event feed (issue #11,
// ADR-0010). It reads the cookie stream with fetch, so it sees HTTP statuses
// and sends `Last-Event-ID`; turns each new Event into an invalidation; and
// coalesces invalidations into fresh server reads (`router.refresh()` in
// the provider, apps/web/src/components/dashboard/project-live-updates.tsx).
// Nothing here renders Event content: the page reads it again from the server.

// ---------------------------------------------------------------------------
// Wire decoding
// ---------------------------------------------------------------------------

/**
 * Most bytes of one SSE message (its `id:`, `event:` and `data:` lines) held
 * before it is complete, and the most bytes a complete message may have. A
 * valid frame is at most `MAX_EVENT_STREAM_FRAME_BYTES`
 * (packages/contract/src/event-stream.ts), so a longer one is a fault.
 */
export const MAX_SSE_MESSAGE_BYTES = MAX_EVENT_STREAM_FRAME_BYTES;

/** A stream sent a message over `MAX_SSE_MESSAGE_BYTES`. */
export class SseMessageTooLargeError extends Error {
  constructor() {
    super(`An event stream message exceeded ${MAX_SSE_MESSAGE_BYTES} bytes.`);
    this.name = "SseMessageTooLargeError";
  }
}

/** UTF-8 length of a string that TextDecoder produced (no lone surrogates). */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

const MESSAGE_DELIMITER = /(?:\r\n|\r(?!\n)|\n){2}/;
const MESSAGE_DELIMITER_GLOBAL = /(?:\r\n|\r(?!\n)|\n){2}/g;

/**
 * Splits an SSE byte stream into messages and parses each with oRPC's
 * `decodeEventMessage`, the parser its own client uses. The framing is
 * oRPC's `EventDecoder` algorithm (@orpc/standard-server 1.15.4), with a
 * byte bound: the text held for an incomplete message is checked before it
 * is buffered, and every complete message is checked before it is parsed,
 * so a stream without message boundaries cannot grow memory. Bytes are
 * decoded with a streaming TextDecoder, so a UTF-8 sequence split across
 * chunks decodes intact. Each `push` also splits a large network chunk into
 * slices of at most `maxMessageBytes`.
 */
export class BoundedSseDecoder {
  readonly #text = new TextDecoder("utf-8");
  readonly #maxBytes: number;
  #pending: string[] = [];
  #pendingBytes = 0;
  // Last characters of the pending text, so a delimiter that straddles two
  // chunks is still found (oRPC's `tail`).
  #tail = "";
  // A chunk-ending CR already ended a message; a leading LF next is its pair.
  #discardLeadingLF = false;

  constructor(maxMessageBytes: number = MAX_SSE_MESSAGE_BYTES) {
    this.#maxBytes = maxMessageBytes;
  }

  /** Decodes `bytes` and returns the messages it completes. Throws `SseMessageTooLargeError`. */
  push(bytes: Uint8Array): EventMessage[] {
    const messages: EventMessage[] = [];
    for (let start = 0; start < bytes.length; start += this.#maxBytes) {
      const slice = bytes.subarray(start, start + this.#maxBytes);
      this.#feed(this.#text.decode(slice, { stream: true }), messages);
    }
    return messages;
  }

  /**
   * Ends the stream. Returns whether it ended between messages; text after
   * the last complete message is a truncated message, which is dropped.
   */
  end(): boolean {
    const rest = this.#text.decode();
    if (rest !== "") this.#feed(rest, []);
    return this.#pending.length === 0;
  }

  #feed(input: string, messages: EventMessage[]): void {
    let chunk = input;
    if (chunk === "") return;
    if (this.#discardLeadingLF) {
      this.#discardLeadingLF = false;
      if (chunk.charCodeAt(0) === 10) chunk = chunk.slice(1);
      if (chunk === "") return;
    }
    const scan = this.#tail + chunk;
    if (!MESSAGE_DELIMITER.test(scan)) {
      const bytes = this.#pendingBytes + utf8ByteLength(chunk);
      if (bytes > this.#maxBytes) throw new SseMessageTooLargeError();
      this.#pending.push(chunk);
      this.#pendingBytes = bytes;
      this.#tail = scan.slice(-3);
      return;
    }
    this.#pending.push(chunk);
    const buffered = this.#pending.join("");
    const offset = buffered.length - scan.length;
    const parts: string[] = [];
    let start = 0;
    for (const match of scan.matchAll(MESSAGE_DELIMITER_GLOBAL)) {
      const part = buffered.slice(start, offset + match.index);
      if (utf8ByteLength(part) > this.#maxBytes) throw new SseMessageTooLargeError();
      parts.push(part);
      start = offset + match.index + match[0].length;
    }
    const incomplete = buffered.slice(start);
    const incompleteBytes = utf8ByteLength(incomplete);
    if (incompleteBytes > this.#maxBytes) throw new SseMessageTooLargeError();
    this.#pending = incomplete === "" ? [] : [incomplete];
    this.#pendingBytes = incompleteBytes;
    this.#tail = incomplete.slice(-3);
    if (incomplete === "") this.#discardLeadingLF = chunk.charCodeAt(chunk.length - 1) === 13;
    for (const part of parts) messages.push(decodeEventMessage(part));
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * What the engine reads from an `event` frame's Event. Validation is
 * structural so that Event types this build does not know are still
 * accepted (and refresh conservatively); the payload is passed through
 * unvalidated for filters that look at it defensively, and is never rendered.
 */
export interface StreamEvent {
  id: string;
  type: string;
  projectId: string;
  seq: string;
  writerXid: string;
  actorSessionId: string | null;
  planId: string | null;
  taskId: string | null;
  sessionId: string | null;
  payload: unknown;
}

export type AccessLostCode = "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND";

/** One SSE message, interpreted. */
export type StreamFrame =
  /** A persisted Event at feed position `position` (its SSE id `cursor`). */
  | { kind: "event"; event: StreamEvent; cursor: string; position: FeedPosition }
  /** The stream's start; its id, when present, is the position it resumes from. */
  | { kind: "ready"; cursor: string | null; position: FeedPosition | null }
  | { kind: "heartbeat"; withheld: boolean }
  | { kind: "access-lost"; code: AccessLostCode }
  /** The server ended the stream (oRPC `done`). */
  | { kind: "end" }
  /** An oRPC `error` message: the procedure failed after the stream opened. */
  | { kind: "server-error"; status: number | null; code: string | null }
  /** Comments, retry hints and control frames this build does not know. */
  | { kind: "ignored" }
  | { kind: "malformed"; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const MAX_EVENT_TYPE_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function readStreamEvent(value: unknown): StreamEvent | null {
  if (!isRecord(value)) return null;
  const { id, type, projectId, seq, writerXid, actorSessionId, planId, taskId, sessionId } = value;
  if (!isUuid(id) || !isUuid(projectId)) return null;
  if (typeof type !== "string" || type.length > MAX_EVENT_TYPE_LENGTH || !EVENT_TYPE.test(type)) {
    return null;
  }
  if (typeof seq !== "string" || !DECIMAL.test(seq)) return null;
  if (typeof writerXid !== "string" || !DECIMAL.test(writerXid)) return null;
  if (
    !isNullableUuid(actorSessionId) ||
    !isNullableUuid(planId) ||
    !isNullableUuid(taskId) ||
    !isNullableUuid(sessionId)
  ) {
    return null;
  }
  return {
    id,
    type,
    projectId,
    seq,
    writerXid,
    actorSessionId,
    planId,
    taskId,
    sessionId,
    payload: value.payload,
  };
}

function parseJson(data: string | undefined): unknown {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * The frame object in a message's data: oRPC's OpenAPI handler sends the
 * frame's JSON as is; its RPC serializer wraps it as `{ json, meta }`. A
 * frame always has `type`, so a `json` key without `type` is the wrapper.
 */
function unwrapFrame(value: unknown): unknown {
  if (isRecord(value) && !("type" in value) && "json" in value) return value.json;
  return value;
}

function readAccessLostCode(value: unknown): AccessLostCode {
  return value === "NOT_FOUND" || value === "FORBIDDEN" ? value : "UNAUTHORIZED";
}

/** The access-loss code of an HTTP status, or null if it is not one. */
function accessLostCodeForStatus(status: number | null): AccessLostCode | null {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  return null;
}

/**
 * Interprets one decoded SSE message of `projectId`'s feed. Only `event`
 * and `ready` frames carry a cursor, and only one that decodes as a feed
 * cursor of this Project is accepted; an `event` frame's cursor must also
 * be its Event's position.
 */
export function interpretSseMessage(message: EventMessage, projectId: string): StreamFrame {
  if (message.data === undefined) return { kind: "ignored" };
  if (utf8ByteLength(message.data) > MAX_EVENT_STREAM_FRAME_BYTES) {
    return { kind: "malformed", reason: "frame too large" };
  }
  const name = message.event ?? "message";
  const value = unwrapFrame(parseJson(message.data));

  if (name === "error") {
    const status = isRecord(value) && typeof value.status === "number" ? value.status : null;
    const code = isRecord(value) && typeof value.code === "string" ? value.code : null;
    return { kind: "server-error", status, code };
  }
  if (name === "done") {
    // A generator's return value: honour a terminal frame, otherwise end.
    if (isRecord(value) && value.type === "access_lost") {
      return { kind: "access-lost", code: readAccessLostCode(value.code) };
    }
    return { kind: "end" };
  }
  if (name !== "message") return { kind: "ignored" };
  if (!isRecord(value) || typeof value.type !== "string") {
    return { kind: "malformed", reason: "frame is not an object with a type" };
  }

  switch (value.type) {
    case "event": {
      const event = readStreamEvent(value.event);
      if (!event) return { kind: "malformed", reason: "invalid Event" };
      if (event.projectId !== projectId.toLowerCase()) {
        return { kind: "malformed", reason: "Event of another Project" };
      }
      if (message.id === undefined) return { kind: "malformed", reason: "Event without an id" };
      const decoded = decodeFeedCursor(message.id, projectId);
      if (!decoded.ok) return { kind: "malformed", reason: `Event id ${decoded.failure}` };
      if (decoded.position.xid !== event.writerXid || decoded.position.seq !== event.seq) {
        return { kind: "malformed", reason: "Event id is not the Event's position" };
      }
      return { kind: "event", event, cursor: message.id, position: decoded.position };
    }
    case "ready": {
      if (message.id === undefined) return { kind: "ready", cursor: null, position: null };
      const decoded = decodeFeedCursor(message.id, projectId);
      if (!decoded.ok) return { kind: "malformed", reason: `ready id ${decoded.failure}` };
      return { kind: "ready", cursor: message.id, position: decoded.position };
    }
    case "heartbeat":
      if (typeof value.withheld !== "boolean") {
        return { kind: "malformed", reason: "heartbeat without withheld" };
      }
      return { kind: "heartbeat", withheld: value.withheld };
    case "access_lost":
      return { kind: "access-lost", code: readAccessLostCode(value.code) };
    default:
      // A control frame from a later version. Its id, if any, is not adopted:
      // only frames this client understands move the cursor.
      return { kind: "ignored" };
  }
}

// ---------------------------------------------------------------------------
// Refresh scheduling
// ---------------------------------------------------------------------------

export interface RefreshScheduler {
  /** Marks the page dirty; a refresh runs now or after the one in flight. */
  request(): void;
  /** Drops pending requests and stops scheduling. An in-flight refresh finishes. */
  stop(): void;
  readonly refreshing: boolean;
}

/**
 * Coalesces refresh requests: at most one refresh runs at a time, and
 * requests that arrive while it runs produce exactly one more after it. A
 * dirty generation counts requests; a refresh covers every request made
 * before it started, so none made during it is lost.
 *
 * `refresh` resolves when the fresh server read has been applied. The
 * provider adapts `router.refresh()`, which returns nothing, by running it
 * in a React transition and resolving when the transition's `isPending`
 * returns to false (see project-live-updates.tsx). A rejected refresh counts
 * as done; the next request or the periodic refresh tries again.
 */
export function createRefreshScheduler(options: {
  refresh: () => void | Promise<void>;
  /** Whether a refresh may start now (the provider defers while the tab is hidden). */
  canRun?: () => boolean;
  onStart?: () => void;
  onSettled?: (succeeded: boolean) => void;
}): RefreshScheduler {
  let requested = 0;
  let covered = 0;
  let inFlight = false;
  let stopped = false;

  const pump = () => {
    if (stopped || inFlight || covered >= requested) return;
    if (options.canRun && !options.canRun()) return;
    const generation = requested;
    inFlight = true;
    options.onStart?.();
    let succeeded = false;
    void (async () => {
      try {
        await options.refresh();
        succeeded = true;
      } catch {
        // Reported through onSettled; the page keeps its last good render.
      } finally {
        covered = generation;
        inFlight = false;
        options.onSettled?.(succeeded);
        pump();
      }
    })();
  };

  return {
    request() {
      if (stopped) return;
      requested++;
      pump();
    },
    stop() {
      stopped = true;
    },
    get refreshing() {
      return inFlight;
    },
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type ProjectEventStreamStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  /** Waiting `nextAttemptAt` (epoch ms) to retry, or retrying now when null. */
  | { kind: "reconnecting"; attempt: number; nextAttemptAt: number | null }
  | { kind: "offline" }
  /** Terminal: the login session or Project access ended. */
  | { kind: "access-lost"; code: AccessLostCode }
  /**
   * Terminal: the server rejected the request (400) twice, for the resume
   * cursor and then for a fresh page's fence, or the fence did not decode.
   */
  | { kind: "error"; reason: "bad-request" | "invalid-cursor" }
  | { kind: "closed" };

export interface ProjectEventStreamSnapshot {
  status: ProjectEventStreamStatus;
  /** Feed cursor of the last processed frame; sent as `Last-Event-ID`. */
  cursor: string;
  /** When the last new Event was accepted (epoch ms). */
  lastEventAt: number | null;
  /**
   * When the data on screen was read (epoch ms): the page's snapshot time,
   * then the end of each successful refresh. Null until known.
   */
  lastSyncAt: number | null;
  /** The latest heartbeat's `withheld`: delivery waits for an older open transaction. */
  withheld: boolean;
  refreshing: boolean;
}

/** The parts of `document` the engine uses. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** The parts of `window` the engine uses. */
export interface NetworkSource {
  readonly navigator?: { readonly onLine: boolean };
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
}

export interface ProjectEventStreamOptions {
  projectId: string;
  /** The page's server-issued fence cursor `(H, 0)` (ADR-0010 snapshot handoff). */
  initialCursor: string;
  /** When the page's snapshot was read (epoch ms). Absent or null: unknown until the first refresh. */
  lastSyncAt?: number | null;
  /** Applies invalidations: re-reads the page from the server. */
  refresh: () => void | Promise<void>;
  /** Whether an Event affects what the page shows. Defaults to every Event. */
  shouldRefresh?: (event: StreamEvent) => boolean;
  /** Called once when the stream reports lost access. */
  onAccessLost?: (code: AccessLostCode) => void;
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  /** Defaults to `globalThis.document` when there is one. */
  document?: VisibilitySource | null;
  /** Defaults to `globalThis.window` when there is one. */
  window?: NetworkSource | null;
  /** Interval of the time-based refresh while visible. */
  periodicRefreshMs?: number;
  /** How many recent Event ids are remembered for deduplication. */
  dedupeCapacity?: number;
}

export interface ProjectEventStream {
  start(): void;
  /** Refreshes the page and reconnects now if the stream is waiting to. */
  reconcile(): void;
  /**
   * Marks the page dirty without touching the connection: it refreshes now,
   * or after the refresh in flight. Does nothing before `start()` or once
   * the stream has stopped.
   */
  invalidate(): void;
  /**
   * Offers the fence of a fresh render of the page. The stream adopts it only
   * while it waits for one after the server rejected its resume cursor, and
   * then reconnects from it; returns whether it did.
   */
  adoptFence(cursor: string): boolean;
  close(): void;
  getSnapshot(): ProjectEventStreamSnapshot;
  subscribe(listener: () => void): () => void;
}

/** Time-based refresh interval: lease and liveness displays change with time alone. */
export const PERIODIC_REFRESH_MS = 60_000;

/** Recent Event ids remembered to drop redelivered Events. */
export const EVENT_DEDUPE_CAPACITY = 2048;

/**
 * A connection open at least this long that delivered a valid frame was
 * healthy: its end resets the backoff, and a clean end (the server's
 * rotation) reconnects at once rather than after a delay.
 */
export const HEALTHY_CONNECTION_MS = 5_000;

export function projectEventStreamUrl(projectId: string): string {
  return `/api/dashboard/projects/${encodeURIComponent(projectId)}/events/stream`;
}

type ConnectionOutcome =
  | { kind: "aborted" }
  | { kind: "ended"; clean: boolean }
  | { kind: "failed" }
  | { kind: "access-lost"; code: AccessLostCode }
  | { kind: "bad-request" };

function defaultDocument(): VisibilitySource | null {
  return typeof document === "undefined" ? null : document;
}

function defaultWindow(): NetworkSource | null {
  return typeof window === "undefined" ? null : window;
}

/**
 * Opens nothing until `start()`. One engine serves one Project: a page that
 * switches Project closes it and creates another, so no cursor crosses
 * Projects.
 */
export function createProjectEventStream(options: ProjectEventStreamOptions): ProjectEventStream {
  const projectId = options.projectId;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const doc = options.document === undefined ? defaultDocument() : options.document;
  const win = options.window === undefined ? defaultWindow() : options.window;
  const url = options.url ?? projectEventStreamUrl(projectId);
  const periodicMs = options.periodicRefreshMs ?? PERIODIC_REFRESH_MS;
  const dedupeCapacity = options.dedupeCapacity ?? EVENT_DEDUPE_CAPACITY;

  let snapshot: ProjectEventStreamSnapshot = {
    status: { kind: "connecting" },
    cursor: options.initialCursor,
    lastEventAt: null,
    lastSyncAt: options.lastSyncAt ?? null,
    withheld: false,
    refreshing: false,
  };
  let cursorPosition: FeedPosition | null = null;
  const listeners = new Set<() => void>();
  const seenEventIds = new Set<string>();

  let started = false;
  let terminal = false;
  let connection: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;
  // Whether the current connection has delivered a valid frame.
  let delivered = false;
  // Set after a failure or going offline: the next live connection refreshes
  // the page once, since time-based state may have changed meanwhile.
  let reconcileWhenLive = false;
  // Resnapshot after a 400. A Postgres crash can leave an issued cursor
  // naming a transaction ID the server has not issued again yet, so the
  // server rejects it. The stream then resumes from the fence of a page read
  // after the rejection, once: a rejected fresh fence is terminal. It never
  // tails from the server's current position, which would skip Events the
  // page has not read.
  let resnapshotUsed = false;
  // The rejected cursor, while a fresh fence is awaited.
  let rejectedCursor: string | null = null;
  // Whether a refresh started after the rejection: only its fence is fresh.
  let resnapshotRefreshStarted = false;

  const update = (patch: Partial<ProjectEventStreamSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const isVisible = () => !doc || doc.visibilityState === "visible";
  const isOnline = () => win?.navigator?.onLine !== false;

  const scheduler = createRefreshScheduler({
    refresh: () => options.refresh(),
    canRun: isVisible,
    onStart: () => {
      if (rejectedCursor !== null) resnapshotRefreshStarted = true;
      update({ refreshing: true });
    },
    onSettled: (succeeded) => {
      update(succeeded ? { refreshing: false, lastSyncAt: now() } : { refreshing: false });
      // The fresh render registers its fence before its refresh settles; a
      // refresh that brought none (it failed, or timed out) ends the stream.
      if (rejectedCursor !== null && resnapshotRefreshStarted) {
        finish({ kind: "error", reason: "bad-request" });
      }
    },
  });

  const rememberEvent = (id: string): boolean => {
    if (seenEventIds.has(id)) {
      // Keep recently redelivered ids longest.
      seenEventIds.delete(id);
      seenEventIds.add(id);
      return false;
    }
    seenEventIds.add(id);
    if (seenEventIds.size > dedupeCapacity) {
      const oldest = seenEventIds.values().next().value;
      if (oldest !== undefined) seenEventIds.delete(oldest);
    }
    return true;
  };

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const startPeriodic = () => {
    if (periodicTimer !== null || terminal) return;
    periodicTimer = setInterval(() => {
      if (isVisible() && snapshot.status.kind !== "offline") scheduler.request();
    }, periodicMs);
  };

  const stopPeriodic = () => {
    if (periodicTimer !== null) clearInterval(periodicTimer);
    periodicTimer = null;
  };

  const abortConnection = () => {
    const current = connection;
    connection = null;
    current?.abort();
  };

  const onVisibilityChange = () => {
    if (terminal) return;
    if (isVisible()) {
      startPeriodic();
      reconcile();
    } else {
      stopPeriodic();
    }
  };

  const onOnline = () => {
    if (terminal) return;
    attempt = 0;
    reconcile();
  };

  const onOffline = () => {
    if (terminal) return;
    abortConnection();
    clearRetry();
    reconcileWhenLive = true;
    update({ status: { kind: "offline" } });
  };

  const removeListeners = () => {
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
    win?.removeEventListener("online", onOnline);
    win?.removeEventListener("offline", onOffline);
  };

  const finish = (status: ProjectEventStreamStatus) => {
    terminal = true;
    abortConnection();
    clearRetry();
    stopPeriodic();
    removeListeners();
    scheduler.stop();
    update({ status });
  };

  const scheduleReconnect = (delay: number) => {
    clearRetry();
    if (!isOnline()) {
      reconcileWhenLive = true;
      update({ status: { kind: "offline" } });
      return;
    }
    if (delay <= 0) {
      connect();
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    update({ status: { kind: "reconnecting", attempt, nextAttemptAt: now() + delay } });
  };

  const backoff = () => {
    reconcileWhenLive = true;
    const delay = eventStreamReconnectDelay(attempt, random);
    attempt++;
    scheduleReconnect(delay);
  };

  const markLive = () => {
    delivered = true;
    if (snapshot.status.kind !== "live") update({ status: { kind: "live" } });
    if (reconcileWhenLive) {
      reconcileWhenLive = false;
      scheduler.request();
    }
  };

  /**
   * Applies one frame. Returns the connection's outcome when the frame ends
   * it, else null. The cursor moves only after an Event has been accepted
   * and its invalidation recorded, and never backwards.
   */
  const applyFrame = (frame: StreamFrame): ConnectionOutcome | null => {
    switch (frame.kind) {
      case "event": {
        const isNew = rememberEvent(frame.event.id);
        if (isNew) {
          let affects = true;
          try {
            affects = options.shouldRefresh ? options.shouldRefresh(frame.event) : true;
          } catch {
            affects = true;
          }
          if (affects) scheduler.request();
        }
        const advance =
          cursorPosition === null || compareFeedPositions(frame.position, cursorPosition) > 0;
        if (advance) cursorPosition = frame.position;
        if (advance || isNew) {
          update({
            ...(advance ? { cursor: frame.cursor } : {}),
            ...(isNew ? { lastEventAt: now() } : {}),
          });
        }
        markLive();
        return null;
      }
      case "ready":
        // The position this stream resumes from: the server's own record of
        // our Last-Event-ID, or the fence it chose.
        if (frame.cursor !== null && frame.position !== null) {
          cursorPosition = frame.position;
          update({ cursor: frame.cursor });
        }
        markLive();
        return null;
      case "heartbeat":
        if (snapshot.withheld !== frame.withheld) update({ withheld: frame.withheld });
        markLive();
        return null;
      case "access-lost":
        return { kind: "access-lost", code: frame.code };
      case "end":
        return { kind: "ended", clean: true };
      case "server-error": {
        const code = accessLostCodeForStatus(frame.status);
        if (code) return { kind: "access-lost", code };
        return frame.status === 400 ? { kind: "bad-request" } : { kind: "failed" };
      }
      case "ignored":
        return null;
      case "malformed":
        return { kind: "failed" };
    }
  };

  const runConnection = async (controller: AbortController): Promise<ConnectionOutcome> => {
    const aborted = () => controller.signal.aborted;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "text/event-stream", "last-event-id": snapshot.cursor },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return aborted() ? { kind: "aborted" } : { kind: "failed" };
    }
    if (aborted()) return { kind: "aborted" };

    // Statuses first: an error body is never read as a stream.
    const lostCode = accessLostCodeForStatus(response.status);
    if (lostCode) {
      void response.body?.cancel().catch(() => {});
      return { kind: "access-lost", code: lostCode };
    }
    if (response.status === 400) {
      void response.body?.cancel().catch(() => {});
      return { kind: "bad-request" };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status !== 200 || !response.body || !/^text\/event-stream\b/i.test(contentType)) {
      void response.body?.cancel().catch(() => {});
      return { kind: "failed" };
    }

    const reader = response.body.getReader();
    const decoder = new BoundedSseDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (aborted()) return { kind: "aborted" };
        if (done) return { kind: "ended", clean: decoder.end() };
        for (const message of decoder.push(value)) {
          const outcome = applyFrame(interpretSseMessage(message, projectId));
          if (aborted()) return { kind: "aborted" };
          if (outcome) return outcome;
        }
      }
    } catch {
      // A network error, an oversized message or a decoding failure.
      return aborted() ? { kind: "aborted" } : { kind: "failed" };
    } finally {
      void reader.cancel().catch(() => {});
    }
  };

  function connect(): void {
    if (terminal || rejectedCursor !== null) return;
    clearRetry();
    abortConnection();
    const controller = new AbortController();
    connection = controller;
    delivered = false;
    const openedAt = now();
    if (snapshot.status.kind === "reconnecting" || snapshot.status.kind === "offline") {
      update({ status: { kind: "reconnecting", attempt, nextAttemptAt: null } });
    }
    void runConnection(controller).then((outcome) => {
      if (connection !== controller || terminal) return;
      connection = null;
      // Releases the request on every exit path; the reader is already cancelled.
      controller.abort();
      // Healthy: it delivered a valid frame and stayed open a while.
      const healthy = delivered && now() - openedAt >= HEALTHY_CONNECTION_MS;
      if (healthy) {
        attempt = 0;
        // The server accepted the adopted fence: a later rejection is a new fault.
        resnapshotUsed = false;
      }
      switch (outcome.kind) {
        case "aborted":
          return;
        case "access-lost":
          options.onAccessLost?.(outcome.code);
          finish({ kind: "access-lost", code: outcome.code });
          return;
        case "bad-request":
          if (resnapshotUsed) {
            finish({ kind: "error", reason: "bad-request" });
            return;
          }
          resnapshotUsed = true;
          rejectedCursor = snapshot.cursor;
          resnapshotRefreshStarted = false;
          cursorPosition = null;
          update({ status: { kind: "reconnecting", attempt, nextAttemptAt: null } });
          scheduler.request();
          return;
        case "ended":
          // The server's planned rotation: resume from the processed cursor
          // at once. A quick or truncated end backs off like a failure.
          if (outcome.clean && healthy) scheduleReconnect(0);
          else backoff();
          return;
        case "failed":
          backoff();
          return;
      }
    });
  }

  function reconcile(): void {
    if (!started || terminal) return;
    scheduler.request();
    if (connection === null && isOnline()) connect();
  }

  return {
    start() {
      if (started || terminal) return;
      started = true;
      const decoded = decodeFeedCursor(options.initialCursor, projectId);
      if (!decoded.ok) {
        finish({ kind: "error", reason: "invalid-cursor" });
        return;
      }
      cursorPosition = decoded.position;
      doc?.addEventListener("visibilitychange", onVisibilityChange);
      win?.addEventListener("online", onOnline);
      win?.addEventListener("offline", onOffline);
      if (isVisible()) startPeriodic();
      if (isOnline()) connect();
      else onOffline();
    },
    reconcile,
    invalidate() {
      if (!started || terminal) return;
      scheduler.request();
    },
    adoptFence(cursor) {
      if (terminal || rejectedCursor === null || !resnapshotRefreshStarted) return false;
      if (cursor === rejectedCursor) return false;
      const decoded = decodeFeedCursor(cursor, projectId);
      if (!decoded.ok) {
        finish({ kind: "error", reason: "invalid-cursor" });
        return false;
      }
      rejectedCursor = null;
      cursorPosition = decoded.position;
      attempt = 0;
      update({ cursor });
      if (isOnline()) connect();
      else onOffline();
      return true;
    },
    close() {
      if (terminal) return;
      finish({ kind: "closed" });
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
