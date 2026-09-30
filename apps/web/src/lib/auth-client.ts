import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { AUTH_BASE_PATH } from "./auth-config";

/**
 * The browser's better-auth client. With no `baseURL` it calls the auth API
 * on the page's own origin, so it works on every deployment.
 */
export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
  plugins: [organizationClient()],
});
