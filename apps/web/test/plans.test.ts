import {
  API_ERRORS,
  addTaskOutputSchema,
  appendPlanLogOutputSchema,
  createPlanOutputSchema,
  eventPageSchema,
  MAX_EVENT_BYTES,
  MAX_MARKDOWN_BYTES,
  MAX_PLAN_TITLE_LENGTH,
  type ProjectKeyPermission,
  planPageSchema,
  planSchema,
  setPlanStatusOutputSchema,
  taskPageSchema,
  updatePlanOutputSchema,
} from "@hivemind/contract";
import { type Event as EventRow, encodedJsonBytes } from "@hivemind/db";
import { agentSession, event, task } from "@hivemind/db/schema";
import { describeDb } from "@hivemind/db/testing";
import { ORPCError } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizeProject } from "../src/server/api/coordination-auth";
import { toEventDto } from "../src/server/api/coordination-dto";
import type { ProjectKeyPrincipal } from "../src/server/api/principal";
import {
  type ApiHarness,
  createApiHarness,
  errorCode,
  type RequestOptions,
  type SignedInUser,
} from "./support/api";

// The Plan, Task (add/list) and Event read routes of #12: the authorization
// matrix, nested-id isolation, attribution, limits, pages, creation replay,
// rollback, Plan transitions and claim visibility.

