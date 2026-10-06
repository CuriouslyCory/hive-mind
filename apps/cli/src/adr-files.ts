import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  ADR_DIRECTORY,
  adrContentSha256,
  formatAdrNumber,
  MAX_ADR_FILE_BYTES,
  MAX_ADR_SYNC_WARNINGS,
  type ParsedAdrFile,
  parseAdrFile,
  parseAdrFileName,
  validateAdrSet,
} from "@hivemind/contract";
import type { CommandContext } from "./command.ts";
import { CLI_ERROR_CODES, CliError, usageError } from "./errors.ts";
import { readFileNoFollow, syncDir, UnsafeFileError, writeTemp } from "./fs-safe.ts";
import { gitWorktreeRoot } from "./git.ts";
import { findProjectConfig } from "./project-resolution.ts";

/**
 * The ADR files the `adr` commands read and write (issue #19, ADR-0001,
 * ADR-0017): where the ADR directory is, listing and reading its files,
 * checking a set of them with the contract's parser, and replacing files
 * atomically. The parser itself is `@hivemind/contract`'s adr.ts; nothing
 * here re-implements it.
 *
 * The ADR directory is `<dir>/docs/adr`, where `<dir>` holds the applicable
 * `.hivemind.json`. Commands that only touch local files fall back to the git
 * worktree root when no `.hivemind.json` applies, so they work in an unbound
 * repository and in a pull request's CI. The ADR files are the entries
 * directly in that directory whose names end in `.md`; subdirectories and
 * other names (such as a leftover `.0003-a.md.<hex>.tmp`) are ignored.
 */

export interface AdrLocation {
  /** Absolute path of the ADR directory (it may not exist yet). */
  dir: string;
  /** The directory `dir` is under: the applicable `.hivemind.json`'s, or the worktree root. */
  base: string;
  /**
   * The ADR directory as a repository-relative POSIX path: `docs/adr`, or
   * `<sub>/docs/adr` when `.hivemind.json` is below the repository root.
   * Relative to `base` outside git.
   */
  directory: string;
  /** The git worktree root; null outside git. */
  root: string | null;
  /** What `directory` is relative to: `root`, or outside git the binding's directory. */
  top: string;
  /** The Project of the applicable `.hivemind.json`; null when none applies. */
  projectId: string | null;
}

function posix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Where the ADR directory is for `context.cwd`. With `binding: true` a
 * `.hivemind.json` must apply (`adr new`, `adr sync`); otherwise the git
 * worktree root stands in for it, and null means neither applies.
 */
export async function locateAdrs(
  context: Pick<CommandContext, "cwd" | "env">,
  options: { binding: boolean },
): Promise<AdrLocation | null> {
  const found = await findProjectConfig({ cwd: context.cwd });
  if (!found && options.binding) {
    throw usageError(
      "No Project: this directory has no .hivemind.json.",
      "Run 'hivemind init' in the repository first.",
    );
  }
  const root = await gitWorktreeRoot(found?.dir ?? context.cwd, context.env);
  const base = found?.dir ?? root;
  if (base === null) return null;
  let below = root === null ? "" : relative(root, base);
  // The binding is at or below the worktree root (discovery stops at the
  // repository boundary); anything else is treated as outside git.
  const outside = below.startsWith("..") || isAbsolute(below);
  if (outside) below = "";
  return {
    dir: join(base, ...ADR_DIRECTORY.split("/")),
    base,
    directory: below === "" ? ADR_DIRECTORY : `${posix(below)}/${ADR_DIRECTORY}`,
    root: outside ? null : root,
    top: outside || root === null ? base : root,
    projectId: found?.config.projectId ?? null,
  };
}

/** One ADR file, wherever it was read from. */
export interface AdrSource {
  /** `0017-adr-sync.md`, or any other `.md` name found in the directory. */
  fileName: string;
  /** Repository-relative POSIX path, the form `--json` and the API use. */
  path: string;
  /** Absolute path in the working tree (for a commit's file, where it would be). */
  absolute: string;
}

/** The ADR number in a file name, or null when the name is not an ADR file name. */
export function numberOfFileName(fileName: string): number | null {
  const parsed = parseAdrFileName(fileName);
  return parsed.ok ? parsed.number : null;
}

export function sourceIn(location: AdrLocation, fileName: string): AdrSource {
  return {
    fileName,
    path: `${location.directory}/${fileName}`,
    absolute: join(location.dir, fileName),
  };
}

function ioError(message: string, cause: unknown, hint?: string): CliError {
  return new CliError(CLI_ERROR_CODES.io, message, { cause, hint });
}

/** The `.md` entries directly in the working tree's ADR directory, by name; none when it is missing. */
export async function listLocalAdrFiles(location: AdrLocation): Promise<AdrSource[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(location.dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw ioError(`Cannot read ${location.dir}: ${(error as Error).message}`, error);
  }
  return entries
    .filter((entry) => entry.name.endsWith(".md") && !entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => sourceIn(location, name));
}

/**
 * A local ADR file's bytes, at most `MAX_ADR_FILE_BYTES + 1` of them (so the
 * parser reports a larger file as ADR_TOO_LARGE). Symlinks and other
 * non-regular files are refused.
 */
