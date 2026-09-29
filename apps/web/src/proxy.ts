import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_PREFIX } from "./lib/auth-config";

/**
 * Sends requests without a login session cookie to `/sign-in`. It only checks
 * that the cookie exists, so it is a redirect for convenience, not access
 * control: pages call `requireSession()`, and API routes answer 401 themselves.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL("/sign-in", request.url));
}

export const config = {
  // Everything except the API (clients there need a 401, not a redirect),
  // Next.js internals, files with an extension, and the sign-in page itself.
  // Must be a literal: Next.js reads it at build time.
  matcher: ["/((?!api(?:/|$)|_next/|sign-in(?:/|$)|.*\\.[^/]+$).*)"],
};
