import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRegistry } from "../src/cli.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { createCredentialManager } from "../src/credentials/manager.ts";
import { commandHarness } from "./helpers/commands.ts";
import {
  type FakeBackend,
  ORG_A,
  ORG_B,
  startFakeBackend,
  USER_TOKEN,
} from "./helpers/fake-backend.ts";
import { onlyJsonLine } from "./helpers/shell.ts";

const harness = commandHarness();
const scratch = mkdtempSync(join(tmpdir(), "hivemind-commands-repos-"));
afterAll(() => {
  harness.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

let api: FakeBackend;
beforeEach(async () => {
  api = await startFakeBackend();
});
afterEach(async () => {
  await api.close();
  await manager().remove(api.origin);
});

function manager(env: Record<string, string> = {}) {
  return createCredentialManager({ env, interactive: false, file: harness.file });
}

async function loginAs(token = USER_TOKEN): Promise<void> {
  await manager().save(api.origin, token);
}

let repoCounter = 0;
/** A fresh git repository (real `git init`) with a nested directory; returns both paths. */
function gitRepo(remote?: string): { root: string; nested: string } {
  const root = join(scratch, `repo-${repoCounter++}`);
  const nested = join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  if (remote) execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
  return { root, nested };
}

function run(argv: string[], options: Parameters<typeof harness.run>[1] = {}) {
  return harness.run([...argv, "--server", api.origin], options);
}

function data(stdout: string): Record<string, unknown> {
  return (onlyJsonLine(stdout) as { data: Record<string, unknown> }).data;
}

function bound(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, ".hivemind.json"), "utf8"));
}

