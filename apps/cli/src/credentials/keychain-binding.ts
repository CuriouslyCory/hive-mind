// Loads the @napi-rs/keyring addon embedded in a Darwin binary.
//
// Each Darwin target has its own module (keychain-addon-darwin-*.ts) that
// imports its `.node` file with `type: "file"`. scripts/build.ts defines
// HIVEMIND_BUILD_TARGET, Bun folds the comparisons below and drops the dead
// require()s before resolution, so each Darwin binary embeds exactly its own
// addon and Linux binaries embed none. The package's generic index.js loader is
// bypassed on purpose: it would make the bundler chase every platform package,
// spawns `ldd` to detect musl, and honors NAPI_RS_NATIVE_LIBRARY_PATH, which
// lets the environment load an arbitrary native library into the CLI.
//
// Why the addon is embedded as a plain file and copied out here, instead of
// letting Bun load it: a compiled binary cannot dlopen from inside itself, so
// for a require()d `.node` Bun 1.4.2 writes the addon to
// `<dir>/.bun-<euid>-<wyhash of contents>.node` and dlopens that. <dir> is
// BUN_TMPDIR, else TMPDIR, TMP or TEMP, else /private/tmp on macOS, read once
// from the environment the process started with (assigning process.env inside
// the binary changes nothing). On later runs Bun reuses any regular file at
// that name that is owned by the user and has the right size, without checking
// its contents. Under a shared or attacker-writable temp directory that is a
// predictable path to a library the CLI will run. (The per-user macOS TMPDIR
// under /var/folders is private; sticky /private/tmp blocks other users from
// planting, but not every TMPDIR a user may set is either.) Copying the bytes
// ourselves takes the temp directory out of the picture: see `materializeAddon`.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

declare const HIVEMIND_BUILD_TARGET: string;

/** The subset of @napi-rs/keyring's synchronous `Entry` class that is used. */
export interface KeyringEntry {
  setPassword(password: string): void;
  getPassword(): string | null | undefined;
  deleteCredential(): boolean;
}

export interface KeyringBinding {
  Entry: new (service: string, account: string) => KeyringEntry;
}

/** The private directory the embedded addon is copied to before dlopen. */
export function nativeExtractDir(home: string = homedir()): string {
  return join(home, "Library", "Caches", "hivemind", "native");
}

/**
 * Path of this build's embedded addon inside the binary (`/$bunfs/...`), or
 * null on targets that embed none (Linux, and Node under Vitest).
 */
export function embeddedAddonPath(): string | null {
  if (typeof HIVEMIND_BUILD_TARGET === "string" && HIVEMIND_BUILD_TARGET === "bun-darwin-arm64") {
    return (require("./keychain-addon-darwin-arm64.ts") as { default: string }).default;
  }
  if (typeof HIVEMIND_BUILD_TARGET === "string" && HIVEMIND_BUILD_TARGET === "bun-darwin-x64") {
    return (require("./keychain-addon-darwin-x64.ts") as { default: string }).default;
  }
  return null;
}

function ownedByMe(uid: number): boolean {
  const me = process.geteuid?.();
  return me === undefined || uid === me;
}

/**
 * Writes `bytes` to `dir/keyring-<sha256>.node` unless an identical copy is
 * already there, and returns that path.
 *
 * Guarantees, checked on every call: `dir` is a real directory (not a symlink)
 * owned by the effective user with no group or other access, so only that user
 * (or root) can add, replace or rename entries in it; and the returned path is
 * a regular file owned by the user with no group or other access, whose contents equal `bytes`
 * byte for byte. A stale, truncated or planted entry is replaced by an atomic
 * rename of a freshly written file, never trusted.
 */
export function materializeAddon(bytes: Buffer, dir: string = nativeExtractDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || !ownedByMe(stats.uid) || (stats.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be a directory owned by you with mode 0700`);
  }
  const name = `keyring-${createHash("sha256").update(bytes).digest("hex")}.node`;
  const path = join(dir, name);
  if (isExactCopy(path, bytes)) return path;

  const scratch = join(dir, `.${name}.${randomBytes(8).toString("hex")}`);
  try {
    // "wx": fail rather than write through anything already at the scratch name.
    writeFileSync(scratch, bytes, { mode: 0o600, flag: "wx" });
    renameSync(scratch, path);
  } finally {
    rmSync(scratch, { force: true });
  }
  return path;
}

function isExactCopy(path: string, bytes: Buffer): boolean {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  return (
    stats.isFile() &&
    ownedByMe(stats.uid) &&
    (stats.mode & 0o077) === 0 &&
    stats.size === bytes.length &&
    readFileSync(path).equals(bytes)
  );
}

/** Returns the embedded Keychain addon, or null on targets that have none. */
export function loadKeyringBinding(): KeyringBinding | null {
  const embedded = embeddedAddonPath();
  if (embedded === null) return null;
  // An absolute path outside /$bunfs/, so Bun dlopens it as is and extracts
  // nothing to the temp directory.
  const addon = { exports: {} };
  process.dlopen(addon, materializeAddon(readFileSync(embedded)));
  return addon.exports as KeyringBinding;
}
