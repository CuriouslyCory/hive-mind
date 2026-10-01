import { spawn } from "node:child_process";
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
 * Linux Secret Service store, driven through libsecret's `secret-tool`.
 *
 * A subprocess rather than a native binding (STATE.md D9), because a child can
 * be killed: the spike showed an in-process Secret Service call blocks forever
 * when the bus accepts the connection but never answers, and neither a
 * JavaScript timeout nor an AbortSignal cancels it. Here every call has a hard
 * deadline after which the child is SIGKILLed and the call returns `timeout`.
 *
 * The secret only ever travels on the child's stdin. argv holds the attribute
 * names, the service and the origin, which are not secret but are visible to
 * other local users through `ps`.
 */

export interface LibsecretStoreOptions {
  /** Value of the `service` attribute. Tests use a unique name. */
  service?: string;
  /** Executable to run, resolved through PATH. */
  command?: string;
  /** Hard deadline per `secret-tool` invocation. */
  timeoutMs?: number;
  /** Environment for the child. Defaults to this process's, minus HIVEMIND_* variables. */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_LIBSECRET_TIMEOUT_MS = 5_000;

// A token is far smaller; anything bigger is not ours and is not read further.
const MAX_OUTPUT_BYTES = 64 * 1024;

// stderr from secret-tool/libsecret when there is no usable Secret Service:
// no session bus, no daemon providing org.freedesktop.secrets, or autolaunch
// impossible (headless/SSH sessions). These mean "fall back", not "fail".
const NO_SERVICE_PATTERNS = [
  /org\.freedesktop\.secrets/i,
  /cannot autolaunch d-?bus/i,
  /DBUS_SESSION_BUS_ADDRESS/,
  /could not connect/i,
  /failed to connect/i,
  /not provided by any \.service files/i,
  // A bus without a `login` collection (Ubuntu 24.04 wording, with curly quotes).
  /Object does not exist at path/i,
  // A locked keyring that could not be unlocked without a prompt.
  /locked collection/i,
];

type RunOutcome =
  | { kind: "exit"; code: number | null; stdout: string; stderr: string }
  | { kind: "missing" }
  | { kind: "timeout" }
  | { kind: "spawn-error"; message: string }
  | { kind: "overflow" };

/** Runs `command args...` with an optional stdin payload and a hard deadline. */
export function runBounded(
  command: string,
  args: readonly string[],
  options: { stdin?: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    // argv array, no shell: nothing in args is ever interpreted.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env });

    // SIGKILL rather than SIGTERM: a wedged client may ignore SIGTERM, and
    // secret-tool holds nothing that needs a clean shutdown. Resolve at once
    // instead of waiting for "close", which a grandchild holding the pipes
    // open could delay indefinitely.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ kind: "timeout" });
    }, options.timeoutMs);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ kind: "overflow" });
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? { kind: "missing" }
          : { kind: "spawn-error", message: error.message },
      );
    });
    child.on("close", (code) => {
      finish({
        kind: "exit",
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    // A child that exits before reading stdin makes the write fail with EPIPE;
    // the exit code reports the real problem, so the stream error is ignored.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}

function childEnv(): NodeJS.ProcessEnv {
  // secret-tool needs the session bus variables, but never our credentials.
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("HIVEMIND_")),
  );
}

export function createLibsecretStore(options: LibsecretStoreOptions = {}): CredentialStore {
  const service = options.service ?? DEFAULT_SERVICE;
  const command = options.command ?? "secret-tool";
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIBSECRET_TIMEOUT_MS;
  const env = options.env ?? childEnv();
  const attributes = (origin: string) => ["service", service, "origin", origin];

  const run = (args: string[], stdin?: string) =>
    runBounded(command, args, { stdin, timeoutMs, env });

  // Maps everything except a clean exit 0 to a typed failure.
  const toFailure = (outcome: RunOutcome, action: string): CredentialFailure | null => {
    switch (outcome.kind) {
      case "missing":
        return failure("unavailable", `${command} is not installed or not on PATH`);
      case "timeout":
        return failure("timeout", `${command} ${action} did not finish within ${timeoutMs} ms`);
      case "spawn-error":
        return failure("error", `could not run ${command}: ${outcome.message}`);
      case "overflow":
        return failure("error", `${command} ${action} produced unexpectedly large output`);
      case "exit": {
        if (outcome.code === 0) return null;
        const detail = outcome.stderr.trim();
        if (NO_SERVICE_PATTERNS.some((pattern) => pattern.test(detail))) {
          return failure("unavailable", `no Secret Service available: ${detail}`);
        }
        return failure(
          "error",
          `${command} ${action} exited with ${outcome.code}${detail ? `: ${detail}` : ""}`,
        );
      }
    }
  };

  const get = async (origin: string): Promise<GetResult | CredentialFailure> => {
    const outcome = await run(["lookup", ...attributes(origin)]);
    // secret-tool exits 1 with nothing on stderr when no item matches.
    if (outcome.kind === "exit" && outcome.code === 1 && outcome.stderr.trim() === "") {
      return { ok: true, found: false };
    }
    const failed = toFailure(outcome, "lookup");
    if (failed) return failed;
    if (outcome.kind !== "exit") return failure("error", "unexpected secret-tool outcome");
    // secret-tool prints the secret verbatim, adding a newline only on a TTY.
    const secret = outcome.stdout.replace(/\n$/, "");
    return secret === "" ? { ok: true, found: false } : { ok: true, found: true, secret };
  };

  const set = async (origin: string, secret: string): Promise<SetResult | CredentialFailure> => {
    const label = `--label=hivemind login (${origin})`;
    const outcome = await run(["store", label, ...attributes(origin)], secret);
    return toFailure(outcome, "store") ?? { ok: true };
  };

  const remove = async (origin: string): Promise<DeleteResult | CredentialFailure> => {
    // `secret-tool clear` does not say whether anything matched, so look first.
    const existing = await get(origin);
    if (!existing.ok) return existing;
    if (!existing.found) return { ok: true, deleted: false };
    const outcome = await run(["clear", ...attributes(origin)]);
    // Real secret-tool exits 1 with nothing on stderr when no item matched,
    // e.g. another process cleared it between the lookup and this call.
    if (outcome.kind === "exit" && outcome.code === 1 && outcome.stderr.trim() === "") {
      return { ok: true, deleted: false };
    }
    return toFailure(outcome, "clear") ?? { ok: true, deleted: true };
  };

  return { id: "libsecret", promptCapable: true, get, set, delete: remove };
}
