import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, cancelledError } from "../../src/clock.ts";
import { COMMANDS } from "../../src/commands/index.ts";
import { createFileStore, type FileCredentialStore } from "../../src/credentials/file.ts";
import { type MemoryStore, memoryStore } from "./memory-store.ts";
import { runShell, type ShellResult } from "./shell.ts";

/** A clock whose sleeps return at once and advance `now`; every sleep is recorded. */
export interface FakeClock extends Clock {
  sleeps: number[];
  /** Called at the start of each sleep (e.g. to abort the signal on the nth wait). */
  onSleep?: (index: number) => void;
}

export function fakeClock(): FakeClock {
  let now = 0;
  const clock: FakeClock = {
    sleeps: [],
    now: () => now,
    async sleep(ms, signal) {
      clock.onSleep?.(clock.sleeps.length);
      clock.sleeps.push(ms);
      if (signal.aborted) throw cancelledError(signal.reason);
      now += ms;
    },
  };
  return clock;
}

export interface CommandHarness {
  /** Holds `hivemind/credentials.json`. */
  configDir: string;
  file: FileCredentialStore;
  /** Stand-in for the OS store, used only when `interactive` is true. */
  os: MemoryStore;
  run(argv: readonly string[], options?: Parameters<typeof runShell>[1]): Promise<ShellResult>;
  cleanup(): void;
}

/**
 * Runs the real command registry in-process against a private credentials
 * directory, a memory OS store and (by default) a fake clock, so no test
 * touches ~/.config, the real keyring or waits on real time.
 */
export function commandHarness(): CommandHarness {
  const base = mkdtempSync(join(tmpdir(), "hivemind-commands-"));
  const configDir = join(base, "config", "hivemind");
  const file = createFileStore({ dir: configDir });
  const os = memoryStore("libsecret");
  return {
    configDir,
    file,
    os,
    run: (argv, options = {}) =>
      runShell(argv, {
        commands: COMMANDS,
        platform: "linux",
        clock: fakeClock(),
        openUrl: async () => false,
        ...options,
        credentialOptions: {
          file,
          factories: { libsecret: () => os, keychain: () => os },
          ...options.credentialOptions,
        },
      }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
