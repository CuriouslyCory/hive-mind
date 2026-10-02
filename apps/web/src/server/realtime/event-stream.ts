import {
  EVENT_STREAM_BATCH_MAX_BYTES,
  EVENT_STREAM_BATCH_MAX_EVENTS,
  EVENT_STREAM_HEARTBEAT_INTERVAL_MS,
  EVENT_STREAM_MAX_BUFFERED_BYTES,
  EVENT_STREAM_POLL_INTERVAL_MS,
  EVENT_STREAM_ROTATE_AFTER_MS,
  type EventStreamFrame,
  encodeFeedCursor,
  type FeedPosition,
  MAX_EVENT_STREAM_FRAME_BYTES,
} from "@hivemind/contract";
import {
  type Db,
  type DbOrTransaction,
  describeFailure,
  type FeedBatch,
  feedPositionOf,
  isIssuableFeedPosition,
  pollEventFeed,
  readFeedHorizon,
} from "@hivemind/db";
import { withEventMeta } from "@orpc/server";
import { sql } from "drizzle-orm";
import { toEventDto } from "../api/coordination-dto";

// The live Event feed engine (issue #11, "Stream lifecycle"; ADR-0010),
// shared by the bearer route `GET /api/v1/projects/{id}/events/stream` and
// the dashboard's cookie route. An adapter authenticates and authorizes the
// request, then:
//
// 1. creates a `StreamLifecycle`, which owns the stream's wall-clock deadline,
//    its cancellation and the response-body wrapper;
// 2. calls `openEventStream`, which validates the start position against the
//    database before any byte is sent, so a bad cursor is a 400, not a 200;
// 3. hands the generator to oRPC (keepalive comments off), whose SSE body it
//    passes through `StreamLifecycle.wrap`.
//
// Every batch runs in one short transaction on the shared pool: a fresh
// access check, then one feed poll. No connection or transaction is held
// between batches, and a statement timeout plus a wall-clock bound on each
// step keep a slow database from delaying cleanup.

/** Durations and sizes of a stream. Production uses the contract's values; tests shrink them. */
export interface EventStreamSettings {
  /** Wait between polls when the last batch was not full. */
  pollIntervalMs: number;
  /** Interval between heartbeat frames. */
  heartbeatIntervalMs: number;
  /** The stream ends itself (clean EOF) this long after it opened. */
  rotateAfterMs: number;
  /** `statement_timeout` of every statement the engine runs. */
  statementTimeoutMs: number;
  /**
   * Bound on one database step: acquiring a pooled connection plus its
   * statements. Past it the stream fails as a server error.
   */
  stepTimeoutMs: number;
  /** A consumer that keeps the send queue full this long is disconnected. */
  slowConsumerTimeoutMs: number;
  /** Log once when newer Events have been withheld this long. */
  withheldLogAfterMs: number;
  /** Most Events one poll reads. */
  batchMaxEvents: number;
  /** Byte budget of one poll (the feed's byte measure). */
  batchMaxBytes: number;
  /** Cap on queued plus in-flight bytes. */
  maxBufferedBytes: number;
  /** Worst-case bytes of one encoded frame. */
  frameMaxBytes: number;
}

export const DEFAULT_EVENT_STREAM_SETTINGS: Readonly<EventStreamSettings> = Object.freeze({
  pollIntervalMs: EVENT_STREAM_POLL_INTERVAL_MS,
  heartbeatIntervalMs: EVENT_STREAM_HEARTBEAT_INTERVAL_MS,
  rotateAfterMs: EVENT_STREAM_ROTATE_AFTER_MS,
  statementTimeoutMs: 5000,
  stepTimeoutMs: 8000,
  slowConsumerTimeoutMs: 5000,
  withheldLogAfterMs: 30_000,
  batchMaxEvents: EVENT_STREAM_BATCH_MAX_EVENTS,
  batchMaxBytes: EVENT_STREAM_BATCH_MAX_BYTES,
  maxBufferedBytes: EVENT_STREAM_MAX_BUFFERED_BYTES,
  frameMaxBytes: MAX_EVENT_STREAM_FRAME_BYTES,
});

/**
 * Frame bytes held outside the counted queue: the queue accepts one frame
 * past its high-water mark, and oRPC's encoder (the frame the generator
 * yielded and the TextEncoderStream) holds up to two more.
 */
