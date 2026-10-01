import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ensurePrivateDir,
  LockTimeoutError,
  readFileNoFollow,
  UnsafeFileError,
  withLock,
  writeFileAtomic,
} from "../fs-safe.ts";
import {
  type CredentialFailure,
  type CredentialStore,
  type DeleteResult,
  failure,
  type GetResult,
  type SetResult,
} from "./types.ts";

/**
 * Private-file credential store, and the index of where each origin's login
 * lives.
 *
 * Layout: `<config dir>/credentials.json` in a 0700 directory, file 0600:
 *
 *     { "version": 1, "credentials": {
 *         "https://hive.example": { "token": "..." },     // login kept in this file
 *         "http://localhost:3000": { "store": "keychain" } // login kept in an OS store
 *     } }
 *
 * The `store` entries (no secret) make this file the single record of the
 * current login per origin, which is what stops an old token from coming back
 * when OS store availability changes: a token in the Keychain or Secret
 * Service only counts while the index points at it, and saving anywhere
 * replaces the entry, which deletes the file copy in the same atomic write.
 * See `manager.ts`.
 *
 * Hardening (issue #3 step 7): the directory must be a real directory owned
 * by this user (permissive modes are tightened to 0700); the file is opened
 * without following symlinks, must be a regular file owned by this user, and
 * is refused for reading a secret if group/others can read it; writes are
 * atomic (temp file, fsync, rename); every read-modify-write runs under a
 * lock file so concurrent login/logout cannot write back a deleted token; a
 * corrupt or unknown-version file is refused, never overwritten.
 */

export interface FileStoreOptions {
  /** Directory holding credentials.json. Defaults to `configDir()`. */
  dir?: string;
  /** Lock wait bound; tests shorten it. */
  lockTimeoutMs?: number;
}

export type OsStoreId = "keychain" | "libsecret";

/** One origin's entry in the index. */
export type FileEntry = { token: string } | { store: OsStoreId };

const FILE_NAME = "credentials.json";
const LOCK_NAME = "credentials.lock";
// Far above any realistic number of origins; a bigger file is not ours.
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * `$XDG_CONFIG_HOME/hivemind`, or `~/.config/hivemind`. A relative
 * XDG_CONFIG_HOME is ignored, as the XDG Base Directory spec requires, so a
 * hostile working directory cannot redirect the credential file.
 */
export function configDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, "hivemind");
}

function parseEntry(value: unknown): FileEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (keys.length === 1 && typeof record.token === "string" && record.token !== "") {
    return { token: record.token };
  }
  if (keys.length === 1 && (record.store === "keychain" || record.store === "libsecret")) {
    return { store: record.store };
  }
  return null;
}

/** Entries live in a Map so an origin string can never reach Object.prototype. */
function parseDocument(text: string): Map<string, FileEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const doc = parsed as { version?: unknown; credentials?: unknown };
  if (doc.version !== 1 || typeof doc.credentials !== "object" || doc.credentials === null)
    return null;
  if (Array.isArray(doc.credentials)) return null;
  const entries = new Map<string, FileEntry>();
  for (const [origin, value] of Object.entries(doc.credentials)) {
    const entry = parseEntry(value);
    if (!entry) return null;
    entries.set(origin, entry);
  }
  return entries;
}

function serializeDocument(entries: Map<string, FileEntry>): string {
  return `${JSON.stringify({ version: 1, credentials: Object.fromEntries(entries) }, null, 2)}\n`;
}

export interface FileCredentialStore extends CredentialStore {
  readonly id: "file";
  readonly path: string;
  /**
   * The index entry for `origin`, or null. Pass `forSecret` when the caller
   * will use a token entry: a file readable by others is then refused.
   */
  readEntry(
    origin: string,
    options?: { forSecret?: boolean },
  ): Promise<{ ok: true; entry: FileEntry | null } | CredentialFailure>;
  /**
   * Runs `fn` while holding the credentials lock. `fn` receives the current
   * entry and a writer that replaces it (null deletes it). Used by the
   * manager so an OS-store call and the index update are one critical section.
   */
  transact<T>(
    origin: string,
    fn: (
      entry: FileEntry | null,
      write: (next: FileEntry | null) => Promise<CredentialFailure | null>,
    ) => Promise<T>,
  ): Promise<T | CredentialFailure>;
}

