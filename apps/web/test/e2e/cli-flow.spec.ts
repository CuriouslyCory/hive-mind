import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { E2E_BASE_URL, e2eDatabaseUrl } from "./e2e-env";
import { signedInPage, testUsers } from "./support";

// The M1 vertical slice with the real compiled CLI against the real app:
// device login approved in a browser, init from a nested directory of a git
// repository, discovery from a linked worktree, a Project key's lifecycle,
// and logout. The CLI runs without a TTY (pipes), with its own HOME and XDG
// directories, so it never touches the developer's login or keyring and only
// uses the private credentials file.

/** Built by `pnpm --filter @hivemind/cli build` (turbo runs it before test:e2e). */
const CLI_BINARY = fileURLToPath(new URL("../../../cli/dist/hivemind", import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let pool: pg.Pool;
let users: TestHelpers;
let sandbox: string;
let baseEnv: NodeJS.ProcessEnv;
/** Everything the CLI printed, checked for secrets at the end. */
const transcript: { argv: string[]; stdout: string; stderr: string }[] = [];

test.beforeAll(async () => {
  if (!existsSync(CLI_BINARY)) {
    throw new Error(`${CLI_BINARY} is missing; run 'pnpm --filter @hivemind/cli build' first.`);
  }
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
  sandbox = mkdtempSync(join(tmpdir(), "hivemind-cli-e2e-"));
  const home = join(sandbox, "home");
  mkdirSync(home);
  baseEnv = {
    NODE_ENV: "test",
    // git is needed by `init` (repo URL) and by this spec; nothing else leaks in.
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
});

test.afterAll(async () => {
  await pool?.end();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/** Starts the CLI with pipes on all three streams (non-TTY). */
function startCli(argv: string[], options: { cwd: string; env?: { HIVEMIND_TOKEN?: string } }) {
  const fullArgv = [...argv, "--server", E2E_BASE_URL];
  const child = spawn(CLI_BINARY, fullArgv, {
    cwd: options.cwd,
    env: { ...baseEnv, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const result: CliResult = { status: null, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    result.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    result.stderr += chunk;
  });
  const done = new Promise<CliResult>((resolve) =>
    child.on("close", (status) => {
      result.status = status;
      transcript.push({ argv: fullArgv, stdout: result.stdout, stderr: result.stderr });
      resolve(result);
    }),
  );
  return { child, result, done };
}

function cli(argv: string[], options: { cwd: string; env?: { HIVEMIND_TOKEN?: string } }) {
  const { child, done } = startCli(argv, options);
  child.stdin.end();
  return done;
}

/** The single JSON envelope on stdout. */
function envelope(result: CliResult): {
  ok: boolean;
  data: Record<string, unknown>;
  error?: { code: string };
} {
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

test("login, init, whoami, Project key lifecycle and logout with the compiled CLI", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { user, page } = await signedInPage(browser, users);
  const suffix = randomUUID().slice(0, 8);

  // --- login: instructions on stderr, approval in the browser, no stdin read.
  const login = startCli(["login", "--json"], { cwd: sandbox });
  await expect
    .poll(() => /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(login.result.stderr)?.[1], {
      timeout: 15_000,
    })
    .toBeTruthy();
  const userCode = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(login.result.stderr)?.[1] as string;
  expect(login.result.stderr).toContain(`${E2E_BASE_URL}/device`);
  await page.goto(`/device?user_code=${userCode}`);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText(/Approved/);
  const loggedIn = await login.done; // stdin was never closed: login must not wait for it
  expect(loggedIn.status, loggedIn.stderr).toBe(0);
  expect(envelope(loggedIn)).toMatchObject({
    ok: true,
    data: { origin: E2E_BASE_URL, credentialStore: "file", user: { id: user.id } },
  });
  const credentialsPath = join(String(baseEnv.XDG_CONFIG_HOME), "hivemind", "credentials.json");
  expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
  const loginToken = (
    JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      credentials: Record<string, { token: string }>;
    }
  ).credentials[E2E_BASE_URL]?.token as string;
  expect(loginToken).toBeTruthy();

  // --- init from a nested directory of a git repository.
  const repo = join(sandbox, "repo");
  const nested = join(repo, "src", "deep");
  mkdirSync(nested, { recursive: true });
  git(sandbox, "init", "-q", "-b", "main", repo);
  git(repo, "remote", "add", "origin", "https://github.com/example/cli-e2e.git");
  const init = await cli(["init", "--name", "CLI e2e", "--slug", `cli-e2e-${suffix}`, "--json"], {
    cwd: nested,
  });
  expect(init.status, init.stderr).toBe(0);
  const initData = envelope(init).data as {
    project: { id: string; repoUrl: string | null };
    created: boolean;
    config: { path: string };
  };
  expect(initData).toMatchObject({
    created: true,
    project: { repoUrl: "https://github.com/example/cli-e2e.git" },
    config: { path: join(repo, ".hivemind.json") },
  });
  const projectId = initData.project.id;

  // --- whoami from the nested directory and from a linked worktree.
  const whoami = await cli(["whoami", "--json"], { cwd: nested });
  expect(envelope(whoami)).toMatchObject({
    ok: true,
    data: { kind: "user", user: { id: user.id } },
  });
  const human = await cli(["whoami"], { cwd: nested });
  expect(human.stdout).toContain(`Bound Project: ${projectId}`);
  expect(human.stdout).toContain(`Server: ${E2E_BASE_URL}`);

  git(repo, "add", ".hivemind.json");
  git(repo, "commit", "-q", "-m", "Bind to Hive Mind");
  const worktree = join(sandbox, "worktree");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  mkdirSync(join(worktree, "src", "deep"), { recursive: true });
  const fromWorktree = await cli(["whoami"], { cwd: join(worktree, "src", "deep") });
  expect(fromWorktree.status, fromWorktree.stderr).toBe(0);
  expect(fromWorktree.stdout).toContain(
    `Bound Project: ${projectId} (${join(worktree, ".hivemind.json")})`,
  );

  // --- key create (the one secret on stdout), then whoami as that key.
  const created = await cli(["key", "create", "--name", "e2e", "--json"], { cwd: nested });
  expect(created.status, created.stderr).toBe(0);
  const { projectKey, secret } = envelope(created).data as {
    projectKey: { id: string; projectId: string };
    secret: string;
  };
  expect(projectKey.projectId).toBe(projectId);
  expect(created.stderr).not.toContain(secret);
  const asKey = await cli(["whoami", "--json"], { cwd: nested, env: { HIVEMIND_TOKEN: secret } });
  expect(envelope(asKey)).toMatchObject({
    ok: true,
    data: { kind: "projectKey", keyId: projectKey.id, projectId },
  });

  // --- the key cannot reach a second Project: hidden as not found (exit 4).
  const otherRepo = join(sandbox, "other");
  mkdirSync(otherRepo);
  git(sandbox, "init", "-q", otherRepo);
  const other = await cli(["init", "--name", "Other", "--slug", `other-${suffix}`, "--json"], {
    cwd: otherRepo,
  });
  const otherId = (envelope(other).data as { project: { id: string } }).project.id;
  const keyElsewhere = await cli(["init", "--project", otherId, "--replace", "--json"], {
    cwd: otherRepo,
    env: { HIVEMIND_TOKEN: secret },
  });
  expect(keyElsewhere.status).toBe(4);
  expect(envelope(keyElsewhere)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  // ... and cannot manage keys (exit 3).
  const keyManages = await cli(["key", "list", "--json"], {
    cwd: nested,
    env: { HIVEMIND_TOKEN: secret },
  });
  expect(keyManages.status).toBe(3);

  // --- revoke the key; it stops working at once.
  const listed = await cli(["key", "list", "--json"], { cwd: nested });
  expect(envelope(listed).data).toMatchObject({ items: [{ id: projectKey.id, name: "e2e" }] });
  const revoke = await cli(["key", "revoke", projectKey.id, "--json"], { cwd: nested });
  expect(envelope(revoke)).toMatchObject({ ok: true, data: { id: projectKey.id, revoked: true } });
  const revoked = await cli(["whoami", "--json"], { cwd: nested, env: { HIVEMIND_TOKEN: secret } });
  expect(revoked.status).toBe(3);
  expect(envelope(revoked)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });

  // --- logout revokes the login on the server and removes it locally.
  const logout = await cli(["logout", "--json"], { cwd: nested });
  expect(envelope(logout)).toMatchObject({ ok: true, data: { removed: true, revoked: true } });
  const afterLogout = await cli(["whoami", "--json"], { cwd: nested });
  expect(afterLogout.status).toBe(3);
  const me = await fetch(`${E2E_BASE_URL}/api/v1/me`, {
    headers: { authorization: `Bearer ${loginToken}` },
  });
  expect(me.status).toBe(401);

  // --- no secret was ever printed or passed as an argument (except the one
  // intentional `key create` output on stdout).
  for (const entry of transcript) {
    const printed = `${entry.stdout}\n${entry.stderr}\n${entry.argv.join(" ")}`;
    expect(printed).not.toContain(loginToken);
    const ownOutput = entry.argv.includes("create") ? entry.stderr : printed;
    expect(ownOutput).not.toContain(secret);
  }
});
