import { join } from "node:path";
import {
  CONFIG_FILENAME,
  CONFIG_VERSION,
  type HivemindConfig,
  MAX_CONFIG_BYTES,
  parseHivemindConfig,
  serializeHivemindConfig,
} from "@hivemind/contract";
import { CLI_ERROR_CODES, CliError } from "./errors.ts";
import {
  createFileExclusive,
  LockTimeoutError,
  readFileNoFollow,
  UnsafeFileError,
  withLock,
  writeFileAtomic,
} from "./fs-safe.ts";

/**
 * Reading and writing one `.hivemind.json` (the Project binding committed to a
 * repository). Discovery across parent directories is in
 * project-resolution.ts.
 *
 * The file is repository content, so it is untrusted data: it is read without
 * following a symlink, only if it is a regular file (a FIFO or device cannot
 * block or flood the CLI), with the 16 KiB cap enforced while reading, and it
 * only ever yields a Project ID. Origins, commands and credentials never come
 * from it. The writer only ever writes `{ version, projectId }`.
 */

export type ConfigReadResult = { found: false } | { found: true; config: HivemindConfig };

function configError(code: string, path: string, message: string, hint?: string): CliError {
  return new CliError(code, `${path}: ${message}`, { hint });
}

/**
 * Reads and validates the `.hivemind.json` at `path`. Returns `found: false`
 * if nothing is there; throws a `CliError` with a `CONFIG_*` code (exit 1) for
 * a file that exists but is unusable (symlink, not a regular file, too large,
 * malformed, unsupported version).
 */
