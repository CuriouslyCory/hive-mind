import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, MAX_CONFIG_BYTES, serializeHivemindConfig } from "@hivemind/contract";
import { afterAll, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/config.ts";
import { CliError } from "../src/errors.ts";
import { bindingDirFor, findProjectConfig } from "../src/project-resolution.ts";
import { runAsync, SHELL_BINARY } from "./helpers/binaries.ts";

// realpath: on macOS tmpdir() is behind a symlink, and discovery reports physical paths.
const root = realpathSync(mkdtempSync(join(tmpdir(), "hivemind-config-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = () => {
  const dir = join(root, String(counter++));
  mkdirSync(dir, { recursive: true });
  return dir;
};

const ID_A = "3e0c4c38-8f3b-4c55-9d2f-0b9f6b1f3a21";
const ID_B = "9a1d6e2f-4b7c-4d8e-8f9a-1b2c3d4e5f60";
const config = (projectId: string) => serializeHivemindConfig({ version: 1, projectId });

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
}

describe("discovery", () => {
  it("finds the nearest file from nested directories", async () => {
    const top = fresh();
    writeFileSync(join(top, CONFIG_FILENAME), config(ID_A));
    const deep = join(top, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectConfig({ cwd: deep })).toEqual({
      path: join(top, CONFIG_FILENAME),
      dir: top,
      config: { version: 1, projectId: ID_A },
    });
    writeFileSync(join(top, "a", CONFIG_FILENAME), config(ID_B));
    expect(await findProjectConfig({ cwd: deep })).toMatchObject({
      dir: join(top, "a"),
      config: { projectId: ID_B },
    });
  });

  it("fails on an unusable nearest file instead of using an ancestor", async () => {
    const cases: [string | null, string][] = [
      ["{not json", "CONFIG_INVALID_JSON"],
      [JSON.stringify({ version: 2, projectId: ID_B }), "CONFIG_UNSUPPORTED_VERSION"],
      [
        JSON.stringify({ version: 1, projectId: ID_B, server: "https://evil.example" }),
        "CONFIG_INVALID",
      ],
      [`${config(ID_B)}${" ".repeat(MAX_CONFIG_BYTES)}`, "CONFIG_TOO_LARGE"],
    ];
    for (const [contents, code] of cases) {
      const top = fresh();
      writeFileSync(join(top, CONFIG_FILENAME), config(ID_A));
      mkdirSync(join(top, "sub"));
      writeFileSync(join(top, "sub", CONFIG_FILENAME), contents ?? "");
      const error = await rejection(findProjectConfig({ cwd: join(top, "sub") }));
      expect([error.code, error.exitCode]).toEqual([code, 1]);
      expect(error.message).toContain(join(top, "sub", CONFIG_FILENAME));
    }
  });

  it("accepts a file of exactly 16 KiB", async () => {
    const top = fresh();
    const body = config(ID_A);
    writeFileSync(
      join(top, CONFIG_FILENAME),
      body + " ".repeat(MAX_CONFIG_BYTES - Buffer.byteLength(body)),
    );
    expect(await findProjectConfig({ cwd: top })).toMatchObject({ config: { projectId: ID_A } });
  });

  it("refuses a symlinked, directory or FIFO .hivemind.json, without blocking", async () => {
    const top = fresh();
    writeFileSync(join(top, "real.json"), config(ID_A));
    for (const [name, make] of [
      ["link", (path: string) => symlinkSync(join(top, "real.json"), path)],
      ["dir", (path: string) => mkdirSync(path)],
      ["fifo", (path: string) => spawnSync("mkfifo", [path])],
    ] as const) {
      const dir = join(top, name);
      mkdirSync(dir);
      make(join(dir, CONFIG_FILENAME));
      const error = await rejection(findProjectConfig({ cwd: dir }));
      expect(error.code).toBe("CONFIG_INVALID");
    }
  });

  it("walks the physical path of a symlinked working directory", async () => {
    const top = fresh();
    writeFileSync(join(top, CONFIG_FILENAME), config(ID_A));
    mkdirSync(join(top, "repo", "sub"), { recursive: true });
    writeFileSync(join(top, "repo", CONFIG_FILENAME), config(ID_B));
    const elsewhere = join(top, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(join(top, "repo", "sub"), join(elsewhere, "link"));
    // Logically elsewhere/link's parent has no file of its own; physically it is repo/.
    writeFileSync(join(elsewhere, CONFIG_FILENAME), config(ID_A));
    expect(await findProjectConfig({ cwd: join(elsewhere, "link") })).toMatchObject({
      dir: join(top, "repo"),
      config: { projectId: ID_B },
    });
  });

  it("returns null when nothing applies", async () => {
    const top = fresh();
    execFileSync("git", ["init", "-q", top]);
    expect(await findProjectConfig({ cwd: top })).toBeNull();
  });
});

describe("git worktrees", () => {
  function repoWithWorktrees() {
    const repo = join(fresh(), "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README"), "x");
    git(repo, "add", "README");
    git(repo, "commit", "-q", "-m", "initial");
    // A branch from before the binding existed, checked out *inside* the main worktree.
    git(repo, "worktree", "add", "-q", join(repo, ".worktrees", "old"), "-b", "old");
    writeFileSync(join(repo, CONFIG_FILENAME), config(ID_A));
    git(repo, "add", CONFIG_FILENAME);
    git(repo, "commit", "-q", "-m", "bind");
    // Branches with the binding: one nested, one beside the repository.
    git(repo, "worktree", "add", "-q", join(repo, ".worktrees", "new"), "-b", "new");
    const sibling = join(repo, "..", "sibling");
    git(repo, "worktree", "add", "-q", sibling, "-b", "sibling");
    return {
      repo,
      old: join(repo, ".worktrees", "old"),
      nested: join(repo, ".worktrees", "new"),
      sibling,
    };
  }

  it("uses each worktree's own copy and never the main worktree's", async () => {
    const { repo, old, nested, sibling } = repoWithWorktrees();
    mkdirSync(join(nested, "src", "deep"), { recursive: true });
    expect(await findProjectConfig({ cwd: join(nested, "src", "deep") })).toMatchObject({
      dir: nested,
      config: { projectId: ID_A },
    });
    expect(await findProjectConfig({ cwd: sibling })).toMatchObject({ dir: sibling });
    expect(await findProjectConfig({ cwd: repo })).toMatchObject({ dir: repo });
    // The old branch has no binding: the enclosing main checkout's file is not inherited.
    expect(await findProjectConfig({ cwd: old })).toBeNull();
    expect(await bindingDirFor({ cwd: join(nested, "src", "deep") })).toBe(nested);
    expect(await bindingDirFor({ cwd: old })).toBe(old);
  });

  it("binds outside a repository to the working directory itself", async () => {
    const top = fresh();
    expect(await bindingDirFor({ cwd: top })).toBe(top);
  });
});

describe("writeProjectConfig", () => {
  it("creates, then no-ops on the same binding, writing only version and projectId", async () => {
    const dir = fresh();
    expect(await writeProjectConfig({ dir, projectId: ID_A })).toMatchObject({
      status: "created",
      path: join(dir, CONFIG_FILENAME),
    });
    const contents = readFileSync(join(dir, CONFIG_FILENAME), "utf8");
    expect(JSON.parse(contents)).toEqual({ version: 1, projectId: ID_A });
    expect(contents).toBe(config(ID_A));
    const before = statSync(join(dir, CONFIG_FILENAME)).mtimeMs;
    expect(await writeProjectConfig({ dir, projectId: ID_A })).toMatchObject({
      status: "unchanged",
    });
    expect(statSync(join(dir, CONFIG_FILENAME)).mtimeMs).toBe(before);
    expect(readdirSync(dir)).toEqual([CONFIG_FILENAME]);
  });

  it("returns CONFLICT (exit 2) for a different or unreadable binding unless replacing", async () => {
    const dir = fresh();
    await writeProjectConfig({ dir, projectId: ID_A });
    const error = await rejection(writeProjectConfig({ dir, projectId: ID_B }));
    expect([error.code, error.exitCode]).toEqual(["CONFLICT", 2]);
    expect(error.hint).toContain("--replace");
    expect(JSON.parse(readFileSync(join(dir, CONFIG_FILENAME), "utf8")).projectId).toBe(ID_A);
    expect(await writeProjectConfig({ dir, projectId: ID_B, replace: true })).toMatchObject({
      status: "replaced",
    });
    expect(JSON.parse(readFileSync(join(dir, CONFIG_FILENAME), "utf8")).projectId).toBe(ID_B);

    writeFileSync(join(dir, CONFIG_FILENAME), "{broken");
    expect((await rejection(writeProjectConfig({ dir, projectId: ID_A }))).code).toBe("CONFLICT");
    expect(await writeProjectConfig({ dir, projectId: ID_A, replace: true })).toMatchObject({
      status: "replaced",
    });
    expect(readdirSync(dir).sort()).toEqual([CONFIG_FILENAME]);
  });

  it("never replaces a symlink, even when asked", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "target.json"), "keep");
    symlinkSync(join(dir, "target.json"), join(dir, CONFIG_FILENAME));
    for (const replace of [false, true]) {
      expect((await rejection(writeProjectConfig({ dir, projectId: ID_A, replace }))).code).toBe(
        "CONFIG_INVALID",
      );
    }
    expect(readFileSync(join(dir, "target.json"), "utf8")).toBe("keep");
  });

  it("rejects a Project ID that is not a UUID", async () => {
    expect(
      (await rejection(writeProjectConfig({ dir: fresh(), projectId: "../../etc" }))).code,
    ).toBe("USAGE_ERROR");
  });

  it("in one process: concurrent writers of different bindings produce one winner and conflicts", async () => {
    const dir = fresh();
    const ids = Array.from(
      { length: 12 },
      (_, index) => `3e0c4c38-8f3b-4c55-9d2f-${String(index).padStart(12, "0")}`,
    );
    const results = await Promise.allSettled(
      ids.map((projectId) => writeProjectConfig({ dir, projectId })),
    );
    const created = results.filter((result) => result.status === "fulfilled");
    expect(created).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected") expect((result.reason as CliError).code).toBe("CONFLICT");
    const winner = (created[0] as PromiseFulfilledResult<{ config: { projectId: string } }>).value
      .config.projectId;
    expect(JSON.parse(readFileSync(join(dir, CONFIG_FILENAME), "utf8")).projectId).toBe(winner);
  });

  it("across compiled processes: exactly one create, the rest unchanged or CONFLICT", async () => {
    const env = { HOME: root };
    const same = fresh();
    const sameRuns = await Promise.all(
      Array.from({ length: 8 }, () =>
        runAsync(SHELL_BINARY, ["config", "write", ID_A, "--json"], { cwd: same, env }),
      ),
    );
    const statuses = sameRuns.map((run) => JSON.parse(run.stdout).data?.status).sort();
    expect(statuses).toEqual(["created", ...Array(7).fill("unchanged")]);

    const different = fresh();
    const ids = Array.from(
      { length: 8 },
      (_, index) => `9a1d6e2f-4b7c-4d8e-8f9a-${String(index).padStart(12, "0")}`,
    );
    const runs = await Promise.all(
      ids.map((id) =>
        runAsync(SHELL_BINARY, ["config", "write", id, "--json"], { cwd: different, env }),
      ),
    );
    expect(runs.map((run) => run.status).sort()).toEqual([0, 2, 2, 2, 2, 2, 2, 2]);
    const winner = ids[runs.findIndex((run) => run.status === 0)];
    expect(JSON.parse(readFileSync(join(different, CONFIG_FILENAME), "utf8"))).toEqual({
      version: 1,
      projectId: winner,
    });

    const replaced = await Promise.all(
      ids.map((id) =>
        runAsync(SHELL_BINARY, ["config", "write", id, "--replace", "--json"], {
          cwd: different,
          env,
        }),
      ),
    );
    expect(replaced.every((run) => run.status === 0)).toBe(true);
    expect(ids).toContain(
      JSON.parse(readFileSync(join(different, CONFIG_FILENAME), "utf8")).projectId,
    );
    expect(readdirSync(different)).toEqual([CONFIG_FILENAME]);
  });
});
