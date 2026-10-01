// Test and native-smoke harness, compiled with the same scripts/build.ts flags
// as the shipped binary (never shipped itself). Each command prints one JSON
// object on stdout. Secrets come from stdin or the environment, never argv.
//
//   probe info                          build constants, TTY state, selected stores
//   probe http <url>                    GET with a bearer from HIVEMIND_PROBE_TOKEN
//   probe store <id> get|set|delete <origin>
//                                       one store call; `set` reads the secret from stdin
//   probe roundtrip <id>                save/read/replace/read/delete/read under a
//                                       unique service name; exit 0 only if all pass
//
// <id> is keychain | libsecret | file. HIVEMIND_PROBE_SERVICE overrides the
// service name and HIVEMIND_PROBE_TIMEOUT_MS the secret-tool deadline.

import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_COMMIT, BUILD_TARGET, BUILD_VERSION, DEFAULT_ORIGIN } from "../../src/build-info.ts";
import {
  type CredentialStore,
  createFileStore,
  createKeychainStore,
  createLibsecretStore,
  isInteractive,
  selectStores,
} from "../../src/credentials/index.ts";
import { embeddedAddonPath, nativeExtractDir } from "../../src/credentials/keychain-binding.ts";

const STARTED = Date.now();

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function makeStore(id: string | undefined, service: string): CredentialStore {
  const timeout = Number(process.env.HIVEMIND_PROBE_TIMEOUT_MS);
  switch (id) {
    case "keychain":
      return createKeychainStore({ service });
    case "libsecret":
      return createLibsecretStore({ service, timeoutMs: timeout > 0 ? timeout : undefined });
    case "file":
      return createFileStore();
    default:
      throw new Error(`unknown store ${id}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function roundtrip(store: CredentialStore): Promise<boolean> {
  const origin = "https://smoke.invalid";
  const first = `first-${randomBytes(8).toString("hex")}`;
  const second = `second-${randomBytes(8).toString("hex")}`;
  const plan: [step: string, run: () => Promise<unknown>, expected: unknown][] = [
    ["save", () => store.set(origin, first), { ok: true }],
    ["read", () => store.get(origin), { ok: true, found: true, secret: first }],
    ["replace", () => store.set(origin, second), { ok: true }],
    ["read-replaced", () => store.get(origin), { ok: true, found: true, secret: second }],
    ["delete", () => store.delete(origin), { ok: true, deleted: true }],
    ["read-deleted", () => store.get(origin), { ok: true, found: false }],
    ["delete-again", () => store.delete(origin), { ok: true, deleted: false }],
  ];
  const steps: { step: string; ok: boolean; result?: unknown }[] = [];
  for (const [step, run, expected] of plan) {
    const result = await run();
    const ok = JSON.stringify(result) === JSON.stringify(expected);
    // Report a mismatch, but never echo a result that holds a test secret.
    const safe = result && typeof result === "object" && "secret" in result ? "<secret>" : result;
    steps.push(ok ? { step, ok } : { step, ok, result: safe });
    if (!ok) break;
  }
  const passed = steps.length === plan.length && steps.every((step) => step.ok);
  const addon = store.id === "keychain" ? addonCheck() : undefined;
  print({ store: store.id, passed, steps, addon });
  return passed && (addon === undefined || addon.ok);
}

/**
 * Native check for loadKeyringBinding: the addon this binary embeds sits in the
 * private extraction directory as an exact 0600 copy, and Bun extracted no
 * addon of its own into the temp directory during this run.
 */
function addonCheck() {
  const embedded = embeddedAddonPath();
  const bytes = embedded === null ? undefined : readFileSync(embedded);
  const dir = nativeExtractDir();
  const uid = process.geteuid?.();
  const dirStats = lstatSync(dir);
  const privateDir =
    dirStats.isDirectory() && dirStats.uid === uid && (dirStats.mode & 0o777) === 0o700;
  const copy = readdirSync(dir)
    .filter((name) => name.endsWith(".node"))
    .map((name) => join(dir, name))
    .find((path) => {
      const stats = lstatSync(path);
      return (
        stats.isFile() &&
        stats.uid === uid &&
        (stats.mode & 0o777) === 0o600 &&
        bytes !== undefined &&
        readFileSync(path).equals(bytes)
      );
    });
  // Bun names its own extractions `.bun-<euid>-<hash>.node`.
  const temp = tmpdir();
  const tmpdirAddons = readdirSync(temp).filter(
    (name) => name.endsWith(".node") && lstatSync(join(temp, name)).mtimeMs >= STARTED - 1000,
  );
  return {
    ok: privateDir && copy !== undefined && tmpdirAddons.length === 0,
    dir,
    dirMode: (dirStats.mode & 0o777).toString(8),
    privateDir,
    copy: copy ?? null,
    tmpdir: temp,
    tmpdirAddons,
  };
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const service = process.env.HIVEMIND_PROBE_SERVICE ?? "hivemind";

  if (command === "info") {
    print({
      version: BUILD_VERSION,
      commit: BUILD_COMMIT,
      target: BUILD_TARGET,
      defaultOrigin: DEFAULT_ORIGIN,
      interactive: isInteractive(),
      stores: selectStores().map((store) => store.id),
      // Presence only, so a test can see whether a hostile .env leaked in.
      env: {
        HIVEMIND_URL: process.env.HIVEMIND_URL ?? null,
        HIVEMIND_TOKEN: process.env.HIVEMIND_TOKEN === undefined ? null : "set",
      },
    });
    return 0;
  }

  if (command === "http") {
    const [url] = args;
    if (!url) throw new Error("usage: probe http <url>");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${process.env.HIVEMIND_PROBE_TOKEN ?? ""}` },
      // Redirects are surfaced, never followed with the bearer attached.
      redirect: "manual",
    });
    const type = response.headers.get("content-type") ?? "";
    const body: unknown = type.includes("application/json") ? await response.json() : null;
    print({ status: response.status, location: response.headers.get("location"), body });
    return 0;
  }

  if (command === "store") {
    const [id, action, origin] = args;
    if (!origin) throw new Error("usage: probe store <id> get|set|delete <origin>");
    const store = makeStore(id, service);
    if (action === "get") print(await store.get(origin));
    else if (action === "set") print(await store.set(origin, await readStdin()));
    else if (action === "delete") print(await store.delete(origin));
    else throw new Error(`unknown action ${action}`);
    return 0;
  }

  if (command === "roundtrip") {
    const unique = `hivemind-smoke-${randomBytes(6).toString("hex")}`;
    return (await roundtrip(makeStore(args[0], unique))) ? 0 : 1;
  }

  throw new Error(`unknown command ${command}`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`probe: ${(error as Error).message}\n`);
    process.exitCode = 2;
  },
);
