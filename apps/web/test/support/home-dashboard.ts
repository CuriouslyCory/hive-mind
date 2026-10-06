import { DEFAULT_HOME_PARAMS } from "../../src/server/dashboard/home-params";
import type {
  HomeDashboard,
  HomeParams,
  HomeSessionRow,
  HomeThroughputBucket,
} from "../../src/server/dashboard/home-types";

// A hand-written `HomeDashboard` for rendering the home page without a
// database: two Projects, every attention kind, a Project-key Session and a
// null median.

export const AS_OF = new Date("2026-10-05T12:00:00.000Z");

export const PROJECT_A = "0a0a0a0a-0000-4000-8000-00000000000a";
export const PROJECT_B = "0b0b0b0b-0000-4000-8000-00000000000b";

function ago(seconds: number): Date {
  return new Date(AS_OF.getTime() - seconds * 1000);
}

function session(overrides: Partial<HomeSessionRow> & { id: string }): HomeSessionRow {
  return {
    projectId: PROJECT_A,
    projectName: "web-app",
    intent: "Fix parser error positions",
    agent: "claude-code",
    owner: { kind: "user", userId: "u1", name: "cory" },
    machine: "hexlin",
    status: "active",
    state: "buzzing",
    gitBranch: "feat/parser-positions",
    focusPlanKey: "PLAN-3",
    lastHeartbeatAt: ago(12),
    endedAt: null,
    overlapping: false,
    ...overrides,
  };
}

function days(values: number[]): HomeThroughputBucket[] {
  return values.map((tasksDone, index) => ({
    start: new Date(Date.UTC(2026, 9, 5 - (values.length - 1 - index))),
    tasksDone,
  }));
}