function describe(error: unknown): CredentialFailure {
  if (error instanceof UnsafeFileError) return failure("error", `${error.message}. ${error.hint}`);
  if (error instanceof LockTimeoutError) {
    return failure(
      "error",
      `${error.message}. If no other hivemind command is running, delete ${error.path}.`,
    );
  }
  return failure("error", (error as Error).message);
}

export function createFileStore(options: FileStoreOptions = {}): FileCredentialStore {
  const dir = options.dir ?? configDir();
  const path = join(dir, FILE_NAME);
  const lockPath = join(dir, LOCK_NAME);

  const readAll = async (
    forSecret: boolean,
  ): Promise<Map<string, FileEntry> | CredentialFailure> => {
    try {
      if (!(await ensurePrivateDir(dir, { create: false }))) return new Map();
      const bytes = await readFileNoFollow(path, {
        maxBytes: MAX_FILE_BYTES,
        requireOwner: true,
        requirePrivate: forSecret,
      });
      if (bytes === null) return new Map();
      const entries = bytes.length <= MAX_FILE_BYTES ? parseDocument(bytes.toString("utf8")) : null;
      if (entries) return entries;
      return failure(
        "error",
        `${path} is not a valid hivemind credentials file. Move it aside (it may hold a token) and log in again.`,
      );
    } catch (error) {
      return describe(error);
    }
  };

  const writeAll = async (entries: Map<string, FileEntry>): Promise<CredentialFailure | null> => {
    try {
      await writeFileAtomic(path, serializeDocument(entries), 0o600);
      return null;
    } catch (error) {
      return failure("error", `cannot write ${path}: ${(error as Error).message}`);
    }
  };

  const transact: FileCredentialStore["transact"] = async (origin, fn) => {
    try {
      await ensurePrivateDir(dir, { create: true });
      return await withLock(
        lockPath,
        async () => {
          // A permissive file is still rewritten (0600), so only ownership and
          // symlinks block a write.
          const entries = await readAll(false);
          if (!(entries instanceof Map)) return entries;
          const write = (next: FileEntry | null) => {
            if (next === null) entries.delete(origin);
            else entries.set(origin, next);
            return writeAll(entries);
          };
          return await fn(entries.get(origin) ?? null, write);
        },
        { timeoutMs: options.lockTimeoutMs },
      );
    } catch (error) {
      return describe(error);
    }
  };

  const readEntry: FileCredentialStore["readEntry"] = async (origin, readOptions = {}) => {
    // Reads take no lock: writes are atomic renames, so a reader sees either
    // the old or the new file.
    const entries = await readAll(readOptions.forSecret ?? false);
    if (!(entries instanceof Map)) return entries;
    return { ok: true, entry: entries.get(origin) ?? null };
  };

  const get = async (origin: string): Promise<GetResult | CredentialFailure> => {
    const result = await readEntry(origin, { forSecret: true });
    if (!result.ok) return result;
    return result.entry && "token" in result.entry
      ? { ok: true, found: true, secret: result.entry.token }
      : { ok: true, found: false };
  };

  const set = (origin: string, secret: string): Promise<SetResult | CredentialFailure> =>
    transact(
      origin,
      async (_entry, write) => (await write({ token: secret })) ?? { ok: true as const },
    );

  const remove = (origin: string): Promise<DeleteResult | CredentialFailure> =>
    transact(origin, async (entry, write) => {
      if (entry === null) return { ok: true as const, deleted: false };
      return (await write(null)) ?? { ok: true as const, deleted: true };
    });

  return { id: "file", promptCapable: false, path, get, set, delete: remove, readEntry, transact };
}
