import { type ExitCode, exitCodeForErrorCode } from "@hivemind/contract";

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
  /** `login`: the device code expired before it was approved. */
  loginExpired: "LOGIN_EXPIRED",
  /** `login`: the server ended the device flow for another reason (unknown client, code already used). */
  loginFailed: "LOGIN_FAILED",
  /** `logout`: the local login was removed, but the server did not confirm it revoked the token. */
  revocationFailed: "REVOCATION_FAILED",
  /** Interrupted by the user (SIGINT/SIGTERM) or a prompt was dismissed. */
  cancelled: "CANCELLED",
  /** A bug: an exception nothing above explains. */
  internal: "INTERNAL_ERROR",
} as const;

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
