import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bindingDirFor, resolveProjectId } from "../src/project-resolution.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hivemind-resolution-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PROJECT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A repository with a committed binding and a linked worktree on another branch. */
function repoWithWorktree() {
  const main = join(root, "main");
  mkdirSync(join(main, "src", "deep"), { recursive: true });
  git(root, "init", "-q", "-b", "main", main);
  writeFileSync(join(main, ".hivemind.json"), JSON.stringify({ version: 1, projectId: PROJECT }));
  writeFileSync(join(main, "src", "deep", "file.txt"), "x");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const linked = join(root, "linked");
  git(main, "worktree", "add", "-q", "-b", "feature", linked);
  return { main, linked };
}

describe("resolveProjectId", () => {
  const { main, linked } = repoWithWorktree();

  it("prefers --project over the binding", async () => {
    expect(await resolveProjectId({ flag: OTHER, cwd: join(main, "src") })).toEqual({
      projectId: OTHER,
      source: "flag",
      configPath: null,
    });
  });

  it("finds the binding from a nested directory", async () => {
    expect(await resolveProjectId({ flag: undefined, cwd: join(main, "src", "deep") })).toEqual({
      projectId: PROJECT,
      source: "config",
      configPath: join(main, ".hivemind.json"),
    });
  });

  it("finds the committed binding in a linked git worktree, from its own checkout", async () => {
    const result = await resolveProjectId({ flag: undefined, cwd: join(linked, "src", "deep") });
    expect(result).toEqual({
      projectId: PROJECT,
      source: "config",
      configPath: join(linked, ".hivemind.json"),
    });
    expect(await bindingDirFor({ cwd: join(linked, "src") })).toBe(linked);
  });

  it("fails on a malformed nearest file instead of using an ancestor", async () => {
    const nested = join(main, "src", "deep");
    writeFileSync(join(main, "src", ".hivemind.json"), "{");
    try {
      await expect(resolveProjectId({ flag: undefined, cwd: nested })).rejects.toMatchObject({
        code: "CONFIG_INVALID_JSON",
      });
    } finally {
      rmSync(join(main, "src", ".hivemind.json"));
    }
  });

  it("is a usage error with no flag and no binding, and for a non-uuid flag", async () => {
    const outside = join(root, "plain");
    mkdirSync(join(outside, ".git"), { recursive: true });
    await expect(resolveProjectId({ flag: undefined, cwd: outside })).rejects.toMatchObject({
      code: "USAGE_ERROR",
    });
    await expect(resolveProjectId({ flag: "abc", cwd: outside })).rejects.toMatchObject({
      code: "USAGE_ERROR",
    });
  });
});
