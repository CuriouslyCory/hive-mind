import { decodeFeedCursor } from "@hivemind/contract";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DASHBOARD_PAGE_SIZE,
  loadPlanDetail,
  loadProjectList,
  loadProjectOverview,
  loadSessionDetail,
} from "../src/server/dashboard/queries";
import { type ApiHarness, createApiHarness, type SignedInUser } from "./support/api";

// The dashboard's page reads (issue #11, step 5) against a real database,
// with data written through the real `/api/v1` handler: membership
// authorization inside the snapshot, one not-found answer for absent,
// foreign and inaccessible records, M2's progress and claim semantics,
// Project-key attribution and bounded, keyset-paged lists.

describeDb("dashboard queries", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let member: SignedInUser;
  let outsider: SignedInUser;
  let projectA: string;
  let projectB: string;
  let projectC: string;
  let keyA: { id: string; secret: string };
  let planA: { id: string; key: string };
  let emptyPlan: { id: string; key: string };
  let planB: { id: string; key: string };
  let tasksA: { id: string }[];
  let userSession: string;
  let keySession: string;
  let endedSession: string;
  let sessionB: string;

  const uuid = () => crypto.randomUUID();
  const db = () => api.testDb.db;

  async function ok<T = Record<string, unknown>>(
    token: string,
    path: string,
    body?: unknown,
    method?: "POST" | "DELETE",
  ): Promise<T> {
    const response = await api.request(path, { token, body, method });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async function createPlan(token: string, projectId: string, body: Record<string, unknown> = {}) {
    const { plan } = await ok<{ plan: { id: string; key: string } }>(
      token,
      `/projects/${projectId}/plans`,
      { planId: uuid(), title: "Plan", status: "active", ...body },
    );
    return plan;
  }

  async function addTask(token: string, projectId: string, planKey: string, title: string) {
    const { task } = await ok<{ task: { id: string } }>(
      token,
      `/projects/${projectId}/plans/${planKey}/tasks`,
      { taskId: uuid(), title },
    );
    return task;
  }

  async function startSession(token: string, projectId: string, body: Record<string, unknown>) {
    const { session } = await ok<{ session: { id: string } }>(
      token,
      `/projects/${projectId}/sessions`,
      { sessionId: uuid(), agent: "test-agent", intent: "Testing", ...body },
    );
    return session.id;
  }

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    member = await api.signUp();
    outsider = await api.signUp();
    await api.addMember(owner.organizationId, member.id, "member");
    projectA = await api.createProject(owner);
    projectB = await api.createProject(owner);
    projectC = await api.createProject(outsider);
    keyA = await api.createKey(owner, projectA, { name: "ci" });

    planA = await createPlan(owner.token, projectA, {
      title: "Ship the dashboard",
      body: "# Goal\n\nRead **only**. <script>alert(1)</script>",
    });
    emptyPlan = await createPlan(owner.token, projectA, { title: "Nothing yet" });
    tasksA = [];
    for (const title of ["First", "Second", "Third"]) {
      tasksA.push(await addTask(owner.token, projectA, planA.key, title));
    }

    userSession = await startSession(owner.token, projectA, {
      agent: "claude",
      intent: "Build pages",
      hostname: "laptop",
      gitBranch: "feat/dashboard",
    });
    await ok(owner.token, `/projects/${projectA}/sessions/${userSession}/attach`, {
      planRef: planA.key,
      taskId: tasksA[0]?.id,
    });
    await ok(owner.token, `/projects/${projectA}/tasks/${tasksA[0]?.id}/claim`, {
      sessionId: userSession,
    });
    await ok(owner.token, `/projects/${projectA}/tasks/${tasksA[0]?.id}/start`, {
      sessionId: userSession,
    });
    await ok(owner.token, `/projects/${projectA}/sessions/${userSession}/scopes`, {
      pattern: "apps/web/**",
    });

    keySession = await startSession(keyA.secret, projectA, { agent: "ci-bot", intent: "Lint" });
    await ok(keyA.secret, `/projects/${projectA}/sessions/${keySession}/scopes`, {
      pattern: "apps/**",
    });
    await ok(owner.token, `/projects/${projectA}/plans/${planA.key}/log`, {
      eventId: uuid(),
      message: "Started with [a link](javascript:alert(1)).",
    });

    endedSession = await startSession(member.token, projectA, { intent: "Short run" });
    await ok(member.token, `/projects/${projectA}/sessions/${endedSession}/end`, {
      summary: "## Done\n\n- one thing",
    });

    planB = await createPlan(owner.token, projectB, { title: "Other Project" });
    sessionB = await startSession(owner.token, projectB, { intent: "Elsewhere" });
  });

  afterAll(async () => {
    await api?.drop();
  });

  describe("membership", () => {
    it("lists the Projects of the User's Organizations with their names", async () => {
      const { data } = await loadProjectList(db(), member.id, undefined);
      expect(data.items.map((item) => item.id)).toEqual([projectA, projectB]);
      expect(new Set(data.items.map((item) => item.organizationName)).size).toBe(1);
      expect(data.nextCursor).toBeNull();

      const outsiders = await loadProjectList(db(), outsider.id, undefined);
      expect(outsiders.data.items.map((item) => item.id)).toEqual([projectC]);
    });

    it("lets a Member read every page of an Organization Project", async () => {
      expect((await loadProjectOverview(db(), member.id, projectA)).data).not.toBeNull();
      expect((await loadPlanDetail(db(), member.id, projectA, planA.key)).data).not.toBeNull();
      expect((await loadSessionDetail(db(), member.id, projectA, keySession)).data).not.toBeNull();
    });

    it("answers null for a non-Member, for every page", async () => {
      expect((await loadProjectOverview(db(), outsider.id, projectA)).data).toBeNull();
      expect((await loadPlanDetail(db(), outsider.id, projectA, planA.key)).data).toBeNull();
      expect((await loadSessionDetail(db(), outsider.id, projectA, userSession)).data).toBeNull();
    });

    it("stops access as soon as the membership is removed", async () => {
      const leaver = await api.signUp();
      await api.addMember(owner.organizationId, leaver.id, "member");
      expect((await loadProjectOverview(db(), leaver.id, projectA)).data).not.toBeNull();
      await api.removeMember(owner.organizationId, leaver.id);
      expect((await loadProjectOverview(db(), leaver.id, projectA)).data).toBeNull();
      const list = await loadProjectList(db(), leaver.id, undefined);
      expect(list.data.items.map((item) => item.id)).not.toContain(projectA);
    });

    it("ignores a forged active Organization on the login session", async () => {
      await api.testDb.pool.query(
        "update session set active_organization_id = $1 where user_id = $2",
        [owner.organizationId, outsider.id],
      );
      expect((await loadProjectOverview(db(), outsider.id, projectA)).data).toBeNull();
      const list = await loadProjectList(db(), outsider.id, undefined);
      expect(list.data.items.map((item) => item.id)).toEqual([projectC]);
    });
  });

  describe("not found", () => {
    it("answers a child of another Project exactly like an absent one", async () => {
      const foreignPlan = await loadPlanDetail(db(), owner.id, projectA, planB.id);
      const absentPlan = await loadPlanDetail(db(), owner.id, projectA, uuid());
      const absentKey = await loadPlanDetail(db(), owner.id, projectA, "PLAN-999");
      expect(foreignPlan.data).toBeNull();
      expect(absentPlan.data).toEqual(foreignPlan.data);
      expect(absentKey.data).toEqual(foreignPlan.data);

      const foreignSession = await loadSessionDetail(db(), owner.id, projectA, sessionB);
      const absentSession = await loadSessionDetail(db(), owner.id, projectA, uuid());
      expect(foreignSession.data).toBeNull();
      expect(absentSession.data).toEqual(foreignSession.data);
    });

    it("answers malformed ids with the same null, without a database error", async () => {
      for (const ref of ["not-a-plan", "PLAN-0", "PLAN-99999999999", "", "PLAN-1'; --"]) {
        expect((await loadPlanDetail(db(), owner.id, projectA, ref)).data).toBeNull();
      }
      expect((await loadSessionDetail(db(), owner.id, projectA, "nope")).data).toBeNull();
      expect((await loadProjectOverview(db(), owner.id, "not-a-uuid")).data).toBeNull();
      expect((await loadProjectOverview(db(), owner.id, uuid())).data).toBeNull();
      // The Project's own pages still work afterwards (no aborted transaction).
      expect((await loadProjectOverview(db(), owner.id, projectA)).data).not.toBeNull();
    });
  });

  describe("overview", () => {
    it("shows active Plans with M2's progress, live and recent Sessions and overlaps", async () => {
      const { data, fence } = await loadProjectOverview(db(), owner.id, projectA);
      if (!data) throw new Error("expected the overview");

      expect(data.project).toMatchObject({ id: projectA, name: expect.any(String) });
      expect(data.activePlans.items.map((plan) => plan.key)).toEqual([emptyPlan.key, planA.key]);
      expect(data.activePlans.items[1]?.progress).toEqual({
        total: 3,
        todo: 2,
        inProgress: 1,
        blocked: 0,
        done: 0,
      });
      expect(data.activePlans.items[0]?.progress.total).toBe(0);

      const live = new Map(data.liveSessions.items.map((session) => [session.id, session]));
      expect([...live.keys()].sort()).toEqual([userSession, keySession].sort());
      expect(live.get(userSession)).toMatchObject({
        agent: "claude",
        machine: "laptop",
        gitBranch: "feat/dashboard",
        attachedPlanKey: planA.key,
        attachedTask: { id: tasksA[0]?.id, title: "First", position: 1 },
        claimCount: 1,
        owner: { kind: "user", userId: owner.id, name: owner.name },
      });
      expect(live.get(userSession)?.declaredScopes.map((scope) => scope.value)).toEqual([
        "apps/web/**",
      ]);
      expect(live.get(keySession)).toMatchObject({
        machine: null,
        gitBranch: null,
        attachedPlanKey: null,
        attachedTask: null,
        claimCount: 0,
      });

      expect(data.recentSessions.items.map((session) => session.id)).toEqual([endedSession]);
      expect(data.recentSessions.items[0]?.status).toBe("ended");

      expect(data.overlaps.items).toHaveLength(1);
      const [overlap] = data.overlaps.items;
      expect([overlap?.sessionId, overlap?.otherSessionId].sort()).toEqual(
        [userSession, keySession].sort(),
      );
      expect(overlap?.session?.agent).toBeDefined();
      expect(overlap?.otherSession?.agent).toBeDefined();

      // The live-update cursor is the snapshot's fence, bound to the Project.
      expect(fence.seq).toBe("0");
      expect(decodeFeedCursor(data.feedCursor, projectA)).toEqual({ ok: true, position: fence });
      expect(decodeFeedCursor(data.feedCursor, projectB)).toMatchObject({ ok: false });
      expect(data.asOf).toBeInstanceOf(Date);
    });
  });

  describe("Plan detail", () => {
    it("shows the body, ordered Tasks with usable claims, activity and attached Sessions", async () => {
      const { data } = await loadPlanDetail(db(), owner.id, projectA, planA.key);
      if (!data) throw new Error("expected the Plan");
      expect(data.plan).toMatchObject({
        key: planA.key,
        title: "Ship the dashboard",
        status: "active",
        createdBy: { kind: "user", userId: owner.id },
      });
      expect(data.plan.body).toContain("# Goal");

      expect(data.tasks.items.map((task) => [task.position, task.title, task.status])).toEqual([
        [1, "First", "in_progress"],
        [2, "Second", "todo"],
        [3, "Third", "todo"],
      ]);
      expect(data.tasks.items[0]?.claim).toMatchObject({
        sessionId: userSession,
        holder: { id: userSession, agent: "claude", status: "active" },
      });
      expect(data.tasks.items[1]?.claim).toBeNull();

      expect(data.sessions.items.map((session) => session.id)).toEqual([userSession]);
      const types = data.activity.items.map((event) => event.type);
      expect(types).toContain("plan.log_appended");
      expect(types).toContain("task.claimed");
      const log = data.activity.items.find((event) => event.type === "plan.log_appended");
      expect(log?.markdown).toBe("Started with [a link](javascript:alert(1)).");
      const claimed = data.activity.items.find((event) => event.type === "task.claimed");
      expect(claimed?.task).toMatchObject({ id: tasksA[0]?.id, title: "First" });
    });

    it("reads an empty body as null and a Plan without Tasks as empty", async () => {
      const { data } = await loadPlanDetail(db(), owner.id, projectA, emptyPlan.key);
      expect(data?.plan.body).toBeNull();
      expect(data?.tasks).toEqual({ items: [], nextCursor: null });
      expect(data?.sessions).toEqual({ items: [], nextCursor: null });
    });
  });

  describe("Session detail and Project-key attribution", () => {
    it("shows a key's Session as the key's, never as a User's", async () => {
      const { data } = await loadSessionDetail(db(), owner.id, projectA, keySession);
      if (!data) throw new Error("expected the Session");
      expect(data.session.owner).toMatchObject({
        kind: "project_key",
        keyId: keyA.id,
        name: "ci",
        revoked: false,
      });
      expect(JSON.stringify(data.session.owner)).not.toContain(owner.id);
      expect(data.session.summary).toBeNull();
      expect(data.scopes.items.map((scope) => [scope.source, scope.value])).toEqual([
        ["declared", "apps/**"],
      ]);
      const added = data.events.items.find((event) => event.type === "scope.added");
      expect(added?.actor).toMatchObject({ kind: "project_key", keyId: keyA.id });
      expect(added?.text).toBe("Declared Scope apps/**");
    });

    it("shows the end summary and status of an ended Session", async () => {
      const { data } = await loadSessionDetail(db(), owner.id, projectA, endedSession);
      expect(data?.session).toMatchObject({
        status: "ended",
        summary: "## Done\n\n- one thing",
        owner: { kind: "user", userId: member.id },
      });
      expect(data?.session.endedAt).toBeInstanceOf(Date);
      expect(data?.events.items.map((event) => event.type)).toEqual([
        "session.ended",
        "session.started",
      ]);
    });

    it("keeps showing a revoked key as a revoked key", async () => {
      const key = await api.createKey(owner, projectB, { name: "temp" });
      const session = await startSession(key.secret, projectB, { intent: "Then revoked" });
      await api.request(`/projects/${projectB}/keys/${key.id}`, {
        method: "DELETE",
        token: owner.token,
      });
      const { data } = await loadSessionDetail(db(), owner.id, projectB, session);
      expect(data?.session.owner).toEqual({
        kind: "project_key",
        keyId: key.id,
        name: null,
        start: null,
        revoked: true,
      });
    });
  });

  describe("paging", () => {
    it("pages Projects with a cursor and restarts on a bad one", async () => {
      const user = await api.signUp();
      const ids: string[] = [];
      for (let i = 0; i <= DASHBOARD_PAGE_SIZE; i++) ids.push(await api.createProject(user));
      const first = await loadProjectList(db(), user.id, undefined);
      expect(first.data.items).toHaveLength(DASHBOARD_PAGE_SIZE);
      expect(first.data.nextCursor).not.toBeNull();
      const second = await loadProjectList(db(), user.id, first.data.nextCursor ?? undefined);
      expect([...first.data.items, ...second.data.items].map((item) => item.id)).toEqual(ids);
      expect(second.data.nextCursor).toBeNull();

      const bad = await loadProjectList(db(), user.id, "garbage");
      expect(bad.data.items.map((item) => item.id)).toEqual(ids.slice(0, DASHBOARD_PAGE_SIZE));
    });

    it("pages Tasks and active Plans, and never continues another list's cursor", async () => {
      const plan = await createPlan(owner.token, projectB, { title: "Many Tasks" });
      const ids: string[] = [];
      for (let i = 0; i <= DASHBOARD_PAGE_SIZE; i++) {
        ids.push((await addTask(owner.token, projectB, plan.key, `Task ${i}`)).id);
      }
      const first = await loadPlanDetail(db(), owner.id, projectB, plan.key);
      const cursor = first.data?.tasks.nextCursor ?? undefined;
      expect(first.data?.tasks.items).toHaveLength(DASHBOARD_PAGE_SIZE);
      expect(cursor).toBeDefined();
      const second = await loadPlanDetail(db(), owner.id, projectB, plan.key, { tasks: cursor });
      expect(
        [...(first.data?.tasks.items ?? []), ...(second.data?.tasks.items ?? [])].map(
          (task) => task.id,
        ),
      ).toEqual(ids);
      expect(second.data?.tasks.nextCursor).toBeNull();

      // The Task cursor of one Plan restarts another Plan's list.
      const other = await loadPlanDetail(db(), owner.id, projectA, planA.key, { tasks: cursor });
      expect(other.data?.tasks.items[0]?.position).toBe(1);

      for (let i = 0; i < DASHBOARD_PAGE_SIZE; i++) {
        await createPlan(owner.token, projectB, { title: `Active ${i}` });
      }
      const plans = await loadProjectOverview(db(), owner.id, projectB);
      expect(plans.data?.activePlans.items).toHaveLength(DASHBOARD_PAGE_SIZE);
      const next = await loadProjectOverview(db(), owner.id, projectB, {
        plans: plans.data?.activePlans.nextCursor ?? undefined,
      });
      const keys = [
        ...(plans.data?.activePlans.items ?? []),
        ...(next.data?.activePlans.items ?? []),
      ].map((item) => item.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toHaveLength(DASHBOARD_PAGE_SIZE + 2);
    });
  });
});
