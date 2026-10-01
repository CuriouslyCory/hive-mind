import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * File-system primitives shared by the credential file and `.hivemind.json`:
 * a private-directory check, no-follow reads with a size cap, atomic replace,
 * atomic create-if-absent, and an advisory lock file. Errors are thrown as
 * `UnsafeFileError` (a refusal the user must fix) or plain Node errors; callers
 * translate them into their own result types.
 */

export class UnsafeFileError extends Error {
  readonly path: string;
  readonly hint: string;

  constructor(path: string, message: string, hint: string) {
    super(message);
    this.name = "UnsafeFileError";
    this.path = path;
    this.hint = hint;
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/**
 * Makes sure `dir` is a real directory owned by this user and closed to
 * everyone else (0700), creating it when `create` is set.
 *
 * - A symlink in place of the directory is refused: whoever controls its
 *   target would control where tokens are written.
 * - A directory owned by another user is refused.
 * - A permissive mode on our own directory is tightened to 0700, which repairs
 *   a directory created by an older tool or under a different umask.
 * - Its parent must not be world-writable unless it has the sticky bit (like
 *   /tmp), otherwise anyone could swap the directory out. Group-writable is
 *   allowed: with a umask of 002 (user private groups, the Ubuntu default)
 *   ~/.config itself is group-writable, and the group is the user's own.
 *
 * Returns false when the directory does not exist and `create` is false.
 */
export async function ensurePrivateDir(
  dir: string,
  options: { create: boolean },
): Promise<boolean> {
  if (options.create) {
    // Parents we create get at most 0755, so even under umask 000 they pass the
    // world-writable check below; existing parents keep their mode.
    await mkdir(dirname(dir), { recursive: true, mode: 0o755 });
    try {
      // mkdir's mode is only ever narrowed by the umask, so 0700 holds under umask 000.
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" && !options.create) return false;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new UnsafeFileError(
      dir,
      `${dir} is a symbolic link; hivemind keeps credentials only in a real directory`,
      `Remove the link and run the command again, or point XDG_CONFIG_HOME at a private directory.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new UnsafeFileError(
      dir,
      `${dir} exists and is not a directory`,
      `Move it aside and run the command again.`,
    );
  }
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new UnsafeFileError(
      dir,
      `${dir} is owned by another user (uid ${stats.uid})`,
      `Remove it or point XDG_CONFIG_HOME at a directory you own.`,
    );
  }
  if ((stats.mode & 0o077) !== 0) await chmod(dir, 0o700);

  const parent = await stat(dirname(dir));
  const sticky = (parent.mode & 0o1000) !== 0;
  if ((parent.mode & 0o002) !== 0 && !sticky) {
    throw new UnsafeFileError(
      dir,
      `${dirname(dir)} is writable by every user (mode ${octal(parent.mode)}), so they could replace ${basename(dir)}`,
      `Run 'chmod o-w ${dirname(dir)}' or point XDG_CONFIG_HOME elsewhere.`,
    );
  }
  return true;
}

export interface ReadNoFollowOptions {
  maxBytes: number;
  /** Require the file to be owned by this user (credentials). */
  requireOwner?: boolean;
  /** Refuse a file that group or others can access (credentials, when reading a secret). */
  requirePrivate?: boolean;
}

/**
 * Reads a regular file without following a symlink at its final component,
 * without blocking on a FIFO, and without reading more than `maxBytes + 1`
 * bytes. Returns null when the file does not exist. The checks run on the
 * opened descriptor, so the file cannot be swapped between check and read.
 */
export async function readFileNoFollow(
  path: string,
  options: ReadNoFollowOptions,
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return null;
    // ELOOP on Linux and macOS when the final component is a symlink; macOS can
    // also report EMLINK for O_NOFOLLOW.
    if (code === "ELOOP" || code === "EMLINK") {
      throw new UnsafeFileError(
        path,
        `${path} is a symbolic link, which hivemind does not follow`,
        `Replace it with a regular file.`,
      );
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new UnsafeFileError(
        path,
        `${path} is not a regular file`,
        `Replace it with a regular file.`,
      );
    }
    const uid = currentUid();
    if (options.requireOwner && uid !== undefined && stats.uid !== uid) {
      throw new UnsafeFileError(
        path,
        `${path} is owned by another user (uid ${stats.uid})`,
        `Remove it and log in again.`,
      );
    }
    if (options.requirePrivate && (stats.mode & 0o077) !== 0) {
      throw new UnsafeFileError(
        path,
        `${path} is readable by other users (mode ${octal(stats.mode)})`,
        `Run 'chmod 600 ${path}'. Others may have read it, so also consider 'hivemind logout' and logging in again.`,
      );
    }
    const buffer = Buffer.alloc(options.maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
}

async function writeTemp(path: string, contents: string, mode: number): Promise<string> {
  const temp = tempPathFor(path);
  // "wx": exclusive create, never follows or reuses an existing path, and the
  // mode applies from creation (narrowed by the umask, never widened), so a
  // secret is never briefly readable by others.
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  return temp;
}

async function syncDir(dir: string): Promise<void> {
  // Makes the rename itself durable. Not every platform/file system allows
  // fsync on a directory; durability is best effort there.
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort.
  }
}

/** Replaces `path` atomically: readers see the old file or the new one, never a mix. */
export async function writeFileAtomic(path: string, contents: string, mode: number): Promise<void> {
  const temp = await writeTemp(path, contents, mode);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDir(dirname(path));
}

/**
 * Creates `path` with `contents` only if nothing exists there, atomically:
 * the content is written to a temporary file and hard-linked into place, and
 * `link` fails with EEXIST instead of replacing. Returns false if the path
 * already existed (any kind of entry, including a dangling symlink). On file
 * systems without hard links it falls back to an exclusive create, which is
 * still never a replacement but can leave a partial file after a crash.
 */
export async function createFileExclusive(
  path: string,
  contents: string,
  mode: number,
): Promise<boolean> {
  const temp = await writeTemp(path, contents, mode);
  try {
    await link(temp, path);
    await syncDir(dirname(path));
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS")
      throw error;
  } finally {
    await rm(temp, { force: true });
  }
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", mode);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** A lock this old is broken even if its owner looks alive (pid reuse, another host). */
  staleMs?: number;
}

export class LockTimeoutError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`timed out waiting for ${path}; another hivemind process is using it`);
    this.name = "LockTimeoutError";
    this.path = path;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ownerIsGone(content: string): boolean {
  const [pidText, host] = content.split(" ");
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0 || host !== hostname()) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

/**
 * An advisory lock: a file created with O_EXCL holding "<pid> <host> <time>
 * <nonce>". Every read-modify-write of a shared file runs under it, so two
 * concurrent `login`/`logout` runs cannot interleave and write back a
 * credential the other one just deleted.
 *
 * A lock left by a crashed process is broken when its pid no longer exists on
 * this host, or when it is older than `staleMs`. Breaking renames the file to
 * a unique name first, so of two processes breaking the same stale lock only
 * one succeeds, and it re-checks that what it moved is the stale lock it saw.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const token = `${process.pid} ${hostname()} ${Date.now()} ${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  let delay = 10;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }

    const observed = await readFile(lockPath, "utf8").catch(() => null);
    const age = await lstat(lockPath).then(
      (stats) => Date.now() - stats.mtimeMs,
      () => 0,
    );
    // An empty file is a lock whose owner has not written its token yet.
    if (observed !== null && observed !== "" && (ownerIsGone(observed) || age > staleMs)) {
      const aside = `${lockPath}.${randomBytes(6).toString("hex")}.stale`;
      const moved = await rename(lockPath, aside).then(
        () => true,
        () => false,
      );
      if (moved) {
        const movedContent = await readFile(aside, "utf8").catch(() => null);
        // Moved a fresh lock by mistake: put it back unless someone took the slot.
        if (movedContent !== observed) await link(aside, lockPath).catch(() => undefined);
        await unlink(aside).catch(() => undefined);
      }
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
    await sleep(delay + Math.random() * delay);
    delay = Math.min(delay * 2, 200);
  }

  try {
    return await fn();
  } finally {
    // Remove the lock only if it is still ours (it was not broken as stale).
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current === token) await unlink(lockPath).catch(() => undefined);
  }
}
