import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyCliEnvelopeSchema, exitCodeForEnvelope } from "@hivemind/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileStore } from "../src/credentials/file.ts";
import { createCredentialManager } from "../src/credentials/manager.ts";
import { type RunResult, runAsync, shippedBinary } from "./helpers/binaries.ts";
import { type FakeBackend, ORG_A, startFakeBackend, USER_TOKEN } from "./helpers/fake-backend.ts";

/**
 * The shipped binary as scripts see it: no TTY, `--json`, a private HOME and
 * XDG config dir per test. Every case checks the output contract: exactly one
 * JSON object on stdout that matches the v1 envelope schema, an exit code
 * that agrees with the envelope, and no login token or Project key anywhere
 * in stdout, stderr or the argv we passed (credentials only travel through
 * the credentials file and HIVEMIND_TOKEN).
 */

const base = mkdtempSync(join(tmpdir(), "hivemind-json-"));
let api: FakeBackend;
beforeAll(async () => {
  api = await startFakeBackend();
});
afterAll(async () => {
  await api.close();
  rmSync(base, { recursive: true, force: true });
});

let counter = 0;
interface Sandbox {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function sandbox(extraEnv: NodeJS.ProcessEnv = {}): Sandbox {
  const home = join(base, String(counter++));
  const cwd = join(home, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return {
    home,
    cwd,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      HIVEMIND_URL: api.origin,
      ...extraEnv,
    },
  };
}

async function storeLogin(box: Sandbox, token = USER_TOKEN): Promise<void> {
  const file = createFileStore({ dir: join(box.home, ".config", "hivemind") });
  await createCredentialManager({ env: {}, interactive: false, file }).save(api.origin, token);
}

/** Secrets that must never be printed (except a new key's own secret by `key create`). */
function secrets(): string[] {
  return [USER_TOKEN, ...api.issuedTokens, ...[...api.keys.values()].map((key) => key.secret)];
}

function envelopeOf(result: RunResult, argv: readonly string[], allowed: string[] = []) {
  expect(result.stdout.endsWith("\n"), result.stderr).toBe(true);
  const lines = result.stdout.slice(0, -1).split("\n");
  expect(lines, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toHaveLength(1);
  const envelope = anyCliEnvelopeSchema.parse(JSON.parse(lines[0] as string));
  expect(result.status).toBe(exitCodeForEnvelope(envelope));
  for (const secret of secrets()) {
    if (allowed.includes(secret)) continue;
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(argv.join(" ")).not.toContain(secret);
  }
  return envelope;
}

async function hivemind(box: Sandbox, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const fullArgv = [...argv, "--json"];
  const result = await runAsync(shippedBinary(), fullArgv, {
    cwd: box.cwd,
    env: { ...box.env, ...env },
  });
  return { result, argv: fullArgv };
}

/** A golden v1 envelope from packages/contract (what released CLIs promise scripts). */
function golden(name: string): unknown {
  const dir = new URL("../../../packages/contract/test/fixtures/v1/", import.meta.url);
  return JSON.parse(readFileSync(new URL(name, dir), "utf8"));
}

/**
 * The structure of a JSON value without its data: object keys, array lengths
 * and leaf types (null is its own type). Ids, times, paths and origins differ
 * from run to run, so only the structure is compared.
 */
function shape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
  }
  return typeof value;
}

/**
 * Every field of the fixture is in the output, with the same type. Extra
 * output fields pass: adding a field is compatible (AGENTS.md); renaming,
 * dropping or retyping one is not.
 */
function expectGolden(envelope: unknown, name: string): void {
  const fixture = golden(name) as { command: string };
  expect(shape(envelope), name).toMatchObject(shape(fixture) as object);
  expect(envelope).toMatchObject({ schemaVersion: 1, command: fixture.command, ok: true });
}

