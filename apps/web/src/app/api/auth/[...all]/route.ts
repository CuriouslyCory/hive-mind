import { toNextJsHandler } from "better-auth/next-js";
import { auth, isRawApiKeyPath } from "../../../../server/auth";

// `auth` is created on the first request, so this module can be imported by
// `next build` without auth environment variables.
//
// The api-key plugin's routes are disabled in createAuth, and also answered
// here, before better-auth parses the path. That keeps every `/api-key/*`
// variant (trailing or doubled slashes, encoded slashes, other case) and any
// route a plugin upgrade adds closed until it is reviewed.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(async (request) =>
  isRawApiKeyPath(new URL(request.url).pathname)
    ? new Response("Not Found", { status: 404 })
    : auth.handler(request),
);
