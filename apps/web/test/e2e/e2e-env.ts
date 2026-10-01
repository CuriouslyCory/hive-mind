// Values shared by playwright.config.ts (the app server's environment) and
// the specs (which sign Users in by writing login sessions directly). They
// are throwaway: the tests never reach GitHub.

export const E2E_BASE_URL = "http://localhost:3000";

/**
 * `next dev` by default; E2E_SERVER=start serves an existing `pnpm build` with
 * `next start`, as CI would. In production mode better-auth names its cookies
 * `__Secure-...` and marks them Secure, even over http on localhost.
 */
export const E2E_SERVES_BUILD = process.env.E2E_SERVER === "start";

export const E2E_AUTH_ENV = {
  BETTER_AUTH_SECRET: "e2e-better-auth-secret-not-a-real-secret",
  GITHUB_CLIENT_ID: "e2e-github-client-id",
  GITHUB_CLIENT_SECRET: "e2e-github-client-secret",
  OAUTH_PROXY_SECRET: "e2e-oauth-proxy-secret-not-a-real-secret",
};

/** The app's database for this run, set by playwright.config.ts. */
export function e2eDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set; run through playwright.config.ts.");
  return url;
}
