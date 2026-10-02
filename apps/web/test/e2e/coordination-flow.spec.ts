import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { type CliCall, cliRunner, describe, failure, git, okData } from "./cli-runner";
import { E2E_BASE_URL, e2eDatabaseUrl } from "./e2e-env";
import { type FieldAddingProxy, startFieldAddingProxy } from "./field-adding-proxy";
import { signedInPage, testUsers } from "./support";

// M2 coordination with two compiled CLIs (issue #12, step 9): two linked git
// worktrees of one repository, each with the committed Project binding, run
// one agent each. Agent A is the User (device login); agent B is a Project key
// and talks to the app through a proxy that adds unknown fields to every JSON
// answer, so every command B runs also checks that the CLI tolerates added
// response fields (ADR-0009). This is CLI/API acceptance only: no dashboard and
// no hooks; heartbeats are explicit `session heartbeat` runs.

/** Built by `pnpm --filter @hivemind/cli build` (turbo runs it before test:e2e). */
const CLI_BINARY = fileURLToPath(new URL("../../../cli/dist/hivemind", import.meta.url));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Agent extends CliCall {
  name: string;
  intent: string;
  sessionId: string;
}

interface SessionDto {
  id: string;
  owner: { kind: string };
  status: string;
  summary: string | null;
  attachedPlanKey: string | null;
}
interface TaskDto {
  id: string;
  status: string;
  claim: { sessionId: string } | null;
}
interface ScopeDto {
  id: string;
  source: string;
  value: string;
}
interface OverlapDto {
  sessionId: string;
  otherSessionId: string;
  scope: Omit<ScopeDto, "id">;
  otherScope: Omit<ScopeDto, "id">;
  kind: string;
  witness: string | null;
}
interface EventDto {
  type: string;
  actorSessionId: string | null;
  planId: string | null;
  taskId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
}
interface HeartbeatData {
  heartbeat: {
    renewedClaims: { items: string[] };
    releasedClaims: { items: string[] };
  };
  collection: Record<string, unknown> | null;
  touchedPathsAvailable: boolean;
  leaseRenewed: boolean;
  pathCount: number | null;
  omittedPathCount: number | null;
  collectionError: unknown;
}

let pool: pg.Pool;
let users: TestHelpers;
let sandbox: string;
let proxy: FieldAddingProxy;
let runner: ReturnType<typeof cliRunner>;

test.beforeAll(async () => {
  if (!existsSync(CLI_BINARY)) {
    throw new Error(`${CLI_BINARY} is missing; run 'pnpm --filter @hivemind/cli build' first.`);
  }
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
  proxy = await startFieldAddingProxy(E2E_BASE_URL);
  sandbox = mkdtempSync(join(tmpdir(), "hivemind-coordination-e2e-"));
  const home = join(sandbox, "home");
  mkdirSync(home);
  runner = cliRunner(CLI_BINARY, {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
  });
});

