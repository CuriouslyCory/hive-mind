import { createDb } from "@hivemind/db";
import type { Browser } from "@playwright/test";
import { type TestHelpers, testUtils } from "better-auth/plugins";
import type pg from "pg";
import { createAuth } from "../../src/server/auth";
import { E2E_AUTH_ENV, E2E_BASE_URL, E2E_SERVES_BUILD } from "./e2e-env";

// Fixtures shared by the browser specs. Users and their login sessions are
// written directly (better-auth's testUtils, with the app server's secret),
// never through GitHub.

/** better-auth's test helpers on the e2e database, configured like the app server. */
export async function testUsers(pool: pg.Pool): Promise<TestHelpers> {
  const auth = createAuth({
    db: createDb(pool),
    secret: E2E_AUTH_ENV.BETTER_AUTH_SECRET,
    github: {
      clientId: E2E_AUTH_ENV.GITHUB_CLIENT_ID,
      clientSecret: E2E_AUTH_ENV.GITHUB_CLIENT_SECRET,
    },
    oauthProxySecret: E2E_AUTH_ENV.OAUTH_PROXY_SECRET,
    allowedHosts: [new URL(E2E_BASE_URL).host],
    plugins: [testUtils()],
  });
  return ((await auth.$context) as unknown as { test: TestHelpers }).test;
}

/** A new User (with their personal organization), and a page signed in as them with a login session cookie. */
export async function signedInPage(browser: Browser, users: TestHelpers) {
  const user = await users.saveUser(users.createUser());
  const cookies = await users.getCookies({
    userId: user.id,
    domain: new URL(E2E_BASE_URL).hostname,
  });
  const context = await browser.newContext();
  // Named as the app server names them, which depends on its NODE_ENV.
  await context.addCookies(
    cookies.map((cookie) => {
      const name = cookie.name.replace(/^__Secure-/, "");
      return E2E_SERVES_BUILD
        ? { ...cookie, name: `__Secure-${name}`, secure: true }
        : { ...cookie, name, secure: false };
    }),
  );
  return { user, page: await context.newPage() };
}
