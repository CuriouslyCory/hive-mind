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