export async function readLocalAdr(source: AdrSource): Promise<Buffer> {
  let bytes: Buffer | null;
  try {
    bytes = await readFileNoFollow(source.absolute, { maxBytes: MAX_ADR_FILE_BYTES });
  } catch (error) {
    if (error instanceof UnsafeFileError) throw ioError(error.message, error, error.hint);
    throw ioError(`Cannot read ${source.absolute}: ${(error as Error).message}`, error);
  }
  if (bytes === null)
    throw ioError(`${source.absolute} disappeared while it was being read.`, null);
  return bytes;
}

/** A file read for checking: its bytes, or why it was not read (a commit's blob over the limit). */
export interface AdrInput {
  source: AdrSource;
  bytes: Uint8Array | null;
  /** Set when `bytes` is null. */
  unread?: { code: string; message: string };
}

export interface ParsedAdrSource {
  source: AdrSource;
  bytes: Uint8Array;
  sha256: string;
  adr: ParsedAdrFile;
}

export interface AdrFileProblem {
  source: AdrSource;
  code: string;
  message: string;
}

/** A sync notice or a warning about one file, in the API's `AdrSyncWarning` shape. */
export interface AdrNotice {
  number: number;
  path: string;
  code: string;
  message: string;
}

export interface AdrSetCheck {
  /** Every file that parsed, by file name. */
  adrs: ParsedAdrSource[];
  /** Numbers that more than one file name has, with those files. */
  duplicates: [number, AdrSource[]][];
  /** Every error, file by file. */
  problems: AdrFileProblem[];
  /** The parser's content warnings and `validateAdrSet`'s warnings, by number. */
  warnings: AdrNotice[];
}

/**
 * Parses every file with `parseAdrFile` and checks the set with
 * `validateAdrSet`. Duplicate numbers are found from the file names alone, so
 * they are reported even when one of the files is also invalid.
 */
export async function checkAdrSet(inputs: readonly AdrInput[]): Promise<AdrSetCheck> {
  const adrs: ParsedAdrSource[] = [];
  const problems: AdrFileProblem[] = [];
  const byNumber = new Map<number, AdrSource[]>();
  for (const input of inputs) {
    const number = numberOfFileName(input.source.fileName);
    if (number !== null) byNumber.set(number, [...(byNumber.get(number) ?? []), input.source]);
    if (input.bytes === null) {
      const unread = input.unread ?? { code: "ADR_TOO_LARGE", message: "The file was not read." };
      problems.push({ source: input.source, ...unread });
      continue;
    }
    const parsed = parseAdrFile(input.source.fileName, input.bytes);
    if (!parsed.ok) {
      for (const error of parsed.errors) problems.push({ source: input.source, ...error });
      continue;
    }
    adrs.push({
      source: input.source,
      bytes: input.bytes,
      sha256: await adrContentSha256(input.bytes),
      adr: parsed.adr,
    });
  }
  const duplicates = [...byNumber.entries()]
    .filter(([, sources]) => sources.length > 1)
    .sort(([a], [b]) => a - b);

  const pathOf = new Map(adrs.map((item) => [item.adr.number, item.source.path]));
  const warnings: AdrNotice[] = [];
  for (const item of adrs) {
    for (const warning of item.adr.warnings) {
      warnings.push({ number: item.adr.number, path: item.source.path, ...warning });
    }
  }
  const set = validateAdrSet(
    adrs.map((item) => ({
      number: item.adr.number,
      path: item.source.path,
      status: item.adr.status,
      supersedes: item.adr.supersedes,
    })),
  );
  for (const warning of set.warnings) {
    warnings.push({ ...warning, path: pathOf.get(warning.number) ?? "" });
  }
  warnings.sort((a, b) => a.number - b.number);
  return { adrs, duplicates, problems, warnings };
}

/** The API's bounded warning list: at most `MAX_ADR_SYNC_WARNINGS` items. */
export function boundedWarnings(warnings: readonly AdrNotice[]): {
  items: AdrNotice[];
  complete: boolean;
} {
  return {
    items: warnings.slice(0, MAX_ADR_SYNC_WARNINGS),
    complete: warnings.length <= MAX_ADR_SYNC_WARNINGS,
  };
}

/** Paths for people: relative to the current directory, so they can be opened as printed. */
export type PathDisplay = (absolute: string) => string;

export async function pathDisplay(cwd: string): Promise<PathDisplay> {
  const from = await realpath(cwd).catch(() => cwd);
  return (absolute) => posix(relative(from, absolute)) || ".";
}

/**
 * The CONFLICT for several files with one number. Lists every number (the
 * envelope keeps the first 4,096 characters).
 */
export function duplicateNumbersError(duplicates: AdrSetCheck["duplicates"]): CliError {
  const list = duplicates
    .map(
      ([number, sources]) =>
        `${formatAdrNumber(number)} (${sources.map((source) => source.path).join(", ")})`,
    )
    .join("; ");
  return new CliError("CONFLICT", `More than one file has the same ADR number: ${list}.`, {
    hint: "Give each ADR its own number: rename the newer file to a free number (hivemind adr new reserves one).",
  });
}

