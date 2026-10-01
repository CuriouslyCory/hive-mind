import { createFileStore, type FileStoreOptions } from "./file.ts";
import { createKeychainStore, type KeychainStoreOptions } from "./keychain.ts";
import { createLibsecretStore, type LibsecretStoreOptions } from "./libsecret.ts";
import type { CredentialStore } from "./types.ts";

export { configDir, createFileStore } from "./file.ts";
export { createKeychainStore } from "./keychain.ts";
export { createLibsecretStore } from "./libsecret.ts";
export * from "./types.ts";

/**
 * Whether a person is at a terminal who could answer an OS prompt. stdin and
 * stderr must both be TTYs; stdout is ignored so `hivemind whoami --json | jq`
 * still counts as interactive. Agents and CI run with pipes on all three.
 */
export function isInteractive(
  streams: { stdin: { isTTY?: boolean }; stderr: { isTTY?: boolean } } = process,
): boolean {
  return streams.stdin.isTTY === true && streams.stderr.isTTY === true;
}

export interface SelectStoresOptions {
  platform?: NodeJS.Platform;
  interactive?: boolean;
  /** Factories, injectable so tests can observe which stores are constructed. */
  factories?: {
    keychain?: (options?: KeychainStoreOptions) => CredentialStore;
    libsecret?: (options?: LibsecretStoreOptions) => CredentialStore;
    file?: (options?: FileStoreOptions) => CredentialStore;
  };
}

/**
 * The stores to try, in order, for this platform and terminal state.
 *
 * Non-TTY policy: without an interactive terminal, prompt-capable stores are
 * not constructed at all. On macOS that means the Keychain addon is never
 * loaded, so no Keychain dialog can appear and no native call can block on
 * one. On Linux `secret-tool` can trigger a keyring unlock dialog, so it is
 * skipped too, even though its subprocess would be killed at its deadline.
 * Only the private file remains. A login stored in an OS store is therefore
 * not visible to non-interactive runs, which use HIVEMIND_TOKEN or a Project
 * key instead (issue #3: headless agents use Project keys).
 */
export function selectStores(options: SelectStoresOptions = {}): CredentialStore[] {
  const platform = options.platform ?? process.platform;
  const interactive = options.interactive ?? isInteractive();
  const make = {
    keychain: options.factories?.keychain ?? createKeychainStore,
    libsecret: options.factories?.libsecret ?? createLibsecretStore,
    file: options.factories?.file ?? createFileStore,
  };

  const stores: CredentialStore[] = [];
  if (interactive && platform === "darwin") stores.push(make.keychain());
  if (interactive && platform === "linux") stores.push(make.libsecret());
  stores.push(make.file());
  return stores;
}
