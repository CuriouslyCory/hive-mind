import { execFile } from "node:child_process";
import {
  compareTouchedPaths,
  gitBranchSchema,
  gitCommitSchema,
  isTouchedPath,
  MAX_COLLECTION_PATHS,
} from "@hivemind/contract";
import type { Env } from "./command.ts";

/**
 * Read-only git queries for Session metadata and touched-path collection
 * (issue #12, "Scopes and overlap"; ADR-0014).
 *
 * Safety rules:
 * - git runs with an argument array (`execFile`, no shell), fixed arguments,
 *   and nothing from the repository in its command line. Output is parsed as
 *   data.
 * - `git status` uses `-z`, so paths arrive NUL-terminated and unquoted: a
 *   name may contain spaces, newlines, `*` or a leading `-` and is still one
 *   path. Output is read as bytes; a name that is not valid UTF-8 cannot be
 *   sent and is counted as omitted, never dropped silently.
 * - The environment is reduced to PATH, HOME, no terminal prompts and the C
 *   locale, as `gitOriginUrl` (commands/init.ts) does, so GIT_DIR and the like
 *   from the caller cannot point git at another repository.
 * - `--no-optional-locks` keeps `git status` from writing the index, so a
 *   heartbeat never contends with the agent's own git commands.
 *
 * Outside a worktree, or without git installed, the answers are explicit
 * nulls; nothing is guessed.
 */

const GIT_TIMEOUT_MS = 30_000;
/** Enough for tens of thousands of changed paths; a larger answer is a failed collection. */
const MAX_STATUS_BYTES = 32 * 1024 * 1024;
const MAX_SMALL_OUTPUT_BYTES = 64 * 1024;

export interface GitRunResult {
  ok: boolean;
  stdout: Buffer;
  /** Why git failed: its exit code, a spawn error code (`ENOENT`) or `maxBuffer`. */
  failure: string | null;
}

/** Runs git with a fixed argument array in `cwd`; never throws. */
export function runGit(
  args: readonly string[],
  options: { cwd: string; env: Env; maxBytes?: number },
): Promise<GitRunResult> {
  return new Promise((resolveResult) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd: options.cwd,
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: options.maxBytes ?? MAX_SMALL_OUTPUT_BYTES,
        env: {
          PATH: options.env.PATH,
          HOME: options.env.HOME,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          const failure =
            code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "maxBuffer"
              : error.killed
                ? "timeout"
                : typeof code === "number"
                  ? `exit ${code}`
                  : String(code ?? error.message);
          resolveResult({ ok: false, stdout: Buffer.from(stdout ?? []), failure });
          return;
        }
        resolveResult({ ok: true, stdout, failure: null });
      },
    );
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** One line of git output as text, or null when it is empty, multi-line or not UTF-8. */
function singleLine(stdout: Buffer): string | null {
  let text: string;
  try {
    text = utf8.decode(stdout);
  } catch {
    return null;
  }
  text = text.replace(/\n$/, "");
  return text === "" || text.includes("\n") ? null : text;
}

/**
 * The top directory of the worktree containing `cwd` (a linked worktree's
 * own top, not the main checkout's), or null outside git.
 */
export async function gitWorktreeRoot(cwd: string, env: Env): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], { cwd, env });
  return result.ok ? singleLine(result.stdout) : null;
}

export interface GitMetadata {
  /** Null outside git. */
  root: string | null;
  /** The checked-out branch; null when detached, outside git, or not a valid branch name to send. */
  branch: string | null;
  /** HEAD's full hash; null before the first commit or outside git. */
  commit: string | null;
}

/** Branch and commit of the worktree containing `cwd`, each null when unknown. */
export async function gitMetadata(cwd: string, env: Env): Promise<GitMetadata> {
  const root = await gitWorktreeRoot(cwd, env);
  if (root === null) return { root: null, branch: null, commit: null };
  const [branch, commit] = await Promise.all([
    runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, env }),
    runGit(["rev-parse", "--quiet", "--verify", "HEAD^{commit}"], { cwd, env }),
  ]);
  const branchName = branch.ok ? singleLine(branch.stdout) : null;
  const hash = commit.ok ? singleLine(commit.stdout) : null;
  return {
    root,
    branch:
      branchName !== null && gitBranchSchema.safeParse(branchName).success ? branchName : null,
    commit: hash !== null && gitCommitSchema.safeParse(hash).success ? hash : null,
  };
}

