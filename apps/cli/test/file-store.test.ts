import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configDir, createFileStore } from "../src/credentials/file.ts";
import { readFileNoFollow, UnsafeFileError } from "../src/fs-safe.ts";
import { json, PROBE_BINARY, type RunResult, runAsync, SHELL_BINARY } from "./helpers/binaries.ts";

// Private-file credential store: the spike's round-trip and mode checks, plus
// cli-core's hardening (symlinks, ownership, permissions, locking, concurrency).

const root = mkdtempSync(join(tmpdir(), "hivemind-file-"));
afterAll(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});
let counter = 0;
const fresh = () => join(root, String(counter++));
const mode = (path: string) => statSync(path).mode & 0o777;
const ORIGIN = "https://hive.example";

describe("configDir", () => {
  it("uses an absolute XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config/hivemind");
    expect(configDir({})).toBe(join(homedir(), ".config", "hivemind"));
    // A relative value would resolve against the working directory.
    expect(configDir({ XDG_CONFIG_HOME: "relative/config" })).toBe(
      join(homedir(), ".config", "hivemind"),
    );
  });
});

describe("file store", () => {
  it("round-trips per origin and keeps other origins", async () => {
    const store = createFileStore({ dir: join(fresh(), "hivemind") });
    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: false });
    expect(await store.set(ORIGIN, "one")).toEqual({ ok: true });
    expect(await store.set("http://localhost:3000", "dev")).toEqual({ ok: true });
    expect(await store.set(ORIGIN, "two")).toEqual({ ok: true });
    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: true, secret: "two" });
    expect(await store.delete(ORIGIN)).toEqual({ ok: true, deleted: true });
    expect(await store.delete(ORIGIN)).toEqual({ ok: true, deleted: false });
    expect(await store.get("http://localhost:3000")).toEqual({
      ok: true,
      found: true,
      secret: "dev",
    });
  });

  it("creates a 0700 directory and a 0600 file under a permissive umask", async () => {
    const dir = join(fresh(), "config", "hivemind");
    const previous = process.umask(0);
    try {
      expect(await createFileStore({ dir }).set(ORIGIN, "secret")).toEqual({ ok: true });
    } finally {
      process.umask(previous);
    }
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "credentials.json"))).toBe(0o600);
    // Atomic write leaves no temporary files behind.
    expect(readdirSync(dir)).toEqual(["credentials.json"]);
  });

  it("keeps the previous file intact when a write fails", async () => {
    const dir = join(fresh(), "hivemind");
    const store = createFileStore({ dir });
    await store.set(ORIGIN, "original");
    const before = readFileSync(join(dir, "credentials.json"), "utf8");
    chmodSync(dir, 0o500);
    try {
      expect(await store.set(ORIGIN, "replacement")).toMatchObject({ ok: false, reason: "error" });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe(before);
  });

  it("refuses a corrupt or foreign file instead of overwriting it", async () => {
    const dir = join(fresh(), "hivemind");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), '{"version": 2}');
    const store = createFileStore({ dir });
    expect(await store.get(ORIGIN)).toMatchObject({ ok: false, reason: "error" });
    expect(await store.set(ORIGIN, "x")).toMatchObject({ ok: false, reason: "error" });
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe('{"version": 2}');
  });

  it("refuses a config path that is not a directory", async () => {
    const base = fresh();
    mkdirSync(base);
    writeFileSync(join(base, "hivemind"), "");
    expect(await createFileStore({ dir: join(base, "hivemind") }).set(ORIGIN, "x")).toMatchObject({
      ok: false,
      reason: "error",
    });
  });
});

