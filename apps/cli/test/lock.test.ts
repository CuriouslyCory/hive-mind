import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LockTimeoutError, withLock } from "../src/fs-safe.ts";

// Lock writes fail (ENOSPC) while this is set; everything else is the real fs.
const failLockWrites = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
    const handle = await actual.open(...args);
    if (!failLockWrites.on || !String(args[0]).endsWith(".lock")) return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === "writeFile") {
          return async () => {
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
              code: "ENOSPC",
            });
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { ...actual, open, default: { ...actual, open } };
});

const root = mkdtempSync(join(tmpdir(), "hivemind-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
/** A fresh directory and the lock path inside it. */
function lockIn(): { dir: string; lockPath: string } {
  const dir = join(root, String(counter++));
  mkdirSync(dir);
  return { dir, lockPath: join(dir, "credentials.lock") };
}

describe("withLock and empty lock files", () => {
  it("breaks an empty lock (owner died before writing) once it is older than the stale window", async () => {
    const { dir, lockPath } = lockIn();
    writeFileSync(lockPath, "");
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(lockPath, dayAgo, dayAgo);
    await expect(withLock(lockPath, async () => "ran", { timeoutMs: 500 })).resolves.toBe("ran");
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("still waits on a fresh empty lock, whose owner may be about to write", async () => {
    const { lockPath } = lockIn();
    writeFileSync(lockPath, "");
    await expect(withLock(lockPath, async () => "ran", { timeoutMs: 200 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    expect(existsSync(lockPath)).toBe(true);
  });

  it("removes the lock it created when writing its owner token fails", async () => {
    const { lockPath } = lockIn();
    const fn = vi.fn(async () => "ran");
    failLockWrites.on = true;
    try {
      await expect(withLock(lockPath, fn, { timeoutMs: 200 })).rejects.toMatchObject({
        code: "ENOSPC",
      });
    } finally {
      failLockWrites.on = false;
    }
    expect(fn).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
    // The next command is not blocked.
    await expect(withLock(lockPath, async () => "ran", { timeoutMs: 200 })).resolves.toBe("ran");
  });
});
