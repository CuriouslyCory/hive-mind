import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anyCliEnvelopeSchema,
  exitCodeForEnvelope,
  UNAVAILABLE_EVENT_TYPE,
  unavailableEventSchema,
} from "@hivemind/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileStore } from "../src/credentials/file.ts";
import { createCredentialManager } from "../src/credentials/manager.ts";
import { shippedBinary } from "./helpers/binaries.ts";
import { type FakeBackend, ORG_A, startFakeBackend, USER_TOKEN } from "./helpers/fake-backend.ts";
import { adrText, gitFixture } from "./helpers/git-fixture.ts";
import { expectGolden } from "./helpers/golden.ts";

/**
 * The shipped binary as an agent runs it: no TTY, and a stdin pipe that is
 * never closed (an agent harness often leaves it open). A command must not
 * wait on it unless it was given `-`; the timeout below turns a hang into a
 * failure instead of a stuck suite.
 */

const base = mkdtempSync(join(tmpdir(), "hivemind-coordination-bin-"));
let api: FakeBackend;
let projectId: string;
let home: string;
let cwd: string;
beforeAll(async () => {
  api = await startFakeBackend();
  home = join(base, "home");
  cwd = join(base, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const project = api.addProject(ORG_A.id, "bin");
  projectId = project.id;
  writeFileSync(join(cwd, ".hivemind.json"), JSON.stringify({ version: 1, projectId: project.id }));
  const file = createFileStore({ dir: join(home, ".config", "hivemind") });
  await createCredentialManager({ env: {}, interactive: false, file }).save(api.origin, USER_TOKEN);
});
afterAll(async () => {
  await api.close();
  rmSync(base, { recursive: true, force: true });
});

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the binary with stdin left open; `input`, when given, is written but stdin is still not closed. */
function hivemind(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: Buffer,
  dir = cwd,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(shippedBinary(), [...args, "--json"], {
      cwd: dir,
      timeout: 10_000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        HIVEMIND_URL: api.origin,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (input) child.stdin.write(input);
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function envelope(result: Result) {
  const lines = result.stdout.split("\n");
  expect(lines, result.stderr).toHaveLength(2);
  const parsed = anyCliEnvelopeSchema.parse(JSON.parse(lines[0] as string));
  expect(result.status).toBe(exitCodeForEnvelope(parsed));
  expect(result.stdout + result.stderr).not.toContain(USER_TOKEN);
  return parsed;
}

describe("compiled binary coordination commands", () => {
  it("never waits on an open stdin and prints one golden envelope per command", async () => {
    const started = envelope(
      await hivemind(["session", "start", "--agent", "ci", "--intent", "Check"]),
    );
    expectGolden(started, "cli.session-start.json");
    const sessionId = (started as { data: { session: { id: string } } }).data.session.id;
    const env = { HIVEMIND_SESSION: sessionId };

    const plan = envelope(
      await hivemind(["plan", "create", "--title", "Bin", "--status", "active"]),
    );
    expectGolden(plan, "cli.plan-create.json");
    const task = envelope(await hivemind(["task", "add", "PLAN-1", "--title", "T"], env)) as {
      data: { task: { id: string } };
    };
    expectGolden(
      envelope(await hivemind(["task", "claim", task.data.task.id], env)),
      "cli.task-claim.json",
    );
    expectGolden(envelope(await hivemind(["status"], env)), "cli.status.json");

    // `.git` here is an empty directory, not a repository: heartbeat still
    // renews and reports touched paths as unavailable.
    const beat = envelope(await hivemind(["session", "heartbeat"], env));
    expectGolden(beat, "cli.session-heartbeat.json");
    expect(beat).toMatchObject({ data: { touchedPathsAvailable: false, leaseRenewed: true } });

    // Too much text on a pipe that stays open: refused, and the process exits.
    const tooLong = await hivemind(
      ["plan", "create", "--title", "Big", "--body-file", "-"],
      {},
      Buffer.alloc(9000, 0x61),
    );
    expect(envelope(tooLong)).toMatchObject({ ok: false, error: { code: "USAGE_ERROR" } });

    const usage = envelope(await hivemind(["task", "start", task.data.task.id]));
    expect(usage).toMatchObject({ ok: false, error: { code: "USAGE_ERROR" } });
  });

  it("passes an Event the server cannot read through session log --json", async () => {
    const started = envelope(
      await hivemind(["session", "start", "--agent", "ci", "--intent", "Rollback"]),
    ) as { data: { session: { id: string } } };
    const sessionId = started.data.session.id;
    const env = { HIVEMIND_SESSION: sessionId };
    for (const title of ["One", "Two"])
      envelope(await hivemind(["plan", "create", "--title", title], env));
    // The middle Event as a server after a rollback returns one a newer
    // deployment wrote (ADR-0015, issue #15).
    const stored = api.coordination.events.find(
      (event) => event.actorSessionId === sessionId && event.type === "plan.created",
    );
    if (!stored) throw new Error("Expected the first plan.created Event.");
    Object.assign(stored, { projectId, type: UNAVAILABLE_EVENT_TYPE, payload: {} });

    const result = await hivemind(["session", "log", sessionId]);
    expect(result.status).toBe(0);
    const log = envelope(result) as { ok: true; data: { items: { type: string }[] } };
    expect(log.ok).toBe(true);
    expect(log.data.items.map((event) => event.type)).toEqual([
      "plan.created",
      UNAVAILABLE_EVENT_TYPE,
      "session.started",
    ]);
    expect(log.data.items[1]).toEqual(
      unavailableEventSchema.parse(JSON.parse(JSON.stringify(stored))),
    );
  });

  it("runs the adr commands without waiting on an open stdin or prompting", async () => {
    const repos = gitFixture(base).origin(
      { "docs/adr/0001-a.md": adrText("A"), "docs/adr/0002-b.md": adrText("B") },
      { projectId },
    );
    const missingTitle = await hivemind(["adr", "new"], {}, undefined, repos.work);
    expect(envelope(missingTitle)).toMatchObject({ ok: false, error: { code: "USAGE_ERROR" } });
    const created = await hivemind(["adr", "new", "--title", "Piped"], {}, undefined, repos.work);
    expect(envelope(created)).toMatchObject({ ok: true, data: { file: { status: "created" } } });
    const synced = await hivemind(["adr", "sync", "--force"], {}, undefined, repos.work);
    expect(envelope(synced)).toMatchObject({ ok: true, data: { outcome: "synced", forced: true } });
    const superseded = await hivemind(
      ["adr", "supersede", "1", "--by", "2"],
      {},
      undefined,
      repos.work,
    );
    expect(envelope(superseded)).toMatchObject({ ok: true, data: { changed: true } });
  });
});
