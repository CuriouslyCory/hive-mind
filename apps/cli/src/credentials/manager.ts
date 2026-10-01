import { CLI_ERROR_CODES, CliError } from "../errors.ts";
import { registerSecret } from "../redact.ts";
import {
  configDir,
  createFileStore,
  type FileCredentialStore,
  type FileEntry,
  type OsStoreId,
} from "./file.ts";
import { isInteractive, type SelectStoresOptions, selectStores } from "./index.ts";
import type { CredentialFailure, CredentialStore } from "./types.ts";

/**
 * Credential resolution and the login/logout bookkeeping on top of the stores.
 *
 * Resolution (issue #3): `HIVEMIND_TOKEN` when it is set and non-empty,
 * otherwise the stored login for the normalized origin. A set token is used
 * as-is and nothing else is consulted, so a malformed or rejected token fails
 * instead of quietly falling back to a stored login (another identity).
 *
 * Where a stored login lives is recorded in the private credentials file (see
 * `file.ts`): either the token itself or a pointer to the OS store that holds
 * it. Only the store the index points at is ever read, so a token left behind
 * in a store that was unavailable at the last login or logout is never
 * revived.
 *
 * Without an interactive terminal the OS stores are never opened (they can
 * prompt). A login kept in one can then be neither read, revoked nor deleted,
 * so `save` and `remove` refuse to touch it (TERMINAL_REQUIRED) and leave the
 * pointer in place: dropping or replacing it would orphan a valid token that
 * a later `hivemind logout` in a terminal could no longer find and revoke.
 */

export type CredentialSource = "env" | "keychain" | "libsecret" | "file";

export interface ResolvedCredential {
  origin: string;
  token: string;
  source: CredentialSource;
}

export interface SaveResult {
  /** Where the login now lives. */
  store: "keychain" | "libsecret" | "file";
  /** OS stores that were skipped because they were unavailable or timed out. */
  warnings: string[];
}

export interface RemoveResult {
  /** Whether a stored login existed for the origin. */
  removed: boolean;
  /** The token that was removed, so `logout` can revoke it on the server. */
  token: string | null;
  /** OS-store copies that could not be deleted. They are no longer referenced, so never used. */
  warnings: string[];
  /**
   * OS stores not checked for leftover copies because there is no interactive
   * terminal. (A login the index keeps in one is refused, never skipped.)
   */
  skipped: OsStoreId[];
}

export interface CredentialManager {
  /** The credential for `origin`, or null when there is none. Throws `CliError` for unusable ones. */
  resolve(origin: string): Promise<ResolvedCredential | null>;
  /** Like `resolve`, but "not logged in" is an UNAUTHORIZED `CliError` (exit 3). */
  require(origin: string): Promise<ResolvedCredential>;
  /** The stored login only, ignoring HIVEMIND_TOKEN. */
  readStored(origin: string): Promise<ResolvedCredential | null>;
  /**
   * Throws TERMINAL_REQUIRED when `save` would have to replace a login this
   * run cannot open (an OS store without a terminal). Lets `login` fail
   * before asking the user to approve anything; `save` checks again.
   */
  checkReplaceable(origin: string): Promise<void>;
  /**
   * Stores `token` as the login for `origin`. If the index write fails, the
   * previous login is left as it was (its OS-store copy restored).
   */
  save(origin: string, token: string): Promise<SaveResult>;
  /**
   * Removes every local copy for `origin`. Never touches HIVEMIND_TOKEN. If
   * the index write fails, nothing is deleted.
   */
  remove(origin: string): Promise<RemoveResult>;
}

export interface CredentialManagerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  interactive?: boolean;
  platform?: NodeJS.Platform;
  /** Overrides for tests: the file store and OS-store factories. */
  file?: FileCredentialStore;
  factories?: SelectStoresOptions["factories"];
}

const STORE_LABELS: Record<OsStoreId, string> = {
  keychain: "the macOS Keychain",
  libsecret: "the Secret Service (libsecret)",
};

