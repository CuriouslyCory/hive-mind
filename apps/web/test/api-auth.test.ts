import {
  MAX_MANAGEMENT_BODY_BYTES,
  meOutputSchema,
  PROJECT_KEY_PERMISSIONS,
} from "@hivemind/contract";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as authCatchallPost } from "../src/app/api/auth/[...all]/route";
import { bearerToken } from "../src/server/api/principal";
import { createApiHandler } from "../src/server/api/router";
import { CLI_CLIENT_ID, PROJECT_KEY_PREFIX } from "../src/server/auth";
import {
  type ApiHarness,
  createApiHarness,
  errorCode,
  ORIGIN,
  type SignedInUser,
} from "./support/api";

describe("bearerToken", () => {
  it.each([
    ["Bearer abc.def", "abc.def"],
    ["bearer abc", "abc"],
    ["  Bearer abc  ", "abc"],
  ])("reads %j", (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([
    null,
    "",
    "Bearer",
    "Bearer ",
    "Basic dXNlcjpwYXNz",
    "Bearer a b",
    "Bearer a, Bearer b",
    "Bearer\tabc",
    "Bearer abcé",
  ])("rejects %j", (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe("createApiHandler without runtime configuration", () => {
  // The app's deps read the environment; requests that need neither the
  // database nor auth must not reach them (as at build time, or with no env).
  const handle = createApiHandler(() => {
    throw new Error("deps were created");
  });

  it("answers 401 to a request without a bearer token", async () => {
    const response = await handle(new Request(`${ORIGIN}/api/v1/me`));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("UNAUTHORIZED");
  });

  it("answers 413 to an oversize body before authentication", async () => {
    const response = await handle(
      new Request(`${ORIGIN}/api/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: " ".repeat(MAX_MANAGEMENT_BODY_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
  });

  it("answers 500 JSON, not a crash, when a credential needs the missing deps", async () => {
    const response = await handle(
      new Request(`${ORIGIN}/api/v1/me`, { headers: { authorization: "Bearer token" } }),
    );
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("INTERNAL_SERVER_ERROR");
  });
});

describeDb("/api/v1 authentication", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let projectId: string;

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    projectId = await api.createProject(owner);
  });

  afterAll(async () => {
    await api?.drop();
  });

  /** A cookie header for a real browser login session of `user`. */
  async function browserCookie(userId: string): Promise<string> {
    const headers = await api.test.getAuthHeaders({ userId });
    return headers.get("cookie") ?? "";
  }

  describe("without a valid credential", () => {
    it("answers 401 JSON, never a redirect", async () => {
      const response = await api.request("/me");
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("location")).toBeNull();
      expect(await errorCode(response)).toBe("UNAUTHORIZED");
    });

    it.each([
      ["a malformed header", { authorization: "Bearer" }],
      ["another scheme", { authorization: "Basic dXNlcjpwYXNz" }],
      ["two bearer tokens", { authorization: "Bearer a, Bearer b" }],
    ])("answers 401 for %s", async (_case, headers) => {
      const response = await api.request("/me", { headers });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("UNAUTHORIZED");
    });

    it("answers 401 for an unknown login session token", async () => {
      const response = await api.request("/me", { token: "not-a-login-session-token" });
      expect(response.status).toBe(401);
    });

    it("answers 401 before routing, so unknown routes do not show", async () => {
      const response = await api.request("/no-such-route");
      expect(response.status).toBe(401);
    });

    // The bearer plugin skips a token with a `.` whose signature does not
    // verify, and better-auth then reads the cookie instead; these must not
    // reach it.
    it.each([
      ["an unknown token", () => "invalid-token"],
      ["a forged signed token", () => "forged.signature"],
      ["the user's own token with a bad signature", () => `${owner.token}.bad-signature`],
    ])("ignores a valid browser cookie when the bearer token is %s", async (_case, token) => {
      const cookie = await browserCookie(owner.id);
      const response = await api.request("/me", { token: token(), headers: { cookie } });
      expect(response.status).toBe(401);
    });

    it("ignores a valid browser cookie with no bearer token (bearer only)", async () => {
      const cookie = await browserCookie(owner.id);
      const response = await api.request("/me", { headers: { cookie } });
      expect(response.status).toBe(401);
    });

    it("does not accept a Project key in x-api-key", async () => {
      const key = await api.createKey(owner, projectId);
      const response = await api.request("/me", { headers: { "x-api-key": key.secret } });
      expect(response.status).toBe(401);
    });
  });

  describe("a user login session", () => {
    it("is a user principal with organizations read from membership", async () => {
      const response = await api.request("/me", { token: owner.token });
      expect(response.status).toBe(200);
      const me = meOutputSchema.parse(await response.json());
      expect(me).toEqual({
        kind: "user",
        user: { id: owner.id, name: owner.name, email: owner.email },
        organizations: [expect.objectContaining({ id: owner.organizationId, role: "owner" })],
      });
    });

    it("works with the token the device flow hands the CLI", async () => {
      const user = await api.signUp();
      const deviceRequest = (path: string, body: unknown, cookie?: string) =>
        api.auth.handler(
          new Request(`${ORIGIN}/api/auth${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: ORIGIN,
              ...(cookie ? { cookie } : {}),
            },
            body: JSON.stringify(body),
          }),
        );
      const started = await deviceRequest("/device/code", { client_id: CLI_CLIENT_ID });
      const { device_code, user_code } = (await started.json()) as Record<string, string>;
      const cookie = await browserCookie(user.id);
      const opened = await api.auth.handler(
        new Request(`${ORIGIN}/api/auth/device?user_code=${user_code}`, {
          headers: { cookie, origin: ORIGIN },
        }),
      );
      expect(opened.status).toBe(200);
      expect((await deviceRequest("/device/approve", { userCode: user_code }, cookie)).status).toBe(
        200,
      );
      const issued = await deviceRequest("/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
        client_id: CLI_CLIENT_ID,
      });
      const { access_token } = (await issued.json()) as { access_token: string };

      const response = await api.request("/me", { token: access_token });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ kind: "user", user: { id: user.id } });
    });

    it("stops working once the login session is revoked", async () => {
      const user = await api.signUp();
      expect((await api.request("/me", { token: user.token })).status).toBe(200);
      await api.testDb.pool.query("delete from session where token = $1", [user.token]);
      expect((await api.request("/me", { token: user.token })).status).toBe(401);
    });

    it("stops working once the login session expires", async () => {
      const user = await api.signUp();
      await api.testDb.pool.query(
        "update session set expires_at = now() - interval '1 second' where token = $1",
        [user.token],
      );
      expect((await api.request("/me", { token: user.token })).status).toBe(401);
    });

    it("loses an organization on the next request after leaving it", async () => {
      const user = await api.signUp();
      await api.addMember(owner.organizationId, user.id, "member");
      const before = meOutputSchema.parse(
        await (await api.request("/me", { token: user.token })).json(),
      );
      expect(before.kind === "user" && before.organizations?.map((org) => org.id)).toEqual([
        user.organizationId,
        owner.organizationId,
      ]);

      await api.removeMember(owner.organizationId, user.id);
      const after = meOutputSchema.parse(
        await (await api.request("/me", { token: user.token })).json(),
      );
      expect(after.kind === "user" && after.organizations?.map((org) => org.id)).toEqual([
        user.organizationId,
      ]);
    });
  });

  describe("a Project key", () => {
    it("is a Project-key principal, not a user", async () => {
      const key = await api.createKey(owner, projectId);
      expect(key.secret.startsWith(PROJECT_KEY_PREFIX)).toBe(true);
      const response = await api.request("/me", { token: key.secret });
      expect(response.status).toBe(200);
      expect(meOutputSchema.parse(await response.json())).toEqual({
        kind: "projectKey",
        keyId: key.id,
        organizationId: owner.organizationId,
        projectId,
        permissions: [...PROJECT_KEY_PERMISSIONS],
      });
    });

    it("never acts as a login session on the auth API", async () => {
      const key = await api.createKey(owner, projectId);
      const response = await api.auth.handler(
        new Request(`${ORIGIN}/api/auth/get-session`, {
          headers: { authorization: `Bearer ${key.secret}` },
        }),
      );
      expect(await response.json()).toBeNull();
    });

    it("fails for an unknown key with the key prefix, without trying a login session", async () => {
      // A login session token that starts with the prefix still goes to key
      // verification, so it fails: the prefix decides the verifier.
      await api.testDb.pool.query("update session set token = $1 where token = $2", [
        `${PROJECT_KEY_PREFIX}${owner.token}`,
        owner.token,
      ]);
      try {
        const response = await api.request("/me", { token: `${PROJECT_KEY_PREFIX}${owner.token}` });
        expect(response.status).toBe(401);
      } finally {
        await api.testDb.pool.query("update session set token = $1 where token = $2", [
          owner.token,
          `${PROJECT_KEY_PREFIX}${owner.token}`,
        ]);
      }
    });

    it("fails once expired", async () => {
      const key = await api.createKey(owner, projectId, { expiresInDays: 1 });
      expect((await api.request("/me", { token: key.secret })).status).toBe(200);
      await api.testDb.pool.query(
        "update apikey set expires_at = now() - interval '1 second' where id = $1",
        [key.id],
      );
      expect((await api.request("/me", { token: key.secret })).status).toBe(401);
    });

    it("fails once revoked", async () => {
      const key = await api.createKey(owner, projectId);
      const revoked = await api.request(`/projects/${projectId}/keys/${key.id}`, {
        method: "DELETE",
        token: owner.token,
      });
      expect(revoked.status).toBe(200);
      expect((await api.request("/me", { token: key.secret })).status).toBe(401);
    });

    it("fails when disabled", async () => {
      const key = await api.createKey(owner, projectId);
      await api.testDb.pool.query("update apikey set enabled = false where id = $1", [key.id]);
      expect((await api.request("/me", { token: key.secret })).status).toBe(401);
    });

    it("fails without a Project binding", async () => {
      // A valid organization key the plugin created, as a failed issuance or
      // a direct server call could leave behind.
      const headers = new Headers({ host: new URL(ORIGIN).host });
      const unbound = await api.auth.api.createApiKey({
        headers,
        body: {
          userId: owner.id,
          organizationId: owner.organizationId,
          name: "unbound",
          remaining: null,
        },
      });
      const verified = await api.auth.api.verifyApiKey({ headers, body: { key: unbound.key } });
      expect(verified.valid).toBe(true);
      expect((await api.request("/me", { token: unbound.key })).status).toBe(401);
    });

    it("fails closed on configuration it does not expect", async () => {
      const withPermissions = await api.createKey(owner, projectId);
      await api.testDb.pool.query(
        `update apikey set permissions = '{"project":["write"]}' where id = $1`,
        [withPermissions.id],
      );
      expect((await api.request("/me", { token: withPermissions.secret })).status).toBe(401);

      const otherConfig = await api.createKey(owner, projectId);
      await api.testDb.pool.query("update apikey set config_id = 'other' where id = $1", [
        otherConfig.id,
      ]);
      expect((await api.request("/me", { token: otherConfig.secret })).status).toBe(401);
    });

    it("survives its creator leaving the organization, until revoked", async () => {
      const creator = await api.signUp();
      const creatorProject = await api.createProject(creator);
      const key = await api.createKey(creator, creatorProject);
      await api.removeMember(creator.organizationId, creator.id);

      const response = await api.request("/me", { token: key.secret });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        kind: "projectKey",
        projectId: creatorProject,
      });
    });
  });

  describe("the api-key plugin's raw routes", () => {
    const paths = ["create", "list", "get", "update", "delete", "verify"].flatMap((name) => [
      `/api/auth/api-key/${name}`,
      `/api/auth/api-key/${name}/`,
      `/api/auth/API-KEY/${name}`,
      `/api/auth/api%2Dkey/${name}`,
    ]);

    it.each(paths)("answer 404 at the auth route for %s, even for an owner", async (path) => {
      const response = await authCatchallPost(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.token}`,
            "content-type": "application/json",
            origin: ORIGIN,
          },
          body: JSON.stringify({ organizationId: owner.organizationId, name: "raw" }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it("cannot create an unbound key through better-auth either", async () => {
      const before = await api.testDb.pool.query("select count(*)::int as n from apikey");
      const response = await api.auth.handler(
        new Request(`${ORIGIN}/api/auth/api-key/create`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.token}`,
            "content-type": "application/json",
            origin: ORIGIN,
          },
          body: JSON.stringify({ organizationId: owner.organizationId, name: "raw" }),
        }),
      );
      expect(response.status).toBe(404);
      const after = await api.testDb.pool.query("select count(*)::int as n from apikey");
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });
});
