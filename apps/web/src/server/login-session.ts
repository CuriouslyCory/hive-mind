import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { signInPath } from "../lib/return-path";
import { type Auth, auth } from "./auth";

type LoginSessionResult = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/**
 * A signed-in User and their login session (a row of better-auth's `session`
 * table, not a Session; see CONTEXT.md).
 */
export interface SignedIn {
  user: LoginSessionResult["user"];
  loginSession: LoginSessionResult["session"];
}

/**
 * The current request's User and login session, or `null` when signed out.
 * Reads request headers, so with Cache Components it must run inside a
 * `<Suspense>` boundary, never in the root layout. Deduplicated per request.
 */
export const getLoginSession = cache(async (): Promise<SignedIn | null> => {
  // Read the headers before touching `auth`: during prerendering, `headers()`
  // is where rendering stops, and `auth` would read the environment.
  const requestHeaders = await headers();
  const result = await auth.api.getSession({ headers: requestHeaders });
  return result && { user: result.user, loginSession: result.session };
});

/**
 * Like `getLoginSession`, but always looks the login session up in the
 * database (`disableCookieCache`), so a revoked or expired login session is
 * refused even if a cookie cache is enabled later. Dashboard pages use it
 * (issue #11, "Authorization and transport"). Deduplicated per request only:
 * every navigation and `router.refresh()` checks again.
 */
export const getFreshLoginSession = cache(async (): Promise<SignedIn | null> => {
  const requestHeaders = await headers();
  const result = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
  return result && { user: result.user, loginSession: result.session };
});

/**
 * `requireLoginSession` with the database check of `getFreshLoginSession`.
 * Call it next to every dashboard read.
 */
export async function requireFreshLoginSession(returnPath = "/"): Promise<SignedIn> {
  const signedIn = await getFreshLoginSession();
  if (!signedIn) redirect(signInPath(returnPath));
  return signedIn;
}

/**
 * Like `getLoginSession`, but redirects to `/sign-in` when signed out, with
 * `returnPath` (validated there) as where to come back to. Call it
 * in every page and layout data read that needs a User: the proxy only checks
 * that a cookie exists, so this is the check that counts.
 *
 * `activeOrganizationId` on the login session is a UI default. Authorize
 * access to data through membership, never through it.
 */
export async function requireLoginSession(returnPath = "/"): Promise<SignedIn> {
  const signedIn = await getLoginSession();
  if (!signedIn) redirect(signInPath(returnPath));
  return signedIn;
}
