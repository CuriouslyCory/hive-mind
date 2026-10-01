import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileStore, type FileCredentialStore } from "../src/credentials/file.ts";
import {
  type CredentialManagerOptions,
  createCredentialManager,
} from "../src/credentials/manager.ts";
import { failure } from "../src/credentials/types.ts";
import { CliError } from "../src/errors.ts";
import { type MemoryStore, memoryStore } from "./helpers/memory-store.ts";

const root = mkdtempSync(join(tmpdir(), "hivemind-credentials-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const ORIGIN = "https://hive.example";

function setup(
  options: {
    interactive?: boolean;
    platform?: NodeJS.Platform;
    env?: CredentialManagerOptions["env"];
  } = {},
) {
  const dir = join(root, String(counter++), "hivemind");
  const file = withFailingWrites(createFileStore({ dir }));
  const os: MemoryStore = memoryStore("libsecret");
  const make = (env = options.env ?? {}, interactive = options.interactive ?? true) =>
    createCredentialManager({
      env,
      interactive,
      platform: options.platform ?? "linux",
      file,
      factories: { libsecret: () => os, keychain: () => os },
    });
  return {
    dir,
    file,
    os,
    manager: make(),
    make,
    raw: () => JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")),
  };
}

/**
 * The real file store, but index writes made through `transact` fail while
 * `failWrites` is set: the "config dir became unwritable mid-login" case.
 */
function withFailingWrites(file: FileCredentialStore): FileCredentialStore & {
  failWrites: boolean;
} {
  const wrapped: FileCredentialStore & { failWrites: boolean } = {
    ...file,
    failWrites: false,
    transact: (origin, fn) =>
      file.transact(origin, (entry, write) =>
        fn(entry, async (next) =>
          wrapped.failWrites
            ? failure("error", "cannot write credentials.json: ENOSPC")
            : write(next),
        ),
      ),
  };
  return wrapped;
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("credential resolution", () => {
  it("uses a non-empty HIVEMIND_TOKEN without consulting any store", async () => {
    const { os, make, manager } = setup();
    await manager.save(ORIGIN, "hm_stored_token");
    os.calls.length = 0;
    expect(await make({ HIVEMIND_TOKEN: "hm_env_token" }).resolve(ORIGIN)).toEqual({
      origin: ORIGIN,
      token: "hm_env_token",
      source: "env",
    });
    expect(os.calls).toEqual([]);
    // Empty counts as unset.
    expect(await make({ HIVEMIND_TOKEN: "" }).resolve(ORIGIN)).toMatchObject({
      token: "hm_stored_token",
      source: "libsecret",
    });
  });

  it("fails on a malformed HIVEMIND_TOKEN instead of falling back to the stored login", async () => {
    const { make, manager } = setup();
    await manager.save(ORIGIN, "hm_stored_token");
    for (const bad of [" hm_token", "hm token", "hm_token\n", "hm_tökén"]) {
      const error = await rejection(make({ HIVEMIND_TOKEN: bad }).resolve(ORIGIN));
      expect([error.code, error.exitCode]).toEqual(["UNAUTHORIZED", 3]);
    }
  });

  it("reports 'not logged in' as UNAUTHORIZED with a non-TTY hint", async () => {
    const { make } = setup();
    const error = await rejection(make({}, false).require(ORIGIN));
    expect([error.code, error.exitCode]).toEqual(["UNAUTHORIZED", 3]);
    expect(error.hint).toContain("HIVEMIND_TOKEN");
  });

  it("keys logins by origin", async () => {
    const { manager } = setup();
    await manager.save(ORIGIN, "hm_token_a");
    await manager.save("http://localhost:3000", "hm_token_b");
    expect(await manager.resolve(ORIGIN)).toMatchObject({ token: "hm_token_a" });
    expect(await manager.resolve("http://localhost:3000")).toMatchObject({ token: "hm_token_b" });
    expect(await manager.resolve("https://other.example")).toBeNull();
  });
});

describe("saving and provider availability", () => {
  it("stores in the OS store and keeps only a pointer (no secret) in the file", async () => {
    const { manager, os, raw } = setup();
    expect(await manager.save(ORIGIN, "hm_os_token")).toEqual({ store: "libsecret", warnings: [] });
    expect(os.items.get(ORIGIN)).toBe("hm_os_token");
    expect(raw()).toEqual({ version: 1, credentials: { [ORIGIN]: { store: "libsecret" } } });
  });

  it("falls back to the file when the OS store is unavailable or hangs, with a warning", async () => {
    for (const reason of ["unavailable", "timeout"] as const) {
      const { manager, os, raw } = setup();
      os.failWith = reason;
      const result = await manager.save(ORIGIN, "hm_file_token");
      expect(result.store).toBe("file");
      expect(result.warnings).toHaveLength(1);
      expect(raw().credentials[ORIGIN]).toEqual({ token: "hm_file_token" });
    }
  });

  it("does not fall back when the OS store answers with an error", async () => {
    const { manager, os, dir } = setup();
    os.failWith = "error";
    const error = await rejection(manager.save(ORIGIN, "hm_token"));
    expect(error.code).toBe("CREDENTIAL_STORE_ERROR");
    expect(() => readFileSync(join(dir, "credentials.json"))).toThrow();
  });

  it("deletes the file copy when a later login reaches the OS store", async () => {
    const { manager, os, raw } = setup();
    os.failWith = "unavailable";
    await manager.save(ORIGIN, "hm_old_file_token");
    os.failWith = null;
    await manager.save(ORIGIN, "hm_new_os_token");
    expect(JSON.stringify(raw())).not.toContain("hm_old_file_token");
    // The OS store vanishes again: the old file token must not come back.
    os.failWith = "unavailable";
    const error = await rejection(manager.resolve(ORIGIN));
    expect(error.code).toBe("CREDENTIAL_STORE_ERROR");
  });

  it("ignores a stale OS-store token once a newer login went to the file", async () => {
    const { manager, os } = setup();
    await manager.save(ORIGIN, "hm_old_os_token");
    os.failWith = "unavailable";
    await manager.save(ORIGIN, "hm_new_file_token");
    os.failWith = null;
    expect(os.items.get(ORIGIN)).toBe("hm_old_os_token");
    expect(await manager.resolve(ORIGIN)).toEqual({
      origin: ORIGIN,
      token: "hm_new_file_token",
      source: "file",
    });
  });

  it("restores the replaced OS-store login when the index cannot be written", async () => {
    const { manager, os, file, raw } = setup();
    await manager.save(ORIGIN, "hm_old_os_token");
    file.failWrites = true;
    const error = await rejection(manager.save(ORIGIN, "hm_new_os_token"));
    expect(error.code).toBe("CREDENTIAL_STORE_ERROR");
    file.failWrites = false;
    expect(os.items.get(ORIGIN)).toBe("hm_old_os_token");
    expect(raw().credentials[ORIGIN]).toEqual({ store: "libsecret" });
    expect(await manager.resolve(ORIGIN)).toMatchObject({ token: "hm_old_os_token" });
  });

  it("leaves a replaced file login in place when the index cannot be written", async () => {
    const { manager, os, file } = setup();
    os.failWith = "unavailable";
    await manager.save(ORIGIN, "hm_old_file_token");
    os.failWith = null;
    file.failWrites = true;
    await rejection(manager.save(ORIGIN, "hm_new_os_token"));
    file.failWrites = false;
    // The new token is not referenced by the index, so it must not linger in the OS store.
    expect(os.items.has(ORIGIN)).toBe(false);
    expect(await manager.resolve(ORIGIN)).toMatchObject({ token: "hm_old_file_token" });
  });

  it("without a terminal, refuses to replace a login kept in an OS store and changes nothing", async () => {
    const { manager, make, os, raw } = setup();
    await manager.save(ORIGIN, "hm_os_token");
    const headless = make({}, false);
    for (const attempt of [headless.checkReplaceable(ORIGIN), headless.save(ORIGIN, "hm_new")]) {
      const error = await rejection(attempt);
      expect([error.code, error.exitCode]).toEqual(["TERMINAL_REQUIRED", 1]);
      expect(error.hint).toContain("hivemind logout");
    }
    expect(os.items.get(ORIGIN)).toBe("hm_os_token");
    expect(raw().credentials[ORIGIN]).toEqual({ store: "libsecret" });
    // A file login, or none, can be replaced without a terminal.
    await expect(
      make({}, false).checkReplaceable("https://other.example"),
    ).resolves.toBeUndefined();
  });

  it("without a terminal, never constructs the OS store and says where the login is", async () => {
    const { manager, make } = setup();
    await manager.save(ORIGIN, "hm_os_token");
    let constructed = 0;
    const file = createFileStore({ dir: join(root, "unused") });
    const headless = createCredentialManager({
      env: {},
      interactive: false,
      platform: "darwin",
      file,
      factories: {
        keychain: () => {
          constructed++;
          return memoryStore("keychain");
        },
      },
    });
    expect(await headless.resolve(ORIGIN)).toBeNull();
    const error = await rejection(make({}, false).resolve(ORIGIN));
    expect([error.code, error.exitCode]).toEqual(["UNAUTHORIZED", 3]);
    expect(error.message).toContain("Secret Service");
    expect(constructed).toBe(0);
  });
});

describe("logout", () => {
  it("removes every local copy and returns the token for remote revocation", async () => {
    const { manager, os, raw } = setup();
    os.failWith = "unavailable";
    await manager.save(ORIGIN, "hm_file_token");
    os.failWith = null;
    os.items.set(ORIGIN, "hm_orphan_os_token");
    const result = await manager.remove(ORIGIN);
    expect(result).toEqual({ removed: true, token: "hm_file_token", warnings: [], skipped: [] });
    expect(os.items.has(ORIGIN)).toBe(false);
    expect(raw().credentials).toEqual({});
    expect(await manager.resolve(ORIGIN)).toBeNull();
  });

  it("reads the token from the OS store it points at", async () => {
    const { manager } = setup();
    await manager.save(ORIGIN, "hm_os_token");
    expect(await manager.remove(ORIGIN)).toMatchObject({ removed: true, token: "hm_os_token" });
    expect(await manager.remove(ORIGIN)).toMatchObject({ removed: false, token: null });
  });

  it("drops the pointer even when the OS copy cannot be deleted, so it is never used again", async () => {
    const { manager, os } = setup();
    await manager.save(ORIGIN, "hm_os_token");
    os.failWith = "timeout";
    const result = await manager.remove(ORIGIN);
    expect(result.removed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    os.failWith = null;
    expect(await manager.resolve(ORIGIN)).toBeNull();
  });

  it("without a terminal, refuses to remove a login kept in an OS store and changes nothing", async () => {
    const { manager, make, os, raw } = setup();
    await manager.save(ORIGIN, "hm_os_token");
    os.calls.length = 0;
    const error = await rejection(make({}, false).remove(ORIGIN));
    expect([error.code, error.exitCode]).toEqual(["TERMINAL_REQUIRED", 1]);
    expect(error.message).toContain("Secret Service");
    expect(error.hint).toContain("hivemind logout");
    expect(os.calls).toEqual([]);
    // The pointer survives, so a later logout in a terminal can still read and revoke it.
    expect(raw().credentials[ORIGIN]).toEqual({ store: "libsecret" });
    expect(await manager.remove(ORIGIN)).toMatchObject({ removed: true, token: "hm_os_token" });
  });

  it("without a terminal, still removes a file login and reports the OS store it skipped", async () => {
    const { make } = setup();
    const headless = make({}, false);
    await headless.save(ORIGIN, "hm_file_token");
    expect(await headless.remove(ORIGIN)).toEqual({
      removed: true,
      token: "hm_file_token",
      warnings: [],
      skipped: ["libsecret"],
    });
  });

  it("keeps the OS copy and the pointer when the index cannot be written", async () => {
    const { manager, os, file, raw } = setup();
    await manager.save(ORIGIN, "hm_os_token");
    file.failWrites = true;
    const error = await rejection(manager.remove(ORIGIN));
    expect(error.code).toBe("CREDENTIAL_STORE_ERROR");
    expect(os.items.get(ORIGIN)).toBe("hm_os_token");
    expect(raw().credentials[ORIGIN]).toEqual({ store: "libsecret" });
    file.failWrites = false;
    expect(await manager.remove(ORIGIN)).toMatchObject({ removed: true, token: "hm_os_token" });
  });

  it("never touches HIVEMIND_TOKEN", async () => {
    const { make } = setup();
    const manager = make({ HIVEMIND_TOKEN: "hm_env_token" });
    expect(await manager.remove(ORIGIN)).toMatchObject({ removed: false, token: null });
    expect(await manager.resolve(ORIGIN)).toMatchObject({ source: "env" });
  });
});