/** Printable ASCII without spaces: what better-auth tokens and Project keys are made of. */
export function isWellFormedToken(token: string): boolean {
  if (token.length > 4096) return false;
  for (let index = 0; index < token.length; index++) {
    const code = token.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function storeError(message: string, hint?: string): CliError {
  return new CliError(CLI_ERROR_CODES.credentialStore, message, { hint });
}

/** `save`/`remove` hit a login in an OS store this run may not open. */
interface TerminalRequired {
  terminalRequired: OsStoreId;
}

function terminalRequiredError(
  origin: string,
  store: OsStoreId,
  action: "replace" | "remove",
): CliError {
  const where = `Your login for ${origin} is kept in ${STORE_LABELS[store]}, which hivemind only opens from an interactive terminal`;
  return action === "remove"
    ? new CliError(
        CLI_ERROR_CODES.terminalRequired,
        `${where}, so it was neither revoked nor deleted. Nothing was changed.`,
        { hint: "Run 'hivemind logout' in a terminal: it revokes the login and deletes it." },
      )
    : new CliError(
        CLI_ERROR_CODES.terminalRequired,
        `${where}. Replacing it here could neither revoke nor delete it, so nothing was changed.`,
        {
          hint: "Run 'hivemind logout' in a terminal first, then log in again here. For scripts and agents, HIVEMIND_TOKEN set to a Project key ('hivemind key create') needs no login.",
        },
      );
}

function osStoreFor(platform: NodeJS.Platform): OsStoreId | null {
  if (platform === "darwin") return "keychain";
  if (platform === "linux") return "libsecret";
  return null;
}

/**
 * Undoes an OS-store `set` after the index write failed, so the index (which
 * still describes the previous login) stays true: the replaced token goes
 * back, or the new one, which nothing references, is deleted. Returns the
 * failure message to report, extended if the undo failed too.
 */
async function rollBack(
  store: CredentialStore & { id: OsStoreId },
  origin: string,
  previous: string | null,
  failed: CredentialFailure,
): Promise<CredentialFailure> {
  const undone = previous !== null ? await store.set(origin, previous) : await store.delete(origin);
  if (undone.ok || previous === null) return failed;
  return {
    ...failed,
    message: `${failed.message}; the previous login in ${STORE_LABELS[store.id]} could not be restored either (${undone.message}), so run 'hivemind login' again`,
  };
}

export function createCredentialManager(options: CredentialManagerOptions = {}): CredentialManager {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const interactive = options.interactive ?? isInteractive();
  const file = options.file ?? createFileStore({ dir: configDir(env) });
  // selectStores applies the non-TTY policy: prompt-capable stores are not
  // even constructed without a terminal.
  const osStores = selectStores({
    platform,
    interactive,
    factories: { ...options.factories, file: () => file },
  }).filter((store): store is CredentialStore & { id: OsStoreId } => store.id !== "file");
  const platformStore = osStoreFor(platform);
  const skipped: OsStoreId[] = !interactive && platformStore ? [platformStore] : [];

  /** The OS store a pointer entry names, when this run is not allowed to open it. */
  const refusedStore = (entry: FileEntry | null): OsStoreId | null =>
    !interactive && entry !== null && "store" in entry ? entry.store : null;

  const checkReplaceable = async (origin: string): Promise<void> => {
    const index = await file.readEntry(origin);
    // An unreadable index is reported by `save`, with its own message.
    const store = index.ok ? refusedStore(index.entry) : null;
    if (store !== null) throw terminalRequiredError(origin, store, "replace");
  };

  const readStored = async (origin: string): Promise<ResolvedCredential | null> => {
    const index = await file.readEntry(origin, { forSecret: true });
    if (!index.ok) throw storeError(`Cannot read stored credentials: ${index.message}`);
    const entry = index.entry;
    if (entry === null) return null;
    if ("token" in entry) {
      registerSecret(entry.token);
      return { origin, token: entry.token, source: "file" };
    }
    const label = STORE_LABELS[entry.store];
    const store = osStores.find((candidate) => candidate.id === entry.store);
    if (!store) {
      throw new CliError(
        "UNAUTHORIZED",
        `Your login for ${origin} is kept in ${label}, which hivemind only reads from an interactive terminal.`,
        {
          hint: "Run the command in a terminal, or set HIVEMIND_TOKEN (for example to a Project key from 'hivemind key create').",
        },
      );
    }
    const result = await store.get(origin);
    if (!result.ok) {
      throw storeError(
        `Your login for ${origin} is kept in ${label}, which failed: ${result.message}`,
        "Unlock or start your keyring, or run 'hivemind login' again.",
      );
    }
    // The copy disappeared (removed by hand in the keyring): not logged in.
    if (!result.found) return null;
    registerSecret(result.secret);
    return { origin, token: result.secret, source: entry.store };
  };

  const resolve = async (origin: string): Promise<ResolvedCredential | null> => {
    const fromEnv = env.HIVEMIND_TOKEN;
    if (fromEnv !== undefined && fromEnv !== "") {
      registerSecret(fromEnv);
      if (!isWellFormedToken(fromEnv)) {
        throw new CliError(
          "UNAUTHORIZED",
          "HIVEMIND_TOKEN is malformed: it contains whitespace, control or non-ASCII characters.",
          {
            hint: "Set it to the exact token, or unset it to use your stored login.",
          },
        );
      }
      return { origin, token: fromEnv, source: "env" };
    }
    return readStored(origin);
  };

  const require = async (origin: string): Promise<ResolvedCredential> => {
    const credential = await resolve(origin);
    if (credential) return credential;
    throw new CliError("UNAUTHORIZED", `Not logged in to ${origin}.`, {
      hint: interactive
        ? "Run 'hivemind login'."
        : "Run 'hivemind login', or set HIVEMIND_TOKEN (for example to a Project key from 'hivemind key create').",
    });
  };

  const save = async (origin: string, token: string): Promise<SaveResult> => {
    if (!isWellFormedToken(token) || token === "")
      throw storeError("Refusing to store a malformed token.");
    registerSecret(token);
    const result = await file.transact(
      origin,
      async (entry, write): Promise<SaveResult | CredentialFailure | TerminalRequired> => {
        const refused = refusedStore(entry);
        if (refused !== null) return { terminalRequired: refused };
        const warnings: string[] = [];
        for (const store of osStores) {
          // `set` overwrites the login the index points at; keep it so a
          // failed index write can put it back.
          let previous: string | null = null;
          if (entry !== null && "store" in entry && entry.store === store.id) {
            const current = await store.get(origin);
            if (current.ok && current.found) {
              registerSecret(current.secret);
              previous = current.secret;
            }
          }
          const stored = await store.set(origin, token);
          if (stored.ok) {
            // Pointing the index at the OS store replaces any token entry, which
            // deletes the file copy in the same atomic write.
            const written = await write({ store: store.id });
            if (written) return rollBack(store, origin, previous, written);
            return { store: store.id, warnings };
          }
          // `error` means the store answered with a failure: stop rather than
          // put the token somewhere the user did not expect.
          if (stored.reason === "error") return stored;
          warnings.push(
            `${STORE_LABELS[store.id]} is ${stored.reason === "timeout" ? "not responding" : "unavailable"} (${stored.message}); storing the login in ${file.path} instead.`,
          );
        }
        return (await write({ token })) ?? { store: "file", warnings };
      },
    );
    if ("terminalRequired" in result)
      throw terminalRequiredError(origin, result.terminalRequired, "replace");
    if ("ok" in result) throw storeError(`Cannot store the login for ${origin}: ${result.message}`);
    return result;
  };

  const remove = async (origin: string): Promise<RemoveResult> => {
    const result = await file.transact(
      origin,
      async (entry, write): Promise<RemoveResult | CredentialFailure | TerminalRequired> => {
        const refused = refusedStore(entry);
        if (refused !== null) return { terminalRequired: refused };
        let token: string | null = entry && "token" in entry ? entry.token : null;
        if (entry !== null && "store" in entry) {
          const current = await osStores.find((store) => store.id === entry.store)?.get(origin);
          if (current?.ok && current.found) token = current.secret;
        }
        // The index first: if this write fails, nothing has been deleted yet
        // and the login stays usable, so the user can simply retry.
        if (entry !== null) {
          const written = await write(null);
          if (written) return written;
        }
        const warnings: string[] = [];
        // Every OS store we can reach, not only the one the index points at:
        // logout clears every local copy for the origin.
        for (const store of osStores) {
          const deleted = await store.delete(origin);
          if (!deleted.ok) {
            warnings.push(
              `Could not remove the copy in ${STORE_LABELS[store.id]} (${deleted.message}); it is no longer used.`,
            );
          }
        }
        if (token !== null) registerSecret(token);
        return { removed: entry !== null, token, warnings, skipped };
      },
    );
    if ("terminalRequired" in result)
      throw terminalRequiredError(origin, result.terminalRequired, "remove");
    if ("ok" in result)
      throw storeError(`Cannot remove the login for ${origin}: ${result.message}`);
    return result;
  };

  return { resolve, require, readStored, checkReplaceable, save, remove };
}
