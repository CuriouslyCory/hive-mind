import {
  type AdrStatus,
  adrContentSha256,
  adrFilePath,
  decodeFeedCursor,
  parseAdrContent,
  serializeAdrFrontmatter,
} from "@hivemind/contract";
import {
  type AdrContentInput,
  MAX_ADR_CHAIN_DEPTH,
  type Principal,
  reserveAdr,
  storeAdrContents,
  syncAdrs,
} from "@hivemind/db";
import { describeDb } from "@hivemind/db/testing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdrDetailView } from "../src/app/(app)/_components/adr-detail";
import { AdrListView } from "../src/app/(app)/_components/adr-list";
import { AttributionText } from "../src/app/(app)/_components/format";
import { EventList } from "../src/app/(app)/_components/lists";
import {
  type AdrDetail,
  DASHBOARD_PAGE_SIZE,
  type EventView,
  loadAdrDetail,
  loadAdrList,
  loadPlanDetail,
  loadProjectList,
  loadProjectOverview,
  loadSessionDetail,
  RECENT_ADR_COUNT,
} from "../src/server/dashboard/queries";
import { type ApiHarness, createApiHarness, type SignedInUser } from "./support/api";
import { canary, futureShapes, insertFutureEvent } from "./support/future-events";

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
      // Members see the key's name and id prefix, never the start of its secret.
      expect(data.session.owner).not.toHaveProperty("start");
      const shown = renderToStaticMarkup(
        createElement(AttributionText, { value: data.session.owner }),
      );
      expect(shown).toContain(`Project key ci (id ${keyA.id.slice(0, 8)})`);
      expect(shown).not.toContain(keyA.secret.slice(0, 6));
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
  describe("Events a newer deployment wrote", () => {
    // Rows a newer writer stored, read after a rollback (issue #15, ADR-0015):
    // the dashboard shows them as unavailable, with their attribution and
    // links, and never their stored type or payload.
    const secret = canary();
    const shapes = futureShapes(secret);
    let project: string;
    let plan: { id: string; key: string };
    let task: { id: string };
    let session: string;
    /** Stored future Events by shape name, oldest first. */
    let future: Map<string, { id: string; seq: string }>;

    async function appendLog(message: string) {
      await ok(owner.token, `/projects/${project}/plans/${plan.key}/log`, {
        eventId: uuid(),
        message,
        sessionId: session,
      });
    }

    beforeAll(async () => {
      project = await api.createProject(owner);
      plan = await createPlan(owner.token, project, { title: "Rollback" });
      task = await addTask(owner.token, project, plan.key, "Read old Events");
      session = await startSession(owner.token, project, { intent: "Read after rollback" });
      await appendLog("Before the newer writer");
      future = new Map();
      for (const [name, shape] of Object.entries(shapes)) {
        const row = await insertFutureEvent(db(), {
          projectId: project,
          ...shape,
          actorKind: "user",
          actorUserId: owner.id,
          actorSessionId: session,
          planId: plan.id,
          taskId: task.id,
          sessionId: session,
        });
        future.set(name, { id: row.id, seq: row.seq });
      }
      await appendLog("After the newer writer");
    });

    /** Checks every future row in `events` and that nothing stored leaks. */
    function expectWithheld(events: readonly EventView[]) {
      for (const [name, stored] of future) {
        const item = events.find((event) => event.id === stored.id);
        expect(item, name).toEqual({
          id: stored.id,
          seq: stored.seq,
          type: "event.unavailable",
          actor: { kind: "user", userId: owner.id, name: owner.name },
          actorSessionId: session,
          planKey: plan.key,
          task: { id: task.id, title: "Read old Events", position: 1, planKey: plan.key },
          sessionId: session,
          effectiveAt: expect.any(Date),
          text: "Event details unavailable",
          markdown: null,
        });
      }
      // A familiar `message` under an unsupported version is not a log entry.
      const unsupported = future.get("unsupported version");
      const entry = events.find((event) => event.id === unsupported?.id);
      expect(entry?.text).not.toBe("Added a log entry");
      const known = events.filter((event) => event.type === "plan.log_appended");
      expect(known.map((event) => [event.text, event.markdown])).toEqual([
        ["Added a log entry", "After the newer writer"],
        ["Added a log entry", "Before the newer writer"],
      ]);
      const loaded = JSON.stringify(events);
      expect(loaded).not.toContain(secret);
      expect(loaded).not.toContain(shapes["unknown type"].type);
      expect(loaded).not.toContain('"task.released"');
      expect(loaded).not.toContain('"task.done"');
    }

    function rendered(events: EventView[], asOf: Date): string {
      return renderToStaticMarkup(
        createElement(EventList, { projectId: project, events, asOf, label: "Activity" }),
      );
    }

    function expectRenderedWithheld(html: string) {
      expect(html).not.toContain(secret);
      expect(html).not.toContain(shapes["unknown type"].type);
      expect(html.match(/data-event-type="event.unavailable"/g)).toHaveLength(future.size);
      expect(html.match(/Event details unavailable/g)).toHaveLength(future.size);
      expect(html).toContain("After the newer writer");
      expect(html).toContain("Before the newer writer");
    }

    it("shows them as unavailable in the Plan's activity, on load and on refresh", async () => {
      const first = await loadPlanDetail(db(), owner.id, project, plan.key);
      if (!first.data) throw new Error("expected the Plan");
      const unavailable = Array(future.size).fill("event.unavailable");
      expect(first.data.activity.items.map((event) => event.type)).toEqual([
        "plan.log_appended",
        ...unavailable,
        "plan.log_appended",
        "task.added",
        "plan.created",
      ]);
      expect(first.data.activity.items.at(-2)?.text).toBe('Added Task 1 "Read old Events"');
      expect(first.data.activity.items.at(-1)?.text).toBe(`Created Plan ${plan.key} "Rollback"`);
      expectWithheld(first.data.activity.items);
      for (const data of [JSON.stringify(first.data), JSON.stringify(first)]) {
        expect(data).not.toContain(secret);
        expect(data).not.toContain(shapes["unknown type"].type);
      }
      expectRenderedWithheld(rendered(first.data.activity.items, first.data.asOf));

      // A refresh reads the same stored rows again and still withholds them.
      const again = await loadPlanDetail(db(), owner.id, project, plan.key);
      if (!again.data) throw new Error("expected the Plan");
      expect(again.data.activity).toEqual(first.data.activity);
      expectWithheld(again.data.activity.items);
      expectRenderedWithheld(rendered(again.data.activity.items, again.data.asOf));
    });

    it("shows them as unavailable in the Session's timeline, on load and on refresh", async () => {
      const first = await loadSessionDetail(db(), owner.id, project, session);
      if (!first.data) throw new Error("expected the Session");
      expect(first.data.events.items.map((event) => event.type)).toEqual([
        "plan.log_appended",
        ...Array(future.size).fill("event.unavailable"),
        "plan.log_appended",
        "session.started",
      ]);
      expectWithheld(first.data.events.items);
      for (const data of [JSON.stringify(first.data), JSON.stringify(first)]) {
        expect(data).not.toContain(secret);
        expect(data).not.toContain(shapes["unknown type"].type);
      }
      expectRenderedWithheld(rendered(first.data.events.items, first.data.asOf));

      const again = await loadSessionDetail(db(), owner.id, project, session);
      if (!again.data) throw new Error("expected the Session");
      expect(again.data.events).toEqual(first.data.events);
      expectWithheld(again.data.events.items);
      expectRenderedWithheld(rendered(again.data.events.items, again.data.asOf));
    });

    it("keeps the Project overview readable", async () => {
      // The overview lists no Events; it must still load beside them.
      const { data } = await loadProjectOverview(db(), owner.id, project);
      expect(data?.activePlans.items.map((item) => item.key)).toEqual([plan.key]);
      expect(JSON.stringify(data)).not.toContain(secret);
    });
  });
  describe("ADRs", () => {
    // ADR data is written with @hivemind/db's functions, as the API does:
    // content parsed by the contract's parser, stored, then synced.
    const C1 = "c1".repeat(20);
    const C2 = "c2".repeat(20);
    const hostileTitle = "<img src=x onerror=alert(1)>";
    let adrProject: string;
    let keyProject: string;
    let chainProject: string;
    let key: { id: string; secret: string };

    interface AdrFile {
      number: number;
      slug: string;
      title: string;
      status: AdrStatus;
      supersedes?: number[];
      body?: string;
    }

    function contents(file: AdrFile): string {
      const frontmatter = serializeAdrFrontmatter({
        status: file.status,
        date: "2026-10-01",
        supersedes: file.supersedes ?? [],
      });
      return `${frontmatter}\n# ${file.title}\n\n## Context\n\nWhy.\n\n## Decision\n\n${
        file.body ?? "What."
      }\n\n## Consequences\n\nWhat follows.\n`;
    }

    async function sync(
      projectId: string,
      principal: Principal,
      files: AdrFile[],
      commitSha: string,
      baseCommitSha: string | null,
    ) {
      const items: AdrContentInput[] = [];
      for (const file of files) {
        const contentMd = contents(file);
        const parsed = parseAdrContent(contentMd);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
        const { title, status, date, supersedes, warnings } = parsed.adr;
        const sha256 = await adrContentSha256(contentMd);
        items.push({ sha256, contentMd, title, status, date, supersedes, warnings });
      }
      const stored = await storeAdrContents(db(), { projectId, principal, items });
      if (stored.status !== "ok") throw new Error(JSON.stringify(stored));
      const outcome = await syncAdrs(db(), {
        projectId,
        principal,
        commitSha,
        baseCommitSha,
        forced: false,
        entries: files.map((file, index) => ({
          path: adrFilePath(file.number, file.slug),
          sha256: items[index]?.sha256 ?? "",
          number: file.number,
          slug: file.slug,
        })),
      });
      if (outcome.status !== "ok") throw new Error(JSON.stringify(outcome));
    }

    async function reserve(projectId: string, principal: Principal, title: string, slug: string) {
      const outcome = await reserveAdr(db(), { projectId, principal, id: uuid(), title, slug });
      if (outcome.status !== "created") throw new Error(JSON.stringify(outcome));
      return outcome.adr.number;
    }

    async function detail(projectId: string, number: string): Promise<AdrDetail> {
      const { data } = await loadAdrDetail(db(), owner.id, projectId, number);
      if (!data) throw new Error(`expected ADR ${number}`);
      return data;
    }

    const HOSTILE_BODY = [
      "<script>alert(1)</script>",
      "",
      "[next](0004-missing-target.md) and [x](javascript:alert(1))",
      "",
      "---",
      "status: accepted",
      "---",
    ].join("\n");

    beforeAll(async () => {
      const ownerPrincipal: Principal = { kind: "user", userId: owner.id };
      adrProject = await api.createProject(owner);
      await sync(
        adrProject,
        ownerPrincipal,
        [
          { number: 1, slug: "use-postgres", title: "Use Postgres", status: "accepted" },
          { number: 2, slug: "old-cache", title: "Old cache", status: "superseded" },
          {
            number: 3,
            slug: "new-cache",
            title: "New cache",
            status: "accepted",
            supersedes: [2],
          },
          {
            number: 4,
            slug: "missing-target",
            title: "Missing target",
            status: "proposed",
            supersedes: [99],
          },
          {
            number: 5,
            slug: "hostile",
            title: hostileTitle,
            status: "accepted",
            supersedes: [6],
            body: HOSTILE_BODY,
          },
          { number: 6, slug: "cycle", title: "Cycle", status: "accepted", supersedes: [5] },
        ],
        C1,
        null,
      );
      await reserve(adrProject, ownerPrincipal, "Reserved title", "reserved-title");

      // Synced by a Project key, with a removed file and a reserved number
      // that a hand-numbered file took.
      keyProject = await api.createProject(owner);
      key = await api.createKey(owner, keyProject, { name: "adr-sync" });
      const keyPrincipal: Principal = { kind: "project_key", keyId: key.id };
      await sync(
        keyProject,
        ownerPrincipal,
        [
          { number: 1, slug: "first", title: "First", status: "accepted" },
          { number: 2, slug: "second", title: "Second", status: "accepted" },
        ],
        C1,
        null,
      );
      await reserve(keyProject, ownerPrincipal, "Planned title", "planned-title");
      await sync(
        keyProject,
        keyPrincipal,
        [
          { number: 1, slug: "first", title: "First", status: "accepted" },
          { number: 3, slug: "something-else", title: "Something else", status: "proposed" },
        ],
        C2,
        C1,
      );

      // 12 ADRs, each superseding the one before.
      chainProject = await api.createProject(owner);
      await sync(
        chainProject,
        ownerPrincipal,
        Array.from({ length: 12 }, (_, index) => ({
          number: index + 1,
          slug: `step-${index + 1}`,
          title: `Step ${index + 1}`,
          status: index === 11 ? "accepted" : "superseded",
          supersedes: index === 0 ? [] : [index],
        })),
        C1,
        null,
      );
    });

    it("lets Members read the ADR pages and answers null for a non-Member", async () => {
      for (const user of [owner, member]) {
        expect((await loadAdrList(db(), user.id, adrProject)).data).not.toBeNull();
        expect((await loadAdrDetail(db(), user.id, adrProject, "1")).data).not.toBeNull();
      }
      expect((await loadAdrList(db(), outsider.id, adrProject)).data).toBeNull();
      expect((await loadAdrDetail(db(), outsider.id, adrProject, "1")).data).toBeNull();

      const leaver = await api.signUp();
      await api.addMember(owner.organizationId, leaver.id, "member");
      expect((await loadAdrDetail(db(), leaver.id, adrProject, "1")).data).not.toBeNull();
      await api.removeMember(owner.organizationId, leaver.id);
      expect((await loadAdrList(db(), leaver.id, adrProject)).data).toBeNull();
      expect((await loadAdrDetail(db(), leaver.id, adrProject, "1")).data).toBeNull();
    });

    it("answers another Project's ADR and malformed numbers like an absent one", async () => {
      // keyProject has ADR 3 with this owner; projectA has no ADRs.
      const foreign = await loadAdrDetail(db(), owner.id, projectA, "3");
      const absent = await loadAdrDetail(db(), owner.id, adrProject, "42");
      expect(foreign.data).toBeNull();
      expect(absent.data).toEqual(foreign.data);
      for (const ref of ["0", "10000", "abc", "1'; --", "", "-1", "1.0", "ADR-00001"]) {
        expect((await loadAdrDetail(db(), owner.id, adrProject, ref)).data).toBeNull();
      }
      expect((await loadAdrList(db(), owner.id, "not-a-uuid")).data).toBeNull();
      // The ADR forms the CLI accepts name the same ADR.
      for (const ref of ["3", "0003", "ADR-0003"]) {
        expect((await detail(adrProject, ref)).adr.number).toBe(3);
      }
      // No aborted transaction: the Project's pages still load.
      expect((await loadProjectOverview(db(), owner.id, adrProject)).data).not.toBeNull();
    });

    it("lists published ADRs by number with status and state, and reservations apart", async () => {
      const { data, fence } = await loadAdrList(db(), owner.id, adrProject);
      if (!data) throw new Error("expected the ADR list");
      expect(data.status).toBeNull();
      expect(data.adrs.items.map((adr) => [adr.number, adr.title, adr.status, adr.state])).toEqual([
        [6, "Cycle", "accepted", "published"],
        [5, hostileTitle, "accepted", "published"],
        [4, "Missing target", "proposed", "published"],
        [3, "New cache", "accepted", "published"],
        [2, "Old cache", "superseded", "published"],
        [1, "Use Postgres", "accepted", "published"],
      ]);
      expect(data.adrs.nextCursor).toBeNull();
      expect(data.removed).toEqual({ items: [], nextCursor: null });
      expect(data.reservations.items).toEqual([
        {
          number: 7,
          title: "Reserved title",
          slug: "reserved-title",
          gitBranch: null,
          reservedBy: { kind: "user", userId: owner.id, name: owner.name },
          reservedAt: expect.any(Date),
        },
      ]);
      expect(fence.seq).toBe("0");
      expect(decodeFeedCursor(data.feedCursor, adrProject)).toEqual({ ok: true, position: fence });

      const superseded = await loadAdrList(db(), owner.id, adrProject, { status: "superseded" });
      expect(superseded.data?.status).toBe("superseded");
      expect(superseded.data?.adrs.items.map((adr) => adr.number)).toEqual([2]);
      // Reservations have no status; they stay listed apart under any filter.
      expect(superseded.data?.reservations.items.map((item) => item.number)).toEqual([7]);

      // A value that is not an ADR status shows every status.
      for (const status of ["bogus", "Superseded", "reserved", "published", ""]) {
        const list = await loadAdrList(db(), owner.id, adrProject, { status });
        expect(list.data?.status).toBeNull();
        expect(list.data?.adrs.items).toHaveLength(6);
      }
    });

    it("shows removed ADRs apart and a taken reservation on its ADR", async () => {
      const { data } = await loadAdrList(db(), owner.id, keyProject);
      expect(data?.adrs.items.map((adr) => [adr.number, adr.state])).toEqual([
        [3, "published"],
        [1, "published"],
      ]);
      expect(data?.removed.items.map((adr) => [adr.number, adr.title, adr.state])).toEqual([
        [2, "Second", "removed"],
      ]);
      expect(data?.reservations.items).toEqual([]);

      const removed = await detail(keyProject, "2");
      expect(removed.adr).toMatchObject({ state: "removed", status: "accepted", commitSha: C1 });
      expect(removed.adr.body).toContain("# Second");

      const taken = await detail(keyProject, "3");
      expect(taken.adr).toMatchObject({
        title: "Something else",
        slug: "something-else",
        reservationTaken: true,
        commitSha: C2,
        reservation: { title: "Planned title", slug: "planned-title" },
      });
      expect(taken.adr.reservation?.reservedBy).toMatchObject({ kind: "user", userId: owner.id });
    });

    it("shows a reserved number with its reservation and no text", async () => {
      const reserved = await detail(adrProject, "7");
      expect(reserved.adr).toMatchObject({
        number: 7,
        title: "Reserved title",
        status: null,
        state: "reserved",
        path: null,
        commitSha: null,
        body: null,
        reservationTaken: false,
      });
      expect(reserved.supersedes).toEqual([]);
      expect(reserved.supersededBy).toEqual([]);
    });

    it("follows supersedes links both ways, marking missing targets", async () => {
      const three = await detail(adrProject, "3");
      expect(three.supersedes).toEqual([
        {
          number: 2,
          depth: 1,
          found: true,
          title: "Old cache",
          status: "superseded",
          state: "published",
        },
      ]);
      expect(three.supersededBy).toEqual([]);

      const two = await detail(adrProject, "2");
      expect(two.supersedes).toEqual([]);
      expect(two.supersededBy.map((link) => [link.number, link.depth, link.found])).toEqual([
        [3, 1, true],
      ]);

      const four = await detail(adrProject, "4");
      expect(four.supersedes).toEqual([
        { number: 99, depth: 1, found: false, title: null, status: null, state: null },
      ]);
      const html = renderToStaticMarkup(createElement(AdrDetailView, { detail: four }));
      expect(html).toContain("Supersedes <span>ADR-0099 (not found)</span>.");
      expect(html).not.toContain("/adrs/99");

      // A cycle returns instead of looping.
      const five = await detail(adrProject, "5");
      expect(five.supersedes.map((link) => link.number)).toEqual([6]);
      expect(five.supersededBy.map((link) => link.number)).toEqual([6]);
      expect(five.chainTruncated).toBe(false);
    });

    it("bounds a long chain and says it continues", async () => {
      const last = await detail(chainProject, "12");
      expect(last.supersedes.map((link) => [link.number, link.depth])).toEqual(
        Array.from({ length: MAX_ADR_CHAIN_DEPTH }, (_, index) => [11 - index, index + 1]),
      );
      expect(last.chainTruncated).toBe(true);
      const first = await detail(chainProject, "1");
      expect(first.supersededBy).toHaveLength(MAX_ADR_CHAIN_DEPTH);
      expect(first.chainTruncated).toBe(true);
      const middle = await detail(chainProject, "6");
      expect(middle.supersedes.map((link) => link.number)).toEqual([5, 4, 3, 2, 1]);
      expect(middle.supersededBy.map((link) => link.number)).toEqual([7, 8, 9, 10, 11, 12]);
      expect(middle.chainTruncated).toBe(false);
      const html = renderToStaticMarkup(createElement(AdrDetailView, { detail: last }));
      expect(html).toContain("The chain continues past the ADRs shown.");
    });

    it("gives the body without its frontmatter, and renders the title as text", async () => {
      const five = await detail(adrProject, "5");
      expect(five.adr.body).not.toBeNull();
      expect(five.adr.body?.startsWith("---")).toBe(false);
      expect(five.adr.body).not.toContain("date: 2026-10-01");
      expect(five.adr.body).not.toContain("supersedes: [6]");
      expect(five.adr).toMatchObject({ date: "2026-10-01", path: "docs/adr/0005-hostile.md" });

      const html = renderToStaticMarkup(createElement(AdrDetailView, { detail: five }));
      expect(html).toContain('data-testid="adr-detail"');
      expect(html).toContain("ADR-0005: &lt;img src=x onerror=alert(1)&gt;");
      expect(html).not.toMatch(/<(?:script|img)/i);
      expect(html).not.toContain('href="0004-missing-target.md"');
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).toContain("<span>next</span>");
    });

    it("carries the last sync for the banner, by a User or a Project key", async () => {
      const { data } = await loadAdrList(db(), owner.id, adrProject);
      expect(data?.lastSync).toEqual({
        commitSha: C1,
        syncedAt: expect.any(Date),
        syncedBy: { kind: "user", userId: owner.id, name: owner.name },
      });
      expect((await detail(adrProject, "1")).lastSync).toEqual(data?.lastSync);

      const byKey = await loadAdrList(db(), owner.id, keyProject);
      expect(byKey.data?.lastSync).toEqual({
        commitSha: C2,
        syncedAt: expect.any(Date),
        syncedBy: { kind: "project_key", keyId: key.id, name: "adr-sync", revoked: false },
      });
      expect(JSON.stringify(byKey.data?.lastSync)).not.toContain(owner.id);

      const none = await loadAdrList(db(), owner.id, projectA);
      expect(none.data?.lastSync).toBeNull();
      expect(none.data?.adrs.items).toEqual([]);
      if (!none.data || !data) throw new Error("expected the ADR lists");
      const empty = renderToStaticMarkup(
        createElement(AdrListView, { list: none.data, path: "/x" as never, cursors: {} }),
      );
      expect(empty).toContain(
        "No ADRs synced yet. Run <code>hivemind adr sync</code> on the default branch.",
      );
      const synced = renderToStaticMarkup(
        createElement(AdrListView, { list: data, path: "/x" as never, cursors: {} }),
      );
      expect(synced).toContain(`at commit <code>${C1.slice(0, 7)}</code>`);
      expect(synced).toContain("The files in the repository are the source of truth.");
    });

    it("renders the list with the selectors the end-to-end test uses", async () => {
      const { data } = await loadAdrList(db(), owner.id, adrProject, { status: "accepted" });
      if (!data) throw new Error("expected the ADR list");
      const html = renderToStaticMarkup(
        createElement(AdrListView, { list: data, path: "/x" as never, cursors: {} }),
      );
      expect(html).toContain('data-testid="adr-list"');
      expect(html).toContain('data-testid="adr-sync-banner"');
      expect(html).toContain('data-testid="adr-reservations"');
      expect(html.match(/data-testid="adr-row"/g)).toHaveLength(4);
      expect(html).toContain(
        'data-testid="adr-row" data-adr-number="3" data-adr-status="accepted" data-adr-state="published"',
      );
      // Reservations are listed apart, never as ADR rows.
      expect(html).toContain('data-testid="adr-reservation" data-adr-number="7"');
      expect(html).toContain("Reserved title");
      // The filter: plain links, the current choice as text.
      expect(html).toContain('<a href="/x?status=superseded">Superseded</a>');
      expect(html).toContain('<a href="/x">All</a>');
      expect(html).toContain('<strong aria-current="page">Accepted</strong>');
      // A hostile title is text.
      expect(html).toContain("<td>&lt;img src=x onerror=alert(1)&gt;</td>");
      expect(html).not.toMatch(/<img/i);
    });

    it("lists the most recently synced ADRs on the overview, bounded", async () => {
      const { data } = await loadProjectOverview(db(), owner.id, adrProject);
      expect(data?.recentAdrs.map((adr) => adr.number)).toEqual([6, 5, 4, 3, 2]);
      expect(data?.recentAdrs).toHaveLength(RECENT_ADR_COUNT);
      expect(data?.recentAdrs.every((adr) => adr.state === "published")).toBe(true);
      const empty = await loadProjectOverview(db(), owner.id, projectA);
      expect(empty.data?.recentAdrs).toEqual([]);
    });
  });
});
