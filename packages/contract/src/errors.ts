/**
 * The stable error codes of `/api/v1` and how each maps to an HTTP status and a
 * CLI exit code.
 *
 * The codes are oRPC's built-in common codes, so errors oRPC raises on its own
 * (input validation is BAD_REQUEST, output validation is INTERNAL_SERVER_ERROR)
 * already use this vocabulary. Installed CLIs branch on these strings, so a
 * code is never renamed or given a different meaning; new codes may be added,
 * and every client must treat an unknown code as a generic error (exit 1).
 */
export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL_SERVER_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** CLI process exit codes. Part of the documented CLI interface. */
export const EXIT_CODES = {
  ok: 0,
  error: 1,
  conflict: 2,
  auth: 3,
  notFound: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Status and exit code for every API error code. FORBIDDEN shares exit 3 with
 * UNAUTHORIZED: either way the caller's credential cannot do this, and a
 * script reacts the same way (use another identity or ask an owner).
 * NOT_FOUND also covers a Project the caller cannot access, so its existence
 * does not leak.
 */
export const API_ERRORS = {
  BAD_REQUEST: {
    status: 400,
    exitCode: EXIT_CODES.error,
    message: "The request is invalid.",
  },
  UNAUTHORIZED: {
    status: 401,
    exitCode: EXIT_CODES.auth,
    message: "Authentication is missing, invalid or expired.",
  },
  FORBIDDEN: {
    status: 403,
    exitCode: EXIT_CODES.auth,
    message: "The credential is not allowed to perform this operation.",
  },
  NOT_FOUND: {
    status: 404,
    exitCode: EXIT_CODES.notFound,
    message: "The resource does not exist or is not accessible.",
  },
  CONFLICT: {
    status: 409,
    exitCode: EXIT_CODES.conflict,
    message: "The request conflicts with existing data.",
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    exitCode: EXIT_CODES.error,
    message: "The request body is too large.",
  },
  INTERNAL_SERVER_ERROR: {
    status: 500,
    exitCode: EXIT_CODES.error,
    message: "The server failed to handle the request.",
  },
} as const satisfies Record<ApiErrorCode, { status: number; exitCode: ExitCode; message: string }>;

/**
 * The oRPC error map attached to every procedure in the router. It carries the
 * status and default message only; `exitCode` is a CLI concern and stays out
 * of the wire contract and the generated OpenAPI document.
 */
export const apiErrorMap = Object.fromEntries(
  API_ERROR_CODES.map((code) => [
    code,
    { status: API_ERRORS[code].status, message: API_ERRORS[code].message },
  ]),
) as { [K in ApiErrorCode]: { status: (typeof API_ERRORS)[K]["status"]; message: string } };

export function isApiErrorCode(code: string): code is ApiErrorCode {
  return Object.hasOwn(API_ERRORS, code);
}

/** HTTP status for a known code; unknown codes are server failures. */
export function httpStatusForErrorCode(code: string): number {
  return isApiErrorCode(code) ? API_ERRORS[code].status : API_ERRORS.INTERNAL_SERVER_ERROR.status;
}

/**
 * CLI exit code for an error code. Codes the CLI does not know, including its
 * own local codes such as those in `CONFIG_ERROR_CODES`, exit 1.
 */
export function exitCodeForErrorCode(code: string): ExitCode {
  return isApiErrorCode(code) ? API_ERRORS[code].exitCode : EXIT_CODES.error;
}

/**
 * Largest JSON body the server accepts on a management route (Project and key
 * creation). The server enforces it before parsing and answers
 * PAYLOAD_TOO_LARGE.
 */
export const MAX_MANAGEMENT_BODY_BYTES = 16 * 1024;