export interface ParsedStatus {
  /** Every path the status names, both names of a rename or copy, decoded and distinct. */
  paths: string[];
  /** Names that are not valid UTF-8; they cannot be uploaded. */
  undecodable: number;
}

/**
 * Parses `git status --porcelain=v1 -z` output: entries `XY <path>\0`, where a
 * rename or copy (`R` or `C` in either column) is followed by its source path
 * as one more NUL-terminated field. Paths are relative to the worktree top.
 */
export function parsePorcelainZ(stdout: Uint8Array): ParsedStatus {
  const names: Uint8Array[] = [];
  let start = 0;
  let expectSource = false;
  for (let index = 0; index < stdout.length; index++) {
    if (stdout[index] !== 0) continue;
    const field = stdout.subarray(start, index);
    start = index + 1;
    if (expectSource) {
      names.push(field);
      expectSource = false;
      continue;
    }
    // `XY ` then the path; anything shorter is not an entry.
    if (field.length < 4 || field[2] !== 0x20) continue;
    const x = String.fromCharCode(field[0] ?? 0);
    const y = String.fromCharCode(field[1] ?? 0);
    names.push(field.subarray(3));
    expectSource = "RC".includes(x) || "RC".includes(y);
  }
  const paths = new Set<string>();
  let undecodable = 0;
  for (const name of names) {
    try {
      // An untracked nested repository is listed as a directory, `sub/`.
      paths.add(utf8.decode(name).replace(/(?<=.)\/$/, ""));
    } catch {
      undecodable++;
    }
  }
  return { paths: [...paths], undecodable };
}

export interface TouchedPathSelection {
  /** At most `MAX_COLLECTION_PATHS` valid paths, distinct, in `compareTouchedPaths` order. */
  paths: string[];
  /** Changed paths that are not sent: not UTF-8, over 256 bytes, otherwise invalid, or beyond the cap. */
  omittedPathCount: number;
}

/**
 * Chooses what a collection uploads: the valid paths in canonical order, the
 * first `MAX_COLLECTION_PATHS` of them, and the count of everything left out.
 * Deterministic, so `--collection-id` recovery re-derives the same manifest
 * from an unchanged worktree.
 */
export function selectTouchedPaths(parsed: ParsedStatus): TouchedPathSelection {
  const valid = parsed.paths.filter(isTouchedPath).sort(compareTouchedPaths);
  const invalid = parsed.paths.length - valid.length;
  const kept = valid.slice(0, MAX_COLLECTION_PATHS);
  return {
    paths: kept,
    omittedPathCount: parsed.undecodable + invalid + (valid.length - kept.length),
  };
}

export type TouchedPathsResult =
  | { available: false }
  | { available: true; root: string; selection: TouchedPathSelection }
  | { available: true; root: string; failure: string };

/**
 * The worktree's changed paths: tracked modifications, additions, deletions,
 * untracked files (every one, not just their directories) and both names of
 * renames. `available: false` outside git; `failure` when git ran but the
 * status could not be read (timeout, too much output).
 */
export async function collectTouchedPaths(cwd: string, env: Env): Promise<TouchedPathsResult> {
  const root = await gitWorktreeRoot(cwd, env);
  if (root === null) return { available: false };
  const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    env,
    maxBytes: MAX_STATUS_BYTES,
  });
  if (!status.ok)
    return { available: true, root, failure: `git status failed (${status.failure})` };
  return { available: true, root, selection: selectTouchedPaths(parsePorcelainZ(status.stdout)) };
}

