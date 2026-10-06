import { touchedPathsContentHash } from "@hivemind/contract";
import { agentSession, event, project, scopeCollectionBatch } from "@hivemind/db/schema";
import { describeDb } from "@hivemind/db/testing";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HomeAnalyticsInput, loadHomeAnalytics } from "../src/server/dashboard/home-analytics";
import type { HomeRange, HomeThroughput } from "../src/server/dashboard/home-types";
import { runDashboardSnapshot } from "../src/server/dashboard/snapshot";
import { type ApiHarness, createApiHarness, type SignedInUser } from "./support/api";

// The home page's analytics (./home-analytics.ts) against a real database.
// Data is written through the real `/api/v1` handler at the current time,
// then aged by rewriting `effective_at` and `created_at`, so each Event and
// touched-path batch lands at a known offset from the database clock.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describeDb("home analytics", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let outsider: SignedInUser;
  let projectA: string;
  let projectB: string;
  let projectC: string;
  /** The database clock when the data was written, in epoch ms. */
  let t0: number;
  const sessions: Record<string, string> = {};

  const uuid = () => crypto.randomUUID();
  const db = () => api.testDb.db;
  const ago = (ms: number) => new Date(t0 - ms);

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

  async function createPlan(token: string, projectId: string) {
    const { plan } = await ok<{ plan: { id: string; key: string } }>(
      token,
      `/projects/${projectId}/plans`,
      { planId: uuid(), title: "Plan", status: "active" },
    );
    return plan;
  }

  async function addTask(token: string, projectId: string, planKey: string) {
    const { task } = await ok<{ task: { id: string } }>(
      token,
      `/projects/${projectId}/plans/${planKey}/tasks`,
      { taskId: uuid(), title: "Task" },
    );
    return task.id;
  }

  async function startSession(
    token: string,
    projectId: string,
    agent: string,
    hostname?: string,
  ): Promise<string> {
    const { session } = await ok<{ session: { id: string } }>(
      token,
      `/projects/${projectId}/sessions`,
      { sessionId: uuid(), agent, intent: "Testing", ...(hostname ? { hostname } : {}) },
    );
    return session.id;
  }

  async function heartbeat(token: string, projectId: string, sessionId: string) {
    return ok<{ collectionId: string }>(
      token,
      `/projects/${projectId}/sessions/${sessionId}/heartbeat`,
      {},
    );
  }

  /** Claims and finishes a Task through `sessionId`; returns the Task id. */
  async function finishTask(token: string, projectId: string, taskId: string, sessionId: string) {
    await ok(token, `/projects/${projectId}/tasks/${taskId}/claim`, { sessionId });
    await ok(token, `/projects/${projectId}/tasks/${taskId}/done`, { sessionId });
    return taskId;
  }

  /** Sets the effective times of the matching Events, in write order. */
  async function age(
    filter: { sessionId?: string; taskId?: string; planId?: string },
    type: string,
    times: Date[],
  ) {
    const conditions = [eq(event.type, type)];
    if (filter.sessionId) conditions.push(eq(event.sessionId, filter.sessionId));
    if (filter.taskId) conditions.push(eq(event.taskId, filter.taskId));
    if (filter.planId) conditions.push(eq(event.planId, filter.planId));
    const rows = await db()
      .select({ id: event.id })
      .from(event)
      .where(and(...conditions))
      .orderBy(asc(event.seq));
    expect(rows).toHaveLength(times.length);
    for (const [index, row] of rows.entries()) {
      await db().update(event).set({ effectiveAt: times[index] }).where(eq(event.id, row.id));
    }
  }

  async function insertBatch(projectId: string, sessionId: string, paths: string[], at: Date) {
    await db()
      .insert(scopeCollectionBatch)
      .values({
        projectId,
        sessionId,
        collectionId: uuid(),
        batchIndex: 0,
        paths,
        fingerprint: "0".repeat(64),
        createdAt: at,
      });
  }

  function load(input: Partial<HomeAnalyticsInput> & { range: HomeRange }) {
    return runDashboardSnapshot(db(), async ({ tx, now }) => {
      const analytics = await loadHomeAnalytics(tx, {
        projects: [
          { id: projectA, name: "Alpha" },
          { id: projectB, name: "Zephyr Works" },
        ],
        q: "",
        now,
        overlappingScopes: [],
        ...input,
      });
      return { analytics, now };
    }).then((snapshot) => snapshot.data);
  }

  /** The times of `times` that fall in each returned bucket. */
  function expectedBuckets(throughput: HomeThroughput, times: Date[]) {
    const step = throughput.unit === "hour" ? HOUR : DAY;
    return throughput.buckets.map(
      ({ start }) =>
        times.filter(
          (time) => time.getTime() >= start.getTime() && time.getTime() < start.getTime() + step,
        ).length,
    );
  }

  /** `task.done` times in Projects A and B. */
  const doneTimes = () => [
    ago(10 * MINUTE),
    ago(3 * HOUR),
    ago(2 * HOUR),
    ago(30 * HOUR),
    ago(10 * DAY),
  ];

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    outsider = await api.signUp();
    projectA = await api.createProject(owner);
    projectB = await api.createProject(owner);
    projectC = await api.createProject(outsider);
    await db().update(project).set({ name: "Zephyr Works" }).where(eq(project.id, projectB));

    const planA = await createPlan(owner.token, projectA);
    const planB = await createPlan(owner.token, projectB);
    const planC = await createPlan(outsider.token, projectC);
    const tasks = {
      t1: await addTask(owner.token, projectA, planA.key),
      t2: await addTask(owner.token, projectA, planA.key),
      t3: await addTask(owner.token, projectA, planA.key),
      t4: await addTask(owner.token, projectA, planA.key),
      t5: await addTask(owner.token, projectB, planB.key),
      t6: await addTask(outsider.token, projectC, planC.key),
    };

    // claude on two machines in two Projects, codex in B, and two older
    // Sessions in A. gemini works in C, which is outside the input.
    sessions.claudeA = await startSession(owner.token, projectA, "claude", "laptop");
    sessions.claudeB = await startSession(owner.token, projectB, "claude", "server");
    sessions.codexB = await startSession(owner.token, projectB, "codex", "desktop");
    sessions.oldBot = await startSession(owner.token, projectA, "old-bot");
    sessions.ancient = await startSession(owner.token, projectA, "ancient");
    sessions.geminiC = await startSession(outsider.token, projectC, "gemini", "laptop");
    const s = sessions as Record<string, string>;

    // Heartbeats: claudeA's last opens the collection uploaded below.
    for (let i = 0; i < 4; i++) await heartbeat(owner.token, projectA, s.claudeA as string);
    const { collectionId } = await heartbeat(owner.token, projectA, s.claudeA as string);
    await heartbeat(owner.token, projectB, s.claudeB as string);
    await heartbeat(owner.token, projectB, s.codexB as string);
    await heartbeat(owner.token, projectA, s.oldBot as string);
    await heartbeat(owner.token, projectA, s.oldBot as string);
    await heartbeat(outsider.token, projectC, s.geminiC as string);

    // One touched-path batch through the collection protocol.
    const touched = ["apps/web/page.tsx", "notes.md"];
    const collection = `/projects/${projectA}/sessions/${s.claudeA}/collections/${collectionId}`;
    await ok(owner.token, `${collection}/manifest`, {
      pathCount: touched.length,
      batchCount: 1,
      omittedPathCount: 0,
      contentHash: await touchedPathsContentHash(touched),
    });
    await ok(owner.token, `${collection}/batches`, { batchIndex: 0, paths: touched });

    // Tasks: t2 is claimed, released and claimed again before it is done.
    await finishTask(owner.token, projectA, tasks.t1, s.claudeA as string);
    await ok(owner.token, `/projects/${projectA}/tasks/${tasks.t2}/claim`, {
      sessionId: s.claudeA,
    });
    await ok(owner.token, `/projects/${projectA}/tasks/${tasks.t2}/release`, {
      sessionId: s.claudeA,
    });
    await finishTask(owner.token, projectA, tasks.t2, s.claudeA as string);
    await finishTask(owner.token, projectB, tasks.t5, s.codexB as string);
    await finishTask(owner.token, projectA, tasks.t3, s.oldBot as string);
    await finishTask(owner.token, projectA, tasks.t4, s.ancient as string);
    await finishTask(outsider.token, projectC, tasks.t6, s.geminiC as string);

    // Finished Plans (empty ones, so `done` needs no Tasks).
    const finished = {
      a: await createPlan(owner.token, projectA),
      b: await createPlan(owner.token, projectB),
      c: await createPlan(outsider.token, projectC),
    };
    await ok(owner.token, `/projects/${projectA}/plans/${finished.a.key}/status`, {
      status: "done",
    });
    await ok(owner.token, `/projects/${projectB}/plans/${finished.b.key}/status`, {
      status: "done",
    });
    await ok(outsider.token, `/projects/${projectC}/plans/${finished.c.key}/status`, {
      status: "done",
    });

    // Age everything relative to the database clock.
    const clock = await db().execute<{ ms: string }>(
      sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms`,
    );
    t0 = Number(clock.rows[0]?.ms);

    const started = {
      claudeA: ago(4 * HOUR),
      claudeB: ago(1 * HOUR),
      codexB: ago(3 * HOUR),
      oldBot: ago(32 * HOUR),
      ancient: ago(10 * DAY + HOUR),
      geminiC: ago(2 * HOUR),
    };
    for (const [name, at] of Object.entries(started)) {
      await age({ sessionId: s[name] }, "session.started", [at]);
    }
    // claudeA: gaps of 2, 2, 2, 14 and 2 minutes; the 14-minute one is not active time.
    const claudeABeats = [2, 4, 6, 20, 22].map(
      (m) => new Date(started.claudeA.getTime() + m * MINUTE),
    );
    await age({ sessionId: s.claudeA }, "session.heartbeat", claudeABeats);
    const claudeBBeat = new Date(started.claudeB.getTime() + 3 * MINUTE);
    await age({ sessionId: s.claudeB }, "session.heartbeat", [claudeBBeat]);
    const codexBeat = new Date(started.codexB.getTime() + MINUTE);
    await age({ sessionId: s.codexB }, "session.heartbeat", [codexBeat]);
    const oldBotBeats = [1, 2].map((m) => new Date(started.oldBot.getTime() + m * MINUTE));
    await age({ sessionId: s.oldBot }, "session.heartbeat", oldBotBeats);
    await age({ sessionId: s.geminiC }, "session.heartbeat", [ago(2 * HOUR - MINUTE)]);
    const lastBeats: Record<string, Date> = {
      claudeA: claudeABeats[4] as Date,
      claudeB: claudeBBeat,
      codexB: codexBeat,
      oldBot: oldBotBeats[1] as Date,
      ancient: started.ancient,
      geminiC: ago(2 * HOUR - MINUTE),
    };
    for (const [name, at] of Object.entries(lastBeats)) {
      await db()
        .update(agentSession)
        .set({ lastHeartbeatAt: at })
        .where(eq(agentSession.id, s[name] as string));
    }

    // Done Tasks and their claims: 30, 10, 50, 60 and 20 minutes (t6 is in C).
    const [d1, d2, d5, d3, d4] = doneTimes() as [Date, Date, Date, Date, Date];
    const before = (time: Date, minutes: number) => new Date(time.getTime() - minutes * MINUTE);
    await age({ taskId: tasks.t1 }, "task.done", [d1]);
    await age({ taskId: tasks.t1 }, "task.claimed", [before(d1, 30)]);
    await age({ taskId: tasks.t2 }, "task.done", [d2]);
    await age({ taskId: tasks.t2 }, "task.claimed", [before(d2, 120), before(d2, 10)]);
    await age({ taskId: tasks.t5 }, "task.done", [d5]);
    await age({ taskId: tasks.t5 }, "task.claimed", [before(d5, 50)]);
    await age({ taskId: tasks.t3 }, "task.done", [d3]);
    await age({ taskId: tasks.t3 }, "task.claimed", [before(d3, 60)]);
    await age({ taskId: tasks.t4 }, "task.done", [d4]);
    await age({ taskId: tasks.t4 }, "task.claimed", [before(d4, 20)]);
    await age({ taskId: tasks.t6 }, "task.done", [ago(HOUR)]);
    await age({ taskId: tasks.t6 }, "task.claimed", [ago(HOUR + 5 * MINUTE)]);

    await age({ planId: finished.a.id }, "plan.status_changed", [ago(2 * HOUR)]);
    await age({ planId: finished.b.id }, "plan.status_changed", [ago(30 * HOUR)]);
    await age({ planId: finished.c.id }, "plan.status_changed", [ago(HOUR)]);

    // Touched paths. A: apps/web/page.tsx 3 batches from 2 Sessions; B:
    // src/main.ts 2 batches from 2 Sessions; the rest 1 batch each. C is
    // outside the input; old/path.ts is outside 24h.
    await db()
      .update(scopeCollectionBatch)
      .set({ createdAt: ago(3 * HOUR + 50 * MINUTE) })
      .where(eq(scopeCollectionBatch.sessionId, s.claudeA as string));
    await insertBatch(projectA, s.claudeA as string, ["apps/web/page.tsx"], ago(3 * HOUR));
    await insertBatch(
      projectA,
      s.oldBot as string,
      ["apps/web/page.tsx", "packages/db/x.ts"],
      ago(HOUR),
    );
    await insertBatch(projectA, s.claudeA as string, ["lib/one.ts", "lib/two.ts"], ago(3 * HOUR));
    await insertBatch(projectB, s.codexB as string, ["src/main.ts"], ago(2 * HOUR));
    await insertBatch(
      projectB,
      s.claudeB as string,
      ["src/main.ts", "docs/guide.md"],
      ago(30 * MINUTE),
    );
    await insertBatch(projectB, s.codexB as string, ["old/path.ts"], ago(30 * HOUR));
    for (let i = 0; i < 5; i++) {
      await insertBatch(projectC, s.geminiC as string, ["apps/web/page.tsx"], ago(HOUR));
    }
  });

  afterAll(async () => {
    await api?.drop();
  });

  describe("throughput", () => {
    // The previous range is as long as the current one, so every previous
    // figure below sits well inside it, wherever `now` falls in its hour.
    it("counts 24 hourly buckets ending with the current hour, and the same span a day earlier", async () => {
      const { analytics, now } = await load({ range: "24h" });
      const { throughput } = analytics;
      expect(throughput).toMatchObject({ range: "24h", unit: "hour" });
      expect(throughput.buckets).toHaveLength(24);
      const currentHour = Math.floor(now.getTime() / HOUR) * HOUR;
      expect(throughput.buckets.at(-1)?.start.getTime()).toBe(currentHour);
      expect(throughput.buckets[0]?.start.getTime()).toBe(currentHour - 23 * HOUR);
      expect(throughput.buckets.map((bucket) => bucket.tasksDone)).toEqual(
        expectedBuckets(throughput, doneTimes()),
      );
      expect(throughput.buckets.reduce((sum, bucket) => sum + bucket.tasksDone, 0)).toBe(3);
      expect(throughput.tasksDone).toEqual({ value: 3, previous: 1 });
      expect(throughput.sessionsStarted).toEqual({ value: 3, previous: 1 });
      expect(throughput.plansFinished).toEqual({ value: 1, previous: 1 });
      // 10, 30 and 50 minutes now; 60 before. t2's earlier claim is not used.
      expect(throughput.medianTaskMinutes).toEqual({ value: 30, previous: 60 });
    });

    it("counts UTC days for 7d, the last one partial, and the same span a week earlier", async () => {
      const { analytics, now } = await load({ range: "7d" });
      const { throughput } = analytics;
      expect(throughput).toMatchObject({ range: "7d", unit: "day" });
      expect(throughput.buckets).toHaveLength(7);
      const today = Math.floor(now.getTime() / DAY) * DAY;
      expect(throughput.buckets.at(-1)?.start.getTime()).toBe(today);
      expect(throughput.buckets[0]?.start.getTime()).toBe(today - 6 * DAY);
      expect(throughput.buckets.map((bucket) => bucket.tasksDone)).toEqual(
        expectedBuckets(throughput, doneTimes()),
      );
      expect(throughput.tasksDone).toEqual({ value: 4, previous: 1 });
      expect(throughput.sessionsStarted).toEqual({ value: 4, previous: 1 });
      expect(throughput.plansFinished).toEqual({ value: 2, previous: 0 });
      expect(throughput.medianTaskMinutes).toEqual({ value: 40, previous: 20 });
    });

    it("has 30 buckets for 30d and no median without samples", async () => {
      const { analytics } = await load({ range: "30d" });
      expect(analytics.throughput.buckets).toHaveLength(30);
      expect(analytics.throughput.tasksDone).toEqual({ value: 5, previous: 0 });
      expect(analytics.throughput.medianTaskMinutes.previous).toBeNull();
    });

    it.each([
      // 01:00 UTC: the current 7d range is 6 days and 1 hour long.
      ["7d", "2026-01-08T01:00:00Z", 145],
      // 01:20 UTC: the current 24h range is 23 hours and 20 minutes long.
      ["24h", "2026-01-08T01:20:00Z", 23],
    ] as const)("compares a steady rate as equal on %s at %s", async (range, at, expected) => {
      // One of each counted Event every hour for 14 days, half an hour off
      // the hour, in a Project of its own, read at a fixed `now`.
      const now = new Date(at);
      const steady = await api.createProject(owner);
      await db().execute(sql`
        insert into event (project_id, type, payload_version, payload, actor_kind, effective_at)
        select ${steady}, kind.type, 1, kind.payload::jsonb, 'system',
          ${now.toISOString()}::timestamptz - (h + 0.5) * interval '1 hour'
        from generate_series(0, 14 * 24 - 1) as h
          cross join (values
            ('task.done', '{}'),
            ('session.started', '{}'),
            ('plan.status_changed', '{"to": "done"}')
          ) as kind(type, payload)
      `);
      const { analytics } = await load({ range, now, projects: [{ id: steady, name: "Steady" }] });
      const same = { value: expected, previous: expected };
      expect(analytics.throughput.tasksDone).toEqual(same);
      expect(analytics.throughput.sessionsStarted).toEqual(same);
      expect(analytics.throughput.plansFinished).toEqual(same);
    });
  });

  describe("agents", () => {
    it("sums active time, Sessions and done Tasks per agent", async () => {
      const { analytics } = await load({ range: "24h" });
      expect(analytics.agents).toEqual([
        {
          agent: "claude",
          machines: ["laptop", "server"],
          projectCount: 2,
          sessions: 2,
          tasksDone: 2,
          // claudeA 2 + 2 + 2 + 2 (the 14-minute gap excluded), claudeB 3.
          activeMinutes: 11,
          lastSeenAt: new Date(t0 - HOUR + 3 * MINUTE),
        },
        {
          agent: "codex",
          machines: ["desktop"],
          projectCount: 1,
          sessions: 1,
          tasksDone: 1,
          activeMinutes: 1,
          lastSeenAt: new Date(t0 - 3 * HOUR + MINUTE),
        },
      ]);
    });

    it("includes agents active only earlier in a longer range", async () => {
      const { analytics } = await load({ range: "7d" });
      expect(analytics.agents.map((row) => row.agent)).toEqual(["claude", "old-bot", "codex"]);
      expect(analytics.agents[1]).toMatchObject({
        machines: [],
        sessions: 1,
        tasksDone: 1,
        activeMinutes: 2,
      });
    });

    it("filters by agent, machine and Project name", async () => {
      const byMachine = await load({ range: "24h", q: "LAPTOP" });
      expect(byMachine.analytics.agents).toEqual([
        expect.objectContaining({
          agent: "claude",
          machines: ["laptop"],
          projectCount: 1,
          sessions: 1,
          tasksDone: 2,
          activeMinutes: 8,
        }),
      ]);
      const byProject = await load({ range: "24h", q: "zephyr" });
      expect(byProject.analytics.agents).toEqual([
        expect.objectContaining({ agent: "claude", machines: ["server"], activeMinutes: 3 }),
        expect.objectContaining({ agent: "codex" }),
      ]);
      const byAgent = await load({ range: "24h", q: "cod" });
      expect(byAgent.analytics.agents.map((row) => row.agent)).toEqual(["codex"]);
    });
  });

  describe("hot paths", () => {
    it("ranks paths by touches with distinct Sessions and flags overlaps", async () => {
      const { analytics } = await load({
        range: "24h",
        overlappingScopes: [
          { projectId: projectA, scope: "apps/web/**" },
          { projectId: projectB, scope: "src/main.ts" },
          // A Scope of B never flags a path of A.
          { projectId: projectB, scope: "lib/**" },
        ],
      });
      expect(analytics.hotPaths).toEqual([
        {
          projectId: projectA,
          projectName: "Alpha",
          path: "apps/web/page.tsx",
          touches: 3,
          sessions: 2,
          overlapping: true,
        },
        {
          projectId: projectB,
          projectName: "Zephyr Works",
          path: "src/main.ts",
          touches: 2,
          sessions: 2,
          overlapping: true,
        },
        expect.objectContaining({ path: "docs/guide.md", touches: 1, overlapping: false }),
        expect.objectContaining({ path: "lib/one.ts", touches: 1, overlapping: false }),
        expect.objectContaining({ path: "lib/two.ts", touches: 1, overlapping: false }),
        expect.objectContaining({ path: "notes.md", touches: 1, sessions: 1 }),
      ]);
    });

    it("keeps older batches for a longer range", async () => {
      const { analytics } = await load({ range: "7d" });
      expect(analytics.hotPaths).toHaveLength(6);
      const paths = await load({ range: "7d", q: "old/" });
      expect(paths.analytics.hotPaths).toEqual([
        expect.objectContaining({ projectId: projectB, path: "old/path.ts", touches: 1 }),
      ]);
    });

    it("filters by path and Project name", async () => {
      const byPath = await load({ range: "24h", q: "LIB/" });
      expect(byPath.analytics.hotPaths.map((row) => row.path)).toEqual([
        "lib/one.ts",
        "lib/two.ts",
      ]);
      const byProject = await load({ range: "24h", q: "zephyr" });
      expect(byProject.analytics.hotPaths.map((row) => row.path)).toEqual([
        "src/main.ts",
        "docs/guide.md",
      ]);
    });
  });

  it("treats LIKE wildcards in q as literal text", async () => {
    for (const q of ["%", "_", "\\"]) {
      const { analytics } = await load({ range: "7d", q });
      expect(analytics.agents).toEqual([]);
      expect(analytics.hotPaths).toEqual([]);
    }
  });

  it("reads only the Projects in the input", async () => {
    const { analytics } = await load({
      range: "24h",
      projects: [{ id: projectA, name: "Alpha" }],
    });
    // B's codex, claudeB and C's gemini are gone; so are their paths and Tasks.
    expect(analytics.throughput.tasksDone).toEqual({ value: 2, previous: 1 });
    expect(analytics.throughput.sessionsStarted).toEqual({ value: 1, previous: 1 });
    expect(analytics.agents.map((row) => row.agent)).toEqual(["claude"]);
    expect(analytics.agents[0]).toMatchObject({ machines: ["laptop"], activeMinutes: 8 });
    expect(analytics.hotPaths.every((row) => row.projectId === projectA)).toBe(true);
    expect(analytics.hotPaths[0]).toMatchObject({ path: "apps/web/page.tsx", touches: 3 });
    expect(
      await db()
        .select({ id: event.id })
        .from(event)
        .where(and(eq(event.projectId, projectC), eq(event.type, "task.done"))),
    ).toHaveLength(1);
  });
});
