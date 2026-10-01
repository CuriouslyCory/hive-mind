import type { OriginFetch } from "./client.ts";
import type { Clock } from "./clock.ts";
import { isWellFormedToken } from "./credentials/manager.ts";
import { CLI_ERROR_CODES, CliError } from "./errors.ts";
import { registerSecret } from "./redact.ts";

/**
 * The client side of the OAuth 2.0 device authorization grant (RFC 8628)
 * against better-auth's device-authorization plugin, as the web app exposes
 * it (see ADR-0013 and apps/web/src/server/auth.ts):
 *
 * - `POST /api/auth/device/code` with `{client_id}` starts a request.
 * - `POST /api/auth/device/token` polls. Bodies are JSON, not the RFC's form
 *   encoding (the server answers form bodies with 415).
 * - The access token is a better-auth login session token, used as a bearer.
 *
 * Polling rules: wait `interval` between polls; after `slow_down` add five
 * seconds to it for every later poll; on a transport failure, a 5xx or a 429
 * back off exponentially (capped) and keep going; stop at `expires_in`; stop
 * at once on denial, expiry, an unknown code or SIGINT. Nothing is stored
 * here, so an interrupted login leaves no partial credential.
 *
 * Time and transport are parameters so tests can drive every branch with a
 * fake clock and fake responses.
 */

/** The public identifier of this CLI. It is not a secret and proves nothing. */
export const CLI_CLIENT_ID = "hivemind-cli";
export const DEVICE_CODE_PATH = "/api/auth/device/code";
export const DEVICE_TOKEN_PATH = "/api/auth/device/token";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 section 3.5: "increase the interval ... by 5 seconds". */
export const SLOW_DOWN_INCREMENT_MS = 5_000;
/** RFC 8628 section 3.2: the default when the server sends no interval. */
export const DEFAULT_INTERVAL_MS = 5_000;
/** Never poll faster than this, whatever the server says. */
export const MIN_INTERVAL_MS = 1_000;
/** Upper bound for the transport-failure backoff. */
export const MAX_BACKOFF_MS = 60_000;
/** A server cannot keep the CLI polling longer than this. */
export const MAX_EXPIRES_MS = 30 * 60_000;

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface DeviceResponse {
  status: number;
  /** Parsed JSON, or null when the body was not JSON. */
  body: unknown;
}

/**
 * Sends one JSON POST to a path on the backend origin. Transport failures are
 * `CliError`s (TIMEOUT, NETWORK_ERROR, CANCELLED, UNEXPECTED_REDIRECT), as
 * thrown by `createOriginFetch`.
 */
export type DeviceTransport = (path: string, body: unknown) => Promise<DeviceResponse>;

export function createDeviceTransport(fetch: OriginFetch): DeviceTransport {
  return async (path, body) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      return { status: response.status, body: null };
    }
  };
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  /** Where the user enters the code; always on the backend origin. */
  verificationUri: string;
  /** The same page with the code filled in, when the server sent one on our origin. */
  verificationUriComplete: string | null;
  expiresInMs: number;
  intervalMs: number;
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function oauthError(body: unknown): string | null {
  const value = field(body, "error");
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : null;
}

function invalidResponse(origin: string, what: string): CliError {
  return new CliError(
    CLI_ERROR_CODES.invalidResponse,
    `${origin} sent an unexpected response ${what}.`,
    { hint: "Check that --server or HIVEMIND_URL points at a Hive Mind backend." },
  );
}

/** `ABCD-EFGH`, the form the approval page shows. */
export function formatUserCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The URL if it is http(s) on `origin`, else null: the CLI only sends people to its own backend. */
function sameOriginUrl(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.origin === origin && url.username === "" && url.password === "" ? url.href : null;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Starts a device authorization request (RFC 8628 section 3.1). */
export async function requestDeviceCode(
  transport: DeviceTransport,
  origin: string,
): Promise<DeviceAuthorization> {
  const response = await transport(DEVICE_CODE_PATH, { client_id: CLI_CLIENT_ID });
  const { status, body } = response;
  if (status !== 200) {
    const error = oauthError(body);
    if (error === "invalid_client") {
      throw new CliError(
        CLI_ERROR_CODES.loginFailed,
        `${origin} does not accept this CLI's device login (invalid_client).`,
        { hint: "Check --server or HIVEMIND_URL, or update hivemind." },
      );
    }
    if (status >= 500) {
      throw new CliError(
        "INTERNAL_SERVER_ERROR",
        `${origin} could not start a device login (HTTP ${status}).`,
        { hint: "Try again in a moment." },
      );
    }
    throw invalidResponse(origin, `when starting a device login (HTTP ${status})`);
  }
  const deviceCode = field(body, "device_code");
  const userCode = field(body, "user_code");
  const expiresIn = seconds(field(body, "expires_in"));
  if (
    typeof deviceCode !== "string" ||
    !isWellFormedToken(deviceCode) ||
    typeof userCode !== "string" ||
    !/^[A-Za-z0-9-]{4,32}$/.test(userCode) ||
    expiresIn === null ||
    expiresIn === 0
  ) {
    throw invalidResponse(origin, "when starting a device login");
  }
  const interval = seconds(field(body, "interval"));
  // The page is built from the request's Host header on the server, so only
  // trust it when it is the origin we called; otherwise fall back to ours.
  const verificationUri =
    sameOriginUrl(field(body, "verification_uri"), origin) ?? `${origin}/device`;
  const verificationUriComplete = sameOriginUrl(field(body, "verification_uri_complete"), origin);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresInMs: Math.min(expiresIn * 1000, MAX_EXPIRES_MS),
    intervalMs: Math.max(
      interval === null ? DEFAULT_INTERVAL_MS : interval * 1000,
      MIN_INTERVAL_MS,
    ),
  };
}

