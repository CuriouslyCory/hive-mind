// Auth settings shared by the server, the browser client and the proxy. Both
// become contracts once the CLI (M1) ships, because released binaries call
// the base path and read the cookie.

/** Where better-auth's route handler is mounted. */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * Prefix of every better-auth cookie. The login session cookie is
 * `hivemind.session_token`, or `__Secure-hivemind.session_token` over HTTPS.
 */
export const AUTH_COOKIE_PREFIX = "hivemind";
