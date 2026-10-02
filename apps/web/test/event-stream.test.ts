import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
  createPlanOutputSchema,
  decodeFeedCursor,
  type EventStreamFrame,
  encodeFeedCursor,
  eventStreamFrameSchema,
  FEED_ORIGIN,
  feedOriginCursor,
} from "@hivemind/contract";
import type { Db } from "@hivemind/db";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiHandler } from "../src/server/api/router";
import { createDashboardEventStreamHandler } from "../src/server/realtime/dashboard-stream";
import {
  type EventStreamSettings,
  openEventStream,
  type StreamAccess,
  StreamLifecycle,
} from "../src/server/realtime/event-stream";
import { type ApiHarness, createApiHarness, ORIGIN, type SignedInUser } from "./support/api";

// The Event stream engine and its two adapters (issue #11, step 4; ADR-0010):
// statuses before the stream opens, the ready frame, lossless replay and
// resume, access rechecked before every batch, server failures, heartbeats,
// rotation and cancellation independent of demand, backpressure and the
// release of timers and pooled connections. Frames are read from the
// response bytes, as a client would.

/** Short durations so the tests run in milliseconds; each test ends its streams. */
const FAST: Partial<EventStreamSettings> = {
  pollIntervalMs: 20,
  heartbeatIntervalMs: 60_000,
  rotateAfterMs: 20_000,
};

/** One SSE message as sent on the wire. */
interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
}

/** A frame with its SSE fields: the parsed `data` of a `message`, or an oRPC `error`. */
interface WireFrame extends SseMessage {
  frame?: EventStreamFrame;
}

/** Reads SSE messages from response bytes, skipping comment-only blocks. */
class SseReader {
  /** Every byte received so far, decoded. */
  raw = "";
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(body: ReadableStream<Uint8Array> | null) {
    if (!body) throw new Error("The response has no body.");
    this.reader = body.getReader();
  }

  /** The next message, or `null` at a clean end of the body. */
  async next(timeoutMs = 15_000): Promise<WireFrame | null> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const message = parseBlock(block);
        if (!message) continue;
        const frame =
          message.event === "message" && message.data !== undefined
            ? eventStreamFrameSchema.parse(JSON.parse(message.data))
            : undefined;
        return { ...message, frame };
      }
      const chunk = await withTimeout(this.reader.read(), timeoutMs);
      if (chunk.done) {
        expect(this.buffer).toBe("");
        return null;
      }
      const text = this.decoder.decode(chunk.value, { stream: true });
      this.raw += text;
      this.buffer += text;
    }
  }

  /** Messages until the end of the body. */
  async rest(timeoutMs = 15_000): Promise<WireFrame[]> {
    const frames: WireFrame[] = [];
    for (let frame = await this.next(timeoutMs); frame; frame = await this.next(timeoutMs)) {
      frames.push(frame);
    }
    return frames;
  }

  /** Messages until one matches `stop` (included). */
  async until(stop: (frame: WireFrame) => boolean, timeoutMs = 15_000): Promise<WireFrame[]> {
    const frames: WireFrame[] = [];
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (!frame) throw new Error(`The stream ended early after ${JSON.stringify(frames)}.`);
      frames.push(frame);
      if (stop(frame)) return frames;
    }
  }

  /** Reads one raw chunk, rejecting if the body errored. */
  read() {
    return this.reader.read();
  }

  cancel() {
    return this.reader.cancel().catch(() => {});
  }
}

function parseBlock(block: string): SseMessage | null {
  const message: SseMessage = {};
  let fields = 0;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    fields += 1;
    if (name === "id") message.id = value;
    else if (name === "event") message.event = value;
    else if (name === "data")
      message.data = message.data === undefined ? value : `${message.data}\n${value}`;
    else throw new Error(`Unexpected SSE field ${name}.`);
  }
  return fields === 0 ? null : message;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No stream data within ${ms} ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const isEvent = (frame: WireFrame) => frame.frame?.type === "event";