export type PollEvent =
  | { type: "slow_down"; intervalMs: number }
  | { type: "retrying"; reason: string; waitMs: number };

export interface PollOptions {
  transport: DeviceTransport;
  clock: Clock;
  signal: AbortSignal;
  origin: string;
  authorization: DeviceAuthorization;
  /** Progress for stderr. */
  onEvent?: (event: PollEvent) => void;
}

export interface PollResult {
  accessToken: string;
  /** Token requests sent, for tests and diagnostics. */
  requests: number;
}

const TRANSIENT_CODES = new Set<string>([CLI_ERROR_CODES.timeout, CLI_ERROR_CODES.network]);

/**
 * Polls the token endpoint until the user approves, denies, the code expires
 * or `signal` aborts. Returns the access token (already registered for
 * redaction). Throws `CliError`: FORBIDDEN (denied, exit 3), LOGIN_EXPIRED,
 * LOGIN_FAILED, CANCELLED, INVALID_RESPONSE.
 */
export async function pollForToken(options: PollOptions): Promise<PollResult> {
  const { transport, clock, signal, origin, authorization } = options;
  const deadline = clock.now() + authorization.expiresInMs;
  // Every poll is preceded by a wait of at least the initial interval, so
  // this bound is never the binding one; it is a backstop against a clock bug.
  const maxRequests = Math.ceil(authorization.expiresInMs / authorization.intervalMs);
  let intervalMs = authorization.intervalMs;
  let failures = 0;
  let requests = 0;
  const expired = () =>
    new CliError(CLI_ERROR_CODES.loginExpired, "The login code expired before it was approved.", {
      hint: "Run 'hivemind login' again.",
    });

  for (;;) {
    const waitMs =
      failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
    if (clock.now() + waitMs > deadline || requests >= maxRequests) throw expired();
    await clock.sleep(waitMs, signal);

    requests++;
    let response: DeviceResponse;
    try {
      response = await transport(DEVICE_TOKEN_PATH, {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: authorization.deviceCode,
        client_id: CLI_CLIENT_ID,
      });
    } catch (error) {
      if (error instanceof CliError && TRANSIENT_CODES.has(error.code) && !signal.aborted) {
        failures++;
        options.onEvent?.({
          type: "retrying",
          reason: error.message,
          waitMs: Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS),
        });
        continue;
      }
      throw error;
    }

    const { status, body } = response;
    if (status === 200) {
      const token = field(body, "access_token");
      if (typeof token !== "string" || !isWellFormedToken(token)) {
        throw invalidResponse(origin, "instead of a login token");
      }
      registerSecret(token);
      return { accessToken: token, requests };
    }
    if (status >= 500 || status === 429) {
      failures++;
      options.onEvent?.({
        type: "retrying",
        reason: `HTTP ${status}`,
        waitMs: Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS),
      });
      continue;
    }
    failures = 0;
    const error = oauthError(body);
    switch (error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_INCREMENT_MS;
        options.onEvent?.({ type: "slow_down", intervalMs });
        continue;
      case "access_denied":
        throw new CliError("FORBIDDEN", "The login request was denied in the browser.", {
          hint: "Run 'hivemind login' again if that was a mistake.",
        });
      case "expired_token":
        throw expired();
      case "invalid_grant":
        throw new CliError(
          CLI_ERROR_CODES.loginFailed,
          "The server no longer recognizes this login code (it may have been used already).",
          { hint: "Run 'hivemind login' again." },
        );
      default:
        throw new CliError(
          CLI_ERROR_CODES.loginFailed,
          `${origin} ended the device login unexpectedly (HTTP ${status}${error ? `, ${error}` : ""}).`,
          { hint: "Run 'hivemind login' again; if it keeps failing, update hivemind." },
        );
    }
  }
}
