import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_COLLECTION_PATHS } from "@hivemind/contract";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectTouchedPaths,
  gitMetadata,
  gitWorktreeRoot,
  parsePorcelainZ,
  selectTouchedPaths,
} from "../src/git.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hivemind-git-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const env = { PATH: process.env.PATH, HOME: scratch };

let counter = 0;
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** A repository with one commit holding `files`. */
function repo(files: Record<string, string> = { "README.md": "hi\n" }): string {
  const root = join(scratch, `repo-${counter++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

async function touched(cwd: string) {
  const result = await collectTouchedPaths(cwd, env);
  if (!result.available || "failure" in result) throw new Error(JSON.stringify(result));
  return result.selection;
}

describe("worktree root and metadata", () => {
  it("finds the root from a nested directory, with branch and commit", async () => {
    const root = repo({ "packages/app/index.ts": "x\n" });
    const nested = join(root, "packages", "app");
    expect(await gitWorktreeRoot(nested, env)).toBe(root);
    const meta = await gitMetadata(nested, env);
    expect(meta).toMatchObject({ root, branch: "main" });
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("uses a linked worktree's own root and branch, not the main checkout's", async () => {
    const root = repo();
    const linked = join(scratch, `linked-${counter++}`);
    git(root, "worktree", "add", "-q", "-b", "feature", linked);
    mkdirSync(join(linked, "deep"));
    expect(await gitWorktreeRoot(join(linked, "deep"), env)).toBe(linked);
    expect(await gitMetadata(linked, env)).toMatchObject({ root: linked, branch: "feature" });
    writeFileSync(join(linked, "only-here.txt"), "x");
    expect((await touched(join(linked, "deep"))).paths).toEqual(["only-here.txt"]);
    expect((await touched(root)).paths).toEqual([]);
  });

  it("reports explicit nulls outside git and on a detached or unborn HEAD", async () => {
    const plain = join(scratch, `plain-${counter++}`);
    mkdirSync(plain);
    expect(await gitMetadata(plain, env)).toEqual({ root: null, branch: null, commit: null });
    expect(await collectTouchedPaths(plain, env)).toEqual({ available: false });

    const root = repo();
    git(root, "checkout", "-q", "--detach");
    const detached = await gitMetadata(root, env);
    expect(detached.branch).toBeNull();
    expect(detached.commit).toMatch(/^[0-9a-f]{40}$/);

    const unborn = join(scratch, `unborn-${counter++}`);
    mkdirSync(unborn);
    git(unborn, "init", "-q", "-b", "trunk");
    expect(await gitMetadata(unborn, env)).toMatchObject({ branch: "trunk", commit: null });
  });

  it("ignores GIT_DIR and similar variables from the caller", async () => {
    const root = repo();
    const other = repo();
    writeFileSync(join(other, "elsewhere.txt"), "x");
    const hostile = { ...env, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other };
    const result = await collectTouchedPaths(root, hostile);
    expect(result).toMatchObject({ available: true, root, selection: { paths: [] } });
  });
});

describe("touched paths", () => {
  it("covers modifications, additions, deletions, untracked files and both rename names", async () => {
    const root = repo({ "a.txt": "a\n", "old/name.txt": "rename me\n", "gone.txt": "x\n" });
    writeFileSync(join(root, "a.txt"), "changed\n");
    writeFileSync(join(root, "staged.txt"), "new\n");
    git(root, "add", "staged.txt");
    unlinkSync(join(root, "gone.txt"));
    mkdirSync(join(root, "new", "dir"), { recursive: true });
    writeFileSync(join(root, "new", "dir", "untracked.txt"), "u\n");
    mkdirSync(join(root, "renamed"));
    git(root, "mv", "old/name.txt", "renamed/name.txt");
    expect((await touched(join(root, "new"))).paths).toEqual([
      "a.txt",
      "gone.txt",
      "new/dir/untracked.txt",
      "old/name.txt",
      "renamed/name.txt",
      "staged.txt",
    ]);
  });

  it("keeps names with spaces, newlines, globs and leading dashes as single literal paths", async () => {
    const root = repo();
    const names = ["with space.txt", "line\nbreak.txt", "star*.ts", "-rf", "--help", "q?.md"];
    for (const name of names) writeFileSync(join(root, name), "x");
    const selection = await touched(root);
    expect(selection.paths).toEqual([...names].sort());
    expect(selection.omittedPathCount).toBe(0);
  });

  it("counts names it cannot send as omitted instead of dropping them", async () => {
    if (process.platform === "darwin") return; // APFS refuses names that are not UTF-8
    const root = repo();
    const latin1 = Buffer.concat([
      Buffer.from(`${root}/bad`),
      Buffer.from([0xff]),
      Buffer.from(".t"),
    ]);
    writeFileSync(latin1, "x");
    writeFileSync(join(root, "x".repeat(200)), "x");
    mkdirSync(join(root, "d".repeat(200)));
    writeFileSync(join(root, "d".repeat(200), "e".repeat(100)), "x");
    writeFileSync(join(root, "fine.txt"), "x");
    const selection = await touched(root);
    expect(selection.paths).toEqual(["fine.txt", "x".repeat(200)]);
    expect(selection.omittedPathCount).toBe(2);
  });
});

describe("parsePorcelainZ and selectTouchedPaths", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("reads the source of a rename or copy in either column", () => {
    const out = bytes("R  new\0old\0 C copy\0orig\0?? u\0 M m\0D  d\0");
    expect(parsePorcelainZ(out).paths.sort()).toEqual([
      "copy",
      "d",
      "m",
      "new",
      "old",
      "orig",
      "u",
    ]);
  });

  it("caps a collection at MAX_COLLECTION_PATHS, sorted, counting the rest as omitted", () => {
    const paths = Array.from({ length: MAX_COLLECTION_PATHS + 5 }, (_, i) => `f${i}`);
    const selection = selectTouchedPaths({ paths: [...paths].reverse(), undecodable: 1 });
    expect(selection.paths).toHaveLength(MAX_COLLECTION_PATHS);
    expect(selection.paths).toEqual([...paths].sort().slice(0, MAX_COLLECTION_PATHS));
    expect(selection.omittedPathCount).toBe(6);
  });

  it("lists an untracked nested repository as its directory", () => {
    expect(parsePorcelainZ(bytes("?? vendor/lib/\0")).paths).toEqual(["vendor/lib"]);
  });
});
