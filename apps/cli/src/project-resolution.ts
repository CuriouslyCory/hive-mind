import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILENAME, type HivemindConfig, idSchema } from "@hivemind/contract";
import { readConfigFile } from "./config.ts";
import { usageError } from "./errors.ts";

/**
 * `.hivemind.json` discovery: which Project the current directory is bound to.
 *
 * Walk: start at `cwd` and check each directory up to the filesystem root.
 * The nearest `.hivemind.json` decides. If it is malformed, too large, of an
 * unsupported version, a symlink or not a regular file, that is an error; an
 * ancestor's file is never used instead, because that would silently bind
 * the command to a different Project.
 *
 * Repository boundary: the walk stops after the first directory that contains
 * a `.git` entry (a directory in a main checkout, a file in a linked worktree
 * or submodule). A repository is bound by its own committed file, so a linked
 * worktree placed inside the main checkout (`repo/.worktrees/x`) or a
 * submodule never inherits the enclosing checkout's binding. Each worktree
 * contains its own copy of the committed file; the main worktree is never
 * consulted. Outside any repository the walk continues to the root.
 *
 * Symlinks: the walk follows the physical path. The start directory is
 * resolved with realpath (`process.cwd()` already is; the shell's logical
 * `$PWD` is ignored) and parents are computed from that path, the same way
 * git discovers its repository. A
 * `.hivemind.json` that is itself a symlink is refused (see config.ts), so a
 * repository cannot point the CLI at a file elsewhere on the machine.
 */

export interface DiscoveredConfig {
  /** Absolute path of the `.hivemind.json` that applies. */
  path: string;
  /** The directory containing it (the bound directory). */
  dir: string;
  config: HivemindConfig;
}

export interface DiscoveryOptions {
  /** Where to start; defaults to `process.cwd()`. */
  cwd?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The binding for `cwd`, or null if no `.hivemind.json` applies. Throws `CliError` (CONFIG_*) for an unusable nearest file. */
export async function findProjectConfig(
  options: DiscoveryOptions = {},
): Promise<DiscoveredConfig | null> {
  let dir = await realpath(resolve(options.cwd ?? process.cwd()));
  for (;;) {
    const path = join(dir, CONFIG_FILENAME);
    const result = await readConfigFile(path);
    if (result.found) return { path, dir, config: result.config };
    if (await exists(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where `init` should write a new binding: the top of the enclosing
 * repository (the nearest directory with a `.git` entry, so a linked worktree
 * gets its own file), or `cwd` itself outside a repository.
 */
export async function bindingDirFor(options: DiscoveryOptions = {}): Promise<string> {
  const start = await realpath(resolve(options.cwd ?? process.cwd()));
  let dir = start;
  for (;;) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export type ProjectIdSource = "flag" | "config";

export interface ResolvedProjectId {
  projectId: string;
  source: ProjectIdSource;
  /** The `.hivemind.json` it came from, when `source` is `config`. */
  configPath: string | null;
}

/**
 * The Project a command acts on: `--project <id>` when given, otherwise the
 * nearest `.hivemind.json`. Neither is a USAGE_ERROR naming both ways to fix
 * it. A malformed nearest file is its CONFIG_* error, never skipped.
 */
export async function resolveProjectId(options: {
  flag: string | undefined;
  cwd: string;
}): Promise<ResolvedProjectId> {
  if (options.flag !== undefined) {
    if (!idSchema.safeParse(options.flag).success) {
      throw usageError("--project must be a Project id (a uuid).");
    }
    return { projectId: options.flag, source: "flag", configPath: null };
  }
  const found = await findProjectConfig({ cwd: options.cwd });
  if (!found) {
    throw usageError(
      "No Project: this directory has no .hivemind.json and --project was not given.",
      "Pass --project <id>, or run 'hivemind init' in the repository first.",
    );
  }
  return { projectId: found.config.projectId, source: "config", configPath: found.path };
}
