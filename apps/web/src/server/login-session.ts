import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
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
 * Like `getLoginSession`, but redirects to `/sign-in` when signed out. Call it
 * in every page and layout data read that needs a User: the proxy only checks
 * that a cookie exists, so this is the check that counts.
 *
 * `activeOrganizationId` on the login session is a UI default. Authorize
 * access to data through membership, never through it.
 */
export async function requireLoginSession(): Promise<SignedIn> {
  const signedIn = await getLoginSession();
  if (!signedIn) redirect("/sign-in");
  return signedIn;
}