describeDb("/api/v1 Plans, Tasks and Events", () => {
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

  async function createPlan(
    token: string,
    projectId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; key: string }> {
    const response = await call(token, `/projects/${projectId}/plans`, {
      body: { planId: uuid(), title: "Plan", ...body },
    });
    if (response.status !== 200) throw new Error(`createPlan: ${await response.text()}`);
    return createPlanOutputSchema.parse(await response.json()).plan;
  }

  async function addTask(token: string, projectId: string, planRef: string, title = "Task") {
    const response = await call(token, `/projects/${projectId}/plans/${planRef}/tasks`, {
      body: { taskId: uuid(), title },
    });
    if (response.status !== 200) throw new Error(`addTask: ${await response.text()}`);
    return addTaskOutputSchema.parse(await response.json()).task;
  }

  async function setStatus(token: string, projectId: string, planRef: string, status: string) {
    return call(token, `/projects/${projectId}/plans/${planRef}/status`, { body: { status } });
  }

  /** A Session row inserted directly; lifecycle routes are not under test here. */
  async function insertSession(
    projectId: string,
    owned: { userId: string } | { keyId: string },
    values: Partial<typeof agentSession.$inferInsert> = {},
  ) {
    const [row] = await api.testDb.db
      .insert(agentSession)
      .values({
        projectId,
        ...("userId" in owned
          ? { ownerKind: "user" as const, userId: owned.userId }
          : { ownerKind: "key" as const, keyId: owned.keyId }),
        agent: "test",
        intent: "Testing",
        creationFingerprint: "0".repeat(64),
        ...values,
      })
      .returning();
    if (!row) throw new Error("Session insert returned no row.");
    return row;
  }

  /** Gives `sessionId` a claim on the Task, as a claim would, without the claim route. */
  async function seedClaim(taskId: string, sessionId: string, leaseSeconds = 300) {
    await api.testDb.db
      .update(task)
      .set({
        claimedBySessionId: sessionId,
        claimedAt: sql`now()`,
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      })
      .where(eq(task.id, taskId));
  }

  async function eventsOf(projectId: string) {
    return api.testDb.db
      .select()
      .from(event)
      .where(eq(event.projectId, projectId))
      .orderBy(event.seq);
  }

  describe("the authorization matrix", () => {
    // One valid request per route, in a fresh Plan of `projectId`.
    async function routes(
      projectId: string,
    ): Promise<Record<string, Omit<RequestOptions, "token"> & { path: string }>> {
      const plan = await createPlan(owner.token, projectId);
      const session = await insertSession(projectId, { userId: owner.id });
      const base = `/projects/${projectId}`;
      return {
        listPlans: { path: `${base}/plans` },
        createPlan: { path: `${base}/plans`, body: { planId: uuid(), title: "New" } },
        getPlan: { path: `${base}/plans/${plan.key}` },
        updatePlan: {
          path: `${base}/plans/${plan.key}`,
          method: "PATCH" as const,
          body: { title: `Edited ${uuid()}` },
        },
        setPlanStatus: { path: `${base}/plans/${plan.id}/status`, body: { status: "active" } },
        listPlanLog: { path: `${base}/plans/${plan.key}/log` },
        appendPlanLog: {
          path: `${base}/plans/${plan.key}/log`,
          body: { eventId: uuid(), message: "Progress." },
        },
        listPlanTasks: { path: `${base}/plans/${plan.key}/tasks` },
        addTask: { path: `${base}/plans/${plan.key}/tasks`, body: { taskId: uuid(), title: "T" } },
        listProjectEvents: { path: `${base}/events` },
        listSessionEvents: { path: `${base}/sessions/${session.id}/events` },
      };
    }

    const callers: [string, () => string, () => string, number][] = [
      ["an organization owner", () => owner.token, () => projectA, 200],
      ["a member who is not an owner", () => member.token, () => projectA, 200],
      ["a non-member", () => outsider.token, () => projectA, 404],
      ["the Project's own key", () => keyA.secret, () => projectA, 200],
      ["another Project's key", () => keyB.secret, () => projectA, 404],
    ];

    for (const [who, token, projectId, status] of callers) {
      it(`answers ${status} to ${who} on every route`, async () => {
        for (const [operation, route] of Object.entries(await routes(projectId()))) {
          const response = await call(token(), route.path, route);
          expect([operation, response.status]).toEqual([operation, status]);
          if (status === 404) expect(await errorCode(response)).toBe("NOT_FOUND");
        }
      });
    }

    it("answers an absent Project the same 404 as an inaccessible one", async () => {
      const absent = await call(owner.token, `/projects/${uuid()}/plans`);
      const foreign = await call(outsider.token, `/projects/${projectA}/plans`);
      expect(absent.status).toBe(404);
      expect(await absent.json()).toEqual(await foreign.json());
    });

    it("stops answering a member who left the organization", async () => {
      const leaver = await api.signUp();
      await api.addMember(owner.organizationId, leaver.id, "member");
      expect((await call(leaver.token, `/projects/${projectA}/plans`)).status).toBe(200);
      await api.removeMember(owner.organizationId, leaver.id);
      expect((await call(leaver.token, `/projects/${projectA}/plans`)).status).toBe(404);
    });

    it("refuses a Project key without a route's permission with 403, after Project access", async () => {
      const limited: ProjectKeyPrincipal = {
        kind: "projectKey",
        keyId: keyA.id,
        organizationId: owner.organizationId,
        projectId: projectA,
        permissions: ["project:read", "plan:read"],
      };
      const attempt = (projectId: string, permissions: ProjectKeyPermission[]) =>
        authorizeProject(api.testDb.db, limited, projectId, permissions).catch(
          (error: unknown) => error,
        );
      const access = await attempt(projectA, ["plan:read"]);
      expect(access).toMatchObject({ principal: { kind: "project_key", keyId: keyA.id } });
      const denied = await attempt(projectA, ["plan:read", "plan:write"]);
      expect(denied).toBeInstanceOf(ORPCError);
      expect(denied).toMatchObject({ code: "FORBIDDEN", status: 403 });
      // Another Project is 404 whatever the permissions.
      expect(await attempt(projectB, ["plan:write"])).toMatchObject({ code: "NOT_FOUND" });
    });

    it("answers 401 to a revoked or expired key, and keeps its history readable", async () => {
      const revoked = await api.createKey(owner, projectA);
      const expired = await api.createKey(owner, projectA);
      const byRevoked = await createPlan(revoked.secret, projectA, { title: "By a key" });
      await createPlan(expired.secret, projectA);
      await call(owner.token, `/projects/${projectA}/keys/${revoked.id}`, { method: "DELETE" });
      await api.testDb.pool.query(
        "update apikey set expires_at = now() - interval '1 second' where id = $1",
        [expired.id],
      );
      for (const secret of [revoked.secret, expired.secret]) {
        const response = await call(secret, `/projects/${projectA}/plans`);
        expect(response.status).toBe(401);
        expect(await errorCode(response)).toBe("UNAUTHORIZED");
      }

      const read = await call(owner.token, `/projects/${projectA}/plans/${byRevoked.key}`);
      expect(planSchema.parse(await read.json())).toMatchObject({
        title: "By a key",
        ownerUserId: null,
        createdBy: { kind: "project_key", keyId: revoked.id },
      });
      const log = eventPageSchema.parse(
        await (await call(owner.token, `/projects/${projectA}/plans/${byRevoked.key}/log`)).json(),
      );
      expect(log.items[0]).toMatchObject({
        type: "plan.created",
        actor: { kind: "project_key", keyId: revoked.id },
      });
    });
  });

  describe("nested resources", () => {
    it("answers 404 for a Plan of another Project, by key or UUID", async () => {
      const foreign = await createPlan(owner.token, projectB);
      for (const ref of [foreign.id]) {
        const base = `/projects/${projectA}/plans/${ref}`;
        const requests: [string, Omit<RequestOptions, "token">][] = [
          [base, {}],
          [base, { method: "PATCH", body: { title: "X" } }],
          [`${base}/status`, { body: { status: "active" } }],
          [`${base}/log`, {}],
          [`${base}/log`, { body: { eventId: uuid(), message: "X" } }],
          [`${base}/tasks`, {}],
          [`${base}/tasks`, { body: { taskId: uuid(), title: "X" } }],
        ];
        for (const [path, options] of requests) {
          const response = await call(owner.token, path, options);
          expect([path, response.status]).toEqual([path, 404]);
          expect(await response.json()).toMatchObject({ message: "Plan not found." });
        }
      }
      const unknown = await call(owner.token, `/projects/${projectA}/plans/PLAN-999999`);
      expect(unknown.status).toBe(404);
      // The foreign Plan is untouched.
      const intact = await call(owner.token, `/projects/${projectB}/plans/${foreign.id}`);
      expect(planSchema.parse(await intact.json())).toMatchObject({
        title: "Plan",
        status: "draft",
      });
    });

    it("resolves PLAN-N within the path's Project", async () => {
      const inA = await createPlan(owner.token, projectA, { title: "In A" });
      const number = inA.key;
      // Give projectB a Plan with the same number if it has fewer Plans.
      let inB = await createPlan(owner.token, projectB, { title: "In B" });
      while (Number(inB.key.slice(5)) < Number(number.slice(5))) {
        inB = await createPlan(owner.token, projectB, { title: "In B" });
      }
      const read = await call(owner.token, `/projects/${projectA}/plans/${number}`);
      expect(planSchema.parse(await read.json()).id).toBe(inA.id);
    });

    it("answers 404 for a Session of another Project or no Session", async () => {
      const foreign = await insertSession(projectB, { userId: owner.id });
      for (const sessionId of [foreign.id, uuid()]) {
        const response = await call(
          owner.token,
          `/projects/${projectA}/sessions/${sessionId}/events`,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ message: "Session not found." });
      }
    });

    it("reads any Session's events in the Project, whoever owns it", async () => {
      const keySession = await insertSession(projectA, { keyId: keyA.id });
      const plan = await createPlan(keyA.secret, projectA, { sessionId: keySession.id });
      const response = await call(
        member.token,
        `/projects/${projectA}/sessions/${keySession.id}/events`,
      );
      const page = eventPageSchema.parse(await response.json());
      expect(page.items.map((item) => [item.type, item.planId])).toEqual([
        ["plan.created", plan.id],
      ]);
    });
  });

  describe("attribution", () => {
    it("rejects owner, creator and actor fields in requests", async () => {
      const forged = [
        { ownerUserId: outsider.id },
        { createdBy: { kind: "user", userId: outsider.id } },
        { actor: { kind: "system" } },
        { projectId: projectB },
      ];
      for (const extra of forged) {
        const response = await call(owner.token, `/projects/${projectA}/plans`, {
          body: { planId: uuid(), title: "Forged", ...extra },
        });
        expect(response.status).toBe(400);
      }
      const plan = await createPlan(owner.token, projectA);
      const log = await call(owner.token, `/projects/${projectA}/plans/${plan.key}/log`, {
        body: { eventId: uuid(), message: "X", actor: { kind: "system" } },
      });
      expect(log.status).toBe(400);
    });

    it("records the authenticated caller and its own Session as the actor", async () => {
      const session = await insertSession(projectA, { userId: member.id });
      const plan = await createPlan(member.token, projectA, { sessionId: session.id });
      const response = await call(member.token, `/projects/${projectA}/plans/${plan.key}/log`, {
        body: { eventId: uuid(), message: "Started.", sessionId: session.id },
      });
      const { event: logged } = appendPlanLogOutputSchema.parse(await response.json());
      expect(logged).toMatchObject({
        actor: { kind: "user", userId: member.id },
        actorSessionId: session.id,
        planId: plan.id,
        sessionId: null,
        payload: { message: "Started." },
      });
      const read = planSchema.parse(
        await (await call(owner.token, `/projects/${projectA}/plans/${plan.key}`)).json(),
      );
      expect(read).toMatchObject({
        ownerUserId: member.id,
        createdBy: { kind: "user", userId: member.id },
      });
    });

    it("answers 403 for another principal's Session, 404 for none and 409 for an ended one", async () => {
      const others = await insertSession(projectA, { userId: owner.id });
      const keys = await insertSession(projectA, { keyId: keyA.id });
      const ended = await insertSession(
        projectA,
        { userId: member.id },
        {
          status: "ended",
          endedAt: new Date(),
        },
      );
      const lapsed = await insertSession(
        projectA,
        { userId: member.id },
        {
          lastHeartbeatAt: new Date(Date.now() - 31 * 60_000),
        },
      );
      const stale = await insertSession(
        projectA,
        { userId: member.id },
        {
          lastHeartbeatAt: new Date(Date.now() - 6 * 60_000),
        },
      );
      const plan = await createPlan(owner.token, projectA);
      const append = (sessionId: string) =>
        call(member.token, `/projects/${projectA}/plans/${plan.key}/log`, {
          body: { eventId: uuid(), message: "X", sessionId },
        });
      // Visible Sessions of the Project the caller does not own.
      for (const foreign of [others.id, keys.id]) {
        const response = await append(foreign);
        expect(response.status).toBe(403);
        expect(await errorCode(response)).toBe("FORBIDDEN");
      }
      expect((await append(uuid())).status).toBe(404);
      expect((await append(ended.id)).status).toBe(409);
      expect((await append(lapsed.id)).status).toBe(409);
      expect((await append(stale.id)).status).toBe(200);
    });
  });

  describe("input limits", () => {
    it("bounds titles to 120 characters and markdown to 8 KiB", async () => {
      const path = `/projects/${projectA}/plans`;
      const longTitle = await call(owner.token, path, {
        body: { planId: uuid(), title: "x".repeat(MAX_PLAN_TITLE_LENGTH + 1) },
      });
      expect(longTitle.status).toBe(400);
      const maxTitle = await call(owner.token, path, {
        body: { planId: uuid(), title: "x".repeat(MAX_PLAN_TITLE_LENGTH) },
      });
      expect(maxTitle.status).toBe(200);
      // 2 bytes per character: 4097 characters are 8194 bytes.
      const longBody = await call(owner.token, path, {
        body: { planId: uuid(), title: "Long", body: "é".repeat(MAX_MARKDOWN_BYTES / 2 + 1) },
      });
      expect(longBody.status).toBe(400);
      const nul = await call(owner.token, path, {
        body: { planId: uuid(), title: "Nul", body: "a\u0000b" },
      });
      expect(nul.status).toBe(400);
    });

    it("answers 413 when JSON escaping makes a valid field exceed the 16 KiB body", async () => {
      const plan = await createPlan(owner.token, projectA);
      const before = (await eventsOf(projectA)).length;
      // 8 KiB of quotes is a valid message that JSON doubles to 16 KiB.
      const response = await call(owner.token, `/projects/${projectA}/plans/${plan.key}/log`, {
        body: { eventId: uuid(), message: '"'.repeat(MAX_MARKDOWN_BYTES) },
      });
      expect(response.status).toBe(413);
      expect(await errorCode(response)).toBe("PAYLOAD_TOO_LARGE");
      expect(await eventsOf(projectA)).toHaveLength(before);
    });

    it("keeps a maximal log entry's Event under 64 KiB", async () => {
      const plan = await createPlan(owner.token, projectA);
      // Backslashes double when JSON-encoded; this is about as large an
      // encoded message as fits in the 16 KiB request bound.
      const message = `${"\\".repeat(MAX_MARKDOWN_BYTES / 2 - 100)}x`;
      const response = await call(owner.token, `/projects/${projectA}/plans/${plan.key}/log`, {
        body: { eventId: uuid(), message },
      });
      expect(response.status).toBe(200);
      const { event: logged } = appendPlanLogOutputSchema.parse(await response.json());
      expect(encodedJsonBytes(logged)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    });

    it("refuses to serve a corrupt Event row and withholds an unreadable one", () => {
      const row: EventRow = {
        id: uuid(),
        seq: "1",
        writerXid: "1",
        projectId: projectA,
        type: "plan.log_appended",
        payloadVersion: 1,
        payload: { message: "x".repeat(MAX_EVENT_BYTES) },
        actorKind: "system",
        actorUserId: null,
        actorKeyId: null,
        actorSessionId: null,
        planId: null,
        taskId: null,
        sessionId: null,
        effectiveAt: new Date(),
        creationFingerprint: null,
        createdAt: new Date(),
      };
      // Over the writer's payload limit: corruption, a generic error that
      // names no stored value.
      expect(() => toEventDto(row)).toThrow(/payload_too_large/);
      expect(() => toEventDto(row)).not.toThrow(/xxxx|plan\.log_appended/);
      // An unknown type is a newer writer's, not corruption (ADR-0015).
      expect(toEventDto({ ...row, type: "plan.unknown", payload: { secret: "x" } })).toEqual({
        id: row.id,
        projectId: projectA,
        seq: "1",
        writerXid: "1",
        type: "event.unavailable",
        payloadVersion: 1,
        payload: {},
        actor: { kind: "system" },
        actorSessionId: null,
        planId: null,
        taskId: null,
        sessionId: null,
        effectiveAt: row.effectiveAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      });
    });
  });

  describe("pages", () => {
    it("pages Plans newest first, bound to their Project and filter", async () => {
      const project = await api.createProject(owner);
      const created = [];
      for (let i = 0; i < 5; i++) created.push(await createPlan(owner.token, project));
      const keys: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : "";
        const response = await call(owner.token, `/projects/${project}/plans?limit=2${query}`);
        const page = planPageSchema.parse(await response.json());
        keys.push(...page.items.map((item) => item.key));
        cursor = page.nextCursor;
        if (cursor) {
          const elsewhere = await call(owner.token, `/projects/${projectA}/plans?cursor=${cursor}`);
          expect(elsewhere.status).toBe(400);
          const filtered = await call(
            owner.token,
            `/projects/${project}/plans?status=draft&cursor=${cursor}`,
          );
          expect(filtered.status).toBe(400);
        }
      } while (cursor);
      expect(keys).toEqual(created.map((plan) => plan.key).reverse());

      await setStatus(owner.token, project, created[1]?.key ?? "", "active");
      const active = planPageSchema.parse(
        await (await call(owner.token, `/projects/${project}/plans?status=active`)).json(),
      );
      expect(active.items.map((item) => item.key)).toEqual([created[1]?.key]);
      expect((await call(owner.token, `/projects/${project}/plans?limit=101`)).status).toBe(400);
      expect((await call(owner.token, `/projects/${project}/plans?cursor=bogus`)).status).toBe(400);
    });

    it("pages Tasks by position and Events newest first", async () => {
      const project = await api.createProject(owner);
      const plan = await createPlan(owner.token, project);
      const tasks = [];
      for (let i = 0; i < 5; i++)
        tasks.push(await addTask(owner.token, project, plan.key, `T${i}`));
      expect(tasks.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);

      const taskIds: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : "";
        const response = await call(
          owner.token,
          `/projects/${project}/plans/${plan.key}/tasks?limit=2${query}`,
        );
        const page = taskPageSchema.parse(await response.json());
        taskIds.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(taskIds).toEqual(tasks.map((item) => item.id));

      const seqs: string[] = [];
      const types: string[] = [];
      cursor = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : "";
        const response = await call(owner.token, `/projects/${project}/events?limit=4${query}`);
        const page = eventPageSchema.parse(await response.json());
        seqs.push(...page.items.map((item) => item.seq));
        types.push(...page.items.map((item) => item.type));
        cursor = page.nextCursor;
        if (cursor) {
          const planLog = await call(
            owner.token,
            `/projects/${project}/plans/${plan.key}/log?cursor=${cursor}`,
          );
          expect(planLog.status).toBe(400);
        }
      } while (cursor);
      expect(types).toEqual([...Array(5).fill("task.added"), "plan.created"]);
      const sorted = [...seqs].sort((a, b) => Number(BigInt(b) - BigInt(a)));
      expect(seqs).toEqual(sorted);
      expect(new Set(seqs).size).toBe(6);
    });
  });

  describe("creation replay", () => {
    it("returns the existing Plan with created: false and no second Event", async () => {
      const planId = uuid();
      const body = { planId, title: "Replayed", body: "Body" };
      const first = await call(owner.token, `/projects/${projectA}/plans`, { body });
      const created = createPlanOutputSchema.parse(await first.json());
      expect(created.created).toBe(true);
      // Edited since: the replay compares the original input, not current fields.
      await call(owner.token, `/projects/${projectA}/plans/${planId}`, {
        method: "PATCH",
        body: { title: "Edited" },
      });
      const before = (await eventsOf(projectA)).length;
      const again = await call(owner.token, `/projects/${projectA}/plans`, { body });
      const replayed = createPlanOutputSchema.parse(await again.json());
      expect(replayed).toMatchObject({
        created: false,
        plan: { id: planId, key: created.plan.key, title: "Edited" },
      });
      expect(await eventsOf(projectA)).toHaveLength(before);
    });

    it("replays a creation sent with uppercase ids, the same record as lowercase", async () => {
      const planId = uuid();
      const upper = projectA.toUpperCase();
      const body = { planId: planId.toUpperCase(), title: "Upper" };
      const first = createPlanOutputSchema.parse(
        await (await call(owner.token, `/projects/${upper}/plans`, { body })).json(),
      );
      expect(first).toMatchObject({ created: true, plan: { id: planId, projectId: projectA } });
      const before = (await eventsOf(projectA)).length;
      for (const [projectId, token] of [
        [upper, owner.token],
        [projectA, owner.token],
      ] as const) {
        const again = await call(token, `/projects/${projectId}/plans`, { body });
        expect(again.status).toBe(200);
        expect(createPlanOutputSchema.parse(await again.json())).toMatchObject({
          created: false,
          plan: { id: planId, key: first.plan.key },
        });
      }
      // A Project key bound to the Project accepts its id in either case.
      const byKey = await call(keyA.secret, `/projects/${upper}/plans/${planId.toUpperCase()}`);
      expect(byKey.status).toBe(200);
      expect(await eventsOf(projectA)).toHaveLength(before);
    });

    it("answers 409 for different input or another principal, 404 from another Project", async () => {
      const planId = uuid();
      await call(owner.token, `/projects/${projectA}/plans`, { body: { planId, title: "One" } });
      const before = (await eventsOf(projectA)).length;
      const changed = await call(owner.token, `/projects/${projectA}/plans`, {
        body: { planId, title: "Two" },
      });
      expect(changed.status).toBe(409);
      const otherUser = await call(member.token, `/projects/${projectA}/plans`, {
        body: { planId, title: "One" },
      });
      expect(otherUser.status).toBe(409);
      const byKey = await call(keyA.secret, `/projects/${projectA}/plans`, {
        body: { planId, title: "One" },
      });
      expect(byKey.status).toBe(409);
      const elsewhere = await call(owner.token, `/projects/${projectB}/plans`, {
        body: { planId, title: "One" },
      });
      expect(elsewhere.status).toBe(404);
      // The generic answer: nothing about the Plan that holds the id.
      expect(await elsewhere.json()).toMatchObject({
        code: "NOT_FOUND",
        message: API_ERRORS.NOT_FOUND.message,
      });
      expect(await eventsOf(projectA)).toHaveLength(before);
    });

    it("replays Task additions and log entries the same way", async () => {
      const plan = await createPlan(owner.token, projectA);
      const taskBody = { taskId: uuid(), title: "Once" };
      const taskPath = `/projects/${projectA}/plans/${plan.key}/tasks`;
      const first = addTaskOutputSchema.parse(
        await (await call(owner.token, taskPath, { body: taskBody })).json(),
      );
      // Retried by UUID instead of key: the same Plan, so the same input.
      const again = addTaskOutputSchema.parse(
        await (
          await call(owner.token, `/projects/${projectA}/plans/${plan.id}/tasks`, {
            body: taskBody,
          })
        ).json(),
      );
      expect(again).toEqual({ ...first, created: false });
      expect(
        (await call(owner.token, taskPath, { body: { ...taskBody, title: "Twice" } })).status,
      ).toBe(409);
      const otherPlan = await createPlan(owner.token, projectA);
      const moved = await call(owner.token, `/projects/${projectA}/plans/${otherPlan.key}/tasks`, {
        body: taskBody,
      });
      expect(moved.status).toBe(409);
      const foreignPlan = await createPlan(owner.token, projectB);
      const foreign = await call(
        owner.token,
        `/projects/${projectB}/plans/${foreignPlan.key}/tasks`,
        { body: taskBody },
      );
      expect(foreign.status).toBe(404);

      const logBody = { eventId: uuid(), message: "Once." };
      const logPath = `/projects/${projectA}/plans/${plan.key}/log`;
      const logged = appendPlanLogOutputSchema.parse(
        await (await call(owner.token, logPath, { body: logBody })).json(),
      );
      expect(logged.created).toBe(true);
      expect(logged.event.id).toBe(logBody.eventId);
      const before = (await eventsOf(projectA)).length;
      const relogged = appendPlanLogOutputSchema.parse(
        await (await call(owner.token, logPath, { body: logBody })).json(),
      );
      expect(relogged).toEqual({ ...logged, created: false });
      expect(await eventsOf(projectA)).toHaveLength(before);
      expect(
        (await call(owner.token, logPath, { body: { ...logBody, message: "Twice." } })).status,
      ).toBe(409);
      expect((await call(keyA.secret, logPath, { body: logBody })).status).toBe(409);
      // A Plan's own creation Event id is not a log entry id.
      const [created] = await api.testDb.db
        .select()
        .from(event)
        .where(eq(event.planId, plan.id))
        .limit(1);
      expect(
        (await call(owner.token, logPath, { body: { eventId: created?.id, message: "Once." } }))
          .status,
      ).toBe(409);
      // Another Project's log entry id.
      const foreignLog = await call(
        owner.token,
        `/projects/${projectB}/plans/${foreignPlan.key}/log`,
        { body: logBody },
      );
      expect(foreignLog.status).toBe(404);
    });
  });

  describe("transactions", () => {
    it("writes neither a Plan, a number nor an Event when creation fails", async () => {
      const project = await api.createProject(owner);
      const ended = await insertSession(
        project,
        { userId: owner.id },
        { status: "ended", endedAt: new Date() },
      );
      const first = await createPlan(owner.token, project);
      const failed = await call(owner.token, `/projects/${project}/plans`, {
        body: { planId: uuid(), title: "Fails", sessionId: ended.id },
      });
      expect(failed.status).toBe(409);
      const next = await createPlan(owner.token, project);
      expect([first.key, next.key]).toEqual(["PLAN-1", "PLAN-2"]);
      expect((await eventsOf(project)).map((row) => row.type)).toEqual([
        "plan.created",
        "plan.created",
      ]);

      const taskFailure = await call(owner.token, `/projects/${project}/plans/${next.key}/tasks`, {
        body: { taskId: uuid(), title: "Fails", sessionId: ended.id },
      });
      expect(taskFailure.status).toBe(409);
      const tasks = await api.testDb.db.select().from(task).where(eq(task.projectId, project));
      expect(tasks).toHaveLength(0);
      expect(await eventsOf(project)).toHaveLength(2);
    });

    it("gives concurrent creations distinct, gapless Plan numbers", async () => {
      const project = await api.createProject(owner);
      const tokens = [
        owner.token,
        member.token,
        owner.token,
        member.token,
        owner.token,
        member.token,
      ];
      const plans = await Promise.all(tokens.map((token) => createPlan(token, project)));
      expect(plans.map((plan) => Number(plan.key.slice(5))).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(await eventsOf(project)).toHaveLength(6);
    });
  });

  describe("Plan lifecycle", () => {
    it("follows the transition table, with no-ops and terminal statuses", async () => {
      const plan = await createPlan(owner.token, projectA);
      const path = `/projects/${projectA}/plans/${plan.key}`;
      expect((await setStatus(owner.token, projectA, plan.key, "paused")).status).toBe(409);
      expect((await setStatus(owner.token, projectA, plan.key, "done")).status).toBe(409);
      const activated = setPlanStatusOutputSchema.parse(
        await (await setStatus(owner.token, projectA, plan.key, "active")).json(),
      );
      expect(activated).toMatchObject({
        changed: true,
        releasedClaimCount: 0,
        plan: { status: "active" },
      });
      const before = (await eventsOf(projectA)).length;
      const again = setPlanStatusOutputSchema.parse(
        await (await setStatus(owner.token, projectA, plan.key, "active")).json(),
      );
      expect(again.changed).toBe(false);
      expect(await eventsOf(projectA)).toHaveLength(before);
      expect((await setStatus(owner.token, projectA, plan.key, "paused")).status).toBe(200);
      expect((await setStatus(owner.token, projectA, plan.key, "active")).status).toBe(200);

      const unchanged = updatePlanOutputSchema.parse(
        await (await call(owner.token, path, { method: "PATCH", body: { title: "Plan" } })).json(),
      );
      expect(unchanged.changed).toBe(false);
      const edited = updatePlanOutputSchema.parse(
        await (
          await call(owner.token, path, { method: "PATCH", body: { body: "Now with a body." } })
        ).json(),
      );
      expect(edited).toMatchObject({
        changed: true,
        plan: { title: "Plan", body: "Now with a body." },
      });
      const cleared = updatePlanOutputSchema.parse(
        await (await call(owner.token, path, { method: "PATCH", body: { body: null } })).json(),
      );
      expect(cleared.plan.body).toBeNull();
      expect((await call(owner.token, path, { method: "PATCH", body: {} })).status).toBe(400);

      const log = eventPageSchema.parse(await (await call(owner.token, `${path}/log`)).json());
      expect(log.items.map((item) => [item.type, item.payload])).toEqual([
        ["plan.updated", { title: null, bodyChanged: true }],
        ["plan.updated", { title: null, bodyChanged: true }],
        ["plan.status_changed", { from: "paused", to: "active" }],
        ["plan.status_changed", { from: "active", to: "paused" }],
        ["plan.status_changed", { from: "draft", to: "active" }],
        ["plan.created", { key: plan.key, title: "Plan", status: "draft" }],
      ]);

      expect((await setStatus(owner.token, projectA, plan.key, "done")).status).toBe(200);
      for (const status of ["active", "paused", "abandoned"]) {
        const response = await setStatus(owner.token, projectA, plan.key, status);
        expect([status, response.status]).toEqual([status, 409]);
      }
      expect(
        (await call(owner.token, path, { method: "PATCH", body: { title: "Late" } })).status,
      ).toBe(409);
      const lateTask = await call(owner.token, `${path}/tasks`, {
        body: { taskId: uuid(), title: "Late" },
      });
      expect(lateTask.status).toBe(409);
      // The log stays open on a terminal Plan.
      const lateLog = await call(owner.token, `${path}/log`, {
        body: { eventId: uuid(), message: "Retro." },
      });
      expect(lateLog.status).toBe(200);
    });

    it("completes a Plan only when every Task is done and unclaimed", async () => {
      const plan = await createPlan(owner.token, projectA, { status: "active" });
      const first = await addTask(owner.token, projectA, plan.key);
      const second = await addTask(owner.token, projectA, plan.key);
      const refused = await setStatus(owner.token, projectA, plan.key, "done");
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ message: "The Plan has 2 Tasks not done." });
      await api.testDb.db.update(task).set({ status: "done" }).where(eq(task.id, first.id));
      expect((await setStatus(owner.token, projectA, plan.key, "done")).status).toBe(409);
      await api.testDb.db.update(task).set({ status: "done" }).where(eq(task.id, second.id));
      const done = setPlanStatusOutputSchema.parse(
        await (await setStatus(owner.token, projectA, plan.key, "done")).json(),
      );
      expect(done.plan).toMatchObject({ status: "done", progress: { total: 2, done: 2 } });
    });

    it("releases every claim, usable or not, when a Plan is abandoned", async () => {
      const plan = await createPlan(owner.token, projectA, { status: "active" });
      const holder = await insertSession(projectA, { userId: member.id });
      const lapsed = await insertSession(
        projectA,
        { keyId: keyA.id },
        {
          lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
        },
      );
      const usable = await addTask(owner.token, projectA, plan.key);
      const expired = await addTask(owner.token, projectA, plan.key);
      const unclaimed = await addTask(owner.token, projectA, plan.key);
      await seedClaim(usable.id, holder.id);
      await seedClaim(expired.id, lapsed.id, -1);

      const abandoned = setPlanStatusOutputSchema.parse(
        await (await setStatus(owner.token, projectA, plan.key, "abandoned")).json(),
      );
      expect(abandoned).toMatchObject({
        changed: true,
        releasedClaimCount: 2,
        plan: { status: "abandoned" },
      });
      const rows = await api.testDb.db.select().from(task).where(eq(task.planId, plan.id));
      expect(
        rows.every((row) => row.claimedBySessionId === null && row.leaseExpiresAt === null),
      ).toBe(true);
      expect(rows.find((row) => row.id === unclaimed.id)?.status).toBe("todo");

      const log = eventPageSchema.parse(
        await (
          await call(owner.token, `/projects/${projectA}/plans/${plan.key}/log?limit=2`)
        ).json(),
      );
      const released = log.items.map((item) => [
        item.type,
        item.taskId,
        item.sessionId,
        item.payload,
      ]);
      expect(released).toEqual(
        expect.arrayContaining([
          ["task.released", usable.id, holder.id, { reason: "plan_abandoned" }],
          ["task.released", expired.id, lapsed.id, { reason: "lease_expired" }],
        ]),
      );
      // The holder's history shows the release that affected it.
      const history = eventPageSchema.parse(
        await (
          await call(owner.token, `/projects/${projectA}/sessions/${holder.id}/events`)
        ).json(),
      );
      expect(history.items.map((item) => [item.type, item.taskId])).toEqual([
        ["task.released", usable.id],
      ]);
    });
  });

  describe("Task claims in lists", () => {
    it("shows a claim only while its lease and holder are live", async () => {
      const plan = await createPlan(owner.token, projectA, { status: "active" });
      const live = await insertSession(projectA, { userId: owner.id });
      const stale = await insertSession(
        projectA,
        { userId: owner.id },
        {
          lastHeartbeatAt: new Date(Date.now() - 5 * 60_000 - 1000),
        },
      );
      const ended = await insertSession(
        projectA,
        { userId: owner.id },
        { status: "ended", endedAt: new Date() },
      );
      const held = await addTask(owner.token, projectA, plan.key, "held");
      const expired = await addTask(owner.token, projectA, plan.key, "expired");
      const staleHeld = await addTask(owner.token, projectA, plan.key, "stale");
      const endedHeld = await addTask(owner.token, projectA, plan.key, "ended");
      await seedClaim(held.id, live.id);
      await seedClaim(expired.id, live.id, 0);
      await seedClaim(staleHeld.id, stale.id);
      await seedClaim(endedHeld.id, ended.id);
      await api.testDb.db
        .update(task)
        .set({ status: "blocked", blockReason: "Waiting." })
        .where(eq(task.id, held.id));

      const page = taskPageSchema.parse(
        await (await call(keyA.secret, `/projects/${projectA}/plans/${plan.key}/tasks`)).json(),
      );
      const claims = Object.fromEntries(
        page.items.map((item) => [item.title, item.claim?.sessionId ?? null]),
      );
      expect(claims).toEqual({ held: live.id, expired: null, stale: null, ended: null });
      expect(page.items[0]).toMatchObject({
        planKey: plan.key,
        status: "blocked",
        blockedReason: "Waiting.",
      });
      const blocked = taskPageSchema.parse(
        await (
          await call(keyA.secret, `/projects/${projectA}/plans/${plan.key}/tasks?status=blocked`)
        ).json(),
      );
      expect(blocked.items.map((item) => item.id)).toEqual([held.id]);
    });
  });
});
