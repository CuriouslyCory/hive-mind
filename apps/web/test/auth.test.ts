import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import type { BetterAuthPlugin } from "better-auth";
import { type TestHelpers, testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  API_KEY_PATHS_DISABLED,
  allowedHosts,
  CLI_CLIENT_ID,
  createAuth,
  getActiveOrganization,
  isRawApiKeyPath,
  MAX_SLUG_LENGTH,
  ORGANIZATION_PATHS_DISABLED_UNTIL_M3,
  PROJECT_KEY_PREFIX,
  slugify,
  suffixedSlug,
} from "../src/server/auth";

const PRODUCTION_URL = "https://hive-mind-web.vercel.app";
/** A preview deployment's VERCEL_URL and VERCEL_BRANCH_URL. */
const PREVIEW_HOSTS = [
  "hive-mind-web-a1b2c3d4e-curiouslycorys-projects.vercel.app",
  "hive-mind-web-git-feat-login-curiouslycorys-projects.vercel.app",
];
const PREVIEW_ORIGINS = PREVIEW_HOSTS.map((host) => `https://${host}`);
const [PREVIEW_ORIGIN = ""] = PREVIEW_ORIGINS;
/** The production deployment's own VERCEL_URL, which production does not serve. */
const PRODUCTION_DEPLOYMENT_HOST = "hive-mind-web-f9e8d7c6b-curiouslycorys-projects.vercel.app";
/**
 * Another Vercel team with the slug `evil-curiouslycorys-projects` could
 * deploy this host. The old `hive-mind-*-curiouslycorys-projects.vercel.app`
 * pattern matched it.
 */
const EVIL_ORIGIN = "https://hive-mind-x-evil-curiouslycorys-projects.vercel.app";

const ENV = {
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-0123456789abcdef",
};

function unsetEnv() {
  for (const name of [
    ...Object.keys(ENV),
    "DATABASE_URL",
    "BETTER_AUTH_URL",
    "VERCEL_ENV",
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
  ]) {
    vi.stubEnv(name, undefined);
  }
}

describe("allowedHosts", () => {
  it("is only the production host in Production", () => {
    const hosts = allowedHosts({
      vercelEnv: "production",
      productionURL: PRODUCTION_URL,
      deploymentHosts: [PRODUCTION_DEPLOYMENT_HOST, "hive-mind-web-git-main.vercel.app"],
    });
    expect(hosts).toEqual(["hive-mind-web.vercel.app"]);
  });

  it("is only the deployment URL and branch alias on a preview", () => {
    const hosts = allowedHosts({
      vercelEnv: "preview",
      productionURL: PRODUCTION_URL,
      deploymentHosts: [...PREVIEW_HOSTS, undefined],
    });
    expect(hosts).toEqual(PREVIEW_HOSTS);
  });

  it.each([undefined, "development"] as const)(
    "is only localhost when VERCEL_ENV is %s",
    (vercelEnv) => {
      const hosts = allowedHosts({ vercelEnv, productionURL: PRODUCTION_URL, deploymentHosts: [] });
      expect(hosts).toEqual(["localhost:3000"]);
    },
  );

  it("fails when a Vercel deployment has no host to serve", () => {
    expect(() =>
      allowedHosts({ vercelEnv: "production", productionURL: undefined, deploymentHosts: [] }),
    ).toThrow(/VERCEL_PROJECT_PRODUCTION_URL/);
    expect(() =>
      allowedHosts({ vercelEnv: "preview", productionURL: PRODUCTION_URL, deploymentHosts: [] }),
    ).toThrow(/VERCEL_URL/);
  });
});

describe("slugify", () => {
  it.each([
    ["CuriouslyCory", "curiouslycory"],
    ["The Octocat!", "the-octocat"],
    ["--", "user"],
    ["a".repeat(50), "a".repeat(39)],
  ])("%s -> %s", (input, slug) => {
    expect(slugify(input)).toBe(slug);
  });
});

describe("suffixedSlug", () => {
  it("shortens a maximum-length base so the result fits", () => {
    const slug = suffixedSlug("a".repeat(MAX_SLUG_LENGTH), "abc123");
    expect(slug).toBe(`${"a".repeat(32)}-abc123`);
    expect(slug).toHaveLength(MAX_SLUG_LENGTH);
  });

  it("does not leave a hyphen before the separator", () => {
    // Cut at 32 characters, the base ends in a hyphen.
    expect(suffixedSlug(`${"a".repeat(31)}-bbbbbbb`, "abc123")).toBe(`${"a".repeat(31)}-abc123`);
  });

  it("keeps a short base whole", () => {
    expect(suffixedSlug("hubot", "abc123")).toBe("hubot-abc123");
  });
});

