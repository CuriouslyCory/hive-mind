import { sweepCoordination } from "@hivemind/db";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { likePattern, loadHomeDashboard } from "../src/server/dashboard/home";
import { DEFAULT_HOME_PARAMS } from "../src/server/dashboard/home-params";
import {
  HOME_TABLE_ROWS,
  type HomeDashboard,
  type HomeParams,
} from "../src/server/dashboard/home-types";
import { type ApiHarness, createApiHarness, type SignedInUser } from "./support/api";

// The home page's read (`loadHomeDashboard`) against a real database, with
// data written through the real `/api/v1` handler and aged in SQL where a
// record has to look old: membership scoping, the selected Project, the
// filter text (wildcards included), Session and Plan tabs, row limits,
// every kind of attention item and Project-key attribution.

describeDb("home dashboard", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let member: SignedInUser;
  let outsider: SignedInUser;
  let projectA: string;
  let projectB: string;
  let projectC: string;
  let keyA: { id: string; secret: string };
  let planA: { id: string; key: string };
  let keyPlan: { id: string; key: string };
  let idlePlan: { id: string; key: string };
  let pausedPlan: { id: string; key: string };
  let tasks: { id: string }[];
  let userSession: string;
  let keySession: string;
  let endedSession: string;
  let sessionB: string;

  const uuid = () => crypto.randomUUID();
  const db = () => api.testDb.db;
  const sql = (text: string, values: unknown[] = []) => api.testDb.pool.query(text, values);

  async function ok<T = Record<string, unknown>>(
    token: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await api.request(path, { token, body });
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

  async function setPlanStatus(projectId: string, planKey: string, status: string) {
    await ok(owner.token, `/projects/${projectId}/plans/${planKey}/status`, { status });
  }

  async function startSession(token: string, projectId: string, body: Record<string, unknown>) {
    const { session } = await ok<{ session: { id: string } }>(
      token,
      `/projects/${projectId}/sessions`,
      { sessionId: uuid(), agent: "test-agent", intent: "Testing", ...body },
    );
    return session.id;
  }

  async function claim(taskId: string) {
    await ok(owner.token, `/projects/${projectA}/tasks/${taskId}/claim`, {
      sessionId: userSession,
    });
  }

  function load(userId: string, params: Partial<HomeParams> = {}): Promise<HomeDashboard> {
    return loadHomeDashboard(
      db(),
      { id: userId, name: "Viewer" },
      { ...DEFAULT_HOME_PARAMS, ...params },
    );
  }

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    member = await api.signUp();
    outsider = await api.signUp();
    await sql(`update "user" set name = $2 where id = $1`, [owner.id, "Ada Owner"]);
    await sql(`update "user" set name = $2 where id = $1`, [member.id, "Bea Member"]);
    await api.addMember(owner.organizationId, member.id, "member");
    projectA = await api.createProject(owner);
    projectB = await api.createProject(owner);
    projectC = await api.createProject(outsider);
    await sql("update project set name = $2 where id = $1", [projectA, "Alpha hive"]);
    await sql("update project set name = $2 where id = $1", [projectB, "Beta hive"]);
    await sql("update project set name = $2 where id = $1", [projectC, "Gamma secret"]);
    keyA = await api.createKey(owner, projectA, { name: "ci-key" });

    // Project A: PLAN-1 to PLAN-8.
    planA = await createPlan(owner.token, projectA, { title: "Ship the dashboard" });
    tasks = [];
    for (const title of ["Wire API", "Lease task", "Expired task", "Swept task"]) {
      tasks.push(await addTask(owner.token, projectA, planA.key, title));
    }
    keyPlan = await createPlan(keyA.secret, projectA, { title: "Key plan" });
    await createPlan(owner.token, projectA, { title: "Ship 100% done", status: "draft" });
    await createPlan(owner.token, projectA, { title: "Ship 100 done", status: "draft" });
    await createPlan(owner.token, projectA, { title: "rename_me", status: "draft" });
    pausedPlan = await createPlan(owner.token, projectA, { title: "On hold" });
    await addTask(owner.token, projectA, pausedPlan.key, "Waits");
    await setPlanStatus(projectA, pausedPlan.key, "paused");
    const donePlan = await createPlan(owner.token, projectA, { title: "Finished" });
    await setPlanStatus(projectA, donePlan.key, "done");
    idlePlan = await createPlan(owner.token, projectA, { title: "Nobody home" });
    await addTask(owner.token, projectA, idlePlan.key, "Untouched");

    userSession = await startSession(owner.token, projectA, {
      agent: "claude",
      intent: "Build pages",
      hostname: "laptop",
      gitBranch: "feat/home",
    });
    await ok(owner.token, `/projects/${projectA}/sessions/${userSession}/attach`, {
      planRef: planA.key,
    });
    await ok(owner.token, `/projects/${projectA}/sessions/${userSession}/scopes`, {
      pattern: "apps/web/**",
    });
    keySession = await startSession(keyA.secret, projectA, { agent: "ci-bot", intent: "Lint" });
    await ok(keyA.secret, `/projects/${projectA}/sessions/${keySession}/scopes`, {
      pattern: "apps/**",
    });
    endedSession = await startSession(member.token, projectA, { intent: "Short run" });
    await ok(member.token, `/projects/${projectA}/sessions/${endedSession}/end`, {
      summary: "Done",
    });
    for (let i = 0; i < 4; i++) {
      await startSession(owner.token, projectA, { agent: "codex", intent: `Extra ${i}` });
    }

    const [wire, lease, expired, swept] = tasks.map((task) => task.id);
    // Blocked, keeping its claim.
    await claim(wire ?? "");
    await ok(owner.token, `/projects/${projectA}/tasks/${wire}/block`, {
      sessionId: userSession,
      reason: "Waiting on API keys",
    });
    // A lease the sweep reconciles: a `task.released` with `lease_expired`.
    await claim(swept ?? "");
    await sql(
      "update task set lease_expires_at = clock_timestamp() - interval '5 minutes' where id = $1",
      [swept],
    );
    await sweepCoordination(db(), {
      projectBatch: 10,
      sessionBatch: 100,
      deadline: new Date(Date.now() + 60_000),
    });
    // An expired lease nothing has reconciled yet.
    await claim(expired ?? "");
    await sql(
      "update task set lease_expires_at = clock_timestamp() - interval '1 minute' where id = $1",
      [expired],
    );
    // A lease ending within LEASE_ENDING_SECONDS.
    await claim(lease ?? "");
    await sql(
      "update task set lease_expires_at = clock_timestamp() + interval '60 seconds' where id = $1",
      [lease],
    );
    // An active Plan with an open Task, unclaimed for two days, and one
    // edited as long ago whose Task was claimed (and released) just now.
    const recent = await createPlan(owner.token, projectA, { title: "Recently claimed" });
    const recentTask = await addTask(owner.token, projectA, recent.key, "Picked up");
    await claim(recentTask.id);
    await ok(owner.token, `/projects/${projectA}/tasks/${recentTask.id}/release`, {
      sessionId: userSession,
    });
    await sql(
      "update plan set updated_at = clock_timestamp() - interval '2 days' where id = any($1)",
      [[idlePlan.id, recent.id]],
    );

    await createPlan(owner.token, projectB, { title: "Other Project plan" });
    sessionB = await startSession(owner.token, projectB, { intent: "Elsewhere" });

    await createPlan(outsider.token, projectC, { title: "Secret plan" });
    await startSession(outsider.token, projectC, { intent: "Secret work" });
  });

  afterAll(async () => {
    await api?.drop();
  });

  describe("membership and scope", () => {
    it("reads only the Projects of the User's Organizations", async () => {
      const home = await load(member.id, { view: "plans" });
      expect(home.projects.items.map((item) => item.id)).toEqual([projectA, projectB]);
      expect(home.projects.total).toBe(2);
      expect(home.projects.items[0]).toMatchObject({ name: "Alpha hive", buzzingCount: 6 });
      expect(home.projects.buzzingTotal).toBe(7);
      const projects = new Set([
        ...home.plans.rows.map((row) => row.projectId),
        ...home.sessions.rows.map((row) => row.projectId),
      ]);
      expect(projects).toEqual(new Set([projectA, projectB]));
      expect(home.plans.total).toBe(10);
      expect(home.selected).toBeNull();

      const outside = await load(outsider.id, { projectId: projectA });
      expect(outside.params.projectId).toBeNull();
      expect(outside.selected).toBeNull();
      expect(outside.projects.items.map((item) => item.id)).toEqual([projectC]);
      expect(outside.plans.rows.map((row) => row.title)).toEqual(["Secret plan"]);
      expect(outside.events.every((item) => item.projectId === projectC)).toBe(true);
      expect(outside.attention.total).toBe(0);
    });

    it("narrows every section to the selected Project but keeps the rail", async () => {
      const home = await load(owner.id, { projectId: projectB });
      expect(home.params.projectId).toBe(projectB);
      expect(home.selected).toMatchObject({ id: projectB, name: "Beta hive", buzzingCount: 1 });
      expect(home.projects.items).toHaveLength(2);
      expect(home.sessions.rows.map((row) => row.id)).toEqual([sessionB]);
      expect(home.plans.rows.map((row) => row.title)).toEqual(["Other Project plan"]);
      expect(home.events.every((item) => item.projectId === projectB)).toBe(true);
      expect(home.attention).toEqual({ items: [], total: 0 });
      expect(home.counts).toMatchObject({ activePlans: 1, buzzing: 1, overlaps: 0 });
    });

    it("gives a User with no Projects an empty page", async () => {
      const loner = await api.signUp();
      const home = await load(loner.id, { sessionTab: "overlap" });
      expect(home.projects).toEqual({ items: [], total: 0, buzzingTotal: 0 });
      expect(home.sessions.tab).toBe("active");
      expect(home.plans.rows).toEqual([]);
    });
  });

  describe("filter text", () => {
    it("escapes LIKE wildcards", async () => {
      expect(likePattern("100%_\\")).toBe("%100\\%\\_\\\\%");
      const percent = await load(owner.id, { view: "plans", q: "100%" });
      expect(percent.plans.rows.map((row) => row.title)).toEqual(["Ship 100% done"]);
      const underscore = await load(owner.id, { view: "plans", q: "_" });
      expect(underscore.plans.rows.map((row) => row.title)).toEqual(["rename_me"]);
    });

    it("matches Sessions on owner, key, Plan key, branch and Project", async () => {
      const ids = async (q: string) =>
        (await load(owner.id, { view: "sessions", sessionTab: "all", q })).sessions.rows.map(
          (row) => row.id,
        );
      expect(await ids("bea member")).toEqual([endedSession]);
      expect(await ids("CI-KEY")).toEqual([keySession]);
      expect(await ids(planA.key)).toEqual([userSession]);
      expect(await ids("feat/home")).toEqual([userSession]);
      expect(await ids("beta")).toEqual([sessionB]);
    });

    it("matches Plans on key, creator, status and Project, and filters the counts", async () => {
      const titles = async (q: string) =>
        (await load(owner.id, { view: "plans", q })).plans.rows.map((row) => row.title);
      expect(await titles("ci-key")).toEqual(["Key plan"]);
      expect(await titles("paused")).toEqual(["On hold"]);
      expect(await titles("beta hive")).toEqual(["Other Project plan"]);
      expect(await titles(idlePlan.key)).toContain("Nobody home");

      const home = await load(owner.id, { projectId: projectA, q: planA.key });
      expect(home.plans.total).toBe(1);
      expect(home.counts).toMatchObject({ activePlans: 1, openTasks: 4, blockedTasks: 1 });
      expect(home.attention.items.map((item) => item.planKey)).toEqual(Array(4).fill(planA.key));
    });

    it("filters Events on agent, newest first", async () => {
      const home = await load(owner.id, { q: "ci-bot" });
      expect(home.events.length).toBeGreaterThan(0);
      for (const item of home.events) {
        expect(item.actorAgent === "ci-bot" || item.text.includes("ci-bot")).toBe(true);
      }
      const all = await load(owner.id);
      expect(all.events).toHaveLength(7);
      const seqs = all.events.map((item) => BigInt(item.seq));
      expect([...seqs].sort((a, b) => (a < b ? 1 : -1))).toEqual(seqs);
    });
  });

  describe("tables", () => {
    it("counts Session tabs and falls back from an empty overlap tab", async () => {
      const home = await load(owner.id, { projectId: projectA, sessionTab: "overlap" });
      expect(home.sessions.counts).toEqual({ active: 6, ended: 1, overlap: 2, all: 7 });
      expect(home.sessions.tab).toBe("overlap");
      expect(new Set(home.sessions.rows.map((row) => row.id))).toEqual(
        new Set([userSession, keySession]),
      );
      expect(home.sessions.rows.every((row) => row.overlapping)).toBe(true);
      expect(home.counts.overlaps).toBe(1);
      expect(home.overlaps[0]).toMatchObject({
        projectId: projectA,
        projectName: "Alpha hive",
        kind: "overlap",
      });
      expect(home.overlaps[0]?.path).toMatch(/^apps\/web/);

      const fallback = await load(owner.id, { projectId: projectB, sessionTab: "overlap" });
      expect(fallback.sessions.tab).toBe("active");
      expect(fallback.params.sessionTab).toBe("active");
    });

    it("orders live Sessions before ended ones and maps their state", async () => {
      const home = await load(owner.id, {
        projectId: projectA,
        view: "sessions",
        sessionTab: "all",
      });
      expect(home.sessions.rows).toHaveLength(7);
      expect(home.sessions.rows.at(-1)).toMatchObject({
        id: endedSession,
        state: "ended",
        status: "ended",
      });
      const user = home.sessions.rows.find((row) => row.id === userSession);
      expect(user).toMatchObject({
        state: "buzzing",
        focusPlanKey: planA.key,
        machine: "laptop",
        gitBranch: "feat/home",
        owner: { kind: "user", userId: owner.id, name: "Ada Owner" },
      });
    });

    it("counts Plan tabs and limits rows per view", async () => {
      const home = await load(owner.id, { projectId: projectA });
      expect(home.plans.counts).toEqual({ all: 9, active: 4, paused: 1, done: 1 });
      expect(home.plans.rows).toHaveLength(HOME_TABLE_ROWS);
      expect(home.sessions.rows).toHaveLength(HOME_TABLE_ROWS);
      const dates = home.plans.rows.map((row) => row.updatedAt.getTime());
      expect([...dates].sort((a, b) => b - a)).toEqual(dates);

      const list = await load(owner.id, { projectId: projectA, view: "plans" });
      expect(list.plans.rows).toHaveLength(9);

      const paused = await load(owner.id, { projectId: projectA, planTab: "paused" });
      expect(paused.plans.matching).toBe(1);
      expect(paused.plans.rows.map((row) => row.key)).toEqual([pausedPlan.key]);

      const progress = list.plans.rows.find((row) => row.key === planA.key)?.progress;
      expect(progress).toEqual({ total: 4, todo: 3, inProgress: 0, blocked: 1, done: 0 });
    });

    it("attributes a Project key's records to the key", async () => {
      const home = await load(owner.id, { view: "sessions", sessionTab: "all", q: "lint" });
      expect(home.sessions.rows[0]?.owner).toEqual({
        kind: "project_key",
        keyId: keyA.id,
        name: "ci-key",
        revoked: false,
      });
      const plans = await load(owner.id, { view: "plans", q: "key plan" });
      expect(plans.plans.rows[0]?.createdBy).toMatchObject({ kind: "project_key", name: "ci-key" });
      expect(plans.plans.rows[0]?.key).toBe(keyPlan.key);
    });
  });

  describe("attention", () => {
    it("lists each kind, most urgent first", async () => {
      const home = await load(member.id);
      const [wire, lease, expired, swept] = tasks;
      expect(wire && lease && expired && swept).toBeTruthy();
      expect(home.attention.total).toBe(6);
      expect(home.attention.items.map((item) => item.kind)).toEqual([
        "lease_ending",
        "claim_lapsed",
        "claim_lapsed",
        "blocked_task",
        "unclaimed_plan",
        "paused_plan",
      ]);
      const [ending, lapsedA, lapsedB, blocked, unclaimed, paused] = home.attention.items;
      expect(ending).toMatchObject({
        projectId: projectA,
        projectName: "Alpha hive",
        planKey: planA.key,
        taskTitle: "Lease task",
        holder: { id: userSession, agent: "claude", status: "active" },
      });
      // The unreconciled lease expired a minute ago, the swept one five.
      expect(lapsedA).toMatchObject({ taskTitle: "Expired task", holder: { id: userSession } });
      expect(lapsedB).toMatchObject({ taskTitle: "Swept task", holder: { id: userSession } });
      expect(blocked).toMatchObject({
        taskTitle: "Wire API",
        reason: "Waiting on API keys",
        blockedAt: expect.any(Date),
      });
      expect(unclaimed).toMatchObject({
        planKey: idlePlan.key,
        planTitle: "Nobody home",
        openTaskCount: 1,
      });
      expect(paused).toMatchObject({
        planKey: pausedPlan.key,
        openTaskCount: 1,
        pausedAt: expect.any(Date),
      });
      expect(home.counts.blockedTasks).toBe(1);
    });

    it("filters attention on reason", async () => {
      const home = await load(owner.id, { q: "api keys" });
      expect(home.attention.items.map((item) => item.kind)).toEqual(["blocked_task"]);
      expect(home.attention.total).toBe(1);
    });

    it("leaves home-only sections empty on the list views", async () => {
      for (const view of ["plans", "sessions"] as const) {
        const home = await load(owner.id, { view });
        expect(home.attention).toEqual({ items: [], total: 0 });
        expect(home.events).toEqual([]);
        expect(home.decisions).toEqual([]);
        expect(home.analytics.agents).toEqual([]);
        expect(home.analytics.throughput.buckets).toEqual([]);
      }
    });
  });
});
