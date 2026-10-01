import { toNextJsHandler } from "better-auth/next-js";
import { auth, isClosedAuthPath } from "../../../../server/auth";

// `auth` is created on the first request, so this module can be imported by
// `next build` without auth environment variables.
//
// The api-key plugin's routes, the device approve and deny routes and the
// organization routes deferred to M3 are disabled in createAuth, and also
// answered here, before better-auth parses the path. That keeps every
// spelling of them (trailing or doubled slashes, encoded slashes, dot
// segments, other case) closed whatever the router matches, and any
// `/api-key/*` route a plugin upgrade adds closed until it is reviewed.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(async (request) =>
  isClosedAuthPath(new URL(request.url).pathname)
    ? new Response("Not Found", { status: 404 })
    : auth.handler(request),
);