// ---------------------------------------------------------------------------
// Commit reads for ADR sync (issue #19, ADR-0017). `adr sync` reads one
// commit's tree and never the working tree, so unmerged branches and dirty
// files cannot reach hive-mind's copy. Revisions come from the user (`--ref`)
// and are passed after `--end-of-options`, so a value starting with `-` is a
// revision, never an option.

/** Enough for `git ls-tree` of a directory with tens of thousands of entries. */
const MAX_TREE_BYTES = 32 * 1024 * 1024;

/** The full hash of the commit `rev` names, or null when it names none. */
export async function gitResolveCommit(cwd: string, env: Env, rev: string): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
    { cwd, env },
  );
  const hash = result.ok ? singleLine(result.stdout) : null;
  return hash !== null && gitCommitSchema.safeParse(hash).success ? hash : null;
}

/** Whether this clone has the commit `hash` (a shallow clone or a fresh clone after a force-push may not). */
export async function gitHasCommit(cwd: string, env: Env, hash: string): Promise<boolean> {
  if (!gitCommitSchema.safeParse(hash).success) return false;
  return (await runGit(["cat-file", "-e", `${hash}^{commit}`], { cwd, env })).ok;
}

/**
 * Whether `ancestor` is an ancestor of (or equal to) `descendant`: true or
 * false as git answers, null when git cannot tell (a missing commit, a
 * shallow history, git failing).
 */
export async function gitIsAncestor(
  cwd: string,
  env: Env,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  const result = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], { cwd, env });
  if (result.ok) return true;
  return result.failure === "exit 1" ? false : null;
}

export interface GitTreeEntry {
  /** `100644`, `100755`, `120000` (symlink), `040000` (tree), `160000` (submodule). */
  mode: string;
  type: string;
  oid: string;
  /** Bytes of a blob; null for anything else. */
  size: number | null;
  /** Repository-relative POSIX path. A name that is not UTF-8 has U+FFFD in it. */
  path: string;
}

export type GitTreeResult = { ok: true; entries: GitTreeEntry[] } | { ok: false; failure: string };

const lossyUtf8 = new TextDecoder("utf-8");

/**
 * The entries directly inside `directory` (repository-relative, no trailing
 * slash) in `commit`'s tree, with blob sizes, so a large blob can be refused
 * before it is read. A missing directory is an empty list.
 */
export async function gitListTree(
  cwd: string,
  env: Env,
  commit: string,
  directory: string,
): Promise<GitTreeResult> {
  const result = await runGit(
    ["ls-tree", "-l", "-z", "--full-tree", "--end-of-options", commit, "--", `${directory}/`],
    { cwd, env, maxBytes: MAX_TREE_BYTES },
  );
  if (!result.ok) return { ok: false, failure: result.failure ?? "unknown" };
  const entries: GitTreeEntry[] = [];
  let start = 0;
  for (let index = 0; index < result.stdout.length; index++) {
    if (result.stdout[index] !== 0) continue;
    const field = result.stdout.subarray(start, index);
    start = index + 1;
    // `<mode> SP <type> SP <oid> SP+ <size> TAB <path>`; the path is unquoted under -z.
    const tab = field.indexOf(0x09);
    if (tab === -1) continue;
    const [mode, type, oid, size] = field.subarray(0, tab).toString("latin1").trim().split(/ +/);
    if (!mode || !type || !oid) continue;
    entries.push({
      mode,
      type,
      oid,
      size: size === undefined || size === "-" ? null : Number(size),
      path: lossyUtf8.decode(field.subarray(tab + 1)),
    });
  }
  return { ok: true, entries };
}

export type GitBlobResult = { ok: true; bytes: Buffer } | { ok: false; failure: string };

/** A blob's exact bytes; a blob larger than `maxBytes` is a failure (`maxBuffer`), not a partial read. */
export async function gitReadBlob(
  cwd: string,
  env: Env,
  oid: string,
  maxBytes: number,
): Promise<GitBlobResult> {
  const result = await runGit(["cat-file", "blob", oid], { cwd, env, maxBytes });
  return result.ok
    ? { ok: true, bytes: result.stdout }
    : { ok: false, failure: result.failure ?? "unknown" };
}
