import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  anyCliEnvelopeSchema,
  compareTouchedPaths,
  exitCodeForEnvelope,
  touchedPathsContentHash,
  UNAVAILABLE_EVENT_TYPE,
  unavailableEventSchema,
} from "@hivemind/contract";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialManager } from "../src/credentials/manager.ts";
import { commandHarness } from "./helpers/commands.ts";
import {
  type FakeBackend,
  type FakeProject,
  ORG_A,
  startFakeBackend,
  USER_TOKEN,
} from "./helpers/fake-backend.ts";
import { expectGolden } from "./helpers/golden.ts";

const harness = commandHarness();
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hivemind-coordination-")));
afterAll(() => {
  harness.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: scratch,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV });
}

let api: FakeBackend;
let project: FakeProject;
/** A committed git repository bound to `project`, with a nested directory. */
let work: string;
let nested: string;
let counter = 0;

beforeEach(async () => {
  api = await startFakeBackend();
  await createCredentialManager({ env: {}, interactive: false, file: harness.file }).save(
    api.origin,
    USER_TOKEN,
  );
  project = api.addProject(ORG_A.id, "coord");
  work = join(scratch, `work-${counter++}`);
  nested = join(work, "packages", "app");
  mkdirSync(nested, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(
    join(work, ".hivemind.json"),
    JSON.stringify({ version: 1, projectId: project.id }),
  );
  writeFileSync(join(work, "README.md"), "hi\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
});
afterEach(async () => {
  await api.close();
});

type RunOptions = Parameters<typeof harness.run>[1];

function run(argv: string[], options: RunOptions = {}) {
  return harness.run([...argv, "--server", api.origin], {
    cwd: nested,
    env: { PATH: process.env.PATH, HOME: scratch },
    ...options,
  });
}

/** A value inside parsed JSON, by dotted path (`session.id`, `items.0.id`). */
function at<T = string>(value: unknown, path: string): T {
  let current = value;
  for (const key of path.split(".")) current = (current as Record<string, unknown>)[key];
  return current as T;
}

/** Runs with --json; checks one envelope line whose exit code agrees, and returns it. */
async function json(argv: string[], options: RunOptions = {}) {
  const result = await run([...argv, "--json"], options);
  const lines = result.stdout.split("\n");
  expect(lines, result.stdout + result.stderr).toHaveLength(2);
  const envelope = anyCliEnvelopeSchema.parse(JSON.parse(lines[0] as string));
  expect(result.code).toBe(exitCodeForEnvelope(envelope));
  const data = envelope.ok ? envelope.data : undefined;
  const error = envelope.ok ? undefined : envelope.error;
  return { ...result, envelope, data, error };
}

function withSession(sessionId: string): RunOptions {
  return { env: { PATH: process.env.PATH, HOME: scratch, HIVEMIND_SESSION: sessionId } };
}

async function startSession(intent = "Build the parser", options: RunOptions = {}) {
  const { data } = await json(
    ["session", "start", "--agent", "claude-code", "--intent", intent],
    options,
  );
  return at(data, "session.id");
}

async function activePlanWithTask() {
  const plan = await json(["plan", "create", "--title", "M2", "--status", "active"]);
  const planKey = at(plan.data, "plan.key");
  const task = await json(["task", "add", planKey, "--title", "Parser"]);
  return { planKey, planId: at(plan.data, "plan.id"), taskId: at(task.data, "task.id") };
}

const coordinationRequests = () =>
  api.requests.filter((request) => /\/projects\/[^/]+\/./.test(request.url));

describe("plan", () => {
  it("create matches the golden envelope; human mode prints only the key", async () => {
    const created = await json([
      "plan",
      "create",
      "--title",
      "M2 coordination",
      "--body",
      "## Goal\n",
      "--status",
      "active",
    ]);
    expectGolden(created.envelope, "cli.plan-create.json");
    expect(created.data).toMatchObject({
      created: true,
      plan: { key: "PLAN-1", status: "active" },
    });

    const human = await run(["plan", "create", "--title", "Second"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe("PLAN-2\n");
    expect(human.stderr).toContain("Created PLAN-2");
  });

  it("generates the id once and replays with --id; other input with that id is exit 2", async () => {
    const first = await json(["plan", "create", "--title", "Once"]);
    const id = at(first.data, "plan.id");
    const sent = JSON.parse(coordinationRequests().at(-1)?.body ?? "{}");
    expect(sent.planId).toBe(id);
    const replay = await json(["plan", "create", "--title", "Once", "--id", id]);
    expect(replay.data).toMatchObject({ created: false, plan: { id, key: "PLAN-1" } });
    const other = await json(["plan", "create", "--title", "Different", "--id", id]);
    expect(other.code).toBe(2);
    expect(other.error?.code).toBe("CONFLICT");
    expect((await json(["plan", "create", "--title", "x", "--id", "nope"])).code).toBe(1);
  });

  it("names the generated id and how to check it when the answer is lost", async () => {
    const lost = async (input: URL | Request | string, init?: RequestInit) => {
      await globalThis.fetch(input, init);
      return new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const human = await run(["plan", "create", "--title", "Lost"], { fetch: lost });
    expect(human.code).toBe(1);
    const id = [...api.coordination.plans.keys()][0] as string;
    expect(human.stderr).toContain(`hivemind plan show ${id}`);
    expect(human.stderr).toContain(`--id ${id}`);
    // Exactly one create was sent: nothing is retried.
    expect(coordinationRequests().filter((request) => request.method === "POST")).toHaveLength(1);

    const machine = await json(["plan", "create", "--title", "Lost again"], { fetch: lost });
    expect(machine.error?.code).toBe("INVALID_RESPONSE");
    expect(machine.error?.message).toContain("--id");
    expect(machine.stderr).toContain("may have been created anyway");

    const retried = await json(["plan", "create", "--title", "Lost", "--id", id]);
    expect(retried.data).toMatchObject({ created: false, plan: { id } });
  });

  it("treats a 5xx after the commit as uncertain for every create, and a 4xx as definitive", async () => {
    /** The request reaches the server and commits; the answer is replaced. */
    const committedThen =
      (answer: () => Response) => async (input: URL | Request | string, init?: RequestInit) => {
        await globalThis.fetch(input, init);
        return answer();
      };
    // A Vercel function timeout (text body) and a failed output check (oRPC JSON).
    const gatewayTimeout = committedThen(
      () => new Response("FUNCTION_INVOCATION_TIMEOUT", { status: 504 }),
    );
    const outputCheck = committedThen(() =>
      Response.json(
        { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "Failed." },
        { status: 500 },
      ),
    );
    const { planKey } = await activePlanWithTask();
    const creates = [
      ["plan", "create", "--title", "Slow"],
      ["task", "add", planKey, "--title", "Slow"],
      ["session", "start", "--agent", "a", "--intent", "Slow"],
      ["plan", "log", planKey, "--message", "Slow"],
      ["plan", "decide", planKey, "Slow"],
    ];
    for (const argv of creates) {
      for (const fetch of [gatewayTimeout, outputCheck]) {
        const failed = await json(argv, { fetch });
        expect(failed.code, argv.join(" ")).toBe(1);
        const id = /created anyway with id ([0-9a-f-]{36})\./.exec(failed.stderr)?.[1];
        expect(id, `${argv.join(" ")}: ${failed.stderr}`).toBeDefined();
        expect(failed.stderr).toContain(`--id ${id}`);
        // The record was committed: the named id replays it.
        const retried = await json([...argv, "--id", id as string]);
        expect(retried.data, argv.join(" ")).toMatchObject({ created: false });
      }
    }
    expect((await json(creates[0] as string[], { fetch: gatewayTimeout })).error?.code).toBe(
      "GATEWAY_TIMEOUT",
    );
    const human = await run(["plan", "create", "--title", "Slow"], { fetch: outputCheck });
    expect(human.code).toBe(1);
    expect(human.stderr).toMatch(/Check with 'hivemind plan show [0-9a-f-]{36}' before retrying/);

    // A documented 4xx means nothing was created: no recovery hint.
    const planId = [...api.coordination.plans.keys()][0] as string;
    const conflict = await json(["plan", "create", "--title", "Other", "--id", planId]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).not.toContain("may have been created");
    expect(conflict.error?.message).not.toContain("--id");
  });

  it("lists, shows with a page of Tasks, edits, logs and changes status", async () => {
    const { planKey, taskId } = await activePlanWithTask();
    const list = await json(["plan", "list", "--status", "active", "--limit", "10"]);
    expect(list.data).toMatchObject({ items: [{ key: planKey }], nextCursor: null });
    expect(coordinationRequests().at(-1)?.url).toContain("limit=10");

    const show = await json(["plan", "show", planKey.toLowerCase()]);
    expect(show.data).toMatchObject({ plan: { key: planKey }, tasks: { items: [{ id: taskId }] } });

    const edit = await json(["plan", "edit", planKey, "--title", "Renamed", "--clear-body"]);
    expect(edit.data).toMatchObject({ changed: true, plan: { title: "Renamed", body: null } });
    expect((await json(["plan", "edit", planKey])).code).toBe(1);

    const appended = await json(["plan", "log", planKey, "--message", "Split the work."]);
    expect(appended.data).toMatchObject({ created: true, event: { type: "plan.log_appended" } });
    const log = await json(["plan", "log", planKey]);
    expect(at(log.data, "items.0.type")).toBe("plan.log_appended");
    expect((await run(["plan", "log", planKey])).stdout).toContain("Split the work.");

    const paused = await json(["plan", "status", planKey, "paused"]);
    expect(paused.data).toMatchObject({ changed: true, plan: { status: "paused" } });
    expect((await json(["plan", "status", planKey, "draft"])).code).toBe(1);
    expect((await json(["plan", "show", "PLAN-99"])).code).toBe(4);
  });

  it("attributes writes to --session, then HIVEMIND_SESSION", async () => {
    const sessionId = await startSession();
    await json(["plan", "create", "--title", "Attributed"], withSession(sessionId));
    expect(JSON.parse(coordinationRequests().at(-1)?.body ?? "{}").sessionId).toBe(sessionId);
    await json(["plan", "create", "--title", "Plain"]);
    expect(JSON.parse(coordinationRequests().at(-1)?.body ?? "{}").sessionId).toBeUndefined();
  });
});

describe("plan decide", () => {
  it("matches the golden envelope, sends the trimmed text and shows it in plan log", async () => {
    const { planKey } = await activePlanWithTask();
    // The golden decision was recorded with a Project key.
    const key = await json(["key", "create", "--name", "agent"]);
    const asKey = {
      env: { PATH: process.env.PATH, HOME: scratch, HIVEMIND_TOKEN: at(key.data, "secret") },
    };
    const decided = await json(
      ["plan", "decide", planKey, "  Retry with jittered backoff.  "],
      asKey,
    );
    expectGolden(decided.envelope, "cli.plan-decide.json");
    expect(decided.data).toMatchObject({
      created: true,
      event: { type: "plan.decision_recorded", payload: { text: "Retry with jittered backoff." } },
    });
    const sent = JSON.parse(coordinationRequests().at(-1)?.body ?? "{}");
    expect(coordinationRequests().at(-1)?.url).toMatch(/\/plans\/PLAN-1\/decisions$/);
    expect(sent).toEqual({
      eventId: at(decided.data, "event.id"),
      text: "Retry with jittered backoff.",
    });

    const log = await json(["plan", "log", planKey]);
    expect(at(log.data, "items.0.type")).toBe("plan.decision_recorded");
    expect((await run(["plan", "log", planKey])).stdout).toMatch(
      /plan\.decision_recorded {2}Retry with jittered backoff\.\n/,
    );

    const human = await run(["plan", "decide", planKey.toLowerCase(), "Cap at 30 seconds."]);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/^Recorded decision [0-9a-f-]{36}\.\n$/);
  });

  it("generates the id once and replays with --id; other text with that id is exit 2", async () => {
    const { planKey } = await activePlanWithTask();
    const first = await json(["plan", "decide", planKey, "Once"]);
    const id = at(first.data, "event.id");
    expect(JSON.parse(coordinationRequests().at(-1)?.body ?? "{}").eventId).toBe(id);
    const replay = await json(["plan", "decide", planKey, "Once", "--id", id]);
    expect(replay.data).toMatchObject({ created: false, event: { id } });
    expect((await run(["plan", "decide", planKey, "Once", "--id", id])).stdout).toBe(
      `Already recorded decision ${id}.\n`,
    );
    const other = await json(["plan", "decide", planKey, "Different", "--id", id]);
    expect(other.code).toBe(2);
    expect(other.error?.code).toBe("CONFLICT");
  });

  it("names the generated id and plan log when the answer is lost", async () => {
    const { planKey } = await activePlanWithTask();
    const lost = async (input: URL | Request | string, init?: RequestInit) => {
      await globalThis.fetch(input, init);
      return new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const human = await run(["plan", "decide", planKey, "Lost"], { fetch: lost });
    expect(human.code).toBe(1);
    const id = /created anyway with id ([0-9a-f-]{36})\./.exec(human.stderr)?.[1];
    expect(id, human.stderr).toBeDefined();
    expect(human.stderr).toContain(`Check with 'hivemind plan log ${planKey}'`);
    expect(human.stderr).toContain(`--id ${id}`);
    const retried = await json(["plan", "decide", planKey, "Lost", "--id", id as string]);
    expect(retried.data).toMatchObject({ created: false, event: { id } });
  });

  it("rejects blank, multi-line or oversized text, and a bad plan or --id, before sending", async () => {
    const { planKey } = await activePlanWithTask();
    const before = coordinationRequests().length;
    const usage = async (argv: string[], message: string, options: RunOptions = {}) => {
      const failed = await json(argv, options);
      expect(failed.code, argv.join(" ")).toBe(1);
      expect(failed.error?.code).toBe("USAGE_ERROR");
      expect(failed.error?.message).toContain(message);
    };
    await usage(["plan", "decide", planKey, "   "], "<text> is blank");
    await usage(["plan", "decide", planKey, "First line\nsecond"], "one line");
    await usage(["plan", "decide", planKey, "First line second"], "one line");
    await usage(["plan", "decide", planKey, "First line second"], "one line");
    await usage(["plan", "decide", planKey, "Tab\there"], "control characters");
    await usage(["plan", "decide", planKey, "x".repeat(501)], "at most 500");
    await usage(["plan", "decide", planKey], "Missing <text>");
    await usage(["plan", "decide", planKey, "Retry", "with", "backoff"], "Too many arguments");
    await usage(["plan", "decide", "PLAN-0", "Retry"], "<plan> must be a Plan key");
    await usage(["plan", "decide", planKey, "Retry", "--id", "nope"], "--id must be a uuid");
    await usage(
      ["plan", "decide", planKey, "Retry"],
      "HIVEMIND_SESSION must be a Session id",
      withSession("not-a-uuid"),
    );
    expect(coordinationRequests()).toHaveLength(before);

    // 500 characters after trimming is the limit, not over it.
    const longest = await json(["plan", "decide", planKey, ` ${"x".repeat(500)} `]);
    expect(longest.data).toMatchObject({ created: true });
    expect((await json(["plan", "decide", "PLAN-99", "Retry"])).code).toBe(4);
  });

  it("attributes the decision to --session, then HIVEMIND_SESSION", async () => {
    const { planKey } = await activePlanWithTask();
    const sessionId = await startSession();
    const decided = await json(["plan", "decide", planKey, "Attributed"], withSession(sessionId));
    expect(JSON.parse(coordinationRequests().at(-1)?.body ?? "{}").sessionId).toBe(sessionId);
    expect(decided.data).toMatchObject({ event: { actorSessionId: sessionId } });
    await json(["plan", "decide", planKey, "Plain"]);
    expect(JSON.parse(coordinationRequests().at(-1)?.body ?? "{}").sessionId).toBeUndefined();
  });

  it("explains itself in --help", async () => {
    const help = await run(["plan", "decide", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("hivemind plan decide <plan> <text>");
    expect(help.stdout).toContain("Decisions panel");
  });
});

describe("text input", () => {
  it("rejects both flags, oversized or binary files, and blank text before sending", async () => {
    const file = join(scratch, `body-${counter++}.md`);
    writeFileSync(file, "x".repeat(8 * 1024 + 1));
    const binary = join(scratch, `bin-${counter++}`);
    writeFileSync(binary, Buffer.from([0x68, 0xff, 0x69]));
    const before = coordinationRequests().length;
    for (const extra of [
      ["--body", "a", "--body-file", file],
      ["--body-file", file],
      ["--body-file", binary],
      ["--body", "   "],
      ["--body", "bell\u0007"],
      ["--body-file", join(scratch, "missing.md")],
    ]) {
      const result = await json(["plan", "create", "--title", "T", ...extra]);
      expect(result.code, extra.join(" ")).toBe(1);
      expect(result.error?.message).not.toContain(scratch);
    }
    expect(coordinationRequests()).toHaveLength(before);
  });

  it("reads stdin only for an explicit -, within 8 KiB", async () => {
    const text = "## From stdin\n\nline two\n";
    const ok = await json(["plan", "create", "--title", "T", "--body-file", "-"], {
      stdin: Readable.from([Buffer.from(text)]),
    });
    expect(at(ok.data, "plan.body")).toBe(text);
    const big = await json(["plan", "create", "--title", "T", "--body-file", "-"], {
      stdin: Readable.from([Buffer.alloc(8 * 1024 + 1, 0x61)]),
    });
    expect(big.code).toBe(1);
    expect(big.error?.message).toContain("8192 bytes");
  });

  it("never waits on an open stdin unless - is given, and - is cancellable", async () => {
    const open = new PassThrough();
    const result = await json(["plan", "create", "--title", "No stdin"], { stdin: open });
    expect(result.code).toBe(0);

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("received SIGINT")), 50);
    const waiting = await json(["plan", "log", "PLAN-1", "--message-file", "-"], {
      stdin: open,
      signal: controller.signal,
    });
    expect(waiting.error?.code).toBe("CANCELLED");
    open.destroy();
  });
});

describe("Session resolution", () => {
  it("prefers --session over HIVEMIND_SESSION and validates both locally", async () => {
    const { taskId } = await activePlanWithTask();
    const mine = await startSession("mine");
    const other = await startSession("other");
    await json(["task", "claim", taskId, "--session", mine], withSession(other));
    expect(api.coordination.tasks.get(taskId)?.claim?.sessionId).toBe(mine);

    const before = coordinationRequests().length;
    const missing = await json(["task", "start", taskId]);
    expect(missing.error).toMatchObject({ code: "USAGE_ERROR" });
    expect(missing.error?.message).toContain("HIVEMIND_SESSION");
    expect((await json(["task", "start", taskId], withSession(""))).code).toBe(1);
    const malformed = await json(["task", "start", taskId], withSession("not-a-uuid"));
    expect(malformed.error?.message).toContain("HIVEMIND_SESSION must be a Session id");
    expect((await json(["task", "start", taskId, "--session", "x"])).code).toBe(1);
    expect(coordinationRequests()).toHaveLength(before);

    const started = await json(["task", "start", taskId], withSession(mine));
    expect(started.data).toMatchObject({ changed: true, task: { status: "in_progress" } });
  });
});

describe("task", () => {
  it("claim matches the golden envelope; a live holder is exit 2 naming it; --steal takes over", async () => {
    const { taskId } = await activePlanWithTask();
    const holder = await startSession("Run the coordination checks");
    const claimed = await json(["task", "claim", taskId], withSession(holder));
    expectGolden(claimed.envelope, "cli.task-claim.json");

    const rival = await startSession("rival");
    const refused = await json(["task", "claim", taskId], withSession(rival));
    expectGolden(refused.envelope, "cli.error.task-claimed.json");
    expect(refused.code).toBe(2);
    expect(refused.error?.message).toContain(
      `The Task is claimed by Session ${holder} (intent: "Run the coordination checks").`,
    );
    const human = await run(["task", "claim", taskId], withSession(rival));
    expect(human.stderr).toContain(`Session ${holder}`);

    const stolen = await json(["task", "claim", taskId, "--steal"], withSession(rival));
    expect(stolen.data).toMatchObject({ changed: true, stolenFromSessionId: holder });
    expect(stolen.stderr).toContain(`from Session ${holder}`);
    expect(JSON.parse(coordinationRequests().at(-1)?.body ?? "{}")).toEqual({
      sessionId: rival,
      steal: true,
    });
    const formerLog = await run(["session", "log", holder]);
    expect(formerLog.stdout).toContain(
      `task.released  Session ${rival}  reason stolen, from Session ${holder}`,
    );
    expect((await run(["session", "log", rival])).stdout).toContain(
      `task.claimed  Session ${rival}  from Session ${holder}`,
    );
    const release = api.coordination.events.find((event) => event.type === "task.released");
    expect(release).toBeDefined();
    if (!release) throw new Error("Expected the stolen release Event.");
    release.actorSessionId = null;
    release.actor = { kind: "system" };
    release.payload = { reason: "lease_expired" };
    expect((await run(["session", "log", holder])).stdout).toContain(
      `task.released  reason lease_expired, from Session ${holder}`,
    );
    release.actorSessionId = holder;
    release.payload = { reason: "released" };
    expect((await run(["session", "log", holder])).stdout).toContain(
      `task.released  Session ${holder}  reason released\n`,
    );
  });

  it("adds, starts, blocks with a reason from stdin, finishes and releases", async () => {
    const { planKey, taskId } = await activePlanWithTask();
    const added = await run(["task", "add", planKey, "--title", "Docs"]);
    expect(added.stdout).toMatch(/^[0-9a-f-]{36}\n$/);
    const session = await startSession();
    const as = withSession(session);
    await json(["task", "claim", taskId], as);
    expect((await json(["task", "start", taskId], as)).data).toMatchObject({ changed: true });
    const blocked = await json(["task", "block", taskId, "--reason-file", "-"], {
      ...as,
      stdin: Readable.from([Buffer.from("Waits for the schema\n")]),
    });
    expect(blocked.data).toMatchObject({
      task: { status: "blocked", blockedReason: "Waits for the schema\n" },
    });
    expect((await json(["task", "block", taskId], as)).code).toBe(1);
    expect((await json(["task", "release", taskId], as)).data).toMatchObject({ changed: true });
    expect((await json(["task", "release", taskId], as)).data).toMatchObject({ changed: false });
    await json(["task", "claim", taskId], as);
    expect((await json(["task", "done", taskId], as)).data).toMatchObject({
      task: { status: "done", claim: null },
    });
    expect((await json(["task", "claim", "not-a-uuid"], as)).code).toBe(1);
  });
});

describe("session", () => {
  it("start matches the golden envelope, prints the id, and says how to export it", async () => {
    const started = await json([
      "session",
      "start",
      "--agent",
      "claude-code",
      "--intent",
      "Define",
    ]);
    expectGolden(started.envelope, "cli.session-start.json");
    const id = at(started.data, "session.id");
    const sent = JSON.parse(coordinationRequests().at(-1)?.body ?? "{}");
    expect(sent).toMatchObject({ sessionId: id, agent: "claude-code", gitBranch: "main" });
    expect(sent.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(started.stderr).toContain(`export HIVEMIND_SESSION=${id}`);

    const human = await run(["session", "start", "--agent", "a", "--intent", "b"]);
    expect(human.stdout).toMatch(/^[0-9a-f-]{36}\n$/);
    expect(human.stderr).toContain(`export HIVEMIND_SESSION=${human.stdout.trim()}`);
    expect((await json(["session", "start", "--agent", "a"])).code).toBe(1);
  });

  it("records no git metadata outside git, explicitly", async () => {
    const plain = join(scratch, `plain-${counter++}`);
    mkdirSync(plain);
    const started = await json(
      ["session", "start", "--agent", "a", "--intent", "b", "--project", project.id],
      { cwd: plain },
    );
    expect(started.data).toMatchObject({ session: { gitBranch: null, gitCommit: null } });
    const sent = JSON.parse(coordinationRequests().at(-1)?.body ?? "{}");
    expect(sent.gitBranch).toBeUndefined();
    expect(started.stderr).toContain("Not in a git worktree");
  });

  it("updates, attaches, lists, shows and ends", async () => {
    const { planKey, taskId } = await activePlanWithTask();
    const id = await startSession();
    const as = withSession(id);
    const updated = await json(
      ["session", "update", "--intent", "Now tests", "--status", "idle"],
      as,
    );
    expect(updated.data).toMatchObject({
      changed: true,
      session: { intent: "Now tests", status: "idle" },
    });
    expect((await json(["session", "update"], as)).code).toBe(1);
    expect((await json(["session", "update", "--status", "stale"], as)).code).toBe(1);

    const attached = await json(["session", "attach", "--plan", planKey, "--task", taskId], as);
    expect(attached.data).toMatchObject({
      session: { attachedPlanKey: planKey, attachedTaskId: taskId },
    });
    expect((await json(["session", "attach", "--task", taskId], as)).code).toBe(1);
    const detached = await json(["session", "attach", "--detach"], as);
    expect(detached.data).toMatchObject({ session: { attachedPlanId: null } });
    expect(JSON.parse(coordinationRequests().at(-1)?.body ?? "{}")).toEqual({ planRef: null });

    const list = await json(["session", "list", "--status", "live"]);
    expect(at(list.data, "items.0.id")).toBe(id);
    const show = await json(["session", "show", id]);
    expect(show.data).toMatchObject({
      session: { id },
      claims: { items: [] },
      scopes: { items: [] },
    });
    expect(at<unknown[]>(show.data, "events.items").length).toBeGreaterThan(0);

    const ended = await json(["session", "end", "--summary", "Done."], as);
    expect(ended.data).toMatchObject({ changed: true, session: { status: "ended" } });
    expect((await json(["session", "end", "--summary", "Done."], as)).data).toMatchObject({
      changed: false,
    });
    expect((await json(["session", "end", "--summary", "Other."], as)).code).toBe(2);
    expect((await json(["session", "end"], as)).code).toBe(1);
  });

  it("pages Session claims to the end and session show points to the next page", async () => {
    const { planKey, taskId } = await activePlanWithTask();
    const id = await startSession();
    const as = withSession(id);
    const added = await json(["task", "add", planKey, "--title", "Docs"]);
    const otherId = at(added.data, "task.id");
    await json(["task", "claim", taskId], as);
    await json(["task", "claim", otherId], as);
    const first = await json(["session", "claims", "--limit", "1"], as);
    const cursor = at(first.data, "nextCursor");
    expect(cursor).toEqual(expect.any(String));
    expect((await run(["session", "show", id, "--limit", "1"])).stdout).toContain(
      `More: hivemind session claims --session ${id} --cursor ${cursor}`,
    );
    const seen = [at(first.data, "items.0.id")];
    let next: string | null = cursor;
    while (next !== null) {
      const page = await json(["session", "claims", id, "--limit", "1", "--cursor", next]);
      expect(coordinationRequests().at(-1)?.url).toContain(`cursor=${next}`);
      seen.push(at(page.data, "items.0.id"));
      next = at<string | null>(page.data, "nextCursor");
    }
    expect(seen).toEqual([taskId, otherId]);
    expect((await json(["session", "claims", id, "--session", id])).code).toBe(1);
    const empty = await startSession();
    expect((await run(["session", "claims", empty])).stdout).toBe("No claims.\n");
    expect((await run(["session", "claims", "--help"])).stdout).toContain(
      "start again without --cursor",
    );
  });

  it("pages older Session Events with session log, which session show points to", async () => {
    const id = await startSession();
    const as = withSession(id);
    // Attributed writes are Session Events too.
    for (const title of ["One", "Two"]) await json(["plan", "create", "--title", title], as);
    const all = await json(["session", "log", id, "--limit", "100"]);
    const total = at<unknown[]>(all.data, "items").length;
    expect(total).toBeGreaterThanOrEqual(3);

    const show = await json(["session", "show", id, "--limit", "1"]);
    const cursor = at(show.data, "events.nextCursor");
    expect(cursor).toEqual(expect.any(String));
    expect((await run(["session", "show", id, "--limit", "1"])).stdout).toContain(
      `More: hivemind session log --session ${id} --cursor ${cursor}`,
    );

    // The Session comes from HIVEMIND_SESSION here, and pages follow nextCursor to the end.
    const first = await json(["session", "log", "--limit", "1"], as);
    expect(first.data).toMatchObject({ nextCursor: cursor });
    const seen = [at<number>(first.data, "items.0.seq")];
    let next: string | null = cursor;
    while (next !== null) {
      const page = await json(["session", "log", id, "--limit", "1", "--cursor", next]);
      expect(coordinationRequests().at(-1)?.url).toContain(`cursor=${next}`);
      seen.push(at<number>(page.data, "items.0.seq"));
      next = at<string | null>(page.data, "nextCursor");
    }
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));

    // Human Event lines name the actor as a Session (CONTEXT.md naming).
    expect((await run(["session", "log", id])).stdout).toContain(`  Session ${id}`);
    expect((await json(["session", "log", id, "--cursor", "not a cursor!"])).code).toBe(1);
    expect((await json(["session", "log", id, "--session", id])).code).toBe(1);
  });

  it("reads an Event the server cannot read in session log, session show and plan log", async () => {
    const id = await startSession();
    const as = withSession(id);
    for (const title of ["One", "Two"]) await json(["plan", "create", "--title", title], as);
    // The middle Event as a server after a rollback returns one a newer
    // deployment wrote: its type and payload withheld (ADR-0015, issue #15).
    const stored = api.coordination.events.find((event) => event.type === "plan.created");
    if (!stored) throw new Error("Expected the first plan.created Event.");
    Object.assign(stored, { projectId: project.id, type: UNAVAILABLE_EVENT_TYPE, payload: {} });
    const expected = unavailableEventSchema.parse(JSON.parse(JSON.stringify(stored)));
    const line = `${stored.createdAt}  #${stored.seq}  event.unavailable  Session ${id}\n`;
    const mixed = ["plan.created", UNAVAILABLE_EVENT_TYPE, "session.started"];

    const log = await json(["session", "log", id]);
    expect(log.code).toBe(0);
    const items = at<{ type: string }[]>(log.data, "items");
    expect(items.map((event) => event.type)).toEqual(mixed);
    expect(items[1]).toEqual(expected);
    const human = await run(["session", "log", id]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(line);
    expect(human.stdout).toMatch(/ {2}#\d+ {2}plan\.created {2}Session /);
    expect(human.stdout).toMatch(/ {2}#\d+ {2}session\.started {2}Session /);

    const show = await json(["session", "show", id]);
    expect(show.code).toBe(0);
    const shown = at<{ type: string }[]>(show.data, "events.items");
    expect(shown.map((event) => event.type)).toEqual(mixed);
    expect(shown[1]).toEqual(expected);
    const showHuman = await run(["session", "show", id]);
    expect(showHuman.code).toBe(0);
    expect(showHuman.stdout).toContain(`Events:\n`);
    expect(showHuman.stdout).toContain(line);

    const planLog = await json(["plan", "log", "PLAN-1"]);
    expect(planLog.code).toBe(0);
    expect(at<unknown[]>(planLog.data, "items")).toEqual([expected]);
    expect((await run(["plan", "log", "PLAN-1"])).stdout).toBe(line);
  });
});

describe("scope", () => {
  it("adds one quoted glob per run, lists, checks overlaps and removes", async () => {
    const mine = await startSession("mine");
    const other = await startSession("other");
    const added = await json(["scope", "add", "packages/db/**"], withSession(mine));
    expect(added.data).toMatchObject({ created: true, scope: { value: "packages/db/**" } });
    await json(["scope", "add", "packages/db/**"], withSession(other));
    // A leading dash is a pattern after `--`, not an option.
    const dashed = await harness.run(
      ["scope", "add", "--server", api.origin, "--json", "--", "-weird/*.ts"],
      { cwd: nested, ...withSession(mine) },
    );
    expect(JSON.parse(dashed.stdout)).toMatchObject({ data: { scope: { value: "-weird/*.ts" } } });

    const before = coordinationRequests().length;
    for (const bad of ["/abs/**", "a/../b", "{a,b}/x", "!neg", "a/b**"]) {
      expect((await json(["scope", "add", bad], withSession(mine))).code, bad).toBe(1);
    }
    expect((await json(["scope", "add", "a", "b"], withSession(mine))).code).toBe(1);
    expect(coordinationRequests()).toHaveLength(before);

    const check = await json(["scope", "check"], withSession(mine));
    expect(check.data).toMatchObject({
      sessionId: mine,
      complete: true,
      items: [{ otherSessionId: other, kind: "overlap", witness: "packages/db/x" }],
    });
    expect((await run(["scope", "check"], withSession(mine))).stdout).toContain("Overlap:");

    const list = await json(["scope", "list", "--source", "declared"], withSession(mine));
    const scopeId = at(list.data, "items.0.id");
    const removed = await json(["scope", "remove", scopeId], withSession(mine));
    expect(removed.data).toMatchObject({ removed: true });
    expect((await json(["scope", "remove", scopeId], withSession(mine))).data).toMatchObject({
      removed: false,
    });
  });

  it("continues scope check from --cursor", async () => {
    const mine = await startSession("mine");
    await json(["scope", "add", "src/**"], withSession(mine));
    // Stand-in for a check that stopped after 20 pages: the server's cursor resumes it.
    const resumed = await json(["scope", "check", "--cursor", "o0"], withSession(mine));
    expect(resumed.data).toMatchObject({ sessionId: mine, nextCursor: null, complete: true });
    expect(coordinationRequests().at(-1)?.url).toContain("cursor=o0");
    expect(
      (await json(["scope", "check", "--cursor", "bad cursor!"], withSession(mine))).code,
    ).toBe(1);
  });

  it("names the next cursor when the check stops after 20 pages", async () => {
    const mine = await startSession("mine");
    let pages = 0;
    const endless = async (input: URL | Request | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/overlaps")) return globalThis.fetch(input, init);
      pages++;
      return Response.json({
        items: [],
        nextCursor: `o${pages * 100}`,
        complete: true,
        incompleteSessionIds: [],
      });
    };
    const check = await json(["scope", "check"], { ...withSession(mine), fetch: endless });
    expect(pages).toBe(20);
    expect(check.data).toMatchObject({ complete: false, nextCursor: "o2000" });
    const human = await run(["scope", "check"], { ...withSession(mine), fetch: endless });
    expect(human.stdout).toContain("More: --cursor o4000");
  });
});

describe("status", () => {
  it("matches the golden envelope; without a Session myClaims is [] and none is chosen", async () => {
    const { taskId } = await activePlanWithTask();
    const id = await startSession();
    await json(["task", "claim", taskId], withSession(id));
    await json(["scope", "add", "src/**"], withSession(id));

    const anonymous = await json(["status"]);
    expect(anonymous.data).toMatchObject({ selectedSessionId: null, myClaims: [] });
    expect(coordinationRequests().at(-1)?.url).not.toContain("sessionId");

    const selected = await json(["status"], withSession(id));
    expectGolden(selected.envelope, "cli.status.json");
    expect(selected.data).toMatchObject({ selectedSessionId: id, myClaims: [{ id: taskId }] });
    expect((await json(["status", "--brief"], withSession(id))).data).toEqual(
      selected.data && {
        ...selected.data,
        asOf: expect.any(String),
      },
    );

    const full = await run(["status"], withSession(id));
    expect(full.stdout).toContain("Active Plans:");
    expect(full.stdout).toContain("(selected)");
    const truncated: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const body = (await response.json()) as { complete: { myClaims: boolean } };
      body.complete.myClaims = false;
      return Response.json(body);
    };
    const more = await run(["status", "--session", id], { fetch: truncated });
    expect(more.stdout).toContain(`(more: hivemind session claims --session ${id})`);
    const brief = await run(["status", "--brief"]);
    expect(brief.stdout.split("\n")[0]).toMatch(/^1 active Plans, 1 live Sessions/);
  });

  it("escapes control characters from the server in human output", async () => {
    await json(["plan", "create", "--title", "Evil", "--status", "active"]);
    const plan = [...api.coordination.plans.values()][0];
    if (plan) plan.title = "Evil\u001b[2J\nforged";
    const result = await run(["status"]);
    expect(result.stdout).toContain("Evil\\x1b[2J\\nforged");
    expect(result.stdout).not.toContain("\u001b");
  });
});

describe("session heartbeat", () => {
  async function heartbeatSetup() {
    const id = await startSession();
    return { id, as: withSession(id) };
  }

  it("renews first, then uploads sorted touched paths and finalizes", async () => {
    const { id, as } = await heartbeatSetup();
    writeFileSync(join(work, "README.md"), "changed\n");
    writeFileSync(join(nested, "new file.ts"), "x");
    writeFileSync(join(work, "line\nbreak"), "x");
    git(work, "mv", "README.md", "MOVED.md");
    const before = api.requests.length;
    const result = await json(["session", "heartbeat"], as);
    expectGolden(result.envelope, "cli.session-heartbeat.json");
    const paths = ["MOVED.md", "README.md", "line\nbreak", "packages/app/new file.ts"].sort(
      compareTouchedPaths,
    );
    expect(result.data).toMatchObject({
      leaseRenewed: true,
      touchedPathsAvailable: true,
      collectionError: null,
      pathCount: 4,
      collection: { finalized: true, collectionComplete: true, scopeComplete: true },
    });

    const steps = api.requests.slice(before).map((request) => request.url.split("/").at(-1));
    expect(steps).toEqual(["heartbeat", "manifest", "batches", "finalize"]);
    const manifest = JSON.parse(api.requests[before + 1]?.body ?? "{}");
    expect(manifest).toEqual({
      pathCount: 4,
      batchCount: 1,
      omittedPathCount: 0,
      contentHash: await touchedPathsContentHash(paths),
    });
    expect(JSON.parse(api.requests[before + 2]?.body ?? "{}")).toEqual({ batchIndex: 0, paths });
    const touched = [...api.coordination.scopes.values()].filter((scope) => scope.sessionId === id);
    expect(touched.map((scope) => scope.value).sort(compareTouchedPaths)).toEqual(paths);
  });

  it("uploads more than 16 paths in deterministic batches, and an empty worktree as zero", async () => {
    const { as } = await heartbeatSetup();
    const empty = await json(["session", "heartbeat"], as);
    expect(empty.data).toMatchObject({
      pathCount: 0,
      collection: { batchCount: 0, finalized: true },
    });

    for (let i = 0; i < 40; i++) writeFileSync(join(work, `f-${i}.txt`), "x");
    const before = api.requests.length;
    const many = await json(["session", "heartbeat"], as);
    expect(many.data).toMatchObject({
      pathCount: 40,
      collection: { batchCount: 3, receivedBatchCount: 3 },
    });
    const batches = api.requests
      .slice(before)
      .filter((request) => request.url.endsWith("/batches"))
      .map((request) => JSON.parse(request.body) as { batchIndex: number; paths: string[] });
    expect(batches.map((batch) => [batch.batchIndex, batch.paths.length])).toEqual([
      [0, 16],
      [1, 16],
      [2, 8],
    ]);
    const flat = batches.flatMap((batch) => batch.paths);
    expect(flat).toEqual([...flat].sort(compareTouchedPaths));
  });

  it("counts paths it cannot send and names the 1,024-path cap", async () => {
    const { as } = await heartbeatSetup();
    writeFileSync(join(work, "ok.txt"), "x");
    // Over 256 bytes as a repository path, though each name fits the filesystem.
    mkdirSync(join(work, "d".repeat(200)));
    writeFileSync(join(work, "d".repeat(200), "f".repeat(100)), "x");
    const result = await json(["session", "heartbeat"], as);
    expect(result.data).toMatchObject({ pathCount: 1, omittedPathCount: 1 });
    expect(result.stderr).toContain(
      "1 changed paths cannot be sent (not UTF-8, longer than 256 bytes, or beyond the first 1,024 paths)",
    );
  });

  it("works outside git and says touched paths are unavailable", async () => {
    const { as } = await heartbeatSetup();
    const plain = join(scratch, `plain-${counter++}`);
    mkdirSync(plain);
    const before = api.requests.length;
    const result = await json(["session", "heartbeat", "--project", project.id], {
      ...as,
      cwd: plain,
    });
    expect(result.data).toMatchObject({
      leaseRenewed: true,
      touchedPathsAvailable: false,
      collection: null,
    });
    expect(result.stderr).toContain("Not a git worktree");
    expect(api.requests.slice(before).map((request) => request.url.split("/").at(-1))).toEqual([
      "heartbeat",
    ]);
    const resume = await json(
      ["session", "heartbeat", "--project", project.id, "--collection-id", project.id],
      { ...as, cwd: plain },
    );
    expect(resume.error?.code).toBe("USAGE_ERROR");
  });

  it("reports a failed upload after renewal, then resumes it with --collection-id", async () => {
    const { as } = await heartbeatSetup();
    for (let i = 0; i < 20; i++) writeFileSync(join(work, `g-${i}.txt`), "x");
    let failBatches = true;
    const flaky = async (input: URL | Request | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (failBatches && url.endsWith("/batches") && url.includes("collections")) {
        const body = String(init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "");
        if (body.includes('"batchIndex":1')) throw new TypeError("fetch failed");
      }
      return globalThis.fetch(input, init);
    };
    const failed = await json(["session", "heartbeat"], { ...as, fetch: flaky });
    expect(failed.code).toBe(0);
    const collectionId = at(failed.data, "collectionId");
    expect(failed.data).toMatchObject({
      leaseRenewed: true,
      collectionError: { step: "batch", code: "NETWORK_ERROR" },
      collection: { receivedBatchCount: 1, finalized: false },
    });
    expect(failed.stderr).toContain(`--collection-id ${collectionId}`);
    expect(failed.stderr).toContain("leases renewed");
    // The next heartbeat would make the lost coverage permanent: resume first.
    expect(failed.stderr).toContain("before the next heartbeat");
    expect(failed.stderr).toContain("incomplete until it ends");
    expect(failed.stderr).not.toContain("wait for the next heartbeat");

    failBatches = false;
    const before = api.requests.length;
    const resumed = await json(["session", "heartbeat", "--collection-id", collectionId], as);
    expect(resumed.data).toMatchObject({
      heartbeat: null,
      leaseRenewed: false,
      collectionError: null,
      collection: { collectionId, finalized: true, scopeComplete: true },
    });
    expect(api.requests.slice(before).map((request) => request.url.split("/").at(-1))).toEqual([
      "manifest",
      "batches",
      "batches",
      "finalize",
    ]);
    const statusClash = await json(
      ["session", "heartbeat", "--collection-id", collectionId, "--status", "idle"],
      as,
    );
    expect(statusClash.code).toBe(1);

    // A newer heartbeat replaced it: resuming the old one is CONFLICT.
    await json(["session", "heartbeat"], as);
    const stale = await json(["session", "heartbeat", "--collection-id", collectionId], as);
    expect(stale.code).toBe(2);
    expect(stale.error?.message).toContain("manifest");
  });

  it("ends with CANCELLED on an interrupt during the upload, naming the resume command", async () => {
    const { as } = await heartbeatSetup();
    writeFileSync(join(work, "dirty.txt"), "x");
    const controller = new AbortController();
    const interrupting = async (input: URL | Request | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/manifest")) {
        controller.abort(new Error("received SIGINT"));
        throw new DOMException("aborted", "AbortError");
      }
      return globalThis.fetch(input, init);
    };
    const result = await json(["session", "heartbeat"], {
      ...as,
      fetch: interrupting,
      signal: controller.signal,
    });
    expect(result.error?.code).toBe("CANCELLED");
    expect(result.error?.message).toContain("--collection-id");
    expect(result.error?.message).toContain("leases renewed");
    expect(result.error?.message).toContain("before the next heartbeat");
    expect(result.error?.message).not.toContain("run a new heartbeat");
  });

  it("fails as a whole when the heartbeat itself fails, before any git work", async () => {
    const { as } = await heartbeatSetup();
    await json(["session", "end", "--summary", "bye"], as);
    writeFileSync(join(work, "dirty.txt"), "x");
    const before = api.requests.length;
    const result = await json(["session", "heartbeat"], as);
    expect(result.code).toBe(2);
    expect(api.requests.slice(before)).toHaveLength(1);
  });
});
