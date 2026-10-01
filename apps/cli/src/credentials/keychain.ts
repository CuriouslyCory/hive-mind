import type { KeyringBinding } from "./keychain-binding.ts";
import {
  type CredentialFailure,
  type CredentialStore,
  DEFAULT_SERVICE,
  type DeleteResult,
  failure,
  type GetResult,
  type SetResult,
} from "./types.ts";

/**
 * macOS Keychain store backed by the embedded @napi-rs/keyring addon. Each
 * token is a generic password item with service `hivemind` and the origin as
 * its account.
 *
 * Keychain calls are synchronous native calls. macOS can block one on an
 * access dialog (for example after the binary is replaced by an update and its
 * signature no longer matches the item's access list), and nothing in this
 * process can cancel it. So the store is `promptCapable` and `selectStores`
 * never returns it without an interactive terminal: the call is avoided, not
 * timed out.
 */

export interface KeychainStoreOptions {
  service?: string;
  /** Loads the addon. Injected by tests; defaults to the embedded binding. */
  loadBinding?: () => KeyringBinding | null;
}

export function createKeychainStore(options: KeychainStoreOptions = {}): CredentialStore {
  const service = options.service ?? DEFAULT_SERVICE;
  let binding: KeyringBinding | null | undefined;

  // The addon is loaded on first use, never at startup, so commands that do
  // not touch credentials (and non-interactive runs) never dlopen it.
  const entry = async (origin: string) => {
    if (binding === undefined) {
      const load =
        options.loadBinding ?? (await import("./keychain-binding.ts")).loadKeyringBinding;
      binding = load();
    }
    return binding ? new binding.Entry(service, origin) : null;
  };

  const call = async <T>(
    origin: string,
    action: string,
    use: (item: NonNullable<Awaited<ReturnType<typeof entry>>>) => T,
  ): Promise<T | CredentialFailure> => {
    let item: Awaited<ReturnType<typeof entry>>;
    try {
      item = await entry(origin);
    } catch (error) {
      return failure("unavailable", `cannot load the Keychain addon: ${(error as Error).message}`);
    }
    if (!item) return failure("unavailable", "this build has no Keychain support");
    try {
      return use(item);
    } catch (error) {
      return failure("error", `Keychain ${action} failed: ${(error as Error).message}`);
    }
  };

  const get = (origin: string): Promise<GetResult | CredentialFailure> =>
    call(origin, "read", (item): GetResult => {
      const secret = item.getPassword();
      return typeof secret === "string" && secret !== ""
        ? { ok: true, found: true, secret }
        : { ok: true, found: false };
    });

  const set = (origin: string, secret: string): Promise<SetResult | CredentialFailure> =>
    call(origin, "write", (item): SetResult => {
      item.setPassword(secret);
      return { ok: true };
    });

  const remove = (origin: string): Promise<DeleteResult | CredentialFailure> =>
    call(
      origin,
      "delete",
      (item): DeleteResult => ({ ok: true, deleted: item.deleteCredential() }),
    );

  return { id: "keychain", promptCapable: true, get, set, delete: remove };
}
