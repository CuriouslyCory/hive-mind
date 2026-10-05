import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_PREFIX } from "./lib/auth-config";
import { signInPath } from "./lib/return-path";

/**
 * Routes requests by whether they carry a login session cookie. It only checks
 * that the cookie exists, so it is routing for convenience, not access
 * control: pages call `requireLoginSession()`, and API routes answer 401 themselves.
 *
 * - With the cookie, every request goes through unchanged, so `/` is the
 *   Projects list (whose own check sends a stale cookie to `/sign-in`).
 * - Without it, `/` is rewritten to the public landing page at `/welcome`: the
 *   URL stays `/`. A `/` that names a page of the Projects list (`?cursor=`)
 *   is a deep link into the signed-in area, so it is redirected like any
 *   other page instead and comes back to that page after sign-in.
 * - Without it, every other page redirects to `/sign-in`. The requested page
 *   goes along as a validated, same-origin return path, so opening a
 *   `/device?user_code=...` link while signed out comes back to it.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
    return NextResponse.next();
  }
  const { pathname, search, searchParams } = request.nextUrl;
  // `cursor` is the only search parameter the Projects list reads
  // (`apps/web/src/app/(app)/page.tsx`). Any other query, such as the
  // tracking parameters that sites add to shared links, still shows the
  // landing page.
  if (pathname === "/" && !searchParams.has("cursor")) {
    const landing = request.nextUrl.clone();
    landing.pathname = "/welcome";
    return NextResponse.rewrite(landing);
  }
  return NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), request.url));
}

export const config = {
  // Everything except the API (clients there need a 401, not a redirect),
  // Next.js internals, files with an extension, and the public pages: the
  // sign-in page and the landing page. Must be a literal: Next.js reads it
  // at build time.
  matcher: ["/((?!api(?:/|$)|_next/|sign-in(?:/|$)|welcome(?:/|$)|.*\\.[^/]+$).*)"],
};
