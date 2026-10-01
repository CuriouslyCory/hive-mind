import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_PREFIX } from "./lib/auth-config";
import { signInPath } from "./lib/return-path";

/**
 * Sends requests without a login session cookie to `/sign-in`. It only checks
 * that the cookie exists, so it is a redirect for convenience, not access
 * control: pages call `requireLoginSession()`, and API routes answer 401 themselves.
 * The requested page goes along as a validated, same-origin return path, so
 * opening a `/device?user_code=...` link while signed out comes back to it.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
    return NextResponse.next();
  }
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), request.url));
}

export const config = {
  // Everything except the API (clients there need a 401, not a redirect),
  // Next.js internals, files with an extension, and the sign-in page itself.
  // Must be a literal: Next.js reads it at build time.
  matcher: ["/((?!api(?:/|$)|_next/|sign-in(?:/|$)|.*\\.[^/]+$).*)"],
};
