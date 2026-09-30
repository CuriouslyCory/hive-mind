import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../server/auth";

// `auth` is created on the first request, so this module can be imported by
// `next build` without auth environment variables.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler((request) =>
  auth.handler(request),
);