describe("registry", () => {
  it("is valid and lists every command in help", async () => {
    expect(validateRegistry(COMMANDS)).toEqual([]);
    const help = await harness.run(["--help"]);
    for (const name of [
      "login",
      "logout",
      "whoami",
      "init",
      "key create",
      "key list",
      "key revoke",
    ])
      expect(help.stdout).toContain(name);
  });

  it.each(COMMANDS.map((command) => command.name))("'%s --help' has examples", async (name) => {
    const result = await harness.run([...name.split(" "), "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Examples:");
  });
});

describe("whoami", () => {
  it("prints the user principal as JSON data, unchanged", async () => {
    await loginAs();
    const result = await run(["whoami", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(data(result.stdout)).toEqual({ kind: "user", ...api.users.get(USER_TOKEN) });
  });

  it("shows the user, server, credential source and bound Project for people", async () => {
    await loginAs();
    const { root, nested } = gitRepo();
    const project = api.addProject(ORG_A.id, "bound");
    writeFileSync(
      join(root, ".hivemind.json"),
      JSON.stringify({ version: 1, projectId: project.id }),
    );
    const result = await run(["whoami"], { cwd: nested });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("User login: Ada <ada@example.com>");
    expect(result.stdout).toContain(`Server: ${api.origin}`);
    expect(result.stdout).toContain("Credential: the private credentials file");
    expect(result.stdout).toContain(`Bound Project: ${project.id}`);
    expect(result.stdout + result.stderr).not.toContain(USER_TOKEN);
  });

  it("identifies a Project key from HIVEMIND_TOKEN, and never prints it", async () => {
    await loginAs();
    const project = api.addProject(ORG_A.id, "keyed");
    const created = await run(["key", "create", "--name", "ci", "--project", project.id, "--json"]);
    const secret = data(created.stdout).secret as string;
    const env = { HIVEMIND_TOKEN: secret };
    const human = await run(["whoami"], { env });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("Project key: ");
    expect(human.stdout).toContain(`Project: ${project.id}`);
    expect(human.stdout).toContain("Credential: HIVEMIND_TOKEN");
    const json = await run(["whoami", "--json"], { env });
    expect(data(json.stdout)).toMatchObject({ kind: "projectKey", projectId: project.id });
    expect(human.stdout + human.stderr + json.stdout + json.stderr).not.toContain(secret);
  });

  it("fails with exit 3 when not logged in", async () => {
    const result = await run(["whoami", "--json"]);
    expect(result.code).toBe(3);
    expect(onlyJsonLine(result.stdout)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("does not fall back to the stored login when HIVEMIND_TOKEN is rejected", async () => {
    await loginAs();
    const result = await run(["whoami", "--json"], { env: { HIVEMIND_TOKEN: "hm_revoked_key" } });
    expect(result.code).toBe(3);
    expect(api.requests.map((request) => request.authorization)).toEqual(["Bearer hm_revoked_key"]);
  });

  it("warns about an unreadable binding but still answers", async () => {
    await loginAs();
    const { root, nested } = gitRepo();
    writeFileSync(join(root, ".hivemind.json"), "{ not json");
    const result = await run(["whoami"], { cwd: nested });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Ignoring the Project binding");
  });
});

describe("login over a stored login", () => {
  const signOuts = () => api.requests.filter((request) => request.url === "/api/auth/sign-out");

  it("revokes the replaced login on the server once the new one is stored", async () => {
    await loginAs();
    const result = await run(["login", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const [issued] = api.issuedTokens;
    expect((await manager().readStored(api.origin))?.token).toBe(issued);
    expect(signOuts()).toEqual([
      expect.objectContaining({ method: "POST", authorization: `Bearer ${USER_TOKEN}` }),
    ]);
    expect(api.users.has(USER_TOKEN)).toBe(false);
    expect(data(result.stdout)).toMatchObject({ user: { email: "ada@example.com" } });
    expect(result.stderr).not.toContain("warning:");
    expect(result.stdout + result.stderr).not.toContain(USER_TOKEN);
  });

  it("still logs in, with a warning, when the server does not revoke the replaced login", async () => {
    await loginAs();
    api.signOutStatus = 503;
    const result = await run(["login", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(onlyJsonLine(result.stdout)).toMatchObject({ ok: true, command: "login" });
    expect((await manager().readStored(api.origin))?.token).toBe(api.issuedTokens[0]);
    expect(result.stderr).toContain(
      `warning: The previous login for ${api.origin} was replaced but not revoked on the server (HTTP 503)`,
    );
    expect(result.stdout + result.stderr).not.toContain(USER_TOKEN);
  });

  it("revokes nothing when no login was stored", async () => {
    const result = await run(["login", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(signOuts()).toEqual([]);
  });
});

describe("logout", () => {
  it("revokes the stored login on the server and removes it locally", async () => {
    await loginAs();
    const result = await run(["logout", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(data(result.stdout)).toEqual({
      origin: api.origin,
      removed: true,
      revoked: true,
      hivemindTokenSet: false,
    });
    const signOut = api.requests.find((request) => request.url === "/api/auth/sign-out");
    expect(signOut).toMatchObject({ method: "POST", authorization: `Bearer ${USER_TOKEN}` });
    expect(await manager().readStored(api.origin)).toBeNull();
    expect(result.stdout + result.stderr).not.toContain(USER_TOKEN);
  });

  it.each([
    [
      "the server refuses",
      (backend: FakeBackend) => {
        backend.signOutStatus = 503;
      },
    ],
    ["the server is unreachable", (backend: FakeBackend) => backend.close()],
  ])("still clears local copies when %s, and fails with REVOCATION_FAILED", async (_, breakIt) => {
    await loginAs();
    await breakIt(api);
    const result = await run(["logout", "--json"]);
    expect(result.code).toBe(1);
    expect(onlyJsonLine(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "REVOCATION_FAILED",
        message: expect.stringContaining("Deleted the stored login"),
      },
    });
    expect(await manager().readStored(api.origin)).toBeNull();
  });

  it("removes the OS-store copy too in a terminal", async () => {
    await createCredentialManager({
      env: {},
      interactive: true,
      platform: "linux",
      file: harness.file,
      factories: { libsecret: () => harness.os },
    }).save(api.origin, USER_TOKEN);
    expect(harness.os.items.get(api.origin)).toBe(USER_TOKEN);
    const result = await run(["logout"], { interactive: true });
    expect(result.code, result.stderr).toBe(0);
    expect(harness.os.items.has(api.origin)).toBe(false);
  });

  it("never touches HIVEMIND_TOKEN and succeeds when nothing is stored", async () => {
    const result = await run(["logout", "--json"], { env: { HIVEMIND_TOKEN: "hm_env_key_value" } });
    expect(result.code).toBe(0);
    expect(data(result.stdout)).toMatchObject({
      removed: false,
      revoked: null,
      hivemindTokenSet: true,
    });
    expect(api.requests).toEqual([]);
  });
});

describe("init", () => {
  it("creates a Project from a nested directory and writes the binding at the repository root", async () => {
    await loginAs();
    const { root, nested } = gitRepo("https://github.com/acme/widgets.git");
    const result = await run(["init", "--name", "Widgets", "--slug", "widgets", "--json"], {
      cwd: nested,
    });
    expect(result.code, result.stderr).toBe(0);
    const out = data(result.stdout) as { project: { id: string }; created: boolean };
    expect(out).toMatchObject({ created: true, config: { status: "created" } });
    expect(bound(root)).toEqual({ version: 1, projectId: out.project.id });
    const post = api.requests.find((request) => request.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      organizationId: ORG_A.id,
      name: "Widgets",
      slug: "widgets",
      repoUrl: "https://github.com/acme/widgets.git",
    });

    // A rerun reuses the Project and leaves the file alone.
    const again = await run(["init", "--name", "Widgets", "--slug", "widgets", "--json"], {
      cwd: root,
    });
    expect(data(again.stdout)).toMatchObject({ created: false, config: { status: "unchanged" } });
  });

  it("never sends or prints a remote URL that carries credentials", async () => {
    await loginAs();
    const { nested } = gitRepo("https://user:ghp_secret123@github.com/acme/widgets.git");
    const result = await run(["init", "--name", "Widgets", "--slug", "widgets"], { cwd: nested });
    expect(result.code, result.stderr).toBe(0);
    const post = api.requests.find((request) => request.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).not.toHaveProperty("repoUrl");
    expect(result.stdout + result.stderr).not.toContain("ghp_secret123");
  });

  it("links an existing Project, and a matching binding is a no-op", async () => {
    await loginAs();
    const project = api.addProject(ORG_A.id, "existing");
    const { root } = gitRepo();
    const first = await run(["init", "--project", project.id, "--json"], { cwd: root });
    expect(data(first.stdout)).toMatchObject({ created: false, config: { status: "created" } });
    const second = await run(["init", "--project", project.id, "--json"], { cwd: root });
    expect(data(second.stdout)).toMatchObject({ config: { status: "unchanged" } });
  });

  it("refuses a different binding with CONFLICT before creating anything, unless --replace", async () => {
    await loginAs();
    const old = api.addProject(ORG_A.id, "old");
    const { root } = gitRepo();
    writeFileSync(join(root, ".hivemind.json"), JSON.stringify({ version: 1, projectId: old.id }));
    const conflict = await run(["init", "--name", "New", "--slug", "new", "--json"], { cwd: root });
    expect(conflict.code).toBe(2);
    expect(onlyJsonLine(conflict.stdout)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(api.requests.some((request) => request.method === "POST")).toBe(false);
    expect(bound(root)).toEqual({ version: 1, projectId: old.id });

    const other = api.addProject(ORG_A.id, "other");
    const link = await run(["init", "--project", other.id], { cwd: root });
    expect(link.code).toBe(2);

    const replaced = await run(["init", "--project", other.id, "--replace", "--json"], {
      cwd: root,
    });
    expect(data(replaced.stdout)).toMatchObject({ config: { status: "replaced" } });
    expect(bound(root)).toEqual({ version: 1, projectId: other.id });
  });

  it("names the Project id when it was created but the file cannot be written", async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only directory
    await loginAs();
    const { root } = gitRepo();
    chmodSync(root, 0o555);
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(["init", "--name", "Ro", "--slug", "ro", "--json"], { cwd: root });
    } finally {
      chmodSync(root, 0o755);
    }
    expect(result.code).toBe(1);
    const created = [...api.projects.values()].find((project) => project.slug === "ro");
    expect(created).toBeDefined();
    const message = (onlyJsonLine(result.stdout) as { error: { message: string } }).error.message;
    expect(message).toContain(`Project ${created?.id} was created on the server`);
    expect(message).toContain(`hivemind init --project ${created?.id}`);
    // The suggested rerun finishes the job without creating anything else.
    const rerun = await run(["init", "--project", created?.id ?? "", "--json"], { cwd: root });
    expect(data(rerun.stdout)).toMatchObject({ config: { status: "created" } });
    expect(api.projects.size).toBe(1);
  });

  describe("choices", () => {
    beforeEach(async () => {
      await api.close();
      api = await startFakeBackend({ organizations: [ORG_A, { ...ORG_B, role: "owner" }] });
      await loginAs();
    });

    it("without a TTY requires --org when there are several organizations", async () => {
      const { root } = gitRepo();
      const result = await run(["init", "--name", "X", "--slug", "x", "--json"], { cwd: root });
      expect(result.code).toBe(1);
      expect(onlyJsonLine(result.stdout)).toMatchObject({
        error: { code: "USAGE_ERROR", message: expect.stringContaining("--org") },
      });
    });

    it("in a TTY offers the organizations on stderr", async () => {
      const { root } = gitRepo();
      const result = await run(["init", "--name", "X", "--slug", "x", "--json"], {
        cwd: root,
        interactive: true,
        stdin: Readable.from(["2\n"]),
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("1) Org A");
      expect(data(result.stdout)).toMatchObject({ project: { organizationId: ORG_B.id } });
    });

    it("without flags links the only Project, and asks for flags when there are several", async () => {
      const { root } = gitRepo();
      const only = api.addProject(ORG_A.id, "only");
      const one = await run(["init", "--json"], { cwd: root });
      expect(data(one.stdout)).toMatchObject({ project: { id: only.id } });
      api.addProject(ORG_B.id, "second");
      rmSync(join(root, ".hivemind.json"));
      const many = await run(["init", "--json"], { cwd: root });
      expect(many.code).toBe(1);
      expect(onlyJsonLine(many.stdout)).toMatchObject({ error: { code: "USAGE_ERROR" } });
    });
  });

  it("lets a Project key link only its own Project", async () => {
    await loginAs();
    const mine = api.addProject(ORG_A.id, "mine");
    const other = api.addProject(ORG_A.id, "other");
    const created = await run(["key", "create", "--name", "ci", "--project", mine.id, "--json"]);
    const env = { HIVEMIND_TOKEN: data(created.stdout).secret as string };
    const { root } = gitRepo();

    const own = await run(["init", "--json"], { cwd: root, env });
    expect(data(own.stdout)).toMatchObject({ project: { id: mine.id } });
    const foreign = await run(["init", "--project", other.id, "--replace"], { cwd: root, env });
    expect(foreign.code).toBe(4);
    const create = await run(["init", "--name", "N", "--slug", "n", "--org", ORG_A.id], {
      cwd: root,
      env,
    });
    expect(create.code).toBe(3);
  });

  it.each([
    [["--project", "not-a-uuid"], "--project must be"],
    [["--name", "only-name"], "both --name and --slug"],
    [["--project", ORG_A.id, "--name", "x"], "cannot be combined"],
    [["--name", "x", "--slug", "Bad Slug"], "--slug must be"],
    [["--name", "x", "--slug", "x", "--repo-url", "https://u:p@host/x"], "--repo-url must be"],
  ])("rejects %j before calling the server", async (flags, message) => {
    await loginAs();
    const result = await run(["init", ...flags], { cwd: gitRepo().root });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(api.requests).toEqual([]);
  });
});

describe("key", () => {
  async function boundRepo() {
    await loginAs();
    const project = api.addProject(ORG_A.id, "keys");
    const { root, nested } = gitRepo();
    writeFileSync(
      join(root, ".hivemind.json"),
      JSON.stringify({ version: 1, projectId: project.id }),
    );
    return { project, nested };
  }

  it("create prints only the secret on stdout, details on stderr", async () => {
    const { project, nested } = await boundRepo();
    const result = await run(["key", "create", "--name", "ci", "--expires-in-days", "30"], {
      cwd: nested,
    });
    expect(result.code, result.stderr).toBe(0);
    const [key] = [...api.keys.values()];
    expect(result.stdout).toBe(`${key?.secret}\n`);
    expect(result.stderr).toContain(`for Project ${project.id}`);
    expect(result.stderr).toContain("shown only once");
    expect(result.stderr).not.toContain(key?.secret ?? "?");
    const post = api.requests.find((request) => request.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ name: "ci", expiresInDays: 30 });
  });

  it("create --json returns the documented projectKey and secret fields", async () => {
    const { project, nested } = await boundRepo();
    const result = await run(["key", "create", "--name", "ci", "--json"], { cwd: nested });
    const out = data(result.stdout) as { projectKey: Record<string, unknown>; secret: string };
    expect(Object.keys(out).sort()).toEqual(["projectKey", "secret"]);
    expect(out.projectKey).toMatchObject({ name: "ci", projectId: project.id, expiresAt: null });
    expect(out.secret).toMatch(/^hm_/);
  });

  it("create is not retried after a transport failure and points at key list", async () => {
    const { nested } = await boundRepo();
    let calls = 0;
    const result = await run(["key", "create", "--name", "ci", "--json"], {
      cwd: nested,
      fetch: async () => {
        calls++;
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      },
    });
    expect(calls).toBe(1);
    expect(result.code).toBe(1);
    expect(onlyJsonLine(result.stdout)).toMatchObject({
      error: { code: "NETWORK_ERROR", message: expect.stringContaining("hivemind key list") },
    });
  });

  it("list shows metadata only; revoke removes the key; a second revoke is exit 4", async () => {
    const { nested } = await boundRepo();
    const created = await run(["key", "create", "--name", "ci", "--json"], { cwd: nested });
    const { projectKey, secret } = data(created.stdout) as {
      projectKey: { id: string };
      secret: string;
    };
    const list = await run(["key", "list", "--json"], { cwd: nested });
    expect(list.stdout).not.toContain(secret);
    expect(data(list.stdout)).toMatchObject({ items: [{ id: projectKey.id, name: "ci" }] });
    const human = await run(["key", "list"], { cwd: nested });
    expect(human.stdout).toContain(`${projectKey.id}  ci  created`);

    const revoked = await run(["key", "revoke", projectKey.id, "--json"], { cwd: nested });
    expect(data(revoked.stdout)).toMatchObject({ id: projectKey.id, revoked: true });
    const again = await run(["key", "revoke", projectKey.id, "--json"], { cwd: nested });
    expect(again.code).toBe(4);
  });

  it("needs a Project from --project or .hivemind.json", async () => {
    await loginAs();
    const result = await run(["key", "list", "--json"], { cwd: gitRepo().root });
    expect(result.code).toBe(1);
    expect(onlyJsonLine(result.stdout)).toMatchObject({
      error: { code: "USAGE_ERROR", message: expect.stringContaining(".hivemind.json") },
    });
  });

  it("is refused for a non-owner (exit 3) and validates arguments locally", async () => {
    await api.close();
    api = await startFakeBackend({ organizations: [ORG_A, ORG_B] });
    await loginAs();
    const project = api.addProject(ORG_B.id, "member-only");
    const denied = await run(["key", "list", "--project", project.id]);
    expect(denied.code).toBe(3);
    for (const days of ["0", "366", "1.5", "ten"]) {
      const bad = await run(["key", "create", "--name", "x", "--expires-in-days", days]);
      expect(bad.code).toBe(1);
    }
    expect((await run(["key", "revoke", "nope"])).code).toBe(1);
  });
});
