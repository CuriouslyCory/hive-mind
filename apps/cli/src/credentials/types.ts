/**
 * Common interface for the places a login token can live: the macOS Keychain,
 * the Linux Secret Service (via `secret-tool`) and a private file.
 *
 * Every store is keyed by a normalized backend origin such as
 * `https://hivemind.curiouslycory.com`; normalizing and validating that origin
 * is the caller's job (cli-core), not the store's. Stores never throw for
 * expected conditions. They return a typed result so the caller can decide
 * between "not logged in", "this store is unusable, try the next one" and
 * "this store failed, stop", without parsing error messages.
 */

export type CredentialStoreId = "keychain" | "libsecret" | "file";

/**
 * Why a store could not complete a call.
 *
 * - `unavailable`: the store does not exist or cannot be reached here (no
 *   `secret-tool`, no Secret Service, no Keychain addon for this target). The
 *   caller may fall back to the next store.
 * - `timeout`: the store did not answer within its bound and the call was
 *   cancelled. Treated like `unavailable` for fallback, but reported
 *   separately so the user can be told the store hung.
 * - `error`: the store answered with a failure (permission denied, corrupt
 *   data, unexpected output). The caller must not silently fall back, or a
 *   token could end up in two places.
 */
export type CredentialFailureReason = "unavailable" | "timeout" | "error";

export interface CredentialFailure {
  ok: false;
  reason: CredentialFailureReason;
  /** Human-readable cause. Never contains the secret. */
  message: string;
}

export type GetResult = { ok: true; found: true; secret: string } | { ok: true; found: false };
export type SetResult = { ok: true };
export type DeleteResult = { ok: true; deleted: boolean };

export interface CredentialStore {
  readonly id: CredentialStoreId;
  /**
   * True when using the store can make the operating system show a prompt
   * (a Keychain access dialog, a keyring unlock dialog). Such stores are never
   * consulted without an interactive terminal; see `selectStores`.
   */
  readonly promptCapable: boolean;
  get(origin: string): Promise<GetResult | CredentialFailure>;
  set(origin: string, secret: string): Promise<SetResult | CredentialFailure>;
  delete(origin: string): Promise<DeleteResult | CredentialFailure>;
}

export function failure(reason: CredentialFailureReason, message: string): CredentialFailure {
  return { ok: false, reason, message };
}

/** The default service/application name the OS stores file entries under. */
export const DEFAULT_SERVICE = "hivemind";
