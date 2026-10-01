import { isAPIError } from "better-auth/api";
import type { Auth } from "./auth";

// The browser side of the CLI's device login (RFC 8628). The `/device` page
// shows a pending request to the signed-in User, and its server action
// approves or denies it through the device plugin's own approve and deny
// methods, which check that the code is pending, unexpired and bound to this
// User. Threat model:
// - Viewing a code binds it to the viewer (the plugin's `deviceVerify`), so a
//   code someone else opened first can never be approved here. Viewing never
//   approves: only a same-origin POST from the page's form does.
// - Approving signs the CLI in as this User, so a phished user code is the
//   main risk. The page shows the code to compare with the terminal, and
//   what approving grants, as text.
// - Only the browser's cookie login session counts here. A bearer token (such
//   as one an earlier CLI login received) is removed from the headers, so it
//   cannot be used to approve further device codes; the plugin's approve and
//   deny HTTP routes are disabled for the same reason (auth.ts).

/** Longest user code input accepted before normalizing. */
const MAX_USER_CODE_INPUT_LENGTH = 64;

/**
 * A user code as the plugin stores its default codes: letters and digits,
 * uppercase. Hyphens, spaces and case in what the user typed are ignored.
 * `null` for anything that cannot be a code.
 */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_USER_CODE_INPUT_LENGTH) return null;
  const code = value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null;
}

/** `ABCDEFGH` as `ABCD-EFGH`, the form the page shows and the CLI prints. */
export function formatUserCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The request's headers without `Authorization`, so only cookies authenticate. */
export function cookieOnlyHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("authorization");
  return headers;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a POST came from a page on this origin. Next.js rejects a server
 * action whose `Origin` names another host, but lets one with no `Origin`
 * through; this also refuses that, a non-same-origin `Sec-Fetch-Site`, and
 * plain http except on loopback. The host is the one Next.js compares too.
 */
export function isSameOriginRequest(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0]?.trim();
  return secure && Boolean(host) && url.host === host?.toLowerCase();
}

export type DeviceRequestView =
  /** Pending and bound to this User: show it with Approve and Deny. */
  | { kind: "review"; userCode: string; clientId: string }
  /** This User already approved or denied it. */
  | { kind: "decided"; status: "approved" | "denied" }
  /** Bound to another User, or no cookie login session. */
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "expired" };

/**
 * Looks up the device request for `rawUserCode` as the signed-in User, binding
 * a pending, unbound code to them (the plugin's `deviceVerify`). Never
 * approves.
 */
export async function viewDeviceRequest(
  auth: Auth,
  requestHeaders: Headers,
  rawUserCode: unknown,
): Promise<DeviceRequestView> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) return { kind: "invalid" };
  try {
    const request = await auth.api.deviceVerify({
      headers: cookieOnlyHeaders(requestHeaders),
      query: { user_code: userCode },
    });
    // The plugin includes the client only for the User the code is bound to.
    if (!request.client_id) return { kind: "unavailable" };
    if (request.status === "approved" || request.status === "denied") {
      return { kind: "decided", status: request.status };
    }
    if (request.status !== "pending") return { kind: "unavailable" };
    return { kind: "review", userCode, clientId: request.client_id };
  } catch (error) {
    const failure = deviceFailure(error);
    if (failure === "expired" || failure === "invalid") return { kind: failure };
    throw error;
  }
}

export type DeviceDecision = "approve" | "deny";

export type DecisionFailure =
  | "cross-origin"
  | "signed-out"
  | "invalid"
  | "expired"
  | "already-decided"
  | "not-reviewed"
  | "other-user";

export type DecisionResult =
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "error"; reason: DecisionFailure };

/**
 * Approves or denies the device request for `rawUserCode` as the signed-in
 * User. The caller is the page's server action, a public POST endpoint, so
 * everything is checked here: origin, cookie login session, then the plugin's
 * pending, expiry and same-User checks. Two decisions on one code cannot both
 * succeed (see device-code-guard.ts).
 */
export async function decideDeviceRequest(
  auth: Auth,
  requestHeaders: Headers,
  rawUserCode: unknown,
  decision: DeviceDecision,
): Promise<DecisionResult> {
  if (!isSameOriginRequest(requestHeaders)) return { kind: "error", reason: "cross-origin" };
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) return { kind: "error", reason: "invalid" };

  const headers = cookieOnlyHeaders(requestHeaders);
  if (!(await auth.api.getSession({ headers }))) return { kind: "error", reason: "signed-out" };
  try {
    if (decision === "approve") {
      await auth.api.deviceApprove({ headers, body: { userCode } });
      return { kind: "approved" };
    }
    await auth.api.deviceDeny({ headers, body: { userCode } });
    return { kind: "denied" };
  } catch (error) {
    const reason = deviceFailure(error);
    if (reason) return { kind: "error", reason };
    throw error;
  }
}

/**
 * The plugin's error for a device request, by its `error` code and, for
 * `invalid_request`, its description (better-auth 1.7.6 messages; the tests
 * pin them). `undefined` for anything else, which the caller rethrows.
 */
function deviceFailure(error: unknown): DecisionFailure | undefined {
  if (!isAPIError(error)) return undefined;
  const body: unknown = error.body;
  if (typeof body !== "object" || body === null) return undefined;
  const code = "error" in body ? body.error : undefined;
  const description = "error_description" in body ? body.error_description : undefined;
  switch (code) {
    case "expired_token":
      return "expired";
    case "access_denied":
      return "other-user";
    case "unauthorized":
      return "signed-out";
    case "invalid_request":
      if (description === "Invalid user code") return "invalid";
      if (description === "Device code already processed") return "already-decided";
      if (typeof description === "string" && description.startsWith("Device code has not been")) {
        return "not-reviewed";
      }
      return undefined;
    default:
      return undefined;
  }
}
