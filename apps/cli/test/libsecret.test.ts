import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLibsecretStore } from "../src/credentials/libsecret.ts";
import { json, PROBE_BINARY, run } from "./helpers/binaries.ts";
import {
  failingSecretTool,
  hangingSecretTool,
  workingSecretTool,
} from "./helpers/fake-secret-tool.ts";

// Spike (c): libsecret through a `secret-tool` subprocess. The real tool is not
// installed here, so fakes on PATH stand in for it.

const root = mkdtempSync(join(tmpdir(), "hivemind-libsecret-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = () => join(root, String(counter++));

const ORIGIN = "https://hive.example";
const SECRET = "hm_libsecret_secret";

function storeWith(dir: string, timeoutMs = 2_000) {
  return createLibsecretStore({
    command: join(dir, "secret-tool"),
    service: "hivemind-test",
    timeoutMs,
    env: { PATH: "/usr/bin:/bin" },
  });
}

/** Waits until `pid` no longer exists (a SIGKILLed child is reaped asynchronously). */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("libsecret store", () => {
  it("stores, reads, replaces and deletes, with the secret only on stdin", async () => {
    const base = fresh();
    const state = join(base, "state");
    const store = storeWith(workingSecretTool(join(base, "bin"), state));

    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: false });
    expect(await store.set(ORIGIN, SECRET)).toEqual({ ok: true });
    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: true, secret: SECRET });
    expect(await store.set(ORIGIN, `${SECRET}-2`)).toEqual({ ok: true });
    expect(await store.get(ORIGIN)).toEqual({ ok: true, found: true, secret: `${SECRET}-2` });
    expect(await store.delete(ORIGIN)).toEqual({ ok: true, deleted: true });
    expect(await store.delete(ORIGIN)).toEqual({ ok: true, deleted: false });

    const argv = readFileSync(join(state, "argv.log"), "utf8");
    expect(argv).not.toContain(SECRET);
    expect(argv).toContain(
      `store --label=hivemind login (${ORIGIN}) service hivemind-test origin ${ORIGIN}`,
    );
    expect(argv).toContain(`lookup service hivemind-test origin ${ORIGIN}`);
    expect(readFileSync(join(state, "stdin.log"), "utf8")).toBe(`${SECRET}${SECRET}-2`);
  });

  it("is unavailable when secret-tool is not installed", async () => {
    const store = storeWith(join(fresh(), "missing"));
    expect(await store.get(ORIGIN)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await store.set(ORIGIN, SECRET)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it.each([
    "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY",
    "secret-tool: The name org.freedesktop.secrets was not provided by any .service files",
  ])("is unavailable without a Secret Service (%s)", async (stderr) => {
    const store = storeWith(failingSecretTool(join(fresh(), "bin"), stderr));
    expect(await store.get(ORIGIN)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("reports other failures as errors, never as 'not found'", async () => {
    const store = storeWith(
      failingSecretTool(join(fresh(), "bin"), "secret-tool: Permission denied"),
    );
    expect(await store.get(ORIGIN)).toMatchObject({
      ok: false,
      reason: "error",
      message: expect.stringContaining("Permission denied"),
    });
  });

  it("kills a hanging secret-tool at the deadline", async () => {
    const base = fresh();
    const pidFile = join(base, "pid");
    const store = storeWith(hangingSecretTool(join(base, "bin"), pidFile), 300);
    const started = Date.now();
    expect(await store.set(ORIGIN, SECRET)).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });
});

describe("libsecret store in the compiled binary", () => {
  it("round-trips through a secret-tool on PATH", () => {
    const base = fresh();
    const bin = workingSecretTool(join(base, "bin"), join(base, "state"));
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    const result = run(PROBE_BINARY, ["roundtrip", "libsecret"], { env });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(json(result)).toMatchObject({ store: "libsecret", passed: true });

    const set = run(PROBE_BINARY, ["store", "libsecret", "set", ORIGIN], { env, input: SECRET });
    expect(json(set)).toEqual({ ok: true });
    expect(readFileSync(join(base, "state", "argv.log"), "utf8")).not.toContain(SECRET);
  });

  it("returns timeout and kills the child when secret-tool hangs", async () => {
    const base = fresh();
    const pidFile = join(base, "pid");
    const bin = hangingSecretTool(join(base, "bin"), pidFile);
    const started = Date.now();
    const result = run(PROBE_BINARY, ["store", "libsecret", "get", ORIGIN], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HIVEMIND_PROBE_TIMEOUT_MS: "300" },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(json(result)).toMatchObject({ ok: false, reason: "timeout" });
    expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("is unavailable when secret-tool is absent from PATH", () => {
    const result = run(PROBE_BINARY, ["store", "libsecret", "get", ORIGIN], {
      env: { PATH: join(fresh(), "empty") },
    });
    expect(json(result)).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
