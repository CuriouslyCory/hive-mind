import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CLI_ROOT, hostTarget } from "../scripts/build.ts";
import { inspectBinary, targetParts } from "../scripts/release-assets.ts";
import { createKeychainStore } from "../src/credentials/keychain.ts";
import type { KeyringBinding, KeyringEntry } from "../src/credentials/keychain-binding.ts";
import {
  embeddedAddonPath,
  loadKeyringBinding,
  materializeAddon,
} from "../src/credentials/keychain-binding.ts";
import { PROBE_BINARY } from "./helpers/binaries.ts";

// Spike (b). macOS binaries cannot run on this Linux host, so this proves what
// a cross-compile can: each Darwin binary embeds exactly its own Keychain addon
// byte for byte, with no separate .node file and no generic loader. The
// save/read/replace/delete proof is `probe roundtrip keychain`, run on native
// macOS runners by the release workflow (see notes/cli-spike.md).

/** In-memory stand-in for the addon's Entry class, keyed by service + account. */
function fakeBinding(): KeyringBinding {
  const items = new Map<string, string>();
  return {
    Entry: class implements KeyringEntry {
      private readonly key: string;
      constructor(service: string, account: string) {
        this.key = `${service}\u0000${account}`;
      }
      setPassword(password: string) {
        items.set(this.key, password);
      }
      getPassword() {
        return items.get(this.key) ?? null;
      }
      deleteCredential() {
        return items.delete(this.key);
      }
    },
  };
}

describe("keychain store", () => {
  it("saves, reads, replaces and deletes per origin", async () => {
    const store = createKeychainStore({ loadBinding: fakeBinding });
    const origin = "https://a.example";
    expect(await store.get(origin)).toEqual({ ok: true, found: false });
    expect(await store.set(origin, "one")).toEqual({ ok: true });
    expect(await store.set(origin, "two")).toEqual({ ok: true });
    expect(await store.get(origin)).toEqual({ ok: true, found: true, secret: "two" });
    expect(await store.get("https://b.example")).toEqual({ ok: true, found: false });
    expect(await store.delete(origin)).toEqual({ ok: true, deleted: true });
    expect(await store.delete(origin)).toEqual({ ok: true, deleted: false });
  });

  it("loads the addon lazily, on the first call", async () => {
    const load = vi.fn(fakeBinding);
    const store = createKeychainStore({ loadBinding: load });
    expect(load).not.toHaveBeenCalled();
    await store.get("https://a.example");
    await store.get("https://a.example");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when the build has no addon or it fails to load", async () => {
    // Under Node (no build target) nothing is embedded and the loader returns null.
    expect(embeddedAddonPath()).toBeNull();
    expect(loadKeyringBinding()).toBeNull();
    expect(await createKeychainStore().get("https://a.example")).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    const broken = createKeychainStore({
      loadBinding: () => {
        throw new Error("dlopen failed");
      },
    });
    expect(await broken.set("https://a.example", "x")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: expect.stringContaining("dlopen failed"),
    });
  });

  it("reports a Keychain failure as an error, without the secret", async () => {
    const store = createKeychainStore({
      loadBinding: () => ({
        Entry: class {
          setPassword(): void {
            throw new Error("User interaction is not allowed.");
          }
          getPassword(): null {
            return null;
          }
          deleteCredential(): boolean {
            return false;
          }
        },
      }),
    });
    const result = await store.set("https://a.example", "hm_secret");
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(JSON.stringify(result)).not.toContain("hm_secret");
  });
});

describe("materializeAddon", () => {
  const root = mkdtempSync(join(tmpdir(), "hivemind-extract-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const addon = Buffer.from("not really a Mach-O, but bytes all the same");

  it("writes a 0600 copy named by content hash into a new 0700 directory", () => {
    const dir = join(root, "a", "native");
    const path = materializeAddon(addon, dir);
    expect(path).toMatch(/^.+\/keyring-[0-9a-f]{64}\.node$/);
    expect(path.startsWith(`${dir}/`)).toBe(true);
    expect(readFileSync(path).equals(addon)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual([basename(path)]);
  });

  it("reuses an identical copy without rewriting it", () => {
    const dir = join(root, "reuse");
    const first = materializeAddon(addon, dir);
    const inode = statSync(first).ino;
    expect(materializeAddon(addon, dir)).toBe(first);
    expect(statSync(first).ino).toBe(inode);
  });

  it("replaces anything at the path that is not an exact private copy", () => {
    const dir = join(root, "replace");
    const path = materializeAddon(addon, dir);
    const decoy = join(root, "decoy.node");
    writeFileSync(decoy, addon);
    const planted: [string, () => void][] = [
      // Same size and owner: the case Bun's own extraction would trust.
      ["same-size junk", () => writeFileSync(path, Buffer.alloc(addon.length), { mode: 0o600 })],
      ["a truncated copy", () => writeFileSync(path, addon.subarray(1), { mode: 0o600 })],
      [
        "a copy others can read",
        () => {
          writeFileSync(path, addon);
          chmodSync(path, 0o644);
        },
      ],
      ["a symlink to an identical file", () => symlinkSync(decoy, path)],
    ];
    for (const [what, plant] of planted) {
      rmSync(path);
      plant();
      expect(materializeAddon(addon, dir), what).toBe(path);
      expect(lstatSync(path).isFile(), what).toBe(true);
      expect(statSync(path).mode & 0o777, what).toBe(0o600);
      expect(readFileSync(path).equals(addon), what).toBe(true);
    }
    expect(readdirSync(dir)).toEqual([basename(path)]);
  });

  it("refuses a directory others can access, or a symlink", () => {
    const open = join(root, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => materializeAddon(addon, open)).toThrow(/mode 0700/);
    const link = join(root, "link");
    symlinkSync(join(root, "a", "native"), link);
    expect(() => materializeAddon(addon, link)).toThrow(/mode 0700/);
  });
});

// Each target embeds only what it needs, checked on the binary built for this
// host. A host can build only its own target (STATE.md D11), so the Darwin
// binaries are checked on macOS runners, where scripts/smoke.ts runs the same
// inspection on the release archive and then a real Keychain roundtrip.
describe("the compiled binary embeds its own Keychain addon", () => {
  it("matches its target, with the addon on Darwin and none on Linux", () => {
    const target = hostTarget();
    const binary = readFileSync(PROBE_BINARY);
    const { os, arch } = targetParts(target);
    const addon =
      os === "darwin"
        ? readFileSync(
            createRequire(join(CLI_ROOT, "package.json")).resolve(
              `@napi-rs/keyring-darwin-${arch}/keyring.darwin-${arch}.node`,
            ),
          )
        : undefined;
    expect(inspectBinary(binary, target, addon)).toEqual([]);
    // Linux binaries carry no Node-API addon at all (D9: libsecret via secret-tool).
    if (os === "linux") expect(binary.includes("keyring.darwin")).toBe(false);
  });
});