export function homeDashboard(
  params: Partial<HomeParams> = {},
  overrides: Partial<HomeDashboard> = {},
): HomeDashboard {
  const applied: HomeParams = { ...DEFAULT_HOME_PARAMS, ...params };
  const projects = [
    { id: PROJECT_A, name: "web-app", slug: "web-app", organizationName: "acme", buzzingCount: 2 },
    { id: PROJECT_B, name: "parser", slug: "parser", organizationName: "acme", buzzingCount: 0 },
  ];
  const selected = projects.find((project) => project.id === applied.projectId) ?? null;
  return {
    asOf: AS_OF,
    viewer: { name: "Cory" },
    params: applied,
    projects: { items: projects, total: 2, buzzingTotal: 2 },
    selected,
    counts: {
      activePlans: 3,
      buzzing: 2,
      openTasks: 11,
      tasksDone: 23,
      blockedTasks: 1,
      overlaps: 1,
    },
    overlaps: [
      {
        projectId: PROJECT_A,
        projectName: "web-app",
        path: "packages/parser/lexer.ts",
        session: { id: "s1", agent: "claude-code", owner: { kind: "system" }, status: "active" },
        scope: "packages/parser/**",
        otherSession: { id: "s2", agent: "codex", owner: { kind: "system" }, status: "active" },
        otherScope: "packages/parser/lexer.ts",
        kind: "overlap",
      },
    ],
    attention: {
      total: 5,
      items: [
        {
          kind: "blocked_task",
          projectId: PROJECT_A,
          projectName: "web-app",
          planId: "a-plan-3",
          planKey: "PLAN-3",
          taskId: "a-plan-3-task-1",
          taskTitle: "Changelog entry",
          reason: "Waiting on the 0.2.0 release notes.",
          blockedAt: ago(40 * 60),
        },
        {
          kind: "lease_ending",
          projectId: PROJECT_A,
          projectName: "web-app",
          planId: "a-plan-3",
          planKey: "PLAN-3",
          taskId: "a-plan-3-task-2",
          taskTitle: "Update error messages and snapshots",
          holder: { id: "s1", agent: "claude-code", owner: { kind: "system" }, status: "active" },
          leaseExpiresAt: new Date(AS_OF.getTime() + 60_000),
        },
        {
          kind: "claim_lapsed",
          projectId: PROJECT_B,
          projectName: "parser",
          planId: "b-plan-5",
          planKey: "PLAN-5",
          taskId: "b-plan-5-task-1",
          taskTitle: "Migrate the Session page",
          holder: null,
          lapsedAt: ago(4 * 60),
        },
        {
          kind: "unclaimed_plan",
          projectId: PROJECT_B,
          projectName: "parser",
          planId: "b-plan-6",
          planKey: "PLAN-6",
          planTitle: "Plan search",
          openTaskCount: 4,
          idleSince: ago(86_400),
        },
        {
          kind: "paused_plan",
          projectId: PROJECT_A,
          projectName: "web-app",
          planId: "a-plan-5",
          planKey: "PLAN-5",
          planTitle: "Settings page redesign",
          openTaskCount: 5,
          pausedAt: null,
        },
      ],
    },
    sessions: {
      total: 7,
      counts: { active: 3, ended: 4, overlap: 2, all: 7 },
      tab: applied.sessionTab,
      matching: 3,
      rows: [
        session({ id: "s1", overlapping: true }),
        session({
          id: "s2",
          agent: "codex",
          intent: "Add retry to the stream client",
          owner: { kind: "user", userId: "u2", name: "maya" },
          gitBranch: "fix/stream-retry",
          focusPlanKey: "PLAN-4",
          overlapping: true,
          lastHeartbeatAt: ago(41),
        }),
        session({
          id: "s3",
          agent: "ci",
          intent: "Nightly dependency bump",
          owner: { kind: "project_key", keyId: "key-1", name: "ci-nightly", revoked: false },
          machine: null,
          status: "idle",
          state: "resting",
          gitBranch: "chore/deps",
          focusPlanKey: null,
          lastHeartbeatAt: ago(180),
        }),
      ],
    },
    plans: {
      total: 9,
      counts: { all: 9, active: 3, paused: 2, done: 4 },
      tab: applied.planTab,
      matching: 9,
      rows: [
        {
          id: "p3",
          projectId: PROJECT_A,
          projectName: "web-app",
          key: "PLAN-3",
          title: "Parser error positions",
          status: "active",
          progress: { total: 6, todo: 2, inProgress: 1, blocked: 0, done: 3 },
          createdBy: { kind: "user", userId: "u1", name: "cory" },
          updatedAt: ago(30),
        },
        {
          id: "p4",
          projectId: PROJECT_B,
          projectName: "parser",
          key: "PLAN-4",
          title: "Tokenizer performance",
          status: "done",
          progress: { total: 4, todo: 0, inProgress: 0, blocked: 0, done: 4 },
          createdBy: { kind: "project_key", keyId: "key-2", name: null, revoked: true },
          updatedAt: ago(7200),
        },
      ],
    },
    events: [
      {
        id: "e1",
        seq: "10",
        type: "task.claimed",
        actor: { kind: "user", userId: "u1", name: "cory" },
        actorSessionId: "s1",
        planKey: "PLAN-3",
        task: null,
        sessionId: null,
        effectiveAt: ago(120),
        text: "Claimed the Task",
        markdown: null,
        projectId: PROJECT_A,
        projectName: "web-app",
        actorAgent: "claude-code",
      },
      {
        id: "e2",
        seq: "9",
        type: "plan.log_appended",
        actor: { kind: "user", userId: "u2", name: "maya" },
        actorSessionId: null,
        planKey: "PLAN-4",
        task: null,
        sessionId: null,
        effectiveAt: ago(600),
        text: "Added a log entry",
        markdown: "## Note\nRetry with jittered backoff.",
        projectId: PROJECT_B,
        projectName: "parser",
        actorAgent: null,
      },
    ],
    analytics: {
      throughput: {
        range: applied.range,
        unit: "day",
        buckets: days([4, 6, 2, 0, 7, 3, 1]),
        tasksDone: { value: 23, previous: 20 },
        sessionsStarted: { value: 9, previous: 12 },
        plansFinished: { value: 2, previous: 0 },
        medianTaskMinutes: { value: null, previous: 40 },
      },
      agents: [
        {
          agent: "claude-code",
          machines: ["hexlin"],
          projectCount: 2,
          sessions: 14,
          tasksDone: 23,
          activeMinutes: 1260,
          lastSeenAt: ago(12),
        },
      ],
      hotPaths: [
        {
          projectId: PROJECT_A,
          projectName: "web-app",
          path: "packages/parser/lexer.ts",
          touches: 18,
          sessions: 3,
          overlapping: true,
        },
        {
          projectId: PROJECT_B,
          projectName: "parser",
          path: "src/tokenizer.ts",
          touches: 1,
          sessions: 1,
          overlapping: false,
        },
      ],
    },
    decisions: [
      {
        id: "d1",
        projectId: PROJECT_A,
        projectName: "web-app",
        planKey: "PLAN-3",
        text: "Count positions in code points, not UTF-16 units.",
        actor: { kind: "user", userId: "u1", name: "cory" },
        actorAgent: "claude-code",
        at: ago(3 * 3600),
      },
    ],
    ...overrides,
  };
}