describe("file store in the compiled binary", () => {
  it("round-trips under XDG_CONFIG_HOME with private modes under umask 000", () => {
    const config = fresh();
    const env = { PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: config };
    const sh = (command: string): RunResult => {
      const result = spawnSync("/bin/sh", ["-c", `umask 000; exec "$PROBE" ${command}`], {
        encoding: "utf8",
        env: { ...env, PROBE: PROBE_BINARY },
        input: "hm_file_secret",
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };

    const roundtrip = sh("roundtrip file");
    expect(roundtrip.status, roundtrip.stdout + roundtrip.stderr).toBe(0);
    expect(json(roundtrip)).toMatchObject({ store: "file", passed: true });

    expect(json(sh(`store file set ${ORIGIN}`))).toEqual({ ok: true });
    expect(mode(join(config, "hivemind"))).toBe(0o700);
    expect(mode(join(config, "hivemind", "credentials.json"))).toBe(0o600);
    expect(json(sh(`store file get ${ORIGIN}`))).toEqual({
      ok: true,
      found: true,
      secret: "hm_file_secret",
    });
  });
});

describe("file store hardening", () => {
  const isRoot = process.getuid?.() === 0;

  it("refuses a symlinked directory and never writes through it", async () => {
    const base = fresh();
    const target = join(base, "elsewhere");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(base, "hivemind"));
    const store = createFileStore({ dir: join(base, "hivemind") });
    expect(await store.set(ORIGIN, "x")).toMatchObject({
      ok: false,
      reason: "error",
      message: expect.stringContaining("symbolic link"),
    });
    expect(await store.get(ORIGIN)).toMatchObject({ ok: false, reason: "error" });
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses a symlinked or non-regular credentials file", async () => {
    const dir = join(fresh(), "hivemind");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const decoy = join(dir, "..", "decoy.json");
    writeFileSync(
      decoy,
      JSON.stringify({ version: 1, credentials: { [ORIGIN]: { token: "planted" } } }),
      { mode: 0o600 },
    );
    symlinkSync(decoy, join(dir, "credentials.json"));
    const store = createFileStore({ dir });
    expect(await store.get(ORIGIN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("symbolic link"),
    });
    expect(await store.set(ORIGIN, "x")).toMatchObject({ ok: false });
    expect(readFileSync(decoy, "utf8")).toContain("planted");

    const fifoDir = join(fresh(), "hivemind");
    mkdirSync(fifoDir, { recursive: true, mode: 0o700 });
    spawnSync("mkfifo", [join(fifoDir, "credentials.json")]);
    // Must not block waiting for a writer.
    expect(await createFileStore({ dir: fifoDir }).get(ORIGIN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("not a regular file"),
    });
  });

  it.skipIf(isRoot)("refuses directories and files owned by another user", async () => {
    expect(await createFileStore({ dir: "/usr/share" }).get(ORIGIN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("owned by another user"),
    });
    await expect(
      readFileNoFollow("/etc/passwd", { maxBytes: 1 << 20, requireOwner: true }),
    ).rejects.toBeInstanceOf(UnsafeFileError);
  });

  it("tightens a permissive directory and refuses to read a token others could read", async () => {
    const dir = join(fresh(), "hivemind");
    const store = createFileStore({ dir });
    await store.set(ORIGIN, "secret");
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "credentials.json"), 0o644);
    expect(await store.get(ORIGIN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("chmod 600"),
    });
    expect(mode(dir)).toBe(0o700);
    // A write replaces the file with a private one, after which reads work again.
    expect(await store.set(ORIGIN, "rotated")).toEqual({ ok: true });
    expect(mode(join(dir, "credentials.json"))).toBe(0o600);
    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: true, secret: "rotated" });
  });

  it("refuses a world-writable parent without the sticky bit", async () => {
    const parent = fresh();
    mkdirSync(parent);
    chmodSync(parent, 0o777);
    expect(await createFileStore({ dir: join(parent, "hivemind") }).set(ORIGIN, "x")).toMatchObject(
      {
        ok: false,
        message: expect.stringContaining("writable by every user"),
      },
    );
  });

  it("stores odd origin keys as plain data", async () => {
    const store = createFileStore({ dir: join(fresh(), "hivemind") });
    expect(await store.set("__proto__", "x-token")).toEqual({ ok: true });
    expect(await store.get("__proto__")).toEqual({ ok: true, found: true, secret: "x-token" });
    expect(await store.get("constructor")).toEqual({ ok: true, found: false });
  });

  it("breaks a lock left by a dead process and times out on a live one", async () => {
    const dir = join(fresh(), "hivemind");
    const store = createFileStore({ dir, lockTimeoutMs: 200 });
    await store.set(ORIGIN, "first");
    writeFileSync(join(dir, "credentials.lock"), `999999999 ${hostname()} 0 dead`);
    expect(await store.set(ORIGIN, "second")).toEqual({ ok: true });
    expect(existsSync(join(dir, "credentials.lock"))).toBe(false);
    writeFileSync(join(dir, "credentials.lock"), `${process.pid} ${hostname()} 0 alive`);
    expect(await store.set(ORIGIN, "third")).toMatchObject({
      ok: false,
      message: expect.stringContaining("credentials.lock"),
    });
    rmSync(join(dir, "credentials.lock"));
    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: true, secret: "second" });
  });
});

describe("concurrent updates", () => {
  it("in one process: a delete is never undone by concurrent writes", async () => {
    const dir = join(fresh(), "hivemind");
    const store = createFileStore({ dir });
    await store.set(ORIGIN, "to-be-deleted");
    const others = Array.from({ length: 30 }, (_, index) => `https://h${index}.example`);
    const results = await Promise.all([
      ...others.map((origin) => store.set(origin, `token-${origin}`)),
      store.delete(ORIGIN),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: false });
    for (const origin of others)
      expect(await store.get(origin)).toEqual({ ok: true, found: true, secret: `token-${origin}` });
    expect(readdirSync(dir).sort()).toEqual(["credentials.json"]);
  });

  it("across compiled processes: concurrent logins and a logout keep every update", async () => {
    const config = fresh();
    const env = { XDG_CONFIG_HOME: config, HOME: root };
    const seed = await runAsync(SHELL_BINARY, ["cred", "save", "--server", ORIGIN], {
      env,
      input: "hm_seed_token",
    });
    expect(seed.status, seed.stderr).toBe(0);
    const origins = Array.from({ length: 8 }, (_, index) => `https://p${index}.example`);
    const runs = await Promise.all([
      ...origins.map((origin) =>
        runAsync(SHELL_BINARY, ["cred", "save", "--server", origin, "--json"], {
          env,
          input: `hm_token_${origin.length}_${origin}`,
        }),
      ),
      runAsync(SHELL_BINARY, ["cred", "remove", "--server", ORIGIN, "--json"], { env }),
    ]);
    for (const result of runs) expect(result.status, result.stdout + result.stderr).toBe(0);
    const document = JSON.parse(readFileSync(join(config, "hivemind", "credentials.json"), "utf8"));
    expect(Object.keys(document.credentials).sort()).toEqual([...origins].sort());
    expect(readdirSync(join(config, "hivemind")).sort()).toEqual(["credentials.json"]);
  });
});