export function uncountedFrameBytes(settings: Readonly<EventStreamSettings>): number {
  return 3 * settings.frameMaxBytes;
}

/**
 * The response queue's high-water mark: what is left of `maxBufferedBytes`
 * after one batch in flight and the uncounted frames, so the stream's Event
 * bytes stay within the cap.
 */
export function queueHighWaterMark(settings: Readonly<EventStreamSettings>): number {
  return Math.max(
    1,
    settings.maxBufferedBytes - settings.batchMaxBytes - uncountedFrameBytes(settings),
  );
}

/**
 * Why a stream ended. `rotate` and `done` close the body cleanly (the client
 * reconnects with its cursor); the others end it at once, dropping what was
 * queued, since nobody is reading it or it must not be held any longer.
 */
export type StreamEndReason =
  /** The wall-clock deadline (`rotateAfterMs`) passed. */
  | "rotate"
  /** The engine finished: access was lost, or it failed after the stream opened. */
  | "done"
  /** The request was aborted. */
  | "abort"
  /** The consumer cancelled the body. */
  | "cancel"
  /** The consumer kept the queue full for `slowConsumerTimeoutMs`. */
  | "slow_consumer"
  /** Reading the encoded frames failed. */
  | "failed";

/** Rejection of a step that the stream's end interrupted. Never a server error. */
export class StreamEndedError extends Error {
  constructor() {
    super("The Event stream ended.");
    this.name = "StreamEndedError";
  }
}

/**
 * The lifecycle of one stream response: its deadline, its cancellation and
 * its memory bound, owned outside the generator so that a generator paused
 * at `yield` (its consumer stopped pulling) still ends on time and releases
 * everything. `signal` aborts when the stream ends for any reason; the engine
 * stops waiting and issues no further queries.
 */
export class StreamLifecycle {
  readonly settings: Readonly<EventStreamSettings>;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private stall: ReturnType<typeof setTimeout> | undefined;
  private readonly onRequestAbort = () => this.end("abort");
  private readonly requestSignal: AbortSignal | undefined;
  private readonly endListeners: ((reason: StreamEndReason) => void)[] = [];
  private queued: () => number = () => 0;
  private endReason: StreamEndReason | undefined;

  constructor(options: { settings?: Partial<EventStreamSettings>; requestSignal?: AbortSignal }) {
    this.settings = { ...DEFAULT_EVENT_STREAM_SETTINGS, ...options.settings };
    this.signal = this.controller.signal;
    this.deadline = setTimeout(() => this.end("rotate"), this.settings.rotateAfterMs);
    this.requestSignal = options.requestSignal;
    if (this.requestSignal?.aborted) this.end("abort");
    else this.requestSignal?.addEventListener("abort", this.onRequestAbort, { once: true });
  }

  /** Why the stream ended, or `undefined` while it runs. */
  get reason(): StreamEndReason | undefined {
    return this.endReason;
  }

  /** Bytes encoded and waiting for the consumer in the wrapped body. */
  queuedBytes(): number {
    return this.queued();
  }

  /**
   * Ends the stream: clears every timer, aborts `signal` and settles the
   * wrapped body. Later calls do nothing.
   */
  end(reason: StreamEndReason): void {
    if (this.endReason !== undefined) return;
    this.endReason = reason;
    clearTimeout(this.deadline);
    clearTimeout(this.stall);
    this.requestSignal?.removeEventListener("abort", this.onRequestAbort);
    this.controller.abort(reason);
    for (const listener of this.endListeners.splice(0)) listener(reason);
  }

