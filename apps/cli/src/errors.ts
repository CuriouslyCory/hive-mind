import {
  API_ERROR_CODES,
  API_ERRORS,
  type ExitCode,
  exitCodeForErrorCode,
} from "@hivemind/contract";

/**
 * Error codes the CLI raises on its own, in addition to the API codes from
 * `@hivemind/contract` (`UNAUTHORIZED`, `CONFLICT`, `NOT_FOUND`, ...) and the
 * `.hivemind.json` codes (`CONFIG_*`). They all exit 1. A local condition that
 * belongs to another exit category reuses the API code instead of inventing a
 * new one: "not logged in" is `UNAUTHORIZED` (exit 3) and an `init` binding
 * conflict is `CONFLICT` (exit 2). That keeps one invariant for scripts: the
 * exit code is always `exitCodeForErrorCode(envelope.error.code)`.
 */
export const CLI_ERROR_CODES = {
  /** Unknown command or option, missing or malformed argument. */
  usage: "USAGE_ERROR",
  /** `--server` or `HIVEMIND_URL` is not an acceptable backend origin. */
  invalidServer: "INVALID_SERVER",
  /** The backend could not be reached (DNS, TCP, TLS). */
  network: "NETWORK_ERROR",
  /** The backend did not answer within the request timeout. */
  timeout: "TIMEOUT",
  /** The backend answered an API request with a redirect, which is never followed. */
  redirect: "UNEXPECTED_REDIRECT",
  /** The backend answered with something that is not the documented shape. */
  invalidResponse: "INVALID_RESPONSE",
  /** A credential store failed in a way that must not fall back to another store. */
  credentialStore: "CREDENTIAL_STORE_ERROR",
  /** A local file could not be read or written (other than `.hivemind.json` parse errors). */
  io: "IO_ERROR",
  /** An ADR file fails the parser (`adr status`, `adr supersede`, `adr sync`, `adr sync --check`). */
  adrInvalid: "ADR_INVALID",
  /** `login`: the device code expired before it was approved. */
  loginExpired: "LOGIN_EXPIRED",
  /** `login`: the server ended the device flow for another reason (unknown client, code already used). */
  loginFailed: "LOGIN_FAILED",
  /** `logout`: the local login was removed, but the server did not confirm it revoked the token. */
  revocationFailed: "REVOCATION_FAILED",
  /**
   * `login`/`logout` without a terminal: the stored login is kept in an OS
   * store, which only an interactive run opens. Nothing was changed.
   */
  terminalRequired: "TERMINAL_REQUIRED",
  /** Interrupted by the user (SIGINT/SIGTERM) or a prompt was dismissed. */
  cancelled: "CANCELLED",
  /** A bug: an exception nothing above explains. */
  internal: "INTERNAL_ERROR",
} as const;

/**
 * Failures that prove a request changed nothing: the server rejected it with
 * a documented 4xx code, or the CLI stopped before sending it.
 */
const DEFINITIVE_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...API_ERROR_CODES.filter((code) => API_ERRORS[code].status < 500),
  CLI_ERROR_CODES.usage,
  CLI_ERROR_CODES.invalidServer,
  CLI_ERROR_CODES.credentialStore,
  CLI_ERROR_CODES.io,
]);

/**
 * Whether a non-idempotent request may still have succeeded on the server
 * after failing with `error`. Only a definitive rejection says it did not: a
 * timeout, a lost connection, a cancel, an unreadable answer, any 5xx (a
 * gateway timeout or an output check that fails after the commit) and any
 * code the CLI does not know all leave the outcome open. Commands that create
 * something turn these into "check before rerunning".
 */
export function isUncertainOutcome(error: unknown): boolean {
  return !(isCliError(error) && DEFINITIVE_FAILURE_CODES.has(error.code));
}

export interface CliErrorOptions {
  /** The next step for the user, e.g. "Run `hivemind login`." Shown on its own line. */
  hint?: string;
  cause?: unknown;
}

/**
 * The one error type commands throw for expected failures. The shell turns it
 * into the `--json` error envelope or a human message plus hint, and exits
 * with `exitCode`, which is derived from `code` and cannot disagree with it.
 *
 * `message` and `hint` may contain server- or repository-provided text; the
 * shell escapes terminal control characters and redacts known secrets when
 * printing them, so callers do not need to.
 */
export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.hint = options.hint;
  }

  get exitCode(): ExitCode {
    return exitCodeForErrorCode(this.code);
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

/** Shorthand for the common usage error. */
export function usageError(message: string, hint?: string): CliError {
  return new CliError(CLI_ERROR_CODES.usage, message, { hint });
}
