import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { type TestHelpers, testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { allowedHosts, createAuth, slugify } from "../src/server/auth";

const PRODUCTION_URL = "https://hive-mind-web.vercel.app";
const PREVIEW_ORIGINS = [
  "https://hive-mind-web-a1b2c3d4e-curiouslycorys-projects.vercel.app",
  "https://hive-mind-web-git-feat-login-curiouslycorys-projects.vercel.app",
];

const ENV = {
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-0123456789abcdef",
};

function unsetEnv() {
  for (const name of [...Object.keys(ENV), "DATABASE_URL", "BETTER_AUTH_URL", "VERCEL_ENV"]) {
    vi.stubEnv(name, undefined);
  }
}

describe("allowedHosts", () => {
  it("lists production, the preview pattern and, outside Vercel, localhost", () => {
    expect(allowedHosts({ productionURL: PRODUCTION_URL, allowLocalDev: true })).toEqual([
      "hive-mind-web.vercel.app",
      "hive-mind-*-curiouslycorys-projects.vercel.app",
      "localhost:3000",
    ]);
    expect(allowedHosts({ productionURL: PRODUCTION_URL, allowLocalDev: false })).not.toContain(
      "localhost:3000",
    );
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
});

describeDb("createAuth", () => {
  let testDb: TestDatabase;
  let auth: ReturnType<typeof createAuth>;
  let test: TestHelpers;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    auth = createAuth({
      db: testDb.db,
      secret: ENV.BETTER_AUTH_SECRET,
      github: { clientId: ENV.GITHUB_CLIENT_ID, clientSecret: ENV.GITHUB_CLIENT_SECRET },
      oauthProxySecret: ENV.OAUTH_PROXY_SECRET,
      productionURL: PRODUCTION_URL,
      allowLocalDev: true,
      plugins: [testUtils()],
    });
    test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  function signInWithGitHub(origin: string) {
    return auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      }),
    );
  }

  async function organizationsOf(userId: string) {
    return testDb.db.query.member.findMany({
      where: (member, { eq }) => eq(member.userId, userId),
      with: { organization: true },
    });
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
    ])("rejects requests to %s, which is not an allowed host", async (origin) => {
      // Thrown rather than answered, so Next.js responds with a 500.
      await expect(signInWithGitHub(origin)).rejects.toThrow(/not in the allowed hosts list/);
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
      headers.set("host", "localhost:3000");
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

    it("is created at sign-in if the user has no organization", async () => {
      const user = await test.saveUser(test.createUser({ githubLogin: "orphan" }));
      await testDb.pool.query("delete from member where user_id = $1", [user.id]);

      const { token } = await test.login({ userId: user.id });

      const [membership] = await organizationsOf(user.id);
      expect(membership?.role).toBe("owner");
      expect(await activeOrganizationIdOf(token)).toBe(membership?.organizationId);
    });
  });

  it("does not let a user change their GitHub login", async () => {
    const user = await test.saveUser(test.createUser({ githubLogin: "mona" }));
    const headers = await test.getAuthHeaders({ userId: user.id });
    headers.set("host", "localhost:3000");

    await auth.api.updateUser({ headers, body: { githubLogin: "someone-else" } }).catch(() => {});

    const stored = await testDb.db.query.user.findFirst({
      where: (row, { eq }) => eq(row.id, user.id),
    });
    expect(stored?.githubLogin).toBe("mona");
  });
});
