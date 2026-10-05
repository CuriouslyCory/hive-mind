import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeFailure } from "../src/cli.ts";
import { TRACKER_COMMAND_NAMES } from "../src/input.ts";

// Runs the CLI the way `pnpm tracker` does: Node with type stripping, on the
// source file. That also proves everything it imports loads without a build.
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let testDb: TestDatabase;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { input?: string; env?: Record<string, string | undefined> } = {},
): Promise<CliResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: testDb.url,
    ...options.env,
  };
  delete env.VERCEL_ENV;
  if (options.env?.VERCEL_ENV !== undefined) env.VERCEL_ENV = options.env.VERCEL_ENV;
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

function json(text: string): unknown {
  return JSON.parse(text);
}

function expectFailure(result: CliResult, code: number, kind: string, message?: RegExp) {
  expect(result.code).toBe(code);
  expect(result.stdout).toBe("");
  expect(json(result.stderr)).toEqual({
    error: { kind, message: message ? expect.stringMatching(message) : expect.any(String) },
  });
}

describeDb("tracker CLI", () => {
  it("prints the snapshot of an empty database", async () => {
    const result = await runCli(["snapshot"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(json(result.stdout)).toEqual({
      readAt: expect.any(String),
      gitScan: null,
      backlogScan: null,
      changelog: [],
      blogIdeas: [],
      backlog: [],
      nextStep: null,
    });
    expect(json((await runCli(["cursor", "git_history"])).stdout)).toBeNull();
  });

  it("runs a mutation from stdin", async () => {
    const result = await runCli(["save-phase"], {
      input: JSON.stringify({ title: "From the CLI", description: null, sortOrder: 0 }),
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const { id } = json(result.stdout) as { id: string };
    const snapshot = json((await runCli(["snapshot"])).stdout) as {
      backlog: { id: string; title: string }[];
    };
    expect(snapshot.backlog).toContainEqual(expect.objectContaining({ id, title: "From the CLI" }));
  });

  it("runs a batch in one transaction", async () => {
    const scan = {
      kind: "git_history",
      throughAt: "2026-09-01T00:00:00Z",
      throughSha: "0123456789abcdef0123456789abcdef01234567",
      note: null,
    };
    const entry = {
      date: "2026-09-01",
      category: "Feature",
      title: "Batched",
      summary: "Summary",
      prNumbers: [3],
    };
    const result = await runCli(["batch"], {
      input: JSON.stringify([
        { command: "save-changelog-entry", input: entry },
        { command: "record-scan", input: scan },
      ]),
    });
    expect(result.code).toBe(0);
    expect(json(result.stdout)).toEqual([{ id: expect.any(String) }, { id: expect.any(String) }]);
    expect(json((await runCli(["cursor", "git_history"])).stdout)).toMatchObject({
      throughSha: scan.throughSha,
    });

    const failed = await runCli(["batch"], {
      input: JSON.stringify([
        { command: "save-changelog-entry", input: { ...entry, title: "Rolled back" } },
        { command: "record-scan", input: { ...scan, throughSha: null } },
      ]),
    });
    expectFailure(failed, 1, "rule", /^Batch command 1 \(record-scan\): /);
    const snapshot = json((await runCli(["snapshot"])).stdout) as {
      changelog: { title: string }[];
    };
    expect(snapshot.changelog.map((each) => each.title)).toEqual(["Batched"]);
  });

  it("reports input, rule and not-found errors as JSON on stderr with exit 1", async () => {
    expectFailure(await runCli(["save-phase"], { input: "{}" }), 1, "input", /title:/);
    expectFailure(
      await runCli(["save-phase"], { input: "{not json" }),
      1,
      "input",
      /not valid JSON/,
    );
    expectFailure(await runCli(["save-phase"]), 1, "input", /got nothing/);
    expectFailure(
      await runCli(["delete-issue"], { input: JSON.stringify({ issueNumber: 404 }) }),
      1,
      "not_found",
      /^Issue #404 is not tracked\.$/,
    );
  });

  it("reports a batch's database failure with the Postgres message and code", async () => {
    // A database without the tracker tables, so the first query fails in Postgres.
    const unmigrated = await createTestDatabase({ migrate: false });
    try {
      const result = await runCli(["batch"], {
        input: JSON.stringify([
          { command: "save-phase", input: { title: "T", description: null, sortOrder: 0 } },
        ]),
        env: { DATABASE_URL: unmigrated.url },
      });
      expectFailure(
        result,
        1,
        "internal",
        /^Batch command 0 \(save-phase\) failed\. Cause: [\s\S]* Cause: relation "tracker_backlog_phase" does not exist \(42P01\)$/,
      );
      const url = new URL(unmigrated.url);
      for (const secret of [unmigrated.url, url.password, url.host].filter(Boolean)) {
        expect(result.stderr).not.toContain(secret);
      }
    } finally {
      await unmigrated.drop();
    }
  });

  it("reports usage errors with exit 2", async () => {
    expectFailure(await runCli([]), 2, "usage");
    expectFailure(await runCli(["frobnicate"]), 2, "usage", /Unknown command "frobnicate"/);
    expectFailure(await runCli(["cursor", "everything"]), 2, "usage");
    expectFailure(await runCli(["snapshot", "extra"]), 2, "usage");
    expectFailure(
      await runCli(["snapshot"], { env: { DATABASE_URL: undefined } }),
      2,
      "usage",
      /DATABASE_URL is not set/,
    );
  });

  it("refuses to run in a Vercel production or preview environment", async () => {
    for (const vercelEnv of ["production", "preview"]) {
      expectFailure(
        await runCli(["snapshot"], { env: { VERCEL_ENV: vercelEnv } }),
        2,
        "usage",
        new RegExp(`Vercel ${vercelEnv} environment`),
      );
    }
    expect((await runCli(["snapshot"], { env: { VERCEL_ENV: "development" } })).code).toBe(0);
  });

  it("prints help listing every command", async () => {
    const result = await runCli(["help"], { env: { DATABASE_URL: undefined } });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    for (const command of ["snapshot", "cursor", "batch", ...TRACKER_COMMAND_NAMES]) {
      expect(result.stdout).toContain(command);
    }
  });
});

describe("describeFailure", () => {
  it("follows the cause chain up to three levels, with each code", () => {
    const pgError = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const chain = new Error("outer", {
      cause: new Error("first", { cause: new Error("second", { cause: pgError }) }),
    });
    expect(describeFailure(chain)).toBe(
      "outer Cause: first Cause: second Cause: relation does not exist (42P01)",
    );
    expect(describeFailure(new Error("deeper", { cause: chain }))).toBe(
      "deeper Cause: outer Cause: first Cause: second",
    );
    expect(describeFailure("not an error")).toBe("Unknown failure.");
  });
});