  /** Resolves `true` after `ms`, or `false` as soon as the stream ends. */
  sleep(ms: number): Promise<boolean> {
    if (this.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onEnd = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        this.signal.removeEventListener("abort", onEnd);
        resolve(true);
      }, ms);
      this.signal.addEventListener("abort", onEnd, { once: true });
    });
  }

  /**
   * `work()`, unless the stream ends first (`StreamEndedError`) or it takes
   * longer than `timeoutMs` (a server error). Either way the caller stops
   * waiting at once; abandoned work runs to its own end, which the statement
   * timeout bounds, and its result is dropped.
   */
  run<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new StreamEndedError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", onEnd);
        finish();
      };
      const onEnd = () => settle(() => reject(new StreamEndedError()));
      const timer = setTimeout(
        () => settle(() => reject(new Error(`A stream step took longer than ${timeoutMs} ms.`))),
        timeoutMs,
      );
      this.signal.addEventListener("abort", onEnd, { once: true });
      work().then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  /**
   * `fn` in one short transaction on `db`'s pool with the statement timeout
   * set, bounded by `run`. A connection acquired after the stream ended runs
   * nothing.
   */
  transaction<T>(db: Db, fn: (tx: DbOrTransaction) => Promise<T>): Promise<T> {
    const { statementTimeoutMs, stepTimeoutMs } = this.settings;
    return this.run(
      () =>
        db.transaction(async (tx) => {
          if (this.signal.aborted) throw new StreamEndedError();
          await tx.execute(
            sql`select set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`,
          );
          return fn(tx);
        }),
      stepTimeoutMs,
    );
  }

  /**
   * The response body: `body` (oRPC's encoded SSE stream) behind a queue of
   * `queueHighWaterMark` bytes, so that the queue, one batch in flight and
   * the frames outside the queue (`uncountedFrameBytes`) fit in
   * `maxBufferedBytes`.
   *
   * Independently of demand: at the deadline the body closes after what is
   * already queued (frames are whole chunks, so the client never sees half
   * of one); on abort, cancel or a stalled consumer it errors at once,
   * dropping the queue. Either way the source is cancelled, which returns the
   * generator, and `signal` stops the engine even while it waits on the
   * database. A consumer that keeps the queue full for
   * `slowConsumerTimeoutMs` is disconnected; it resumes from the last Event
   * it processed.
   */
  wrap(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const highWaterMark = queueHighWaterMark(this.settings);
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.queued = () =>
            Math.max(0, highWaterMark - (controller.desiredSize ?? highWaterMark));
          const settle = (reason: StreamEndReason) => {
            reader.cancel(reason).catch(() => {});
            try {
              if (reason === "rotate" || reason === "done") controller.close();
              // Next.js treats an AbortError from a response body as the end
              // of the response rather than a server failure.
              else
                controller.error(new DOMException(`Event stream ended: ${reason}.`, "AbortError"));
            } catch {
              // Already closed or cancelled.
            }
          };
          if (this.endReason !== undefined) settle(this.endReason);
          else this.endListeners.push(settle);
        },
        pull: async (controller) => {
          clearTimeout(this.stall);
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            this.end("failed");
            return;
          }
          if (this.endReason !== undefined) return;
          if (chunk.done) {
            this.end("done");
            return;
          }
          controller.enqueue(chunk.value);
          if ((controller.desiredSize ?? 1) <= 0) {
            this.stall = setTimeout(
              () => this.end("slow_consumer"),
              this.settings.slowConsumerTimeoutMs,
            );
          }
        },
        cancel: () => this.end("cancel"),
      },
      { highWaterMark, size: (chunk) => chunk.byteLength },
    );
  }
}

/** A fresh access check's verdict; the codes are what the same request would get before the stream opened. */
export type StreamAccess = { ok: true } | { ok: false; code: "UNAUTHORIZED" | "NOT_FOUND" };

export interface OpenEventStreamOptions {
  /** The shared attached pool's client. */
  db: Db;
  projectId: string;
  /** Where the client resumes, or `null` to tail from the current horizon. */
  start: FeedPosition | null;
  /**
   * Checks the credential and Project access again, from the database,
   * before every batch, inside the batch's transaction. It must not cache
   * anything across calls. It throws when it cannot decide (a database
   * failure), which ends the stream as a server error, never `access_lost`.
   */
  authorize: (executor: DbOrTransaction) => Promise<StreamAccess>;
  lifecycle: StreamLifecycle;
}

/**
 * Validates the start position, then returns the stream's frames: one
 * `ready` frame whose SSE id is the start cursor, then Events in feed order
 * with their cursors as ids, idless heartbeats, and possibly one final
 * `access_lost`. Returns `null` for a start position the feed could not have
 * issued (a future transaction ID or sequence value): the adapter answers 400.
 *
 * The caller has already authorized the request; this does not repeat that
 * check before the first batch's own.
 */