describe("compiled binary --json contract", () => {
  it("login without a TTY prints instructions on stderr, polls, and never reads stdin", async () => {
    const box = sandbox();
    // stdin stays open: a CLI that waited for input would hang until the timeout.
    const child = spawn(shippedBinary(), ["login", "--json"], {
      cwd: box.cwd,
      env: { PATH: "/usr/bin:/bin", ...box.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const envelope = envelopeOf({ status, stdout, stderr }, ["login", "--json"]);
    expect(status, stderr).toBe(0);
    expect(envelope).toMatchObject({ ok: true, data: { credentialStore: "file" } });
    expect(stderr).toContain(`${api.origin}/device`);
    expect(stderr).toContain("WDJB-MJHT");
    expect(stderr).not.toContain("Opened your browser");

    const whoami = await hivemind(box, ["whoami"]);
    expect(envelopeOf(whoami.result, whoami.argv)).toMatchObject({
      ok: true,
      data: { kind: "user" },
    });
    const logout = await hivemind(box, ["logout"]);
    expect(envelopeOf(logout.result, logout.argv)).toMatchObject({ data: { revoked: true } });
    const after = await hivemind(box, ["whoami"]);
    expect(after.result.status).toBe(3);
    envelopeOf(after.result, after.argv);
  });

  it("exit 3: a denied login, and no credential", async () => {
    const box = sandbox();
    api.deviceOutcome = "deny";
    try {
      const { result, argv } = await hivemind(box, ["login"]);
      expect(result.status).toBe(3);
      expect(envelopeOf(result, argv)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    } finally {
      api.deviceOutcome = "approve";
    }
    const whoami = await hivemind(box, ["whoami"]);
    expect(whoami.result.status).toBe(3);
  });

  it("covers exit 0, 1, 2, 3 and 4 across init and key commands", async () => {
    const box = sandbox();
    await storeLogin(box);

    // 1: usage errors are JSON too.
    const usage = await hivemind(box, ["key", "create"]);
    expect(usage.result.status).toBe(1);
    expect(envelopeOf(usage.result, usage.argv)).toMatchObject({ error: { code: "USAGE_ERROR" } });
    const unknown = await hivemind(box, ["frobnicate"]);
    expect(envelopeOf(unknown.result, unknown.argv)).toMatchObject({ command: "hivemind" });

    // 0: init creates and binds; key create prints its own secret, once, in data.secret.
    const init = await hivemind(box, [
      "init",
      "--name",
      "Json",
      "--slug",
      "json",
      "--org",
      ORG_A.id,
    ]);
    expect(init.result.status, init.result.stderr).toBe(0);
    const projectId = (envelopeOf(init.result, init.argv) as { data: { project: { id: string } } })
      .data.project.id;
    const created = await hivemind(box, ["key", "create", "--name", "ci"]);
    const key = [...api.keys.values()].at(-1);
    const keyEnvelope = envelopeOf(created.result, created.argv, [key?.secret ?? ""]);
    expect(keyEnvelope).toMatchObject({ ok: true, data: { secret: key?.secret } });
    expect(created.result.stdout.split(key?.secret ?? "?")).toHaveLength(2);
    expect(created.result.stderr).not.toContain(key?.secret ?? "?");

    // 0: the key identifies itself through HIVEMIND_TOKEN.
    const asKey = await hivemind(box, ["whoami"], { HIVEMIND_TOKEN: key?.secret });
    expect(envelopeOf(asKey.result, asKey.argv)).toMatchObject({
      data: { kind: "projectKey", projectId },
    });

    // 2: a different binding is a conflict.
    const other = api.addProject(ORG_A.id, "other");
    const conflict = await hivemind(box, ["init", "--project", other.id]);
    expect(conflict.result.status).toBe(2);
    expect(envelopeOf(conflict.result, conflict.argv)).toMatchObject({
      error: { code: "CONFLICT" },
    });

    // 4: the key cannot see another Project; an unknown key id is not found.
    const foreign = await hivemind(box, ["init", "--project", other.id, "--replace"], {
      HIVEMIND_TOKEN: key?.secret,
    });
    expect(foreign.result.status).toBe(4);
    envelopeOf(foreign.result, foreign.argv);
    const missing = await hivemind(box, ["key", "revoke", other.id]);
    expect(missing.result.status).toBe(4);
    expect(envelopeOf(missing.result, missing.argv)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // 3: a key cannot manage keys; a revoked key is rejected.
    const keyManages = await hivemind(box, ["key", "list"], { HIVEMIND_TOKEN: key?.secret });
    expect(keyManages.result.status).toBe(3);
    envelopeOf(keyManages.result, keyManages.argv);
    const revoke = await hivemind(box, ["key", "revoke", key?.id ?? ""]);
    expect(revoke.result.status).toBe(0);
    envelopeOf(revoke.result, revoke.argv);
    const revoked = await hivemind(box, ["whoami"], { HIVEMIND_TOKEN: key?.secret });
    expect(revoked.result.status).toBe(3);
    expect(envelopeOf(revoked.result, revoked.argv)).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("exit 1 with REVOCATION_FAILED when the server cannot revoke, and the login is gone", async () => {
    const box = sandbox();
    await storeLogin(box, `${USER_TOKEN}-copy`);
    api.users.set(`${USER_TOKEN}-copy`, api.users.get(USER_TOKEN) as never);
    api.signOutStatus = 500;
    try {
      const { result, argv } = await hivemind(box, ["logout"]);
      expect(result.status).toBe(1);
      expect(envelopeOf(result, argv)).toMatchObject({ error: { code: "REVOCATION_FAILED" } });
      expect(result.stdout + result.stderr).not.toContain(`${USER_TOKEN}-copy`);
    } finally {
      api.signOutStatus = 200;
    }
    const whoami = await hivemind(box, ["whoami"]);
    expect(whoami.result.status).toBe(3);
  });

  it("matches the golden v1 fixtures for login, init, key create/list/revoke and logout", async () => {
    const box = sandbox();
    // `key create` prints its own new secret; nothing else prints any.
    const run = async (argv: string[], printsNewKey = false) => {
      const { result, argv: full } = await hivemind(box, argv);
      expect(result.status, result.stderr).toBe(0);
      const allowed = printsNewKey ? [[...api.keys.values()].at(-1)?.secret ?? ""] : [];
      return envelopeOf(result, full, allowed) as { data: Record<string, unknown> };
    };

    const login = await run(["login"]);
    expectGolden(login, "cli.login.json");
    expect(login).toMatchObject({ data: { credentialStore: "file", hivemindTokenSet: false } });

    const init = await run([
      "init",
      "--name",
      "Golden",
      "--slug",
      "golden",
      "--org",
      ORG_A.id,
      "--repo-url",
      "https://github.com/acme/golden.git",
    ]);
    expectGolden(init, "cli.init.json");
    expect(init).toMatchObject({ data: { created: true, config: { status: "created" } } });

    // The fixtures have a created key without expiry (expiresAt null) and a
    // listed key with one (a string), so: create one without, revoke it, then
    // create one with an expiry and list that.
    const created = await run(["key", "create", "--name", "ci"], true);
    expectGolden(created, "cli.key-create.json");
    const keyId = (created.data.projectKey as { id: string }).id;
    expectGolden(await run(["key", "revoke", keyId]), "cli.key-revoke.json");
    await run(["key", "create", "--name", "ci", "--expires-in-days", "90"], true);
    expectGolden(await run(["key", "list"]), "cli.key-list.json");

    const logout = await run(["logout"]);
    expectGolden(logout, "cli.logout.json");
    expect(logout).toMatchObject({ data: { removed: true, revoked: true } });
  });

  it("exit 1 for an unreadable binding, never falling back to an ancestor", async () => {
    const box = sandbox();
    await storeLogin(box);
    writeFileSync(join(box.cwd, ".hivemind.json"), JSON.stringify({ version: 2, projectId: "x" }));
    const { result, argv } = await hivemind(box, ["key", "list"]);
    expect(result.status).toBe(1);
    expect(envelopeOf(result, argv)).toMatchObject({
      error: { code: "CONFIG_UNSUPPORTED_VERSION" },
    });
  });
});
