// Selects the @napi-rs/keyring addon for the binary's build target.
//
// `bun build --compile` embeds a `.node` file only when it is reached through a
// static require(). scripts/build.ts defines HIVEMIND_BUILD_TARGET, Bun folds
// these comparisons, and dead branches are dropped before resolution, so each
// Darwin binary embeds exactly its own addon and Linux binaries embed none.
// This bypasses the package's generic index.js loader on purpose: that loader
// would make the bundler chase every platform package, spawns `ldd` to detect
// musl, and honors NAPI_RS_NATIVE_LIBRARY_PATH, which lets the environment
// load an arbitrary native library into the CLI.
import { lstatSync, mkdirSync } from "node:fs";
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

/** Where the embedded addon is extracted before dlopen; see `withPrivateTmpdir`. */
export function nativeExtractDir(home: string = homedir()): string {
  return join(home, "Library", "Caches", "hivemind", "native");
}

/**
 * Runs `load` with TMPDIR pointing at a private directory, then restores it.
 *
 * A compiled Bun binary cannot dlopen an addon from inside itself. On first
 * use it writes the addon to `$TMPDIR/.bun-<uid>-<content hash>.node` and on
 * later runs loads whatever valid library is at that name. The name is
 * predictable, so in a shared, world-writable TMPDIR (macOS falls back to /tmp
 * when TMPDIR is unset) another local user could plant a library there first
 * and have it run inside the CLI. The spike showed Bun reads TMPDIR at load
 * time, so redirecting it to a 0700 directory owned by the user closes that.
 */
export function withPrivateTmpdir<T>(load: () => T, dir: string = nativeExtractDir()): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  const uid = process.getuid?.();
  if (
    !stats.isDirectory() ||
    (uid !== undefined && stats.uid !== uid) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(`${dir} must be a directory owned by you with mode 0700`);
  }
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return load();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

/** Returns the embedded Keychain addon, or null on targets that have none. */
export function loadKeyringBinding(): KeyringBinding | null {
  if (typeof HIVEMIND_BUILD_TARGET === "string" && HIVEMIND_BUILD_TARGET === "bun-darwin-arm64") {
    return withPrivateTmpdir(
      () => require("@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node") as KeyringBinding,
    );
  }
  if (typeof HIVEMIND_BUILD_TARGET === "string" && HIVEMIND_BUILD_TARGET === "bun-darwin-x64") {
    return withPrivateTmpdir(
      () => require("@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node") as KeyringBinding,
    );
  }
  return null;
}