export async function openEventStream(
  options: OpenEventStreamOptions,
): Promise<AsyncGenerator<EventStreamFrame, void, undefined> | null> {
  const { db, lifecycle } = options;
  let start: FeedPosition;
  if (options.start) {
    const position = options.start;
    const issuable = await lifecycle.transaction(db, (tx) => isIssuableFeedPosition(tx, position));
    if (!issuable) return null;
    start = position;
  } else {
    start = { xid: await lifecycle.transaction(db, readFeedHorizon), seq: "0" };
  }
  return streamFrames({ ...options, start });
}

async function* streamFrames(
  options: OpenEventStreamOptions & { start: FeedPosition },
): AsyncGenerator<EventStreamFrame, void, undefined> {
  const { db, projectId, authorize, lifecycle } = options;
  const { settings, signal } = lifecycle;
  const cursor = (position: FeedPosition) => encodeFeedCursor({ projectId, ...position });
  const withheld = new WithheldDiagnostics(projectId, settings.withheldLogAfterMs);
  let position = options.start;
  let nextHeartbeat = Date.now() + settings.heartbeatIntervalMs;

  try {
    yield withEventMeta({ type: "ready" as const }, { id: cursor(position) });
    while (!signal.aborted) {
      let full = false;
      // Poll only while a whole batch fits beside what is queued and the
      // frames outside the queue.
      const free =
        settings.maxBufferedBytes - uncountedFrameBytes(settings) - lifecycle.queuedBytes();
      if (free >= settings.batchMaxBytes) {
        const step = await lifecycle.transaction(db, async (tx) => {
          const access = await authorize(tx);
          if (!access.ok) return access;
          const batch = await pollEventFeed(tx, {
            projectId,
            after: position,
            limit: settings.batchMaxEvents,
            maxBytes: settings.batchMaxBytes,
          });
          return { ok: true as const, batch };
        });
        if (!step.ok) {
          // Terminal, idless, and the cursor stays where it was.
          yield { type: "access_lost", code: step.code };
          return;
        }
        const { batch } = step;
        withheld.observe(batch);
        // A full batch, or one the byte budget cut, means more is waiting.
        full = batch.events.length >= settings.batchMaxEvents || batch.truncated;
        // Drop each row as it is yielded, so the batch holds only what is
        // still to send.
        for (let row = batch.events.shift(); row !== undefined; row = batch.events.shift()) {
          if (signal.aborted) return;
          const next = feedPositionOf(row);
          yield withEventMeta(
            { type: "event" as const, event: toEventDto(row) },
            { id: cursor(next) },
          );
          position = next;
        }
      }
      if (signal.aborted) return;
      if (Date.now() >= nextHeartbeat) {
        nextHeartbeat = Date.now() + settings.heartbeatIntervalMs;
        yield {
          type: "heartbeat",
          serverTime: new Date().toISOString(),
          withheld: withheld.current,
        };
      }
      // Read what is waiting now rather than in a second.
      if (!full && !(await lifecycle.sleep(settings.pollIntervalMs))) return;
    }
  } catch (error) {
    if (error instanceof StreamEndedError || signal.aborted) return;
    console.error(
      `Event stream for Project ${projectId} failed after it opened: ${describeFailure(error)}`,
    );
    // oRPC sends this as an `error` frame with a generic INTERNAL_SERVER_ERROR body.
    throw error;
  }
}

/**
 * Tracks how long newer Events have been withheld behind the feed horizon
 * and logs once per stream when it passes the threshold: one bounded line
 * with the Project and the horizon, never credentials or payloads.
 */
class WithheldDiagnostics {
  current = false;
  private since: number | undefined;
  private reported = false;

  constructor(
    private readonly projectId: string,
    private readonly logAfterMs: number,
  ) {}

  observe(batch: FeedBatch): void {
    this.current = batch.withheld;
    if (!batch.withheld) {
      this.since = undefined;
      return;
    }
    const now = Date.now();
    this.since ??= now;
    if (!this.reported && now - this.since >= this.logAfterMs) {
      this.reported = true;
      console.warn(
        `Event stream for Project ${this.projectId}: newer Events have been withheld for ` +
          `${Math.round((now - this.since) / 1000)} s behind feed horizon ${batch.horizon}; ` +
          "a transaction older than the horizon is still open (ADR-0010).",
      );
    }
  }
}