/**
 * ADR_INVALID listing every problem as `<path>: <CODE>: <message>`. In human
 * mode each problem is also printed on its own stderr line, with the path
 * relative to the current directory, and the error message only counts them.
 */
export function adrInvalidError(
  context: Pick<CommandContext, "json" | "report">,
  lead: string,
  problems: readonly AdrFileProblem[],
  display: PathDisplay,
  hint?: string,
): CliError {
  if (!context.json) {
    for (const problem of problems) {
      context.report.info(
        `${display(problem.source.absolute)}: ${problem.code}: ${problem.message}`,
      );
    }
    const files = new Set(problems.map((problem) => problem.source.path)).size;
    return new CliError(
      CLI_ERROR_CODES.adrInvalid,
      `${lead}: ${problems.length} ${problems.length === 1 ? "problem" : "problems"} in ${files} ADR ${files === 1 ? "file" : "files"} (listed above).`,
      { hint },
    );
  }
  const list = problems
    .map((problem) => `${problem.source.path}: ${problem.code}: ${problem.message}`)
    .join("; ");
  return new CliError(CLI_ERROR_CODES.adrInvalid, `${lead}: ${list}`, { hint });
}

export interface FileReplacement {
  path: string;
  contents: string;
}

/**
 * Replaces existing files, keeping each one's permission bits. Every
 * temporary file is written before the first rename, then the renames run in
 * the given order, so a failure while writing changes nothing, and a crash
 * between renames leaves a prefix of the list replaced. Callers order the
 * list so that a rerun can finish from any such prefix (`adr supersede`).
 * A failed rename removes the temporary files that were not renamed and
 * reports how many files were replaced.
 */
export async function replaceFiles(
  replacements: readonly FileReplacement[],
): Promise<{ replaced: number }> {
  const temps: string[] = [];
  try {
    for (const replacement of replacements) {
      const mode = (await stat(replacement.path)).mode & 0o777;
      const temp = await writeTemp(replacement.path, replacement.contents, mode);
      temps.push(temp);
      // The temp's mode was narrowed by the umask; the file keeps its own.
      await chmod(temp, mode);
    }
  } catch (error) {
    await Promise.all(temps.map((temp) => rm(temp, { force: true })));
    throw ioError(
      `Cannot write ${dirname(replacements[0]?.path ?? ".")}: ${(error as Error).message}`,
      error,
    );
  }
  let replaced = 0;
  try {
    for (const [index, replacement] of replacements.entries()) {
      await rename(temps[index] as string, replacement.path);
      replaced += 1;
    }
  } catch (error) {
    await Promise.all(temps.slice(replaced).map((temp) => rm(temp, { force: true })));
    throw ioError(
      `Cannot replace ${replacements[replaced]?.path}: ${(error as Error).message}. ${replaced} of ${replacements.length} files were replaced.`,
      error,
    );
  }
  for (const directory of new Set(replacements.map((replacement) => dirname(replacement.path)))) {
    await syncDir(directory);
  }
  return { replaced };
}

function isInside(parent: string, path: string): boolean {
  const below = relative(parent, path);
  return below === "" || (!below.startsWith("..") && !isAbsolute(below));
}

/**
 * Refuses (IO_ERROR, as for a symlinked ADR file) when `docs`, `docs/adr` or
 * any other existing part of the ADR directory resolves outside its base
 * directory, so a symlink cannot make the write commands create or replace
 * files elsewhere. A link that stays inside the base is followed. Parts that
 * do not exist yet are fine: `mkdir` creates real directories.
 */
export async function assertAdrDirectoryInside(location: AdrLocation): Promise<void> {
  let base: string;
  try {
    base = await realpath(location.base);
  } catch (error) {
    throw ioError(`Cannot resolve ${location.base}: ${(error as Error).message}`, error);
  }
  let path = location.base;
  for (const part of relative(location.base, location.dir).split(sep)) {
    path = join(path, part);
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw ioError(`Cannot read ${path}: ${(error as Error).message}`, error);
    }
    const target = await realpath(path).catch(() => null);
    if (target === null || !isInside(base, target)) {
      const refusal = new UnsafeFileError(
        path,
        target === null
          ? `${path} is a symbolic link that leads nowhere, which hivemind does not follow when writing ADR files`
          : `${path} is a symbolic link to ${target}, outside ${location.base}, which hivemind does not follow when writing ADR files`,
        `Replace it with a real directory inside ${location.base}.`,
      );
      throw ioError(refusal.message, refusal, refusal.hint);
    }
  }
}

/**
 * Creates the ADR directory (and its parents) if needed, after checking that
 * no existing part of it leads outside its base directory, and checks again
 * once it exists.
 */
export async function ensureAdrDirectory(location: AdrLocation): Promise<void> {
  await assertAdrDirectoryInside(location);
  try {
    await mkdir(location.dir, { recursive: true });
  } catch (error) {
    throw ioError(`Cannot create ${location.dir}: ${(error as Error).message}`, error);
  }
  await assertAdrDirectoryInside(location);
}
