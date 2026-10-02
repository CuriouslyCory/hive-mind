import {
  addSessionScopeOutputSchema,
  addTaskOutputSchema,
  claimTaskOutputSchema,
  collectionOutputSchema,
  createPlanOutputSchema,
  endSessionOutputSchema,
  eventPageSchema,
  heartbeatSessionOutputSchema,
  MAX_MARKDOWN_BYTES,
  MAX_SESSION_INTENT_LENGTH,
  overlapPageSchema,
  projectStatusSchema,
  scopePageSchema,
  sessionChangeOutputSchema,
  sessionPageSchema,
  sessionSchema,
  startSessionOutputSchema,
  taskActionOutputSchema,
  taskClaimConflictMessage,
  taskPageSchema,
  touchedPathsContentHash,
  uploadCollectionBatchOutputSchema,
} from "@hivemind/contract";
import { createDb, createPool, withCoordinationLock } from "@hivemind/db";
import { agentSession, event } from "@hivemind/db/schema";
import { describeDb } from "@hivemind/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeKeysetCursor } from "../src/server/api/keyset";
import {
  type ApiHarness,
  createApiHarness,
  errorCode,
  type RequestOptions,
  type SignedInUser,
} from "./support/api";

// The Session, Task action, Scope, collection and status routes of #12
// through the real handler and database: authorization (Project access,
// capability, Session ownership), input bounds, replay, claim rules, the
// collection protocol, overlap completeness and the status read.

