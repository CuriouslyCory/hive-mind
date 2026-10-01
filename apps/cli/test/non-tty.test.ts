import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  type CredentialStore,
  type CredentialStoreId,
  isInteractive,
  selectStores,
} from "../src/credentials/index.ts";
import { json, PROBE_BINARY, run } from "./helpers/binaries.ts";

// Spike (e): without an interactive terminal, the credential layer never
// constructs a store that can make the OS show a prompt. On macOS that means
// the Keychain addon is not even loaded, so a blocking native call cannot
// happen; it is avoided, not timed out.

function factory(id: CredentialStoreId, promptCapable: boolean) {
  return vi.fn(
    (): CredentialStore => ({
      id,
      promptCapable,
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    }),
  );
}

function factories() {
  return {
    keychain: factory("keychain", true),
    libsecret: factory("libsecret", true),
    file: factory("file", false),
  };
}

describe("isInteractive", () => {
  it("needs both stdin and stderr to be TTYs; stdout may be piped", () => {
    expect(isInteractive({ stdin: { isTTY: true }, stderr: { isTTY: true } })).toBe(true);
    expect(isInteractive({ stdin: { isTTY: true }, stderr: {} })).toBe(false);
    expect(isInteractive({ stdin: {}, stderr: { isTTY: true } })).toBe(false);
    expect(isInteractive({ stdin: {}, stderr: {} })).toBe(false);
  });
});

describe("selectStores", () => {
  it.each(["darwin", "linux"] as const)(
    "never constructs a prompt-capable store without a TTY (%s)",
    (platform) => {
      const make = factories();
      const stores = selectStores({ platform, interactive: false, factories: make });
      expect(stores.map((store) => store.id)).toEqual(["file"]);
      expect(stores.every((store) => !store.promptCapable)).toBe(true);
      expect(make.keychain).not.toHaveBeenCalled();
      expect(make.libsecret).not.toHaveBeenCalled();
    },
  );

  it("prefers the OS store, then the file, at a terminal", () => {
    const ids = (platform: NodeJS.Platform) =>
      selectStores({ platform, interactive: true, factories: factories() }).map(
        (store) => store.id,
      );
    expect(ids("darwin")).toEqual(["keychain", "file"]);
    expect(ids("linux")).toEqual(["libsecret", "file"]);
  });
});

describe("TTY policy in the compiled binary", () => {
  it("uses only the file store when run with pipes", () => {
    const info = json(run(PROBE_BINARY, ["info"]));
    expect(info).toMatchObject({ interactive: false, stores: ["file"] });
  });

  it("adds the OS store when run under a pseudo-terminal", () => {
    // `script` gives the probe a PTY on stdin/stdout/stderr; BSD (macOS) and
    // util-linux (Linux) spell the invocation differently.
    const args =
      process.platform === "darwin"
        ? ["-q", "/dev/null", PROBE_BINARY, "info"]
        : ["-qec", `${PROBE_BINARY} info`, "/dev/null"];
    const result = spawnSync("script", args, {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TERM: "dumb" },
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const info = JSON.parse(result.stdout.trim());
    const osStore = process.platform === "darwin" ? "keychain" : "libsecret";
    expect(info).toMatchObject({ interactive: true, stores: [osStore, "file"] });
  });
});