test.afterAll(async () => {
  await pool?.end();
  await proxy?.close();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test("two worktrees coordinate a Plan through claims, Scopes, heartbeats, a steal and summaries", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { run } = runner;
  const suffix = randomUUID().slice(0, 8);

  // --- Setup: the User logs in, binds a repository, commits the binding and
  // creates a Project key; two linked worktrees get the binding from git.
  const { user, page } = await signedInPage(browser, users);
  const login = runner.start(["login", "--json"], { cwd: sandbox, server: E2E_BASE_URL });
  await expect
    .poll(() => /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(login.result.stderr)?.[1], {
      timeout: 15_000,
    })
    .toBeTruthy();
  const userCode = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(login.result.stderr)?.[1] as string;
  await page.goto(`/device?user_code=${userCode}`);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText(/Approved/);
  okData(await login.done);

  const repo = join(sandbox, "repo");
  git(sandbox, "init", "-q", "-b", "main", repo);
  git(repo, "remote", "add", "origin", "https://github.com/example/coordination-e2e.git");
  const owner: CliCall = { cwd: repo, server: E2E_BASE_URL };
  const { project } = okData<{ project: { id: string } }>(
    await run(
      ["init", "--name", "Coordination e2e", "--slug", `coordination-${suffix}`, "--json"],
      owner,
    ),
  );
  writeFileSync(join(repo, "README.md"), "# Coordination e2e\n");
  git(repo, "add", ".hivemind.json", "README.md");
  git(repo, "commit", "-q", "-m", "Bind to Hive Mind");
  const { secret } = okData<{ secret: string }>(
    await run(["key", "create", "--name", "agent-b", "--json"], owner),
  );

  const worktreeA = join(sandbox, "wt-a");
  const worktreeB = join(sandbox, "wt-b");
  git(repo, "worktree", "add", "-q", "-b", "agent-a", worktreeA);
  git(repo, "worktree", "add", "-q", "-b", "agent-b", worktreeB);
  const a: Agent = {
    name: "agent-a",
    intent: "Rewrite the lexer in wt-a",
    cwd: worktreeA,
    server: E2E_BASE_URL,
    sessionId: "",
  };
  const b: Agent = {
    name: "agent-b",
    intent: "Document the grammar in wt-b",
    cwd: worktreeB,
    server: proxy.origin,
    env: { HIVEMIND_TOKEN: secret },
    sessionId: "",
  };
  /** Runs as the agent, with its Session (once started) in HIVEMIND_SESSION. */
  const as = (agent: Agent, argv: string[]) =>
    run(argv, {
      ...agent,
      env: { ...agent.env, ...(agent.sessionId ? { HIVEMIND_SESSION: agent.sessionId } : {}) },
    });

  // --- Distinct Sessions, one per worktree. Human mode prints only the UUID.
  const startedA = await as(a, ["session", "start", "--agent", a.name, "--intent", a.intent]);
  expect(startedA.status, describe(startedA)).toBe(0);
  a.sessionId = startedA.stdout.trim();
  expect(a.sessionId).toMatch(UUID);
  expect(startedA.stderr).toContain(`export HIVEMIND_SESSION=${a.sessionId}`);
  const startedB = okData<{ session: SessionDto & Record<string, unknown>; created: boolean }>(
    await as(b, ["session", "start", "--agent", b.name, "--intent", b.intent, "--json"]),
  );
  b.sessionId = startedB.session.id;
  expect(startedB).toMatchObject({
    created: true,
    session: { projectId: project.id, owner: { kind: "key" }, gitBranch: "agent-b" },
  });
  expect(b.sessionId).not.toBe(a.sessionId);
  const shownA = okData<{ session: Record<string, unknown> }>(
    await as(b, ["session", "show", a.sessionId, "--json"]),
  );
  expect(shownA.session).toMatchObject({
    owner: { kind: "user", userId: user.id },
    gitBranch: "agent-a",
    intent: a.intent,
  });

  // --- A Plan with two Tasks, attributed to A's Session; both Sessions attach to it.
  const planCreated = await as(a, [
    "plan",
    "create",
    "--title",
    "Parser rewrite",
    "--status",
    "active",
  ]);
  expect(planCreated.status, describe(planCreated)).toBe(0);
  expect(planCreated.stdout.trim()).toBe("PLAN-1");
  const lexerAdded = await as(a, ["task", "add", "PLAN-1", "--title", "Rewrite the lexer"]);
  expect(lexerAdded.status, describe(lexerAdded)).toBe(0);
  const lexerTask = lexerAdded.stdout.trim();
  expect(lexerTask).toMatch(UUID);
  const grammarTask = okData<{ task: TaskDto }>(
    await as(b, ["task", "add", "PLAN-1", "--title", "Document the grammar", "--json"]),
  ).task.id;
  for (const agent of [a, b]) {
    const attached = okData<{ session: SessionDto }>(
      await as(agent, ["session", "attach", "--plan", "PLAN-1", "--json"]),
    );
    expect(attached.session.attachedPlanKey).toBe("PLAN-1");
  }

  // --- Declared Scopes that overlap, then real edits in each worktree,
  // uploaded as touched paths by explicit heartbeats.
  okData(await as(a, ["scope", "add", "src/parser/**", "--json"]));
  okData(await as(b, ["scope", "add", "src/**/*.ts", "--json"]));
  okData(await as(b, ["scope", "add", "docs/**", "--json"]));
  mkdirSync(join(worktreeA, "src", "parser"), { recursive: true });
  writeFileSync(join(worktreeA, "src", "parser", "lexer.ts"), "export const lexer = 1;\n");
  appendFileSync(join(worktreeA, "README.md"), "\nThe lexer is being rewritten.\n");
  mkdirSync(join(worktreeB, "src", "parser"), { recursive: true });
  mkdirSync(join(worktreeB, "docs"), { recursive: true });
  writeFileSync(join(worktreeB, "src", "parser", "grammar.ts"), "export const grammar = 1;\n");
  writeFileSync(join(worktreeB, "docs", "grammar.md"), "# Grammar\n");

  for (const [agent, paths] of [
    [a, ["README.md", "src/parser/lexer.ts"]],
    [b, ["docs/grammar.md", "src/parser/grammar.ts"]],
  ] as const) {
    const beat = okData<HeartbeatData>(await as(agent, ["session", "heartbeat", "--json"]));
    expect(beat).toMatchObject({
      touchedPathsAvailable: true,
      leaseRenewed: true,
      pathCount: 2,
      omittedPathCount: 0,
      collectionError: null,
      collection: { finalized: true, collectionComplete: true, scopeComplete: true },
    });
    const touched = okData<{ items: ScopeDto[] }>(
      await as(agent, ["scope", "list", "--source", "touched", "--json"]),
    );
    expect(touched.items.map((scope) => scope.value).sort()).toEqual([...paths]);
  }

  // Each agent sees the overlap with the other, declared and touched.
  const checkA = okData<{ items: OverlapDto[]; complete: boolean }>(
    await as(a, ["scope", "check", "--json"]),
  );
  expect(checkA.complete).toBe(true);
  expect(checkA.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionId: a.sessionId,
        otherSessionId: b.sessionId,
        kind: "overlap",
        scope: expect.objectContaining({ source: "declared", value: "src/parser/**" }),
        otherScope: expect.objectContaining({ source: "declared", value: "src/**/*.ts" }),
      }),
      expect.objectContaining({
        otherSessionId: b.sessionId,
        kind: "overlap",
        scope: expect.objectContaining({ source: "declared", value: "src/parser/**" }),
        otherScope: expect.objectContaining({ source: "touched", value: "src/parser/grammar.ts" }),
        witness: "src/parser/grammar.ts",
      }),
    ]),
  );
  const checkB = okData<{ items: OverlapDto[]; complete: boolean }>(
    await as(b, ["scope", "check", "--json"]),
  );
  expect(checkB.complete).toBe(true);
  expect(checkB.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionId: b.sessionId,
        otherSessionId: a.sessionId,
        kind: "overlap",
        scope: expect.objectContaining({ source: "declared", value: "src/**/*.ts" }),
        otherScope: expect.objectContaining({ source: "touched", value: "src/parser/lexer.ts" }),
        witness: "src/parser/lexer.ts",
      }),
    ]),
  );
  const checkBHuman = await as(b, ["scope", "check"]);
  expect(checkBHuman.status, describe(checkBHuman)).toBe(0);
  expect(checkBHuman.stdout).toContain(a.sessionId);
  expect(checkBHuman.stdout).toContain("src/parser/lexer.ts");
  // ... and so does the Project status, from either side.
  const liveStatus = okData<{
    liveSessions: { session: SessionDto; touchedScopeCount: number }[];
    overlaps: OverlapDto[];
  }>(await as(a, ["status", "--json"]));
  expect(liveStatus.liveSessions.map((entry) => entry.session.id).sort()).toEqual(
    [a.sessionId, b.sessionId].sort(),
  );
  expect(liveStatus.liveSessions.every((entry) => entry.touchedScopeCount === 2)).toBe(true);
  expect(liveStatus.overlaps).toContainEqual(
    expect.objectContaining({ sessionId: a.sessionId, otherSessionId: b.sessionId }),
  );

  // --- Both claim the lexer Task at once: one wins, the other gets exit 2
  // naming the holder's Session UUID and intent.
  const [claimA, claimB] = await Promise.all([
    as(a, ["task", "claim", lexerTask, "--json"]),
    as(b, ["task", "claim", lexerTask, "--json"]),
  ]);
  expect([claimA.status, claimB.status].sort(), `${describe(claimA)}\n${describe(claimB)}`).toEqual(
    [0, 2],
  );
  const [holder, other] = claimA.status === 0 ? [a, b] : [b, a];
  const [won, lost] = claimA.status === 0 ? [claimA, claimB] : [claimB, claimA];
  expect(okData(won)).toMatchObject({
    task: { id: lexerTask, claim: { sessionId: holder.sessionId } },
    changed: true,
    stolenFromSessionId: null,
  });
  const conflict = failure(lost, 2);
  expect(conflict.code).toBe("CONFLICT");
  expect(conflict.message).toContain(holder.sessionId);
  expect(conflict.message).toContain(holder.intent);
  const lostHuman = await as(other, ["task", "claim", lexerTask]);
  expect(lostHuman.status, describe(lostHuman)).toBe(2);
  expect(lostHuman.stdout).toBe("");
  expect(lostHuman.stderr).toContain(holder.sessionId);
  expect(lostHuman.stderr).toContain(holder.intent);

  // The holder starts the Task, logs progress and renews its lease.
  expect(
    okData<{ task: TaskDto }>(await as(holder, ["task", "start", lexerTask, "--json"])).task,
  ).toMatchObject({ status: "in_progress", claim: { sessionId: holder.sessionId } });
  const progress = "Lexer skeleton is in; tokens next.";
  expect(
    okData(await as(holder, ["plan", "log", "PLAN-1", "--message", progress, "--json"])),
  ).toMatchObject({
    created: true,
    event: { type: "plan.log_appended", actorSessionId: holder.sessionId },
  });
  const renewed = okData<HeartbeatData>(await as(holder, ["session", "heartbeat", "--json"]));
  expect(renewed.heartbeat.renewedClaims.items).toContain(lexerTask);

  // --- The other agent takes the claim over with --steal; the former holder
  // can no longer act on the Task.
  const stolen = await as(other, ["task", "claim", lexerTask, "--steal", "--json"]);
  expect(okData(stolen)).toMatchObject({
    task: { id: lexerTask, claim: { sessionId: other.sessionId } },
    changed: true,
    stolenFromSessionId: holder.sessionId,
  });
  expect(stolen.stderr).toContain(`Took the claim over from Session ${holder.sessionId}`);
  const formerLog = okData<{ items: EventDto[] }>(
    await as(holder, ["session", "log", holder.sessionId, "--json"]),
  );
  expect(formerLog.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "task.released",
        sessionId: holder.sessionId,
        actorSessionId: other.sessionId,
        taskId: lexerTask,
        payload: expect.objectContaining({ reason: "stolen" }),
      }),
    ]),
  );
  for (const action of ["start", "done", "release"]) {
    const rejected = failure(await as(holder, ["task", action, lexerTask, "--json"]), 2);
    expect(rejected.code).toBe("CONFLICT");
  }
  const reclaim = failure(await as(holder, ["task", "claim", lexerTask, "--json"]), 2);
  expect(reclaim.message).toContain(other.sessionId);
  expect(reclaim.message).toContain(other.intent);
  const formerBeat = okData<HeartbeatData>(await as(holder, ["session", "heartbeat", "--json"]));
  expect(formerBeat.heartbeat.renewedClaims.items).not.toContain(lexerTask);

  // The new holder finishes it and logs that; the former holder moves to the
  // grammar Task and starts it.
  expect(
    okData<{ task: TaskDto }>(await as(other, ["task", "done", lexerTask, "--json"])).task,
  ).toMatchObject({ status: "done" });
  const takeover = "Took the lexer over and finished it.";
  okData(await as(other, ["plan", "log", "PLAN-1", "--message", takeover, "--json"]));
  okData(await as(holder, ["task", "claim", grammarTask, "--json"]));
  okData(await as(holder, ["task", "start", grammarTask, "--json"]));

  // A Session acts only for its own principal: the User and the key cannot
  // act through each other's Session (FORBIDDEN, exit 3).
  const borrowedLog = await run(["plan", "log", "PLAN-1", "--message", "Not mine.", "--json"], {
    ...b,
    env: { ...b.env, HIVEMIND_SESSION: a.sessionId },
  });
  expect(failure(borrowedLog, 3).code).toBe("FORBIDDEN");
  const borrowedClaim = await run(["task", "claim", grammarTask, "--json"], {
    ...a,
    env: { HIVEMIND_SESSION: b.sessionId },
  });
  expect(failure(borrowedClaim, 3).code).toBe("FORBIDDEN");

  // --- Final summaries. Ending releases claims and keeps Task progress; the
  // same summary again is a no-op, a different one is a conflict.
  const otherSummary = "Finished the lexer after taking it over.";
  const ended = okData<{ session: SessionDto; changed: boolean }>(
    await as(other, ["session", "end", "--summary", otherSummary, "--json"]),
  );
  expect(ended).toMatchObject({
    changed: true,
    session: { status: "ended", summary: otherSummary, attachedPlanKey: "PLAN-1" },
  });
  expect(
    okData(await as(other, ["session", "end", "--summary", otherSummary, "--json"])),
  ).toMatchObject({ changed: false });
  expect(
    failure(await as(other, ["session", "end", "--summary", "Something else.", "--json"]), 2).code,
  ).toBe("CONFLICT");

  const holderSummary = "Lost the lexer to a takeover; the grammar Task is started.";
  const summaryFile = join(sandbox, "summary.md");
  writeFileSync(summaryFile, `${holderSummary}\n`);
  const holderEnded = okData<{
    session: SessionDto;
    changed: boolean;
    releasedClaims: { items: string[] };
  }>(await as(holder, ["session", "end", "--summary-file", summaryFile, "--json"]));
  expect(holderEnded).toMatchObject({
    changed: true,
    session: { status: "ended", attachedPlanKey: "PLAN-1" },
    releasedClaims: { items: [grammarTask] },
  });
  expect(holderEnded.session.summary?.trim()).toBe(holderSummary);
  const afterEnd = failure(await as(holder, ["task", "claim", grammarTask, "--json"]), 2);
  expect(afterEnd.code).toBe("CONFLICT");

  // --- Eventual status and history, read without a Session.
  const noSession = { ...owner, cwd: worktreeA };
  const finalStatus = okData<{
    selectedSessionId: string | null;
    activePlans: { key: string; progress: Record<string, number> }[];
    liveSessions: { session: SessionDto }[];
    recentTerminalSessions: SessionDto[];
    overlaps: OverlapDto[];
  }>(await run(["status", "--json"], noSession));
  expect(finalStatus.selectedSessionId).toBeNull();
  expect(finalStatus.liveSessions).toEqual([]);
  expect(finalStatus.overlaps).toEqual([]);
  expect(finalStatus.activePlans).toEqual([
    expect.objectContaining({
      key: "PLAN-1",
      progress: { total: 2, todo: 0, inProgress: 1, blocked: 0, done: 1 },
    }),
  ]);
  expect(finalStatus.recentTerminalSessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: other.sessionId,
        status: "ended",
        summary: otherSummary,
        attachedPlanKey: "PLAN-1",
      }),
      expect.objectContaining({ id: holder.sessionId, status: "ended", attachedPlanKey: "PLAN-1" }),
    ]),
  );
  const statusHuman = await run(["status"], noSession);
  expect(statusHuman.status, describe(statusHuman)).toBe(0);
  expect(statusHuman.stdout).toContain("PLAN-1");

  const planLog = okData<{ items: EventDto[] }>(
    await run(["plan", "log", "PLAN-1", "--limit", "100", "--json"], noSession),
  );
  const messages = planLog.items
    .filter((event) => event.type === "plan.log_appended")
    .map((event) => event.payload.message);
  // Newest first.
  expect(messages).toEqual([takeover, progress]);
  expect(planLog.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "task.claimed",
        taskId: lexerTask,
        sessionId: other.sessionId,
        payload: expect.objectContaining({ stolenFromSessionId: holder.sessionId }),
      }),
      expect.objectContaining({
        type: "task.done",
        taskId: lexerTask,
        actorSessionId: other.sessionId,
      }),
      expect.objectContaining({ type: "session.attached", sessionId: a.sessionId }),
      expect.objectContaining({ type: "session.attached", sessionId: b.sessionId }),
    ]),
  );
  const planLogHuman = await run(["plan", "log", "PLAN-1"], noSession);
  expect(planLogHuman.status, describe(planLogHuman)).toBe(0);
  expect(planLogHuman.stdout).toContain(progress);
  expect(planLogHuman.stdout).toContain(takeover);

  for (const agent of [holder, other]) {
    // B reads through the proxy: history of either Session, whoever owns it.
    const shown = okData<{
      session: SessionDto;
      scopes: { items: ScopeDto[] };
      events: { items: EventDto[] };
    }>(await run(["session", "show", agent.sessionId, "--limit", "100", "--json"], b));
    expect(shown.session).toMatchObject({ status: "ended", attachedPlanKey: "PLAN-1" });
    expect(shown.session.summary?.trim()).toBe(agent === other ? otherSummary : holderSummary);
    const types = shown.events.items.map((event) => event.type);
    for (const type of [
      "session.started",
      "session.attached",
      "scope.added",
      "scope.touched",
      "session.heartbeat",
      "task.claimed",
      "session.ended",
    ]) {
      expect(types, `${agent.name}: ${types.join(", ")}`).toContain(type);
    }
    expect(shown.scopes.items.some((scope) => scope.source === "touched")).toBe(true);
  }
  const terminal = okData<{ items: SessionDto[] }>(
    await run(["session", "list", "--status", "terminal", "--json"], noSession),
  );
  expect(terminal.items.map((session) => session.id).sort()).toEqual(
    [a.sessionId, b.sessionId].sort(),
  );

  // --- Agent B's commands all went through the field-adding proxy.
  expect(proxy.changedAnswers()).toBeGreaterThan(20);
  // No secret was printed or passed as an argument (except the one intended
  // `key create` output on stdout).
  for (const entry of runner.transcript) {
    const ownOutput =
      entry.argv.includes("create") && entry.argv.includes("key")
        ? entry.stderr
        : `${entry.stdout}\n${entry.stderr}\n${entry.argv.join(" ")}`;
    expect(ownOutput).not.toContain(secret);
  }
});