describeDb("/api/v1 Sessions, Task actions, Scopes and status", () => {
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

  const uuid = () => crypto.randomUUID();

  function call(token: string, path: string, options: Omit<RequestOptions, "token"> = {}) {
    return api.request(path, { ...options, token });
  }

  async function ok(response: Response | Promise<Response>) {
    const resolved = await response;
    if (resolved.status !== 200) {
      throw new Error(`expected 200, got ${resolved.status}: ${await resolved.text()}`);
    }
    return resolved.json();
  }

  async function expectError(response: Response | Promise<Response>, status: number) {
    const resolved = await response;
    const body = await resolved.clone().text();
    expect([resolved.status, body]).toEqual([status, expect.any(String)]);
    return errorCode(resolved);
  }

  async function startSession(
    token: string,
    projectId: string,
    body: Record<string, unknown> = {},
  ) {
    const output = startSessionOutputSchema.parse(
      await ok(
        call(token, `/projects/${projectId}/sessions`, {
          body: { sessionId: uuid(), agent: "test", intent: "Testing", ...body },
        }),
      ),
    );
    return output.session;
  }

  /** An active Plan with one Task, in `projectId`. */
  async function activeTask(projectId: string, token = owner.token) {
    const { plan } = createPlanOutputSchema.parse(
      await ok(
        call(token, `/projects/${projectId}/plans`, {
          body: { planId: uuid(), title: "Plan", status: "active" },
        }),
      ),
    );
    const { task } = addTaskOutputSchema.parse(
      await ok(
        call(token, `/projects/${projectId}/plans/${plan.key}/tasks`, {
          body: { taskId: uuid(), title: "Task" },
        }),
      ),
    );
    return { plan, task };
  }

  function taskAction(
    token: string,
    projectId: string,
    taskId: string,
    action: string,
    body: Record<string, unknown>,
  ) {
    return call(token, `/projects/${projectId}/tasks/${taskId}/${action}`, { body });
  }

  function heartbeat(token: string, projectId: string, sessionId: string, body = {}) {
    return call(token, `/projects/${projectId}/sessions/${sessionId}/heartbeat`, { body });
  }

  async function eventCount(projectId: string) {
    const [row] = await api.testDb.db
      .select({ count: sql<number>`count(*)::int` })
      .from(event)
      .where(eq(event.projectId, projectId));
    return row?.count ?? 0;
  }

  async function ageSession(sessionId: string, minutes: number) {
    await api.testDb.db
      .update(agentSession)
      .set({ lastHeartbeatAt: sql`clock_timestamp() - make_interval(mins => ${minutes})` })
      .where(eq(agentSession.id, sessionId));
  }

  describe("authorization", () => {
    /** Every route of this item for a Session and Task of `projectA`. */
    function routes(sessionId: string, taskId: string) {
      const session = `/projects/${projectA}/sessions/${sessionId}`;
      const collection = `${session}/collections/${uuid()}`;
      const action = { sessionId };
      return [
        ["GET", `/projects/${projectA}/sessions`, undefined],
        ["POST", `/projects/${projectA}/sessions`, { sessionId: uuid(), agent: "a", intent: "i" }],
        ["GET", session, undefined],
        ["PATCH", session, { status: "idle" }],
        ["POST", `${session}/heartbeat`, {}],
        ["POST", `${session}/attach`, { planRef: null }],
        ["POST", `${session}/end`, { summary: "Done." }],
        ["GET", `${session}/claims`, undefined],
        ["GET", `${session}/overlaps`, undefined],
        ["GET", `${session}/scopes`, undefined],
        ["POST", `${session}/scopes`, { pattern: "src/**" }],
        ["DELETE", `${session}/scopes/${uuid()}`, undefined],
        [
          "POST",
          `${collection}/manifest`,
          {
            pathCount: 0,
            batchCount: 0,
            omittedPathCount: 0,
            contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        ],
        ["POST", `${collection}/batches`, { batchIndex: 0, paths: ["a.ts"] }],
        ["POST", `${collection}/finalize`, {}],
        ["POST", `/projects/${projectA}/tasks/${taskId}/claim`, action],
        ["POST", `/projects/${projectA}/tasks/${taskId}/release`, action],
        ["POST", `/projects/${projectA}/tasks/${taskId}/start`, action],
        ["POST", `/projects/${projectA}/tasks/${taskId}/block`, { ...action, reason: "Wait." }],
        ["POST", `/projects/${projectA}/tasks/${taskId}/done`, action],
        ["GET", `/projects/${projectA}/status`, undefined],
      ] as const;
    }

    it("answers 404 to a non-member and to another Project's key on every route", async () => {
      const session = await startSession(owner.token, projectA);
      const { task } = await activeTask(projectA);
      for (const [method, path, body] of routes(session.id, task.id)) {
        for (const token of [outsider.token, keyB.secret]) {
          const response = await call(token, path, { method, body });
          expect([method, path, response.status]).toEqual([method, path, 404]);
          expect(await errorCode(response)).toBe("NOT_FOUND");
        }
        const anonymous = await api.request(path, { method, body });
        expect(anonymous.status).toBe(401);
      }
      // Nothing was written by the refused calls.
      expect(await ok(call(owner.token, `/projects/${projectA}/sessions/${session.id}`))).toEqual(
        session,
      );
    });

    it("lets a member and the Project's key read every Session of the Project", async () => {
      const session = await startSession(owner.token, projectA);
      for (const token of [member.token, keyA.secret]) {
        const base = `/projects/${projectA}/sessions/${session.id}`;
        expect(sessionSchema.parse(await ok(call(token, base))).id).toBe(session.id);
        taskPageSchema.parse(await ok(call(token, `${base}/claims`)));
        scopePageSchema.parse(await ok(call(token, `${base}/scopes`)));
        overlapPageSchema.parse(await ok(call(token, `${base}/overlaps`)));
        eventPageSchema.parse(await ok(call(token, `${base}/events`)));
        const status = projectStatusSchema.parse(
          await ok(call(token, `/projects/${projectA}/status?sessionId=${session.id}`)),
        );
        expect(status.selectedSessionId).toBe(session.id);
      }
    });

    it("answers 403 when another principal changes a Session or acts through it", async () => {
      const ownersSession = await startSession(owner.token, projectA);
      const { task } = await activeTask(projectA);
      const writes = routes(ownersSession.id, task.id).filter(
        ([method, path]) =>
          method !== "GET" && !path.endsWith("/sessions") && !path.endsWith("/status"),
      );
      expect(writes).toHaveLength(14);
      for (const token of [member.token, keyA.secret]) {
        for (const [method, path, body] of writes) {
          const response = await call(token, path, { method, body });
          expect([token === keyA.secret, path, response.status]).toEqual([
            token === keyA.secret,
            path,
            403,
          ]);
          expect(await errorCode(response)).toBe("FORBIDDEN");
        }
      }
      const after = sessionSchema.parse(
        await ok(call(owner.token, `/projects/${projectA}/sessions/${ownersSession.id}`)),
      );
      expect(after).toMatchObject({ status: "active", summary: null });
    });

    it("answers 404 for a Session or Task of another Project, or none", async () => {
      const own = await startSession(owner.token, projectA);
      const elsewhere = await startSession(owner.token, projectB);
      const { task: taskB } = await activeTask(projectB);
      const { task } = await activeTask(projectA);
      for (const sessionId of [elsewhere.id, uuid()]) {
        for (const [method, path, body] of routes(sessionId, task.id)) {
          if (path.endsWith("/sessions") || path.endsWith("/status")) continue;
          const response = await call(owner.token, path, { method, body });
          expect([path, response.status]).toEqual([path, 404]);
          expect(await response.json()).toMatchObject({ message: "Session not found." });
        }
        await expectError(
          call(owner.token, `/projects/${projectA}/status?sessionId=${sessionId}`),
          404,
        );
      }
      for (const taskId of [taskB.id, uuid()]) {
        const response = await taskAction(owner.token, projectA, taskId, "claim", {
          sessionId: own.id,
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ message: "Task not found." });
      }
    });

    it("keeps a revoked key's Session readable and lets it do nothing more", async () => {
      const key = await api.createKey(owner, projectA);
      const session = await startSession(key.secret, projectA);
      const { task } = await activeTask(projectA);
      await ok(taskAction(key.secret, projectA, task.id, "claim", { sessionId: session.id }));
      const revoke = await call(owner.token, `/projects/${projectA}/keys/${key.id}`, {
        method: "DELETE",
      });
      expect(revoke.status).toBe(200);

      await expectError(heartbeat(key.secret, projectA, session.id), 401);
      await expectError(
        taskAction(key.secret, projectA, task.id, "done", { sessionId: session.id }),
        401,
      );
      // Nobody else can continue it: the owner of the Project is not its owner.
      await expectError(heartbeat(owner.token, projectA, session.id), 403);

      const read = sessionSchema.parse(
        await ok(call(member.token, `/projects/${projectA}/sessions/${session.id}`)),
      );
      expect(read.owner).toEqual({ kind: "key", keyId: key.id });
      const events = eventPageSchema.parse(
        await ok(call(member.token, `/projects/${projectA}/sessions/${session.id}/events`)),
      );
      expect(events.items.map((e) => e.type)).toEqual(["task.claimed", "session.started"]);
      expect(events.items[0]?.actor).toEqual({ kind: "project_key", keyId: key.id });
    });
  });

  describe("access revoked while waiting for the Project lock", () => {
    /**
     * Runs `request` while another connection holds the Project's
     * coordination lock, applies `revoke` once the request waits for it, then
     * releases the lock and returns the request's answer.
     */
    async function behindLock(
      projectId: string,
      request: () => Promise<Response>,
      revoke: () => Promise<unknown>,
    ): Promise<Response> {
      const pool = createPool({ connectionString: api.testDb.url, max: 1 });
      try {
        let release = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let held = () => {};
        const holding = new Promise<void>((resolve) => {
          held = resolve;
        });
        const holder = withCoordinationLock(createDb(pool), projectId, async () => {
          held();
          await released;
        });
        await holding;
        const pending = request();
        for (let attempt = 0; ; attempt++) {
          const { rows } = await api.testDb.pool.query<{ count: string }>(
            `select count(*) from pg_stat_activity
             where datname = current_database() and wait_event = 'advisory'`,
          );
          if (Number(rows[0]?.count) > 0) break;
          if (attempt > 250) throw new Error("The request never waited for the lock.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await revoke();
        release();
        await holder;
        return await pending;
      } finally {
        await pool.end();
      }
    }

    it("answers 401 to a key revoked meanwhile, and 404 to a removed Member", async () => {
      const projectId = await api.createProject(owner);
      const key = await api.createKey(owner, projectId);
      const { task } = await activeTask(projectId);
      const keySession = await startSession(key.secret, projectId);
      const before = await eventCount(projectId);
      const revoked = await behindLock(
        projectId,
        () => taskAction(key.secret, projectId, task.id, "claim", { sessionId: keySession.id }),
        () => ok(call(owner.token, `/projects/${projectId}/keys/${key.id}`, { method: "DELETE" })),
      );
      expect(await expectError(revoked, 401)).toBe("UNAUTHORIZED");
      expect(revoked.headers.get("www-authenticate")).toBe("Bearer");

      const leaver = await api.signUp();
      await api.addMember(owner.organizationId, leaver.id, "member");
      const leaverSession = await startSession(leaver.token, projectId);
      const removed = await behindLock(
        projectId,
        () => heartbeat(leaver.token, projectId, leaverSession.id),
        () => api.removeMember(owner.organizationId, leaver.id),
      );
      expect(await expectError(removed, 404)).toBe("NOT_FOUND");
      // Neither change happened: one Event, the leaver's session.started.
      expect(await eventCount(projectId)).toBe(before + 1);
    });
  });

  describe("input", () => {
    it("rejects forged owner, actor and server-chosen fields", async () => {
      const session = await startSession(owner.token, projectA);
      const { task } = await activeTask(projectA);
      const base = `/projects/${projectA}/sessions`;
      for (const [path, method, body] of [
        [base, "POST", { sessionId: uuid(), agent: "a", intent: "i", owner: { kind: "user" } }],
        [base, "POST", { sessionId: uuid(), agent: "a", intent: "i", status: "ended" }],
        [base, "POST", { sessionId: uuid(), agent: "a", intent: "i", userId: member.id }],
        [`${base}/${session.id}`, "PATCH", { owner: { kind: "key", keyId: keyA.id } }],
        [`${base}/${session.id}`, "PATCH", { status: "ended" }],
        [`${base}/${session.id}/heartbeat`, "POST", { collectionId: uuid() }],
        [`${base}/${session.id}/end`, "POST", { summary: "x", actor: { kind: "system" } }],
        [
          `/projects/${projectA}/tasks/${task.id}/claim`,
          "POST",
          { sessionId: session.id, actor: { kind: "user", userId: member.id } },
        ],
        [`${base}/${session.id}/scopes`, "POST", { pattern: "a/**", source: "touched" }],
      ] as const) {
        const response = await call(owner.token, path, { method, body });
        expect([path, response.status]).toEqual([path, 400]);
      }
      expect(await eventCount(projectA)).toBeGreaterThan(0);
      const read = sessionSchema.parse(await ok(call(owner.token, `${base}/${session.id}`)));
      expect(read).toEqual(session);
    });

    it("bounds fields with 400 and the body with 413", async () => {
      const session = await startSession(owner.token, projectA);
      const base = `/projects/${projectA}/sessions`;
      const start = (body: Record<string, unknown>) =>
        call(owner.token, base, { body: { sessionId: uuid(), agent: "a", intent: "i", ...body } });
      expect((await start({ intent: "x".repeat(MAX_SESSION_INTENT_LENGTH) })).status).toBe(200);
      await expectError(start({ intent: "x".repeat(MAX_SESSION_INTENT_LENGTH + 1) }), 400);
      await expectError(start({ agent: "x".repeat(121) }), 400);
      await expectError(
        call(owner.token, `${base}/${session.id}/scopes`, { body: { pattern: "a".repeat(257) } }),
        400,
      );
      await expectError(
        call(owner.token, `${base}/${session.id}/collections/${uuid()}/batches`, {
          body: {
            batchIndex: 0,
            paths: Array.from({ length: 17 }, (_, i) => `p${String(i).padStart(2, "0")}`),
          },
        }),
        400,
      );
      await expectError(
        call(owner.token, `${base}/${session.id}/end`, {
          body: { summary: "x".repeat(MAX_MARKDOWN_BYTES + 1) },
        }),
        400,
      );
      // Valid 8 KiB of characters JSON escapes six-fold: over the 16 KiB body.
      expect(
        await expectError(
          call(owner.token, `${base}/${session.id}/end`, {
            body: { summary: "\u0001".repeat(MAX_MARKDOWN_BYTES) },
          }),
          413,
        ),
      ).toBe("PAYLOAD_TOO_LARGE");
      expect(sessionSchema.parse(await ok(call(owner.token, `${base}/${session.id}`))).status).toBe(
        "active",
      );
    });
  });

  describe("cursors", () => {
    // The scope hash is unkeyed, so a caller can build a well-formed cursor
    // for a list it may read. A position outside its column's range is the
    // list's 400, never a database error (500).
    it("answers 400 to a forged cursor whose position is out of range", async () => {
      const projectId = await api.createProject(owner);
      const session = await startSession(owner.token, projectId);
      const { plan } = await activeTask(projectId);
      const uuidPosition = uuid();
      const forged: [string, string][] = [
        [
          `/projects/${projectId}/events`,
          encodeKeysetCursor(["events", projectId, "project", null], ["9223372036854775808"]),
        ],
        [
          `/projects/${projectId}/events`,
          encodeKeysetCursor(["events", projectId, "project", null], ["99999999999999999999"]),
        ],
        [
          `/projects/${projectId}/plans`,
          encodeKeysetCursor(["plans", projectId, null], ["2147483648"]),
        ],
        [
          `/projects/${projectId}/plans/${plan.key}/tasks`,
          encodeKeysetCursor(
            ["plan-tasks", projectId, plan.key, null],
            ["9999999999", uuidPosition],
          ),
        ],
        [
          `/projects/${projectId}/sessions/${session.id}/scopes`,
          encodeKeysetCursor(
            ["session-scopes", projectId, session.id, null],
            ["99999999999999999999", uuidPosition],
          ),
        ],
        [
          `/projects/${projectId}/sessions/${session.id}/scopes`,
          encodeKeysetCursor(
            ["session-scopes", projectId, session.id, null],
            ["253402300800000", uuidPosition],
          ),
        ],
        [
          `/projects/${projectId}/sessions/${session.id}/overlaps`,
          encodeKeysetCursor(
            ["overlaps", projectId, session.id],
            ["start", "99999999999999999999", "0"],
          ),
        ],
      ];
      for (const [path, cursor] of forged) {
        const response = await call(owner.token, `${path}?cursor=${cursor}`);
        expect([path, response.status, await errorCode(response)]).toEqual([
          path,
          400,
          "BAD_REQUEST",
        ]);
      }
      // The largest values each column holds are still accepted.
      const inRange: [string, string][] = [
        [
          `/projects/${projectId}/events`,
          encodeKeysetCursor(["events", projectId, "project", null], ["9223372036854775807"]),
        ],
        [
          `/projects/${projectId}/plans`,
          encodeKeysetCursor(["plans", projectId, null], ["2147483647"]),
        ],
        [
          `/projects/${projectId}/sessions/${session.id}/scopes`,
          encodeKeysetCursor(
            ["session-scopes", projectId, session.id, null],
            ["253402300799999", uuidPosition],
          ),
        ],
      ];
      for (const [path, cursor] of inRange) {
        await ok(call(owner.token, `${path}?cursor=${cursor}`));
      }
    });
  });

  describe("Sessions", () => {
    it("replays a start without a second Event, and refuses other input or Projects", async () => {
      const projectId = await api.createProject(owner);
      const body = { sessionId: uuid(), agent: "claude", intent: "Replay", hostname: "laptop" };
      const first = startSessionOutputSchema.parse(
        await ok(call(owner.token, `/projects/${projectId}/sessions`, { body })),
      );
      const again = startSessionOutputSchema.parse(
        await ok(call(owner.token, `/projects/${projectId}/sessions`, { body })),
      );
      expect(first.created).toBe(true);
      expect(again).toEqual({ ...first, created: false });
      expect(first.session).toMatchObject({
        owner: { kind: "user", userId: owner.id },
        status: "active",
        hostname: "laptop",
        gitBranch: null,
        scopeComplete: false,
      });
      expect(await eventCount(projectId)).toBe(1);
      await expectError(
        call(owner.token, `/projects/${projectId}/sessions`, {
          body: { ...body, intent: "Other" },
        }),
        409,
      );
      await expectError(call(member.token, `/projects/${projectId}/sessions`, { body }), 409);
      await expectError(call(owner.token, `/projects/${projectA}/sessions`, { body }), 404);
      expect(await eventCount(projectId)).toBe(1);
    });

    it("pages Sessions newest first and filters by effective status", async () => {
      const projectId = await api.createProject(owner);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await startSession(owner.token, projectId)).id);
      await ageSession(ids[0] ?? "", 31);
      const list = (query: string) =>
        call(owner.token, `/projects/${projectId}/sessions${query}`).then(async (r) =>
          sessionPageSchema.parse(await ok(r)),
        );
      const first = await list("?limit=2");
      expect(first.items.map((s) => s.id)).toEqual([ids[2], ids[1]]);
      expect(first.nextCursor).not.toBeNull();
      const second = await list(`?limit=2&cursor=${first.nextCursor}`);
      expect(second.items.map((s) => [s.id, s.status])).toEqual([[ids[0], "abandoned"]]);
      expect(second.nextCursor).toBeNull();
      expect((await list("?status=live")).items.map((s) => s.id)).toEqual([ids[2], ids[1]]);
      expect((await list("?status=terminal")).items.map((s) => s.id)).toEqual([ids[0]]);
      // A cursor belongs to the list (and filter) that returned it.
      await expectError(
        call(owner.token, `/projects/${projectId}/sessions?status=live&cursor=${first.nextCursor}`),
        400,
      );
      await expectError(
        call(owner.token, `/projects/${projectA}/sessions?cursor=${first.nextCursor}`),
        400,
      );
    });

    it("updates and attaches the caller's Session, and no-ops write no Event", async () => {
      const session = await startSession(owner.token, projectA);
      const { plan, task } = await activeTask(projectA);
      const base = `/projects/${projectA}/sessions/${session.id}`;
      const update = sessionChangeOutputSchema.parse(
        await ok(call(owner.token, base, { method: "PATCH", body: { status: "idle" } })),
      );
      expect(update).toMatchObject({ changed: true, session: { status: "idle" } });
      const before = await eventCount(projectA);
      const same = sessionChangeOutputSchema.parse(
        await ok(call(owner.token, base, { method: "PATCH", body: { status: "idle" } })),
      );
      expect(same.changed).toBe(false);
      const attached = sessionChangeOutputSchema.parse(
        await ok(
          call(owner.token, `${base}/attach`, {
            body: { planRef: plan.key, taskId: task.id },
          }),
        ),
      );
      expect(attached.session).toMatchObject({
        attachedPlanId: plan.id,
        attachedPlanKey: plan.key,
        attachedTaskId: task.id,
      });
      expect(await eventCount(projectA)).toBe(before + 1);
      const other = await activeTask(projectB);
      const missing = await call(owner.token, `${base}/attach`, {
        body: { planRef: other.plan.id },
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ message: "Plan or Task not found." });
    });

    it("cannot revive an abandoned Session with a heartbeat", async () => {
      const session = await startSession(owner.token, projectA);
      await ageSession(session.id, 30);
      const before = await eventCount(projectA);
      await expectError(heartbeat(owner.token, projectA, session.id), 409);
      expect(await eventCount(projectA)).toBe(before);
      const read = sessionSchema.parse(
        await ok(call(owner.token, `/projects/${projectA}/sessions/${session.id}`)),
      );
      expect(read.status).toBe("abandoned");
    });

    it("revives a stale Session, opening a fresh collection on every heartbeat", async () => {
      const session = await startSession(owner.token, projectA);
      await ageSession(session.id, 6);
      const first = heartbeatSessionOutputSchema.parse(
        await ok(heartbeat(owner.token, projectA, session.id)),
      );
      expect(first).toMatchObject({
        previousStatus: "stale",
        session: { status: "active" },
        renewedClaims: { items: [], complete: true },
        leaseExpiresAt: null,
        historicalScopeComplete: true,
      });
      const second = heartbeatSessionOutputSchema.parse(
        await ok(heartbeat(owner.token, projectA, session.id, { status: "idle" })),
      );
      expect(second.collectionId).not.toBe(first.collectionId);
      // The first collection was never finalized: coverage is lost for good.
      expect(second).toMatchObject({
        previousStatus: "active",
        session: { status: "idle", scopeComplete: false },
        historicalScopeComplete: false,
      });
    });

    it("ends with a summary, releases claims, replays the same summary and refuses another", async () => {
      const session = await startSession(owner.token, projectA);
      const { task } = await activeTask(projectA);
      await ok(taskAction(owner.token, projectA, task.id, "claim", { sessionId: session.id }));
      const end = (summary: string) =>
        call(owner.token, `/projects/${projectA}/sessions/${session.id}/end`, {
          body: { summary },
        });
      const ended = endSessionOutputSchema.parse(await ok(end("Shipped.")));
      expect(ended).toMatchObject({
        changed: true,
        releasedClaims: { items: [task.id], complete: true },
        session: { status: "ended", summary: "Shipped." },
      });
      const before = await eventCount(projectA);
      const replay = endSessionOutputSchema.parse(await ok(end("Shipped.")));
      expect(replay).toMatchObject({ changed: false, releasedClaims: { items: [] } });
      await expectError(end("Something else."), 409);
      expect(await eventCount(projectA)).toBe(before);
      // The claim is gone; progress stays.
      const other = await startSession(member.token, projectA);
      const claimed = claimTaskOutputSchema.parse(
        await ok(taskAction(member.token, projectA, task.id, "claim", { sessionId: other.id })),
      );
      expect(claimed.task.claim?.sessionId).toBe(other.id);
      await expectError(heartbeat(owner.token, projectA, session.id), 409);
    });
  });

  describe("Task actions", () => {
    it("names the live holder's Session and intent in a claim conflict", async () => {
      const holder = await startSession(owner.token, projectA, { intent: "Refactor auth" });
      const other = await startSession(member.token, projectA);
      const { task } = await activeTask(projectA);
      await ok(taskAction(owner.token, projectA, task.id, "claim", { sessionId: holder.id }));
      const response = await taskAction(member.token, projectA, task.id, "claim", {
        sessionId: other.id,
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; message: string };
      expect(body).toEqual({
        defined: true,
        code: "CONFLICT",
        status: 409,
        message: taskClaimConflictMessage({ sessionId: holder.id, intent: "Refactor auth" }),
      });
      expect(body.message).toContain(holder.id);
      expect(body.message).toContain("Refactor auth");
    });

    it("claims, starts, blocks and completes, with the claim in each answer", async () => {
      const session = await startSession(owner.token, projectA);
      const { task } = await activeTask(projectA);
      const act = (action: string, body: Record<string, unknown> = {}) =>
        taskAction(owner.token, projectA, task.id, action, { sessionId: session.id, ...body });
      const claimed = claimTaskOutputSchema.parse(await ok(act("claim")));
      expect(claimed).toMatchObject({
        changed: true,
        stolenFromSessionId: null,
        task: { status: "todo", claim: { sessionId: session.id } },
      });
      expect(claimTaskOutputSchema.parse(await ok(act("claim"))).changed).toBe(false);
      const started = taskActionOutputSchema.parse(await ok(act("start")));
      expect(started.task).toMatchObject({
        status: "in_progress",
        claim: { sessionId: session.id },
      });
      const blocked = taskActionOutputSchema.parse(await ok(act("block", { reason: "Review." })));
      expect(blocked.task).toMatchObject({ status: "blocked", blockedReason: "Review." });
      const done = taskActionOutputSchema.parse(await ok(act("done")));
      expect(done).toMatchObject({ changed: true, task: { status: "done", claim: null } });
      expect(taskActionOutputSchema.parse(await ok(act("done"))).changed).toBe(false);
      const claims = taskPageSchema.parse(
        await ok(call(owner.token, `/projects/${projectA}/sessions/${session.id}/claims`)),
      );
      expect(claims.items).toEqual([]);
    });

    it("leaves a stolen claim with the new holder whatever the former holder does", async () => {
      const former = await startSession(owner.token, projectA, { intent: "First" });
      const thief = await startSession(member.token, projectA, { intent: "Second" });
      const { task } = await activeTask(projectA);
      await ok(taskAction(owner.token, projectA, task.id, "claim", { sessionId: former.id }));
      const stolen = claimTaskOutputSchema.parse(
        await ok(
          taskAction(member.token, projectA, task.id, "claim", {
            sessionId: thief.id,
            steal: true,
          }),
        ),
      );
      expect(stolen).toMatchObject({
        stolenFromSessionId: former.id,
        task: { claim: { sessionId: thief.id } },
      });

      const history = eventPageSchema.parse(
        await ok(call(owner.token, `/projects/${projectA}/sessions/${former.id}/events`)),
      );
      expect(history.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "task.released",
            sessionId: former.id,
            actorSessionId: thief.id,
            taskId: task.id,
            payload: { reason: "stolen" },
          }),
        ]),
      );
      const conflict = taskClaimConflictMessage({ sessionId: thief.id, intent: "Second" });
      for (const [action, extra] of [
        ["release", {}],
        ["start", {}],
        ["block", { reason: "Mine." }],
        ["done", {}],
      ] as const) {
        const response = await taskAction(owner.token, projectA, task.id, action, {
          sessionId: former.id,
          ...extra,
        });
        expect([action, response.status]).toEqual([action, 409]);
        expect(await response.json()).toMatchObject({ message: conflict });
      }
      const beat = heartbeatSessionOutputSchema.parse(
        await ok(heartbeat(owner.token, projectA, former.id)),
      );
      expect(beat.renewedClaims.items).toEqual([]);
      const claims = taskPageSchema.parse(
        await ok(call(owner.token, `/projects/${projectA}/sessions/${thief.id}/claims`)),
      );
      expect(claims.items.map((t) => [t.id, t.status, t.claim?.sessionId])).toEqual([
        [task.id, "todo", thief.id],
      ]);
    });

    it("refuses Task work through a stale Session with 409", async () => {
      const session = await startSession(owner.token, projectA);
      const { task } = await activeTask(projectA);
      await ageSession(session.id, 6);
      await expectError(
        taskAction(owner.token, projectA, task.id, "claim", { sessionId: session.id }),
        409,
      );
    });
  });

  describe("Scopes and collections", () => {
    it("adds and removes declared Scopes idempotently", async () => {
      const session = await startSession(owner.token, projectA);
      const base = `/projects/${projectA}/sessions/${session.id}/scopes`;
      const added = addSessionScopeOutputSchema.parse(
        await ok(call(owner.token, base, { body: { pattern: "apps/web/**" } })),
      );
      expect(added).toMatchObject({ created: true, scope: { source: "declared" } });
      const again = addSessionScopeOutputSchema.parse(
        await ok(call(owner.token, base, { body: { pattern: "apps/web/**" } })),
      );
      expect(again).toEqual({ ...added, created: false });
      const remove = (scopeId: string) =>
        call(owner.token, `${base}/${scopeId}`, { method: "DELETE" });
      expect(await ok(remove(added.scope.id))).toEqual({
        id: added.scope.id,
        sessionId: session.id,
        removed: true,
      });
      expect(await ok(remove(added.scope.id))).toMatchObject({ removed: false });
      expect(scopePageSchema.parse(await ok(call(member.token, base))).items).toEqual([]);
    });

    it("runs the collection protocol, replays a batch and refuses an obsolete collection", async () => {
      const session = await startSession(owner.token, projectA);
      const base = `/projects/${projectA}/sessions/${session.id}`;
      const { collectionId } = heartbeatSessionOutputSchema.parse(
        await ok(heartbeat(owner.token, projectA, session.id)),
      );
      const paths = ["README.md", "apps/web/page.tsx"];
      const collection = `${base}/collections/${collectionId}`;
      const manifest = {
        pathCount: 2,
        batchCount: 1,
        omittedPathCount: 0,
        contentHash: await touchedPathsContentHash(paths),
      };
      expect(
        collectionOutputSchema.parse(
          await ok(call(owner.token, `${collection}/manifest`, { body: manifest })),
        ),
      ).toMatchObject({ changed: true, collection: { pathCount: 2, finalized: false } });
      const batch = { batchIndex: 0, paths };
      const uploaded = uploadCollectionBatchOutputSchema.parse(
        await ok(call(owner.token, `${collection}/batches`, { body: batch })),
      );
      expect(uploaded).toMatchObject({ changed: true, storedPathCount: 2 });
      const events = await eventCount(projectA);
      const replay = uploadCollectionBatchOutputSchema.parse(
        await ok(call(owner.token, `${collection}/batches`, { body: batch })),
      );
      expect(replay).toMatchObject({ changed: false, storedPathCount: 2 });
      expect(await eventCount(projectA)).toBe(events);
      await expectError(
        call(owner.token, `${collection}/batches`, {
          body: { batchIndex: 0, paths: ["README.md"] },
        }),
        409,
      );
      const finalized = collectionOutputSchema.parse(
        await ok(call(owner.token, `${collection}/finalize`, { body: {} })),
      );
      expect(finalized.collection).toMatchObject({
        finalized: true,
        collectionComplete: true,
        historicalScopeComplete: true,
        scopeComplete: true,
      });
      const touched = scopePageSchema.parse(
        await ok(call(owner.token, `${base}/scopes?source=touched`)),
      );
      expect(touched.items.map((s) => s.value).sort()).toEqual(paths);
      await expectError(
        call(owner.token, `${base}/scopes/${touched.items[0]?.id}`, { method: "DELETE" }),
        409,
      );

      // A new heartbeat makes the old collection obsolete.
      await ok(heartbeat(owner.token, projectA, session.id));
      await expectError(call(owner.token, `${collection}/finalize`, { body: {} }), 409);
      await expectError(call(owner.token, `${collection}/manifest`, { body: manifest }), 409);
    });

    it("finds overlaps with witnesses, complete only when every coverage is complete", async () => {
      const projectId = await api.createProject(owner);
      const first = await startSession(owner.token, projectId);
      const second = await startSession(member.token, projectId);
      const declare = (token: string, sessionId: string, pattern: string) =>
        ok(
          call(token, `/projects/${projectId}/sessions/${sessionId}/scopes`, {
            body: { pattern },
          }),
        );
      await declare(owner.token, first.id, "apps/web/**");
      await declare(member.token, second.id, "apps/*/src/*.ts");
      const check = async () =>
        overlapPageSchema.parse(
          await ok(call(member.token, `/projects/${projectId}/sessions/${first.id}/overlaps`)),
        );
      const incomplete = await check();
      expect(incomplete.items).toHaveLength(1);
      expect(incomplete.items[0]).toMatchObject({
        sessionId: first.id,
        otherSessionId: second.id,
        kind: "overlap",
        scope: { value: "apps/web/**" },
        otherScope: { value: "apps/*/src/*.ts" },
      });
      expect(incomplete.items[0]?.witness).toMatch(/^apps\/web\/src\/[^/]*\.ts$/);
      // Neither Session has finalized a collection: not an all-clear.
      expect(incomplete.complete).toBe(false);
      expect(new Set(incomplete.incompleteSessionIds)).toEqual(new Set([first.id, second.id]));

      for (const [token, session] of [
        [owner.token, first],
        [member.token, second],
      ] as const) {
        const { collectionId } = heartbeatSessionOutputSchema.parse(
          await ok(heartbeat(token, projectId, session.id)),
        );
        const collection = `/projects/${projectId}/sessions/${session.id}/collections/${collectionId}`;
        await ok(
          call(token, `${collection}/manifest`, {
            body: {
              pathCount: 0,
              batchCount: 0,
              omittedPathCount: 0,
              contentHash: await touchedPathsContentHash([]),
            },
          }),
        );
        await ok(call(token, `${collection}/finalize`, { body: {} }));
      }
      const complete = await check();
      expect(complete).toMatchObject({ complete: true, incompleteSessionIds: [] });
      expect(complete.items).toHaveLength(1);

      // With two candidates, a limit-1 check takes two pages. The new
      // Session has no finished collection, so the check ends incomplete.
      const third = await startSession(owner.token, projectId);
      await declare(owner.token, third.id, "apps/web/src/**");
      const overlaps = `/projects/${projectId}/sessions/${first.id}/overlaps?limit=1`;
      const page1 = overlapPageSchema.parse(await ok(call(member.token, overlaps)));
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.complete).toBe(false);
      const page2 = overlapPageSchema.parse(
        await ok(call(member.token, `${overlaps}&cursor=${page1.nextCursor}`)),
      );
      expect(page2.nextCursor).toBeNull();
      expect(page2.complete).toBe(false);
      expect([...page1.items, ...page2.items].map((item) => item.otherSessionId).sort()).toEqual(
        [second.id, third.id].sort(),
      );
      await expectError(
        call(
          member.token,
          `/projects/${projectId}/sessions/${second.id}/overlaps?cursor=${page1.nextCursor}`,
        ),
        400,
      );
    });
  });

  describe("status", () => {
    it("reports every section at one time, myClaims only for a named Session, without writing", async () => {
      const projectId = await api.createProject(owner);
      const mine = await startSession(owner.token, projectId);
      const theirs = await startSession(member.token, projectId);
      const lapsed = await startSession(owner.token, projectId);
      const { plan, task } = await activeTask(projectId);
      await ok(taskAction(owner.token, projectId, task.id, "claim", { sessionId: mine.id }));
      await ok(
        call(owner.token, `/projects/${projectId}/sessions/${mine.id}/scopes`, {
          body: { pattern: "src/**" },
        }),
      );
      await ok(
        call(member.token, `/projects/${projectId}/sessions/${theirs.id}/scopes`, {
          body: { pattern: "src/*.ts" },
        }),
      );
      await ageSession(lapsed.id, 31);
      const events = await eventCount(projectId);
      const [lapsedRow] = await api.testDb.db
        .select()
        .from(agentSession)
        .where(eq(agentSession.id, lapsed.id));

      const status = (query = "") =>
        call(member.token, `/projects/${projectId}/status${query}`).then(async (r) =>
          projectStatusSchema.parse(await ok(r)),
        );
      const general = await status();
      expect(general).toMatchObject({
        projectId,
        selectedSessionId: null,
        myClaims: [],
        complete: {
          activePlans: true,
          liveSessions: true,
          myClaims: true,
          recentTerminalSessions: true,
        },
      });
      expect(general.activePlans.map((p) => [p.key, p.progress.total])).toEqual([[plan.key, 1]]);
      expect(new Set(general.liveSessions.map((entry) => entry.session.id))).toEqual(
        new Set([mine.id, theirs.id]),
      );
      const mineEntry = general.liveSessions.find((entry) => entry.session.id === mine.id);
      expect(mineEntry).toMatchObject({ claimCount: 1, touchedScopeCount: 0 });
      expect(mineEntry?.declaredScopes.map((s) => s.value)).toEqual(["src/**"]);
      expect(general.recentTerminalSessions.map((s) => [s.id, s.status])).toEqual([
        [lapsed.id, "abandoned"],
      ]);
      expect(general.overlaps).toHaveLength(1);
      // Coverage is incomplete (no collection finalized): never an all-clear.
      expect(general.complete.overlaps).toBe(false);

      const selected = await status(`?sessionId=${mine.id}`);
      expect(selected.selectedSessionId).toBe(mine.id);
      expect(selected.myClaims.map((t) => [t.id, t.claim?.sessionId])).toEqual([
        [task.id, mine.id],
      ]);
      expect(selected.overlaps.map((o) => o.sessionId)).toEqual([mine.id]);
      const others = await status(`?sessionId=${theirs.id}`);
      expect(others.myClaims).toEqual([]);
      expect(others.overlaps.map((o) => [o.sessionId, o.otherSessionId])).toEqual([
        [theirs.id, mine.id],
      ]);

      // Reads never write: no Event, and the lapsed Session's row is untouched.
      expect(await eventCount(projectId)).toBe(events);
      const [after] = await api.testDb.db
        .select()
        .from(agentSession)
        .where(eq(agentSession.id, lapsed.id));
      expect(after).toEqual(lapsedRow);
    });

    it("bounds each section and says when it is incomplete", async () => {
      const projectId = await api.createProject(owner);
      for (let i = 0; i < 21; i++) await startSession(owner.token, projectId);
      const status = projectStatusSchema.parse(
        await ok(call(owner.token, `/projects/${projectId}/status`)),
      );
      expect(status.liveSessions).toHaveLength(20);
      expect(status.complete.liveSessions).toBe(false);
      expect(JSON.stringify(status).length).toBeLessThan(4 * 1024 * 1024);
    });
  });
});