const eventIds = (frames: WireFrame[]) =>
  frames.flatMap((frame) => (frame.frame?.type === "event" ? [frame.frame.event.id] : []));

/** `db` with its transactions counted, and failing once `failAfter` have started. */
function instrumentedDb(db: Db, failAfter = Number.POSITIVE_INFINITY) {
  const counter = { transactions: 0 };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") {
        return (...args: Parameters<Db["transaction"]>) => {
          counter.transactions += 1;
          if (counter.transactions > failAfter) {
            return Promise.reject(new Error("database unavailable"));
          }
          return target.transaction(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, counter };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("Event stream", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let member: SignedInUser;
  let outsider: SignedInUser;
  let projectA: string;
  let projectB: string;
  let keyA: { id: string; secret: string };
  let keyB: { id: string; secret: string };

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    member = await api.signUp();
    outsider = await api.signUp();
    await api.addMember(owner.organizationId, member.id, "member");
    projectA = await api.createProject(owner);
    projectB = await api.createProject(owner);
    keyA = await api.createKey(owner, projectA);
    keyB = await api.createKey(owner, projectB);
  });

  afterAll(async () => {
    await api?.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const deps =
    (db: Db = api.testDb.db) =>
    () => ({ auth: api.auth, db });

  interface StreamRequest {
    token?: string;
    cookie?: string;
    cursor?: string;
    lastEventId?: string;
    headers?: Record<string, string>;
    settings?: Partial<EventStreamSettings>;
    db?: Db;
    signal?: AbortSignal;
  }

  function buildRequest(url: string, options: StreamRequest): Request {
    const headers = new Headers(options.headers);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.cookie) headers.set("cookie", options.cookie);
    if (options.lastEventId) headers.set("last-event-id", options.lastEventId);
    const query = options.cursor ? `?cursor=${options.cursor}` : "";
    return new Request(`${url}${query}`, { headers, signal: options.signal });
  }

  /** `GET /api/v1/projects/{id}/events/stream`. */
  function v1Stream(projectId: string, options: StreamRequest = {}): Promise<Response> {
    const handle = createApiHandler(deps(options.db), {
      eventStream: { ...FAST, ...options.settings },
    });
    return handle(buildRequest(`${ORIGIN}/api/v1/projects/${projectId}/events/stream`, options));
  }

  /** `GET /api/dashboard/projects/{projectId}/events/stream`. */
  function dashboardStream(projectId: string, options: StreamRequest = {}): Promise<Response> {
    const handle = createDashboardEventStreamHandler(deps(options.db), {
      eventStream: { ...FAST, ...options.settings },
    });
    return handle(
      buildRequest(`${ORIGIN}/api/dashboard/projects/${projectId}/events/stream`, options),
    );
  }

  /** A fresh cookie login session of `user`. */
  async function cookieLogin(user: SignedInUser) {
    const login = await api.test.login({ userId: user.id });
    const cookie = login.headers.get("cookie");
    if (!cookie) throw new Error("testUtils login returned no cookie.");
    return { cookie, sessionId: login.session.id };
  }

  async function createPlan(projectId: string) {
    const response = await api.request(`/projects/${projectId}/plans`, {
      token: owner.token,
      body: { planId: crypto.randomUUID(), title: "Plan" },
    });
    if (response.status !== 200) throw new Error(`createPlan: ${await response.text()}`);
    return createPlanOutputSchema.parse(await response.json()).plan;
  }

  /** Appends `count` log entries to a new Plan of `projectId`: `count + 1` Events. */
  async function writeEvents(projectId: string, count: number, message = "Progress.") {
    const plan = await createPlan(projectId);
    for (let index = 0; index < count; index += 1) {
      const response = await api.request(`/projects/${projectId}/plans/${plan.key}/log`, {
        token: owner.token,
        body: { eventId: crypto.randomUUID(), message: `${message} ${index}` },
      });
      if (response.status !== 200) throw new Error(`appendPlanLog: ${await response.text()}`);
    }
    return plan;
  }

  /** The Project's Event ids in feed order, with their cursors. */
  async function feed(projectId: string) {
    const result = await api.testDb.pool.query<{ id: string; xid: string; seq: string }>(
      "select id, writer_xid::text as xid, seq::text as seq from event where project_id = $1 order by writer_xid, seq",
      [projectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      cursor: encodeFeedCursor({ projectId, xid: row.xid, seq: row.seq }),
    }));
  }

  /**
   * Waits until every Event of the Project is below the feed horizon. The
   * horizon is cluster-wide, so a transaction held open elsewhere on a shared
   * server can hold back Events this test wrote.
   */
  async function feedHorizonPassed(projectId: string) {
    await vi.waitFor(
      async () => {
        const result = await api.testDb.pool.query<{ passed: boolean }>(
          `select coalesce(max(writer_xid) < pg_snapshot_xmin(pg_current_snapshot()), true) as passed
           from event where project_id = $1`,
          [projectId],
        );
        expect(result.rows[0]?.passed).toBe(true);
      },
      { timeout: 20_000, interval: 50 },
    );
  }

  async function expectPoolReleased() {
    const { pool } = api.testDb;
    await vi.waitFor(() => {
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount - pool.idleCount).toBe(0);
    });
  }

  async function expectJsonError(response: Response, status: number, code: string) {
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { code: string; status: number };
    expect([response.status, body.code]).toEqual([status, code]);
  }

  describe("before the stream opens", () => {
    it("answers bearer credential, access and cursor failures with 401, 404 and 400", async () => {
      const future = encodeFeedCursor({ projectId: projectA, xid: 2n ** 62n, seq: 0n });
      const futureSeq = encodeFeedCursor({ projectId: projectA, xid: 3n, seq: 2n ** 62n });
      const cases: [StreamRequest & { project?: string }, number, string][] = [
        [{}, 401, "UNAUTHORIZED"],
        [{ token: "not-a-login-session" }, 401, "UNAUTHORIZED"],
        [{ token: "hm_not-a-real-key" }, 401, "UNAUTHORIZED"],
        [{ token: outsider.token }, 404, "NOT_FOUND"],
        [{ token: keyB.secret }, 404, "NOT_FOUND"],
        // A bad cursor on a Project the caller cannot see is still 404.
        [{ token: outsider.token, cursor: "garbage" }, 404, "NOT_FOUND"],
        [{ token: owner.token, cursor: "garbage" }, 400, "BAD_REQUEST"],
        [{ token: owner.token, cursor: feedOriginCursor(projectB) }, 400, "BAD_REQUEST"],
        [{ token: keyA.secret, cursor: future }, 400, "BAD_REQUEST"],
        [{ token: keyA.secret, cursor: futureSeq }, 400, "BAD_REQUEST"],
        [{ token: owner.token, lastEventId: future }, 400, "BAD_REQUEST"],
        [
          { token: owner.token, cursor: feedOriginCursor(projectA), lastEventId: "garbage" },
          400,
          "BAD_REQUEST",
        ],
      ];
      for (const [options, status, code] of cases) {
        await expectJsonError(await v1Stream(projectA, options), status, code);
      }
      // A cookie never authenticates /api/v1.
      const { cookie } = await cookieLogin(owner);
      await expectJsonError(await v1Stream(projectA, { cookie }), 401, "UNAUTHORIZED");
      await expectPoolReleased();
    });

    it("answers cookie failures likewise and ignores bearer and key headers", async () => {
      const { cookie } = await cookieLogin(owner);
      const { cookie: outsiderCookie } = await cookieLogin(outsider);
      const cases: [StreamRequest, number, string][] = [
        [{}, 401, "UNAUTHORIZED"],
        [{ cookie: "hivemind.session_token=forged.signature" }, 401, "UNAUTHORIZED"],
        // A valid bearer token or Project key is not a cookie login session.
        [{ token: owner.token }, 401, "UNAUTHORIZED"],
        [{ headers: { "x-api-key": keyA.secret } }, 401, "UNAUTHORIZED"],
        [{ cookie: outsiderCookie }, 404, "NOT_FOUND"],
        // Nor does a bearer token of a member make an outsider's cookie one.
        [{ cookie: outsiderCookie, token: owner.token }, 404, "NOT_FOUND"],
        [{ cookie, cursor: "garbage" }, 400, "BAD_REQUEST"],
        [{ cookie, cursor: feedOriginCursor(projectB) }, 400, "BAD_REQUEST"],
      ];
      for (const [options, status, code] of cases) {
        await expectJsonError(await dashboardStream(projectA, options), status, code);
      }
      await expectJsonError(
        await dashboardStream(crypto.randomUUID(), { cookie }),
        404,
        "NOT_FOUND",
      );

      // An invalid bearer token beside a valid cookie changes nothing.
      const response = await dashboardStream(projectA, { cookie, token: "not-a-login-session" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const reader = new SseReader(response.body);
      expect((await reader.next())?.frame).toEqual({ type: "ready" });
      await reader.cancel();
      await expectPoolReleased();
    });
  });

  describe("delivery", () => {
    it("opens a tail with a ready frame whose id is the fence it read", async () => {
      const response = await v1Stream(projectA, { token: owner.token });
      expect(response.status).toBe(200);
      const reader = new SseReader(response.body);
      const ready = await reader.next();
      expect(ready?.frame).toEqual({ type: "ready" });
      const decoded = decodeFeedCursor(ready?.id ?? "", projectA);
      expect(decoded.ok && decoded.position.seq).toBe("0");

      // Something written after the stream opened arrives.
      const before = new Set((await feed(projectA)).map((row) => row.id));
      await writeEvents(projectA, 1);
      const written = (await feed(projectA)).filter((row) => !before.has(row.id));
      const frames = await reader.until(
        (frame) => frame.frame?.type === "event" && frame.id === written.at(-1)?.cursor,
      );
      expect(eventIds(frames)).toEqual(written.map((row) => row.id));
      await reader.cancel();

      // A client that drops before its first Event resumes from the ready
      // id and still gets everything written after the stream opened.
      const resumed = new SseReader(
        (await v1Stream(projectA, { token: owner.token, lastEventId: ready?.id })).body,
      );
      expect((await resumed.next())?.id).toBe(ready?.id);
      const replay = await resumed.until((frame) => frame.id === written.at(-1)?.cursor);
      expect(eventIds(replay)).toEqual(written.map((row) => row.id));
      await resumed.cancel();
      await expectPoolReleased();
    });

    it("replays from the origin, then resumes from Last-Event-ID without loss or duplicates", async () => {
      const projectId = await api.createProject(owner);
      await writeEvents(projectId, 4);
      const first = await feed(projectId);
      expect(first).toHaveLength(5);

      const origin = feedOriginCursor(projectId);
      const reader = new SseReader(
        (await dashboardStream(projectId, { ...(await cookieLogin(owner)), cursor: origin })).body,
      );
      const ready = await reader.next();
      expect(ready).toMatchObject({ id: origin, frame: { type: "ready" } });
      const frames = await reader.until((frame) => frame.id === first.at(-1)?.cursor);
      // Every Event frame carries its cursor as its id; nothing else in between.
      expect(frames.every(isEvent)).toBe(true);
      expect(
        frames.map((frame) => [frame.frame?.type === "event" && frame.frame.event.id, frame.id]),
      ).toEqual(first.map((row) => [row.id, row.cursor]));
      await reader.cancel();

      // Disconnect after the second Event, write more, resume with its id.
      await writeEvents(projectId, 2);
      const all = await feed(projectId);
      const byOwner = new SseReader(
        (await v1Stream(projectId, { token: owner.token, lastEventId: first[1]?.cursor })).body,
      );
      expect((await byOwner.next())?.id).toBe(first[1]?.cursor);
      const rest = await byOwner.until((frame) => frame.id === all.at(-1)?.cursor);
      expect(eventIds(rest)).toEqual(all.slice(2).map((row) => row.id));
      await byOwner.cancel();
      await expectPoolReleased();
    });

    it("delivers more than one batch in order", async () => {
      const projectId = await api.createProject(owner);
      await writeEvents(projectId, 129);
      const all = await feed(projectId);
      expect(all).toHaveLength(130);
      await feedHorizonPassed(projectId);
      const { db, counter } = instrumentedDb(api.testDb.db);
      const reader = new SseReader(
        (
          await v1Stream(projectId, {
            token: owner.token,
            cursor: feedOriginCursor(projectId),
            db,
            // A day between polls: only full batches are read without waiting.
            settings: { pollIntervalMs: 86_400_000 },
          })
        ).body,
      );
      await reader.next();
      const frames = await reader.until((frame) => frame.id === all.at(-1)?.cursor);
      expect(eventIds(frames)).toEqual(all.map((row) => row.id));
      // The open, a full batch of 100, then the remaining 30.
      expect(counter.transactions).toBe(3);
      await reader.cancel();
      await expectPoolReleased();
    });

    it("withholds Events behind an older open transaction, reports it, then delivers them", async () => {
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      const projectId = await api.createProject(owner);
      const holder = await api.testDb.pool.connect();
      try {
        await holder.query("begin");
        await holder.query("select pg_current_xact_id()");
        const reader = new SseReader(
          (
            await v1Stream(projectId, {
              token: owner.token,
              settings: { heartbeatIntervalMs: 50, withheldLogAfterMs: 100 },
            })
          ).body,
        );
        await reader.next();
        await writeEvents(projectId, 0);
        const [written] = await feed(projectId);
        await vi.waitFor(() => expect(warnings).toHaveBeenCalledOnce());
        expect(String(warnings.mock.calls[0]?.[0])).toContain(`Project ${projectId}`);
        const withheld = await reader.until(
          (frame) => frame.frame?.type === "heartbeat" && frame.frame.withheld,
        );
        expect(withheld.filter(isEvent)).toEqual([]);
        await holder.query("rollback");
        const frames = await reader.until(isEvent);
        expect(eventIds(frames)).toEqual([written?.id]);
        await reader.cancel();
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
      }
      await expectPoolReleased();
    });

    it("sends idless heartbeats", async () => {
      const response = await v1Stream(projectA, {
        token: keyA.secret,
        settings: { heartbeatIntervalMs: 50 },
      });
      const reader = new SseReader(response.body);
      await reader.next();
      const heartbeat = (await reader.until((frame) => frame.frame?.type === "heartbeat")).at(-1);
      expect(heartbeat?.id).toBeUndefined();
      const frame = heartbeat?.frame;
      if (frame?.type !== "heartbeat") throw new Error("expected a heartbeat");
      expect(frame.withheld).toBe(false);
      expect(Number.isNaN(Date.parse(frame.serverTime))).toBe(false);
      await reader.cancel();
    });
  });

  describe("access checked before every batch", () => {
    const revocations: {
      name: string;
      code: "UNAUTHORIZED" | "NOT_FOUND";
      open: () => Promise<{ response: Response; revoke: () => Promise<void> }>;
    }[] = [
      {
        name: "a revoked cookie login session",
        code: "UNAUTHORIZED",
        open: async () => {
          const { cookie, sessionId } = await cookieLogin(owner);
          return {
            response: await dashboardStream(projectA, { cookie }),
            revoke: async () => {
              await api.testDb.pool.query("delete from session where id = $1", [sessionId]);
            },
          };
        },
      },
      {
        name: "an expired cookie login session",
        code: "UNAUTHORIZED",
        open: async () => {
          const { cookie, sessionId } = await cookieLogin(owner);
          return {
            response: await dashboardStream(projectA, { cookie }),
            revoke: async () => {
              await api.testDb.pool.query(
                "update session set expires_at = now() - interval '1 second' where id = $1",
                [sessionId],
              );
            },
          };
        },
      },
      {
        name: "a removed membership (cookie)",
        code: "NOT_FOUND",
        open: async () => {
          const user = await api.signUp();
          await api.addMember(owner.organizationId, user.id, "member");
          const { cookie } = await cookieLogin(user);
          return {
            response: await dashboardStream(projectA, { cookie }),
            revoke: () => api.removeMember(owner.organizationId, user.id),
          };
        },
      },
      {
        name: "a revoked bearer login session",
        code: "UNAUTHORIZED",
        open: async () => {
          const user = await api.signUp();
          await api.addMember(owner.organizationId, user.id, "member");
          return {
            response: await v1Stream(projectA, { token: user.token }),
            revoke: async () => {
              await api.testDb.pool.query("delete from session where token = $1", [user.token]);
            },
          };
        },
      },
      {
        name: "a removed membership (bearer)",
        code: "NOT_FOUND",
        open: async () => {
          const user = await api.signUp();
          await api.addMember(owner.organizationId, user.id, "member");
          return {
            response: await v1Stream(projectA, { token: user.token }),
            revoke: () => api.removeMember(owner.organizationId, user.id),
          };
        },
      },
      {
        name: "a revoked Project key",
        code: "UNAUTHORIZED",
        open: async () => {
          const key = await api.createKey(owner, projectA);
          return {
            response: await v1Stream(projectA, { token: key.secret }),
            revoke: async () => {
              const response = await api.request(`/projects/${projectA}/keys/${key.id}`, {
                method: "DELETE",
                token: owner.token,
              });
              expect(response.status).toBe(200);
            },
          };
        },
      },
      {
        name: "an expired Project key",
        code: "UNAUTHORIZED",
        open: async () => {
          const key = await api.createKey(owner, projectA);
          return {
            response: await v1Stream(projectA, { token: key.secret }),
            revoke: async () => {
              await api.testDb.pool.query(
                "update apikey set expires_at = now() - interval '1 second' where id = $1",
                [key.id],
              );
            },
          };
        },
      },
    ];

    for (const { name, code, open } of revocations) {
      it(`ends with access_lost after ${name}`, async () => {
        const { response, revoke } = await open();
        expect(response.status).toBe(200);
        const reader = new SseReader(response.body);
        const ready = await reader.next();
        expect(ready?.frame).toEqual({ type: "ready" });
        await revoke();
        // Written after the revocation: never delivered.
        const before = new Set((await feed(projectA)).map((row) => row.id));
        await writeEvents(projectA, 1);
        const written = (await feed(projectA)).filter((row) => !before.has(row.id));
        await feedHorizonPassed(projectA);
        const frames = await reader.rest();
        expect(written).toHaveLength(2);
        expect(eventIds(frames).filter((id) => !before.has(id))).toEqual([]);
        expect(frames.at(-1)).toEqual({
          event: "message",
          data: JSON.stringify({ type: "access_lost", code }),
          frame: { type: "access_lost", code },
        });
        expect(frames.at(-1)?.id).toBeUndefined();
        await expectPoolReleased();
      });
    }

    it("ends a stream whose database fails as a server error, not access_lost", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      // The open's own transaction succeeds; the first batch's fails.
      const { db } = instrumentedDb(api.testDb.db, 1);
      const reader = new SseReader((await v1Stream(projectA, { token: owner.token, db })).body);
      expect((await reader.next())?.frame).toEqual({ type: "ready" });
      const frames = await reader.rest();
      expect(frames).toHaveLength(1);
      expect(frames[0]?.event).toBe("error");
      expect(JSON.parse(frames[0]?.data ?? "{}")).toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
      });
      expect(reader.raw).not.toContain("access_lost");
      expect(reader.raw).not.toContain("database unavailable");
      expect(errors).toHaveBeenCalled();
      await expectPoolReleased();
    });
  });

  describe("lifecycle", () => {
    it("rotates at the deadline with a clean end", async () => {
      const started = Date.now();
      const reader = new SseReader(
        (await v1Stream(projectA, { token: owner.token, settings: { rotateAfterMs: 300 } })).body,
      );
      const frames = await reader.rest();
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      expect(frames.map((frame) => frame.frame?.type)).toEqual(["ready"]);
      await expectPoolReleased();
    });

    it("ends at the deadline and stops querying while the consumer is not reading", async () => {
      const projectId = await api.createProject(owner);
      await writeEvents(projectId, 9, "x".repeat(400));
      const { db, counter } = instrumentedDb(api.testDb.db);
      const reader = new SseReader(
        (
          await v1Stream(projectId, {
            token: owner.token,
            cursor: feedOriginCursor(projectId),
            db,
            // A queue of about 1 KiB: the generator stops at a yield almost at once.
            settings: {
              rotateAfterMs: 400,
              maxBufferedBytes: 2048,
              batchMaxBytes: 1024,
              slowConsumerTimeoutMs: 60_000,
            },
          })
        ).body,
      );
      await reader.next();
      // Stop reading past the deadline.
      await sleep(600);
      const queries = counter.transactions;
      await sleep(200);
      expect(counter.transactions).toBe(queries);
      await expectPoolReleased();
      // What was queued is still delivered, then the body ends cleanly.
      const frames = await reader.rest();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.length).toBeLessThan(10);
      expect(frames.every(isEvent)).toBe(true);
    });

    it("ends on request abort while the generator is paused at a yield", async () => {
      const projectId = await api.createProject(owner);
      await writeEvents(projectId, 9, "x".repeat(400));
      const { db, counter } = instrumentedDb(api.testDb.db);
      const abort = new AbortController();
      const reader = new SseReader(
        (
          await v1Stream(projectId, {
            token: owner.token,
            cursor: feedOriginCursor(projectId),
            db,
            signal: abort.signal,
            settings: {
              maxBufferedBytes: 2048,
              batchMaxBytes: 1024,
              slowConsumerTimeoutMs: 60_000,
            },
          })
        ).body,
      );
      await reader.next();
      await sleep(100);
      abort.abort();
      await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
      const queries = counter.transactions;
      await sleep(200);
      expect(counter.transactions).toBe(queries);
      await expectPoolReleased();
    });

    it("disconnects a stalled consumer, which resumes from its last Event", async () => {
      const projectId = await api.createProject(owner);
      await writeEvents(projectId, 9, "x".repeat(400));
      const all = await feed(projectId);
      const reader = new SseReader(
        (
          await v1Stream(projectId, {
            token: owner.token,
            cursor: feedOriginCursor(projectId),
            settings: { maxBufferedBytes: 2048, batchMaxBytes: 1024, slowConsumerTimeoutMs: 150 },
          })
        ).body,
      );
      await reader.next();
      const [first] = await reader.until(isEvent);
      expect(first?.id).toBe(all[0]?.cursor);
      // Stop reading for longer than the slow-consumer limit.
      await sleep(400);
      await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
      await expectPoolReleased();

      const resumed = new SseReader(
        (await v1Stream(projectId, { token: owner.token, lastEventId: first?.id })).body,
      );
      await resumed.next();
      const rest = await resumed.until((frame) => frame.id === all.at(-1)?.cursor);
      expect(eventIds(rest)).toEqual(all.slice(1).map((row) => row.id));
      await resumed.cancel();
    });

    it("leaves a generator paused at a yield nothing to release once ended", async () => {
      const projectId = await api.createProject(owner);
      await writeEvents(projectId, 2);
      const lifecycle = new StreamLifecycle({ settings: FAST });
      let checks = 0;
      const frames = await openEventStream({
        db: api.testDb.db,
        projectId,
        start: FEED_ORIGIN,
        lifecycle,
        authorize: async (): Promise<StreamAccess> => {
          checks += 1;
          return { ok: true };
        },
      });
      expect(frames).not.toBeNull();
      if (!frames) return;
      expect((await frames.next()).value).toEqual({ type: "ready" });
      expect((await frames.next()).value).toMatchObject({ type: "event" });
      // Paused at the yield of the first Event.
      lifecycle.end("abort");
      expect(lifecycle.signal.aborted).toBe(true);
      expect(await frames.return(undefined)).toEqual({ done: true, value: undefined });
      expect(checks).toBe(1);
      await expectPoolReleased();
    });

    it("rejects a future position with null rather than a stream", async () => {
      const lifecycle = new StreamLifecycle({ settings: FAST });
      try {
        const frames = await openEventStream({
          db: api.testDb.db,
          projectId: projectA,
          start: { xid: (2n ** 62n).toString(), seq: "0" },
          lifecycle,
          authorize: async () => ({ ok: true }),
        });
        expect(frames).toBeNull();
      } finally {
        lifecycle.end("done");
      }
    });

    it("ends a database failure in authorize as an error, not access_lost", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const lifecycle = new StreamLifecycle({ settings: FAST });
      const frames = await openEventStream({
        db: api.testDb.db,
        projectId: projectA,
        start: null,
        lifecycle,
        authorize: async () => {
          throw new Error("database unavailable");
        },
      });
      if (!frames) throw new Error("expected a stream");
      expect((await frames.next()).value).toEqual({ type: "ready" });
      await expect(frames.next()).rejects.toThrow("database unavailable");
      expect(errors.mock.calls.flat().join(" ")).not.toContain("hm_");
      lifecycle.end("done");
    });
  });

  describe("over HTTP", () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      const handle = createApiHandler(deps(), { eventStream: FAST });
      // A minimal Node adapter, as Next.js's: the request aborts when the
      // client goes away, and the body is piped with backpressure.
      server = createServer(async (req, res) => {
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === "string" && name !== "host") headers.set(name, value);
        }
        // The harness's better-auth trusts only the app's own host.
        headers.set("host", new URL(ORIGIN).host);
        const response = await handle(
          new Request(`${ORIGIN}${req.url}`, { headers, signal: abort.signal }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) {
          res.end();
          return;
        }
        Readable.fromWeb(response.body as never)
          .on("error", () => res.destroy())
          .pipe(res);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server?.close();
    });

    it("sends standard SSE bytes and releases everything when the client disconnects", async () => {
      const projectId = await api.createProject(owner);
      await writeEvents(projectId, 1);
      const [planCreated, logged] = await feed(projectId);
      const abort = new AbortController();
      const response = await fetch(`${base}/api/v1/projects/${projectId}/events/stream`, {
        headers: {
          authorization: `Bearer ${owner.token}`,
          "last-event-id": planCreated?.cursor ?? "",
        },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = new SseReader(response.body);
      await reader.until((frame) => frame.id === logged?.cursor);
      // The exact bytes: oRPC's opening comment, then id/event/data messages.
      expect(reader.raw.startsWith(": \n\nevent: message\n")).toBe(true);
      expect(reader.raw).toContain(
        `event: message\nid: ${planCreated?.cursor}\ndata: {"type":"ready"}\n\n`,
      );
      expect(reader.raw).toContain(`event: message\nid: ${logged?.cursor}\ndata: {"type":"event",`);
      abort.abort();
      await expectPoolReleased();
    });
  });
});
