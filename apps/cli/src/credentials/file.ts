import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  type CredentialFailure,
  type CredentialStore,
  type DeleteResult,
  failure,
  type GetResult,
  type SetResult,
} from "./types.ts";

/**
 * Private-file fallback for hosts without a usable OS store.
 *
 * Layout: `<config dir>/hivemind/credentials.json`, directory 0700, file 0600,
 * holding `{ "version": 1, "credentials": { "<origin>": { "token": "..." } } }`.
 * Writes go to a 0600 temporary file in the same directory, are fsynced and
 * then renamed over the target, so a crash leaves either the old or the new
 * file, never a partial one.
 *
 * This is the spike's minimal store. cli-core adds the hardening from issue
 * step 7 behind the same interface: refusing symlinked or foreign-owned
 * directories and files, tightening an existing permissive directory, a lock
 * so concurrent login/logout cannot resurrect a deleted token, and handling a
 * corrupt file. `readDocument` and `writeDocument` are the seams for that.
 */

export interface FileStoreOptions {
  /** Directory holding credentials.json. Defaults to `configDir()`. */
  dir?: string;
}

interface CredentialsDocument {
  version: 1;
  credentials: Record<string, { token: string }>;
}

const FILE_NAME = "credentials.json";

/**
 * `$XDG_CONFIG_HOME/hivemind`, or `~/.config/hivemind`. A relative
 * XDG_CONFIG_HOME is ignored, as the XDG Base Directory spec requires, so a
 * hostile working directory cannot redirect the credential file.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, "hivemind");
}

function emptyDocument(): CredentialsDocument {
  return { version: 1, credentials: {} };
}

function isDocument(value: unknown): value is CredentialsDocument {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as { version?: unknown; credentials?: unknown };
  return (
    doc.version === 1 &&
    typeof doc.credentials === "object" &&
    doc.credentials !== null &&
    !Array.isArray(doc.credentials)
  );
}

export function createFileStore(options: FileStoreOptions = {}): CredentialStore {
  const dir = options.dir ?? configDir();
  const path = join(dir, FILE_NAME);

  const readDocument = async (): Promise<CredentialsDocument | CredentialFailure> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      return failure("error", `cannot read ${path}: ${(error as Error).message}`);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isDocument(parsed)) return parsed;
    } catch {
      // Fall through: the message below covers both parse and shape errors.
    }
    return failure("error", `${path} is not a valid hivemind credentials file`);
  };

  const ensureDir = async (): Promise<CredentialFailure | null> => {
    // Only the hivemind directory is private; its parent (~/.config) keeps
    // whatever mode the user's other tools expect. mkdir's mode can only be
    // narrowed by the umask, never widened, so 0700 holds under any umask.
    await mkdir(dirname(dir), { recursive: true });
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await lstat(dir);
    if (!stats.isDirectory()) {
      return failure("error", `${dir} exists and is not a directory`);
    }
    return null;
  };

  const writeDocument = async (doc: CredentialsDocument): Promise<CredentialFailure | null> => {
    try {
      const dirProblem = await ensureDir();
      if (dirProblem) return dirProblem;
      const temp = join(dir, `.${FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`);
      // "wx": never follow or reuse an existing path; 0600 from creation, so
      // the token is never readable by others, even briefly.
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return null;
    } catch (error) {
      return failure("error", `cannot write ${path}: ${(error as Error).message}`);
    }
  };

  const get = async (origin: string): Promise<GetResult | CredentialFailure> => {
    const doc = await readDocument();
    if ("ok" in doc) return doc;
    const entry = Object.hasOwn(doc.credentials, origin) ? doc.credentials[origin] : undefined;
    return typeof entry?.token === "string" && entry.token !== ""
      ? { ok: true, found: true, secret: entry.token }
      : { ok: true, found: false };
  };

  const set = async (origin: string, secret: string): Promise<SetResult | CredentialFailure> => {
    const doc = await readDocument();
    if ("ok" in doc) return doc;
    doc.credentials[origin] = { token: secret };
    return (await writeDocument(doc)) ?? { ok: true };
  };

  const remove = async (origin: string): Promise<DeleteResult | CredentialFailure> => {
    const doc = await readDocument();
    if ("ok" in doc) return doc;
    if (!Object.hasOwn(doc.credentials, origin)) return { ok: true, deleted: false };
    delete doc.credentials[origin];
    return (await writeDocument(doc)) ?? { ok: true, deleted: true };
  };

  return { id: "file", promptCapable: false, get, set, delete: remove };
}