describe("the app's auth instance", () => {
  it("can be imported, with the route handler, without any environment", async () => {
    unsetEnv();
    vi.resetModules();
    const route = await import("../src/app/api/auth/[...all]/route");
    const request = new Request("http://localhost:3000/api/auth/ok");
    // The first request reads the environment and names what is missing.
    await expect(Promise.resolve().then(() => route.GET(request))).rejects.toThrow(
      /BETTER_AUTH_SECRET[\s\S]*DATABASE_URL[\s\S]*OAUTH_PROXY_SECRET/,
    );
  });

  it("answers GET /api/auth/ok", async () => {
    unsetEnv();
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    // /ok never queries, so the pool never connects.
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@127.0.0.1:1/unused");
    vi.resetModules();
    const route = await import("../src/app/api/auth/[...all]/route");

    const response = await route.GET(new Request("http://localhost:3000/api/auth/ok"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each(RAW_API_KEY_PATH_VARIANTS)(
    "answers 404 for %s before better-auth sees it",
    async (path) => {
      // No environment: had the request reached better-auth, creating the
      // instance would have thrown.
      unsetEnv();
      vi.resetModules();
      const route = await import("../src/app/api/auth/[...all]/route");
      const url = `http://localhost:3000/api/auth${path}`;

      for (const handler of [route.GET, route.POST, route.PATCH, route.PUT, route.DELETE]) {
        const response = await handler(new Request(url, { method: "POST" }));
        expect(response.status).toBe(404);
      }
    },
  );
});

/**
 * Paths that are, or that a router could normalize to, api-key plugin routes.
 * Relative to the auth base path.
 */
const RAW_API_KEY_PATH_VARIANTS = [
  ...API_KEY_PATHS_DISABLED,
  ...API_KEY_PATHS_DISABLED.map((path) => `${path}/`),
  "/api-key/create//",
  "//api-key/create",
  "/api-key//create",
  "/api-key%2Fcreate",
  "/api-key%2fcreate",
  "/api-key%252Fcreate",
  "/api-key%5Ccreate",
  "/%61pi-key/create",
  "/API-KEY/CREATE",
  "/Api-Key/list",
  "/api-key",
  "/api-key/",
  "/api-key/verify",
  "/api-key/delete-all-expired-api-keys",
  "/api-key/a-route-from-a-future-version",
  "/organization/..%2Fapi-key/create",
  "/api-key%/create",
];

describe("isRawApiKeyPath", () => {
  it.each(RAW_API_KEY_PATH_VARIANTS)("matches %s", (path) => {
    expect(isRawApiKeyPath(`/api/auth${path}`)).toBe(true);
  });

  it.each([
    "/ok",
    "/get-session",
    "/device",
    "/device/code",
    "/device/token",
    "/device/approve",
    "/organization/get-full-organization",
    "/sign-in/social",
  ])("does not match %s", (path) => {
    expect(isRawApiKeyPath(`/api/auth${path}`)).toBe(false);
  });
});

/** The routes in ORGANIZATION_PATHS_DISABLED_UNTIL_M3 that are GET, not POST. */
const GET_ROUTES = new Set([
  "/organization/get-invitation",
  "/organization/list-invitations",
  "/organization/list-user-invitations",
]);

const GITHUB_EMAIL = "round-trip@example.com";

/**
 * Stubs the GitHub endpoints better-auth's GitHub provider calls after the
 * redirect: the token exchange, the user and the user's emails. Every other
 * request goes to the real `fetch`.
 */
function mockGitHub() {
  const realFetch = globalThis.fetch;
  const calls: { url: string; body: string | undefined }[] = [];
  const responses: Record<string, unknown> = {
    "https://github.com/login/oauth/access_token": {
      access_token: "gho_fake",
      token_type: "bearer",
      scope: "read:user,user:email",
    },
    "https://api.github.com/user": {
      id: 4242,
      login: "round-trip",
      name: "Round Trip",
      email: null,
      avatar_url: "https://avatars.githubusercontent.com/u/4242",
    },
    "https://api.github.com/user/emails": [{ email: GITHUB_EMAIL, primary: true, verified: true }],
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const response = responses[url];
    if (response === undefined) return realFetch(input, init);
    calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
    return Response.json(response);
  });
  return { calls, restore: () => spy.mockRestore() };
}

/** The cookies a response sets, as a request `cookie` header. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describeDb("createAuth", () => {
  // `auth` is a preview deployment and `production` is production. Each has
  // its own database, as previews have their own database branch.
  let testDb: TestDatabase;
  let auth: ReturnType<typeof createAuth>;
  let test: TestHelpers;
  let productionDb: TestDatabase;
  let production: ReturnType<typeof createAuth>;

  function instance(
    db: TestDatabase,
    vercelEnv: "production" | "preview",
    deploymentHosts: string[],
  ) {
    return createAuth({
      db: db.db,
      secret: ENV.BETTER_AUTH_SECRET,
      github: { clientId: ENV.GITHUB_CLIENT_ID, clientSecret: ENV.GITHUB_CLIENT_SECRET },
      oauthProxySecret: ENV.OAUTH_PROXY_SECRET,
      productionURL: PRODUCTION_URL,
      allowedHosts: allowedHosts({ vercelEnv, productionURL: PRODUCTION_URL, deploymentHosts }),
      plugins: [testUtils()],
    });
  }

  beforeAll(async () => {
    [testDb, productionDb] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    auth = instance(testDb, "preview", PREVIEW_HOSTS);
    production = instance(productionDb, "production", [PRODUCTION_DEPLOYMENT_HOST]);
    test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
  });

  afterAll(async () => {
    await Promise.all([testDb?.drop(), productionDb?.drop()]);
  });

  function signInWithGitHub(origin: string, callbackURL = "/", instance = auth) {
    return instance.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ provider: "github", callbackURL }),
      }),
    );
  }

  async function organizationsOf(userId: string) {
    return testDb.db.query.member.findMany({
      where: (member, { eq }) => eq(member.userId, userId),
      with: { organization: true },
    });
  }

  /** A request to the preview's auth API, signed in as `userId`. */
  async function apiRequest(userId: string, path: string, body?: unknown) {
    const headers = await test.getAuthHeaders({ userId });
    headers.set("origin", PREVIEW_ORIGIN);
    if (body !== undefined) headers.set("content-type", "application/json");
    return auth.handler(
      new Request(`${PREVIEW_ORIGIN}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  /** The stored login session's active organization. */
  async function activeOrganizationIdOf(token: string) {
    const loginSession = await testDb.db.query.session.findFirst({
      where: (row, { eq }) => eq(row.token, token),
    });
    return loginSession?.activeOrganizationId;
  }

  describe("oAuthProxy", () => {
    it.each(PREVIEW_ORIGINS)(
      "sends GitHub to the production callback from %s",
      async (previewOrigin) => {
        const response = await signInWithGitHub(previewOrigin);
        expect(response.status).toBe(200);

        const authorize = new URL(((await response.json()) as { url: string }).url);
        expect(`${authorize.origin}${authorize.pathname}`).toBe(
          "https://github.com/login/oauth/authorize",
        );
        expect(authorize.searchParams.get("redirect_uri")).toBe(
          `${PRODUCTION_URL}/api/auth/callback/github`,
        );
      },
    );

    it.each([
      "https://hive-mind-web.evil.example",
      "https://evil.vercel.app",
      "https://hive-mind-web-a1b2c3d4e-someone-else.vercel.app",
      EVIL_ORIGIN,
      PRODUCTION_URL,
    ])("rejects requests to %s, which is not an allowed host", async (origin) => {
      // Thrown rather than answered, so Next.js responds with a 500.
      await expect(signInWithGitHub(origin)).rejects.toThrow(/not in the allowed hosts list/);
    });

    it("completes the round trip preview -> production -> preview without production trusting the preview", async () => {
      expect(production.options.baseURL).toEqual({ allowedHosts: ["hive-mind-web.vercel.app"] });

      // 1. The preview starts the sign-in and sends GitHub to production's callback.
      const signIn = await signInWithGitHub(PREVIEW_ORIGIN);
      expect(signIn.status).toBe(200);
      const authorize = new URL(((await signIn.json()) as { url: string }).url);
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        `${PRODUCTION_URL}/api/auth/callback/github`,
      );
      const state = authorize.searchParams.get("state") ?? "";

      // 2. GitHub calls production back. Production exchanges the code and
      // returns the encrypted profile to the preview.
      const github = mockGitHub();
      let callback: Response;
      try {
        callback = await production.handler(
          new Request(
            `${PRODUCTION_URL}/api/auth/callback/github?code=fake-code&state=${encodeURIComponent(state)}`,
          ),
        );
      } finally {
        github.restore();
      }
      expect(github.calls.map((call) => call.url)).toEqual([
        "https://github.com/login/oauth/access_token",
        "https://api.github.com/user",
        "https://api.github.com/user/emails",
      ]);
      const tokenRequest = new URLSearchParams(github.calls[0]?.body);
      expect(tokenRequest.get("code")).toBe("fake-code");
      expect(tokenRequest.get("redirect_uri")).toBe(`${PRODUCTION_URL}/api/auth/callback/github`);

      expect(callback.status).toBe(302);
      const proxyCallback = new URL(callback.headers.get("location") ?? "");
      expect(`${proxyCallback.origin}${proxyCallback.pathname}`).toBe(
        `${PREVIEW_ORIGIN}/api/auth/callback/github/oauth-proxy`,
      );
      expect(proxyCallback.searchParams.get("callbackURL")).toBe("/");
      expect(proxyCallback.searchParams.get("profile")).toBeTruthy();

      // 3. The preview decrypts the profile and signs the user in. It finds
      // the OAuth state in its own database; the state cookie is not checked.
      const completion = await auth.handler(new Request(proxyCallback));
      expect(completion.status).toBe(302);
      expect(completion.headers.get("location")).toBe("/");
      expect(cookieHeader(completion)).toMatch(/(^|; )hivemind\.session_token=[^;]+/);

      const user = await testDb.db.query.user.findFirst({
        where: (row, { eq }) => eq(row.email, GITHUB_EMAIL),
      });
      expect(user).toBeDefined();
      const memberships = await organizationsOf(user?.id ?? "");
      expect(memberships).toMatchObject([{ role: "owner" }]);

      // Production only relayed the profile: it stored no user and no login session.
      expect(await productionDb.db.query.user.findMany()).toEqual([]);
      expect(await productionDb.db.query.session.findMany()).toEqual([]);
    });

    it.each([
      ["production", PRODUCTION_URL],
      ["the preview", PREVIEW_ORIGIN],
    ])("%s rejects a callbackURL on an untrusted host", async (name, origin) => {
      const instance = name === "production" ? production : auth;
      const response = await signInWithGitHub(origin, `${EVIL_ORIGIN}/`, instance);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "INVALID_CALLBACK_URL" });
    });

    it("the preview rejects an oAuthProxy completion that would redirect to an untrusted host", async () => {
      const response = await auth.handler(
        new Request(
          `${PREVIEW_ORIGIN}/api/auth/callback/github/oauth-proxy?callbackURL=${encodeURIComponent(`${EVIL_ORIGIN}/`)}&profile=x`,
        ),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "INVALID_CALLBACK_URL" });
    });
  });

  describe("personal organization", () => {
    it("is created with the user as owner, and is active on a new login session", async () => {
      const user = await test.saveUser(
        test.createUser({ name: "The Octocat", githubLogin: "Octocat" }),
      );

      const memberships = await organizationsOf(user.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        role: "owner",
        organization: { name: "The Octocat", slug: "octocat" },
      });

      const { token, headers } = await test.login({ userId: user.id });
      expect(await activeOrganizationIdOf(token)).toBe(memberships[0]?.organizationId);

      // Next.js request headers always carry the host; the base URL comes from it.
      headers.set("host", PREVIEW_HOSTS[0] ?? "");
      const current = await auth.api.getSession({ headers });
      expect(current?.session.activeOrganizationId).toBe(memberships[0]?.organizationId);
    });

    it("gets a distinct slug when another user already has the login-derived one", async () => {
      const first = await test.saveUser(test.createUser({ githubLogin: "hubot" }));
      const second = await test.saveUser(test.createUser({ githubLogin: "hubot" }));

      const [firstSlug, secondSlug] = await Promise.all(
        [first, second].map(async (user) => (await organizationsOf(user.id))[0]?.organization.slug),
      );
      expect(firstSlug).toBe("hubot");
      expect(secondSlug).toMatch(/^hubot-[0-9a-f]{6}$/);
    });

    it("falls back to the name when there is no GitHub login", async () => {
      // Users created through oAuthProxy on a preview deployment have none.
      const user = await test.saveUser(test.createUser({ name: "Mona Lisa Octocat" }));
      const [membership] = await organizationsOf(user.id);
      expect(membership?.organization.slug).toBe("mona-lisa-octocat");
    });

    it("keeps a maximum-length login whole, and a suffixed slug within the limit", async () => {
      const login = "m".repeat(MAX_SLUG_LENGTH);
      const first = await test.saveUser(test.createUser({ githubLogin: login }));
      const second = await test.saveUser(test.createUser({ githubLogin: login }));

      const [firstSlug, secondSlug] = await Promise.all(
        [first, second].map(async (user) => (await organizationsOf(user.id))[0]?.organization.slug),
      );
      expect(firstSlug).toBe(login);
      expect(secondSlug).toMatch(/^m{32}-[0-9a-f]{6}$/);
      expect(secondSlug).toHaveLength(MAX_SLUG_LENGTH);
    });

    it("is created at sign-in if the user has no organization", async () => {
      const user = await test.saveUser(test.createUser({ githubLogin: "orphan" }));
      await testDb.pool.query("delete from member where user_id = $1", [user.id]);

      const { token } = await test.login({ userId: user.id });

      const [membership] = await organizationsOf(user.id);
      expect(membership?.role).toBe("owner");
      expect(await activeOrganizationIdOf(token)).toBe(membership?.organizationId);
    });

    it("is created once when first login sessions race", async () => {
      const user = await test.saveUser(test.createUser({ githubLogin: "racer" }));
      await testDb.pool.query("delete from organization where slug = 'racer'");
      expect(await organizationsOf(user.id)).toEqual([]);
      // Open the pool's connections first. Otherwise the first login takes
      // the one idle connection and finishes before the others connect.
      await Promise.all(
        Array.from({ length: 10 }, () => testDb.pool.query("select pg_sleep(0.05)")),
      );

      const logins = await Promise.all(
        Array.from({ length: 5 }, () => test.login({ userId: user.id })),
      );

      const memberships = await organizationsOf(user.id);
      expect(memberships).toMatchObject([{ role: "owner", organization: { slug: "racer" } }]);
      for (const { token } of logins) {
        expect(await activeOrganizationIdOf(token)).toBe(memberships[0]?.organizationId);
      }
    });
  });

  describe("organization API in M0", () => {
    it("does not let an owner delete their personal organization", async () => {
      const user = await test.saveUser(test.createUser({ githubLogin: "keeper" }));
      const [membership] = await organizationsOf(user.id);

      const response = await apiRequest(user.id, "/organization/delete", {
        organizationId: membership?.organizationId,
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "ORGANIZATION_DELETION_DISABLED" });
      expect(await organizationsOf(user.id)).toHaveLength(1);
    });

    it("does not let a user create an organization", async () => {
      const user = await test.saveUser(test.createUser({ githubLogin: "founder" }));

      const response = await apiRequest(user.id, "/organization/create", {
        name: "Second",
        slug: "founder-second",
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
      });
      expect(await organizationsOf(user.id)).toHaveLength(1);
    });

    it.each(ORGANIZATION_PATHS_DISABLED_UNTIL_M3)("answers 404 for %s", async (path) => {
      const user = await test.saveUser(test.createUser());
      const [membership] = await organizationsOf(user.id);

      // Use each route's own method: the router answers 404 for a wrong one.
      const response = GET_ROUTES.has(path)
        ? await apiRequest(user.id, `${path}?organizationId=${membership?.organizationId}`)
        : await apiRequest(user.id, path, {
            organizationId: membership?.organizationId,
            email: "invitee@example.com",
            role: "member",
          });

      expect(response.status).toBe(404);
    });

    it("stores no invitation when one is attempted", async () => {
      const user = await test.saveUser(test.createUser());
      const [membership] = await organizationsOf(user.id);

      await apiRequest(user.id, "/organization/invite-member", {
        organizationId: membership?.organizationId,
        email: "invitee@example.com",
        role: "member",
      });

      expect(await testDb.db.query.invitation.findMany()).toEqual([]);
    });

    it("has no team routes", async () => {
      const user = await test.saveUser(test.createUser());
      const response = await apiRequest(user.id, "/organization/create-team", { name: "Team" });
      expect(response.status).toBe(404);
    });

    it("still serves the active organization", async () => {
      const user = await test.saveUser(test.createUser({ name: "Reader", githubLogin: "reader" }));

      const response = await apiRequest(user.id, "/organization/get-full-organization");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: "Reader", slug: "reader" });
    });
  });

  describe("getActiveOrganization", () => {
    it("is the login session's active organization", async () => {
      const user = await test.saveUser(test.createUser({ name: "Active", githubLogin: "active" }));
      const headers = await test.getAuthHeaders({ userId: user.id });
      headers.set("host", PREVIEW_HOSTS[0] ?? "");

      expect(await getActiveOrganization(auth, headers)).toMatchObject({ slug: "active" });
    });

    it("is null once the user is no longer a member of it", async () => {
      const user = await test.saveUser(test.createUser({ githubLogin: "departed" }));
      const { token, headers } = await test.login({ userId: user.id });
      headers.set("host", PREVIEW_HOSTS[0] ?? "");
      await testDb.pool.query("delete from member where user_id = $1", [user.id]);

      expect(await getActiveOrganization(auth, headers)).toBeNull();
      expect(await activeOrganizationIdOf(token)).toBeNull();
    });
  });

  describe("M1 plugins", () => {
    it("are registered with nextCookies last", () => {
      const ids = (auth.options.plugins as BetterAuthPlugin[]).map((plugin) => plugin.id);
      expect(ids).toEqual([
        "organization",
        "oauth-proxy",
        "device-authorization",
        "hivemind-device-no-user-binding",
        "bearer",
        "api-key",
        "test-utils",
        "next-cookies",
      ]);
    });

    it("disable every HTTP route the api-key plugin has", () => {
      const plugin = (auth.options.plugins as BetterAuthPlugin[]).find(
        (candidate) => candidate.id === "api-key",
      );
      const paths = Object.values(plugin?.endpoints ?? {})
        .map((endpoint) => endpoint.path)
        .filter((path): path is string => typeof path === "string");
      // verifyApiKey and deleteAllExpiredApiKeys are server-only: no path.
      expect(paths.sort()).toEqual([...API_KEY_PATHS_DISABLED].sort());
      expect(auth.options.disabledPaths).toEqual(expect.arrayContaining(API_KEY_PATHS_DISABLED));
    });

    it.each(API_KEY_PATHS_DISABLED.flatMap((path) => [path, `${path}/`, `${path}//`]))(
      "answer 404 for %s from better-auth itself, for an organization owner",
      async (path) => {
        const owner = await test.saveUser(test.createUser());
        const [membership] = await organizationsOf(owner.id);
        const organizationId = membership?.organizationId;
        // A real key, so get/update/delete would find it if they were served.
        const headers = await test.getAuthHeaders({ userId: owner.id });
        headers.set("host", PREVIEW_HOSTS[0] ?? "");
        const key = await auth.api.createApiKey({
          headers,
          body: { organizationId, name: "server" },
        });

        const read = path.startsWith("/api-key/get") || path.startsWith("/api-key/list");
        const response = await apiRequest(
          owner.id,
          read ? `${path}?id=${key.id}&organizationId=${organizationId}` : path,
          read ? undefined : { organizationId, keyId: key.id, name: "raw" },
        );

        expect(response.status).toBe(404);
        const keys = await testDb.pool.query(
          "select id, name from apikey where reference_id = $1",
          [organizationId],
        );
        expect(keys.rows).toEqual([{ id: key.id, name: "server" }]);
      },
    );

    /** POST /device/code on the preview, as the unauthenticated CLI. */
    function requestDeviceCode(body: string, contentType = "application/json") {
      return auth.handler(
        new Request(`${PREVIEW_ORIGIN}/api/auth/device/code`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        }),
      );
    }

    it("start the device flow for the CLI, with bounded lifetime and polling", async () => {
      const response = await requestDeviceCode(JSON.stringify({ client_id: CLI_CLIENT_ID }));

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        verification_uri: `${PREVIEW_ORIGIN}/device`,
        expires_in: 600,
        interval: 5,
      });
      expect(body.verification_uri_complete).toBe(
        `${PREVIEW_ORIGIN}/device?user_code=${String(body.user_code)}`,
      );
    });

    it("reject a device flow from another client", async () => {
      const response = await requestDeviceCode(JSON.stringify({ client_id: "someone-else" }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    });

    it.each([
      ["JSON", JSON.stringify({ client_id: CLI_CLIENT_ID, user_id: crypto.randomUUID() })],
      ["JSON, empty", JSON.stringify({ client_id: CLI_CLIENT_ID, user_id: "" })],
    ])("reject a device code pre-bound to a user (%s)", async (_case, body) => {
      const response = await requestDeviceCode(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    });

    it("reject a device code pre-bound to a user in a form body", async () => {
      const contentType = "application/x-www-form-urlencoded";
      const accepted = await requestDeviceCode(`client_id=${CLI_CLIENT_ID}`, contentType);
      expect(accepted.status).toBe(200);

      const response = await requestDeviceCode(
        `client_id=${CLI_CLIENT_ID}&user_id=${crypto.randomUUID()}`,
        contentType,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    });

    it("let an approved device token act as a bearer login session", async () => {
      const user = await test.saveUser(test.createUser());
      const started = await requestDeviceCode(JSON.stringify({ client_id: CLI_CLIENT_ID }));
      const { device_code, user_code } = (await started.json()) as Record<string, string>;
      // Opening the code in the browser binds it to the signed-in user.
      expect((await apiRequest(user.id, `/device?user_code=${user_code}`)).status).toBe(200);
      expect((await apiRequest(user.id, "/device/approve", { userCode: user_code })).status).toBe(
        200,
      );

      const token = await auth.handler(
        new Request(`${PREVIEW_ORIGIN}/api/auth/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code,
            client_id: CLI_CLIENT_ID,
          }),
        }),
      );
      expect(token.status).toBe(200);
      const { access_token } = (await token.json()) as { access_token: string };

      const session = await auth.handler(
        new Request(`${PREVIEW_ORIGIN}/api/auth/get-session`, {
          headers: { authorization: `Bearer ${access_token}` },
        }),
      );
      expect(await session.json()).toMatchObject({ user: { id: user.id } });
    });

    it("create organization-owned, hashed, prefixed keys from server code only", async () => {
      const owner = await test.saveUser(test.createUser());
      const [membership] = await organizationsOf(owner.id);
      const headers = await test.getAuthHeaders({ userId: owner.id });
      headers.set("host", PREVIEW_HOSTS[0] ?? "");

      const created = await auth.api.createApiKey({
        headers,
        body: { organizationId: membership?.organizationId, name: "ci" },
      });

      expect(created.key.startsWith(PROJECT_KEY_PREFIX)).toBe(true);
      // `generateId: "uuid"` covers plugin tables; the contract validates key IDs as uuids.
      expect(created.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const stored = await testDb.db.query.apikey.findFirst({
        where: (row, { eq }) => eq(row.id, created.id),
      });
      expect(stored).toMatchObject({
        referenceId: membership?.organizationId,
        prefix: PROJECT_KEY_PREFIX,
        enabled: true,
        rateLimitEnabled: false,
      });
      expect(stored?.key).not.toContain(created.key.slice(PROJECT_KEY_PREFIX.length));

      // Session mocking is off: the key is not a login session.
      const keyRequests: Record<string, string>[] = [
        { "x-api-key": created.key },
        { authorization: `Bearer ${created.key}` },
      ];
      for (const keyHeaders of keyRequests) {
        const session = await auth.handler(
          new Request(`${PREVIEW_ORIGIN}/api/auth/get-session`, { headers: keyHeaders }),
        );
        expect(await session.json()).toBeNull();
      }
    });
  });

  it("does not let a user change their GitHub login", async () => {
    const user = await test.saveUser(test.createUser({ githubLogin: "mona" }));
    const headers = await test.getAuthHeaders({ userId: user.id });
    headers.set("host", PREVIEW_HOSTS[0] ?? "");

    await auth.api.updateUser({ headers, body: { githubLogin: "someone-else" } }).catch(() => {});

    const stored = await testDb.db.query.user.findFirst({
      where: (row, { eq }) => eq(row.id, user.id),
    });
    expect(stored?.githubLogin).toBe("mona");
  });
});
