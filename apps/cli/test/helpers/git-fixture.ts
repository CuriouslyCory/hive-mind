import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real git repositories for the `adr` command tests: a bare origin whose
 * `main` holds the given files, a seed clone that pushes to it, and a work
 * clone (where commands run) whose `refs/remotes/origin/HEAD` the clone set.
 *
 * HOME is the scratch directory, so the developer's ~/.gitconfig (signing,
 * hooks, init.defaultBranch) never applies; author and committer are fixed.
 */
export interface GitFixture {
  /** Runs git in `cwd` and returns its trimmed stdout. */
  git(cwd: string, ...args: string[]): string;
  /** A bare origin holding `files` on `main`, bound to `projectId`, and clones of it. */
  origin(files: Record<string, string>, binding: { projectId: string; dir?: string }): GitRepos;
  /** Writes files (null deletes) relative to `cwd` and commits them; returns the new commit. */
  commit(cwd: string, files: Record<string, string | null>, message?: string): string;
  /** Writes files (null deletes) without committing. */
  write(cwd: string, files: Record<string, string | null>): void;
}

export interface GitRepos {
  origin: string;
  /** A clone used to push new commits to origin. */
  seed: string;
  /** The clone the commands run in. */
  work: string;
  /** The binding's directory inside `work` (`work` itself unless `dir` was given). */
  bound: string;
  /** `binding.dir` or "" (repository-relative). */
  prefix: string;
  /** `git rev-parse <rev>` in `cwd`. */
  head(cwd: string, rev?: string): string;
}

export function gitFixture(scratch: string): GitFixture {
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (cwd: string, files: Record<string, string | null>) => {
    for (const [path, contents] of Object.entries(files)) {
      const target = join(cwd, path);
      if (contents === null) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
      }
    }
  };
  const commit = (cwd: string, files: Record<string, string | null>, message = "change") => {
    write(cwd, files);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "--allow-empty", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  let counter = 0;
  return {
    git,
    write,
    commit,
    origin(files, binding) {
      const root = join(scratch, `fixture-${counter++}`);
      const origin = join(root, "origin.git");
      const seed = join(root, "seed");
      mkdirSync(root, { recursive: true });
      git(root, "init", "--bare", "-q", "-b", "main", origin);
      git(root, "init", "-q", "-b", "main", seed);
      git(seed, "remote", "add", "origin", origin);
      const prefix = binding.dir ?? "";
      const under = (path: string) => (prefix === "" ? path : `${prefix}/${path}`);
      commit(
        seed,
        {
          [under(".hivemind.json")]: JSON.stringify({ version: 1, projectId: binding.projectId }),
          ...Object.fromEntries(Object.entries(files).map(([path, text]) => [under(path), text])),
        },
        "seed",
      );
      git(seed, "push", "-q", "origin", "main");
      const work = join(root, "work");
      git(root, "clone", "-q", origin, work);
      return {
        origin,
        seed,
        work,
        bound: prefix === "" ? work : join(work, ...prefix.split("/")),
        prefix,
        head: (cwd, rev = "HEAD") => git(cwd, "rev-parse", rev),
      };
    },
  };
}

/** A valid ADR file, following ADR-0001's template. */
export function adrText(
  title: string,
  options: { status?: string; date?: string; supersedes?: number[]; body?: string } = {},
): string {
  const supersedes =
    options.supersedes && options.supersedes.length > 0
      ? `supersedes: [${options.supersedes.join(", ")}]\n`
      : "";
  return `---\nstatus: ${options.status ?? "accepted"}\ndate: ${options.date ?? "2026-01-01"}\n${supersedes}---\n\n# ${title}\n\n## Context\n\n${options.body ?? "Why."}\n\n## Decision\n\nWhat.\n\n## Consequences\n\nSo.\n`;
}