export async function readConfigFile(path: string): Promise<ConfigReadResult> {
  let bytes: Buffer | null;
  try {
    bytes = await readFileNoFollow(path, { maxBytes: MAX_CONFIG_BYTES });
  } catch (error) {
    if (error instanceof UnsafeFileError) {
      throw configError("CONFIG_INVALID", path, error.message.replace(`${path} `, ""), error.hint);
    }
    throw new CliError(CLI_ERROR_CODES.io, `Cannot read ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (bytes === null) return { found: false };
  const parsed = parseHivemindConfig(bytes);
  if (parsed.ok) return { found: true, config: parsed.config };
  const hint =
    parsed.error.code === "CONFIG_UNSUPPORTED_VERSION"
      ? "Upgrade hivemind to a version that supports it."
      : `Fix the file, or run 'hivemind init --replace' to rewrite it. Expected {"version": ${CONFIG_VERSION}, "projectId": "<uuid>"}.`;
  throw configError(parsed.error.code, path, parsed.error.message, hint);
}

export type ConfigWriteStatus = "created" | "unchanged" | "replaced";

export interface ConfigWriteResult {
  status: ConfigWriteStatus;
  path: string;
  config: HivemindConfig;
}

export interface WriteProjectConfigOptions {
  /** Directory to write `.hivemind.json` into. */
  dir: string;
  projectId: string;
  /**
   * Replace an existing file that binds a different Project (or is
   * unreadable). Without it, a different binding is a CONFLICT (exit 2).
   */
  replace?: boolean;
  lockTimeoutMs?: number;
}

function sameBinding(a: HivemindConfig, b: HivemindConfig): boolean {
  return a.version === b.version && a.projectId === b.projectId;
}

async function readCurrent(
  path: string,
): Promise<{ config: HivemindConfig | null; error: CliError | null }> {
  try {
    const result = await readConfigFile(path);
    return { config: result.found ? result.config : null, error: null };
  } catch (error) {
    if (error instanceof CliError && error.code.startsWith("CONFIG_"))
      return { config: null, error };
    throw error;
  }
}

/**
 * Writes `{ version: 1, projectId }` to `<dir>/.hivemind.json`, safely under
 * concurrency:
 *
 * - No file: created atomically with create-if-absent semantics (temp file +
 *   hard link), so two concurrent `init`s cannot both "create"; the loser
 *   re-reads what the winner wrote and reports unchanged or CONFLICT.
 * - Same binding already there: no-op (`unchanged`), the file is not touched.
 * - Different (or unreadable) binding: CONFLICT unless `replace` is set.
 * - `replace`: under a lock file, re-reads the current content and replaces
 *   it with an atomic rename. Every replacing writer holds the lock, and a
 *   creating writer can only succeed while no file exists (a rename never
 *   leaves the path empty), so each write is decided on exactly the content
 *   it replaces and the result names what happened.
 *
 * A symlinked `.hivemind.json` is refused, even with `replace`. Interrupted
 * writes leave the previous file intact (no partial file is ever renamed in).
 */
export async function writeProjectConfig(
  options: WriteProjectConfigOptions,
): Promise<ConfigWriteResult> {
  const path = join(options.dir, CONFIG_FILENAME);
  const desired: HivemindConfig = { version: CONFIG_VERSION, projectId: options.projectId };
  // Validates the Project ID (uuid) before anything touches the disk.
  let contents: string;
  try {
    contents = serializeHivemindConfig(desired);
  } catch {
    throw new CliError(
      CLI_ERROR_CODES.usage,
      `Invalid Project ID for ${CONFIG_FILENAME}; expected a UUID.`,
    );
  }

  const conflict = (current: HivemindConfig | null, error: CliError | null): CliError => {
    const what = current
      ? `is bound to Project ${current.projectId}`
      : `cannot be read (${error?.message ?? "invalid"})`;
    return new CliError("CONFLICT", `${path} ${what}, not ${options.projectId}.`, {
      hint: "Pass --replace to bind this directory to the new Project.",
    });
  };

  const attempt = async (): Promise<ConfigWriteResult | null> => {
    const current = await readCurrent(path);
    if (current.config && sameBinding(current.config, desired))
      return { status: "unchanged", path, config: desired };
    if (!current.config && !current.error) {
      // Nothing there: create without ever replacing.
      if (await createFileExclusive(path, contents, 0o666))
        return { status: "created", path, config: desired };
      return null; // Someone created it first; decide again from what they wrote.
    }
    // A symlink or non-regular file is never replaced, even when asked.
    if (
      current.error &&
      current.error.code === "CONFIG_INVALID" &&
      /symbolic link|not a regular file/.test(current.error.message)
    ) {
      throw current.error;
    }
    if (!options.replace) throw conflict(current.config, current.error);
    return null;
  };

  try {
    // Two rounds cover "file appeared between our read and our create".
    for (let round = 0; round < 2; round++) {
      const result = await attempt();
      if (result) return result;
      if (options.replace) break;
    }
    if (!options.replace) {
      const current = await readCurrent(path);
      if (current.config && sameBinding(current.config, desired))
        return { status: "unchanged", path, config: desired };
      throw conflict(current.config, current.error);
    }

    // Replace: compare-and-swap under the lock. Every replacing writer takes
    // the lock; a creating writer cannot interfere because creation only
    // succeeds while no file exists.
    return await withLock(
      `${path}.lock`,
      async () => {
        const before = await readFileNoFollow(path, { maxBytes: MAX_CONFIG_BYTES }).catch(
          (error: unknown) => {
            if (error instanceof UnsafeFileError) {
              throw configError(
                "CONFIG_INVALID",
                path,
                error.message.replace(`${path} `, ""),
                error.hint,
              );
            }
            throw error;
          },
        );
        if (before !== null) {
          const parsed = parseHivemindConfig(before);
          if (parsed.ok && sameBinding(parsed.config, desired))
            return { status: "unchanged" as const, path, config: desired };
        }
        await writeFileAtomic(path, contents, 0o666);
        return {
          status: before === null ? ("created" as const) : ("replaced" as const),
          path,
          config: desired,
        };
      },
      { timeoutMs: options.lockTimeoutMs },
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof LockTimeoutError) {
      throw new CliError(CLI_ERROR_CODES.io, error.message, {
        hint: `If no other hivemind command is running, delete ${error.path}.`,
      });
    }
    throw new CliError(CLI_ERROR_CODES.io, `Cannot write ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
