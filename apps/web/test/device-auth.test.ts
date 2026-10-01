import { createDb } from "@hivemind/db";
import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { type TestHelpers, testUtils } from "better-auth/plugins";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_CLIENT_ID, createAuth, DEVICE_DECISION_PATHS_DISABLED } from "../src/server/auth";
import {
  type DeviceDecision,
  decideDeviceRequest,
  formatUserCode,
  isSameOriginRequest,
  normalizeUserCode,
  viewDeviceRequest,
} from "../src/server/device-approval";

// The device login (RFC 8628) end to end against a real database: the
// protocol the CLI speaks (/device/code, /device/token), and the browser
// approval that the /device page's server action performs. The page's server
// action is a thin wrapper around decideDeviceRequest, which is what these
// tests call; Next.js's own origin check is covered by the Playwright spec.

const HOST = "localhost:3000";
const ORIGIN = `http://${HOST}`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SECRET = "test-better-auth-secret-0123456789abcdef";

describe("normalizeUserCode", () => {
  it.each([
    ["ABCDEFGH", "ABCDEFGH"],
    ["abcd-efgh", "ABCDEFGH"],
    [" abcd efgh ", "ABCDEFGH"],
  ])("accepts %j as %s", (input, code) => {
    expect(normalizeUserCode(input)).toBe(code);
  });

  it.each([undefined, 42, "", "AB", "-".repeat(10), "A".repeat(33), "A".repeat(65)])(
    "rejects %j",
    (input) => {
      expect(normalizeUserCode(input)).toBeNull();
    },
  );

  it("formats an eight-character code in two groups", () => {
    expect(formatUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});

describe("isSameOriginRequest", () => {
  const request = (headers: Record<string, string>) => isSameOriginRequest(new Headers(headers));

  it("accepts a same-origin POST", () => {
    expect(request({ host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin" })).toBe(true);
    expect(request({ host: "hive.example", origin: "https://hive.example" })).toBe(true);
    // Behind Vercel's proxy, the forwarded host is the public one.
    expect(
      request({
        host: "internal:3000",
        "x-forwarded-host": "hive.example",
        origin: "https://hive.example",
      }),
    ).toBe(true);
  });

  it.each([
    ["no Origin", { host: HOST }],
    ["Origin null", { host: HOST, origin: "null" }],
    ["another origin", { host: HOST, origin: "https://evil.example" }],
    ["another port", { host: HOST, origin: "http://localhost:3001" }],
    ["a sibling subdomain", { host: "hive.example", origin: "https://evil.hive.example" }],
    ["http off loopback", { host: "hive.example", origin: "http://hive.example" }],
    ["cross-site fetch", { host: HOST, origin: ORIGIN, "sec-fetch-site": "cross-site" }],
    ["same-site fetch", { host: HOST, origin: ORIGIN, "sec-fetch-site": "same-site" }],
    ["no host", { origin: ORIGIN }],
  ])("rejects %s", (_case, headers: Record<string, string>) => {
    expect(request(headers)).toBe(false);
  });
});

describeDb("device authorization", () => {
  let testDb: TestDatabase;
  let auth: ReturnType<typeof createAuth>;
  let test: TestHelpers;

  function instance(db: TestDatabase["db"]) {
    return createAuth({
      db,
      secret: SECRET,
      github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
      oauthProxySecret: "test-oauth-proxy-secret-0123456789abcdef",
      allowedHosts: [HOST],
      plugins: [testUtils()],
    });
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    auth = instance(testDb.db);
    test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function newUser() {
    return test.saveUser(test.createUser());
  }

  /** What the browser sends with a same-origin POST, signed in as `userId`. */
  async function browserHeaders(userId: string) {
    const headers = await test.getAuthHeaders({ userId });
    headers.set("host", HOST);
    headers.set("origin", ORIGIN);
    headers.set("sec-fetch-site", "same-origin");
    return headers;
  }

  /** POST /device/code as the CLI. */
  async function startDeviceFlow(body: Record<string, unknown> = { client_id: CLI_CLIENT_ID }) {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { response, body: (await response.json()) as Record<string, unknown> };
  }

  async function deviceCode() {
    const { body } = await startDeviceFlow();
    return { deviceCode: String(body.device_code), userCode: String(body.user_code) };
  }

  /** POST /device/token as the CLI. */
  async function poll(
    code: string,
    { clientId = CLI_CLIENT_ID, via = auth }: { clientId?: string; via?: typeof auth } = {},
  ) {
    const response = await via.handler(
      new Request(`${ORIGIN}/api/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: code, client_id: clientId }),
      }),
    );
    return {
      status: response.status,
      response,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  /** Lets the next poll through the polling interval without waiting for it. */
  async function waitOutInterval(code: string) {
    await testDb.pool.query(
      "update device_code set last_polled_at = now() - interval '1 minute' where device_code = $1",
      [code],
    );
  }

  async function row(code: string) {
    const result = await testDb.pool.query<{ status: string; user_id: string | null }>(
      "select status, user_id from device_code where device_code = $1",
      [code],
    );
    return result.rows[0];
  }

  async function view(userId: string, userCode: string) {
    return viewDeviceRequest(auth, await browserHeaders(userId), userCode);
  }

  async function decide(userId: string, userCode: string, decision: DeviceDecision) {
    return decideDeviceRequest(auth, await browserHeaders(userId), userCode, decision);
  }

  describe("POST /device/code", () => {
    it("issues a code to the CLI client, uncached", async () => {
      const { response, body } = await startDeviceFlow();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({
        device_code: expect.stringMatching(/^[A-Za-z0-9]{40}$/),
        user_code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/),
        verification_uri: `${ORIGIN}/device`,
        verification_uri_complete: `${ORIGIN}/device?user_code=${String(body.user_code)}`,
        expires_in: 600,
        interval: 5,
      });
    });

    it("rejects an unknown or missing client", async () => {
      const unknown = await startDeviceFlow({ client_id: "not-the-cli" });
      expect(unknown.response.status).toBe(400);
      expect(unknown.body).toMatchObject({ error: "invalid_client" });

      const missing = await startDeviceFlow({});
      expect(missing.response.status).toBe(400);
    });
  });

  describe("POST /device/token", () => {
    it("answers authorization_pending, then slow_down when polled within the interval", async () => {
      const { deviceCode: code } = await deviceCode();

      expect(await poll(code)).toMatchObject({
        status: 400,
        body: { error: "authorization_pending" },
      });
      expect(await poll(code)).toMatchObject({ status: 400, body: { error: "slow_down" } });
      // slow_down does not restart the interval; a poll after it is pending again.
      await waitOutInterval(code);
      expect(await poll(code)).toMatchObject({
        status: 400,
        body: { error: "authorization_pending" },
      });
    });

    it("rejects an unknown device code, client or grant type", async () => {
      const { deviceCode: code } = await deviceCode();

      expect(await poll("not-a-device-code")).toMatchObject({
        status: 400,
        body: { error: "invalid_grant" },
      });
      expect(await poll(code, { clientId: "not-the-cli" })).toMatchObject({
        status: 400,
        body: { error: "invalid_grant" },
      });
      const wrongGrant = await auth.handler(
        new Request(`${ORIGIN}/api/auth/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "password",
            device_code: code,
            client_id: CLI_CLIENT_ID,
          }),
        }),
      );
      expect(wrongGrant.status).toBe(400);
      expect((await row(code))?.status).toBe("pending");
    });

    it("returns a login session token once after approval, usable as a bearer", async () => {
      const user = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();
      expect(await view(user.id, userCode)).toEqual({
        kind: "review",
        userCode,
        clientId: CLI_CLIENT_ID,
      });
      expect(await decide(user.id, userCode, "approve")).toEqual({ kind: "approved" });

      const granted = await poll(code);
      expect(granted.status).toBe(200);
      expect(granted.response.headers.get("cache-control")).toBe("no-store");
      expect(granted.body).toEqual({
        access_token: expect.any(String),
        token_type: "Bearer",
        expires_in: expect.any(Number),
        scope: "",
      });
      const token = String(granted.body.access_token);

      const loginSession = await auth.handler(
        new Request(`${ORIGIN}/api/auth/get-session`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(await loginSession.json()).toMatchObject({ user: { id: user.id } });

      // The code is consumed: polling again finds nothing.
      await waitOutInterval(code);
      expect(await poll(code)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      expect(await row(code)).toBeUndefined();
    });

    it("lets the CLI revoke its login session with POST /sign-out and the bearer token", async () => {
      const user = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();
      await view(user.id, userCode);
      await decide(user.id, userCode, "approve");
      const token = String((await poll(code)).body.access_token);
      const bearer = { authorization: `Bearer ${token}` };

      const signOut = await auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-out`, {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(signOut.status).toBe(200);
      const loginSession = await auth.handler(
        new Request(`${ORIGIN}/api/auth/get-session`, { headers: bearer }),
      );
      expect(await loginSession.json()).toBeNull();
    });

    it("redeems an approved code at most once under concurrent polling on separate connections", async () => {
      // Two app instances, each with its own pool, as two serverless
      // instances would be. Every request polls at once.
      const pools = [0, 1].map(() => new pg.Pool({ connectionString: testDb.url, max: 4 }));
      const instances = pools.map((pool) => instance(createDb(pool)));
      try {
        for (let round = 0; round < 3; round++) {
          const user = await newUser();
          const { deviceCode: code, userCode } = await deviceCode();
          await view(user.id, userCode);
          await decide(user.id, userCode, "approve");
          const before = await loginSessionCount(user.id);

          const results = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
              poll(code, { via: instances[index % instances.length] ?? auth }),
            ),
          );

          const granted = results.filter((result) => result.status === 200);
          expect(granted).toHaveLength(1);
          for (const result of results.filter((candidate) => candidate.status !== 200)) {
            expect(result.status).toBe(400);
            expect(["invalid_grant", "slow_down"]).toContain(result.body.error);
          }
          expect(await loginSessionCount(user.id)).toBe(before + 1);
        }
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
      }
    });

    async function loginSessionCount(userId: string) {
      const result = await testDb.pool.query<{ count: string }>(
        "select count(*) from session where user_id = $1",
        [userId],
      );
      return Number(result.rows[0]?.count);
    }
  });

  describe("browser approval", () => {
    it("denies: the CLI gets access_denied, then nothing", async () => {
      const user = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();
      await view(user.id, userCode);

      expect(await decide(user.id, userCode, "deny")).toEqual({ kind: "denied" });
      expect(await view(user.id, userCode)).toEqual({ kind: "decided", status: "denied" });
      expect(await poll(code)).toMatchObject({ status: 400, body: { error: "access_denied" } });
      await waitOutInterval(code);
      expect(await poll(code)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    });

    it("rejects an unknown or malformed user code", async () => {
      const user = await newUser();

      expect(await view(user.id, "BCDF-GHJK")).toEqual({ kind: "invalid" });
      expect(await view(user.id, "<script>")).toEqual({ kind: "invalid" });
      expect(await decide(user.id, "BCDF-GHJK", "approve")).toEqual({
        kind: "error",
        reason: "invalid",
      });
    });

    it("accepts the user code as typed, with a hyphen and in lowercase", async () => {
      const user = await newUser();
      const { userCode } = await deviceCode();

      const typed = formatUserCode(userCode).toLowerCase();
      expect(await view(user.id, typed)).toMatchObject({ kind: "review", userCode });
      expect(await decide(user.id, typed, "approve")).toEqual({ kind: "approved" });
    });

    it("rejects an expired code everywhere", async () => {
      const user = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();
      await view(user.id, userCode);
      await testDb.pool.query(
        "update device_code set expires_at = now() - interval '1 second' where device_code = $1",
        [code],
      );

      expect(await view(user.id, userCode)).toEqual({ kind: "expired" });
      expect(await decide(user.id, userCode, "approve")).toEqual({
        kind: "error",
        reason: "expired",
      });
      expect((await row(code))?.status).toBe("pending");
      expect(await poll(code)).toMatchObject({ status: 400, body: { error: "expired_token" } });
    });

    it("requires the code to be opened (bound) before a decision", async () => {
      const user = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();

      expect(await decide(user.id, userCode, "approve")).toEqual({
        kind: "error",
        reason: "not-reviewed",
      });
      expect(await row(code)).toEqual({ status: "pending", user_id: null });
    });

    it("never lets another User approve or deny a code someone else opened", async () => {
      const owner = await newUser();
      const other = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();
      await view(owner.id, userCode);

      expect(await view(other.id, userCode)).toEqual({ kind: "unavailable" });
      for (const decision of ["approve", "deny"] as const) {
        expect(await decide(other.id, userCode, decision)).toEqual({
          kind: "error",
          reason: "other-user",
        });
      }
      expect(await row(code)).toEqual({ status: "pending", user_id: owner.id });

      expect(await decide(owner.id, userCode, "approve")).toEqual({ kind: "approved" });
      expect(await row(code)).toEqual({ status: "approved", user_id: owner.id });
    });

    it("binds a code to only one of two Users opening it at once", async () => {
      for (let round = 0; round < 5; round++) {
        const [first, second] = await Promise.all([newUser(), newUser()]);
        const { deviceCode: code, userCode } = await deviceCode();
        const [firstHeaders, secondHeaders] = await Promise.all([
          browserHeaders(first.id),
          browserHeaders(second.id),
        ]);

        const views = await Promise.all([
          viewDeviceRequest(auth, firstHeaders, userCode),
          viewDeviceRequest(auth, secondHeaders, userCode),
        ]);

        const reviewers = [first, second].filter((_, index) => views[index]?.kind === "review");
        expect(reviewers).toHaveLength(1);
        expect(views.filter((result) => result.kind === "unavailable")).toHaveLength(1);
        expect((await row(code))?.user_id).toBe(reviewers[0]?.id);
      }
    });

    it("shows the request in both of one User's views opening a code at once", async () => {
      // Two tabs (or the CLI's link and a click on the printed one) on two
      // app instances with their own pools, so the binding writes race.
      const pools = [0, 1].map(() => new pg.Pool({ connectionString: testDb.url, max: 2 }));
      const instances = pools.map((pool) => instance(createDb(pool)));
      try {
        for (let round = 0; round < 10; round++) {
          const user = await newUser();
          const { deviceCode: code, userCode } = await deviceCode();
          const headers = await Promise.all(instances.map(() => browserHeaders(user.id)));

          const views = await Promise.all(
            instances.map((via, index) =>
              viewDeviceRequest(via, headers[index] ?? new Headers(), userCode),
            ),
          );

          expect(views.map((result) => result.kind)).toEqual(["review", "review"]);
          expect(await row(code)).toEqual({ status: "pending", user_id: user.id });
        }
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
      }
    });

    it.each([
      ["approve", "deny"],
      ["deny", "approve"],
    ] as const)("refuses %s after %s on the same code", async (first, second) => {
      const user = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();
      await view(user.id, userCode);

      expect(await decide(user.id, userCode, first)).toMatchObject({
        kind: first === "approve" ? "approved" : "denied",
      });
      expect(await decide(user.id, userCode, second)).toEqual({
        kind: "error",
        reason: "already-decided",
      });
      expect((await row(code))?.status).toBe(first === "approve" ? "approved" : "denied");
    });

    it("lets only one of a concurrent Approve and Deny succeed, and the code keeps its result", async () => {
      for (let round = 0; round < 5; round++) {
        const user = await newUser();
        const { deviceCode: code, userCode } = await deviceCode();
        await view(user.id, userCode);
        const [approveHeaders, denyHeaders] = await Promise.all([
          browserHeaders(user.id),
          browserHeaders(user.id),
        ]);

        const [approved, denied] = await Promise.all([
          decideDeviceRequest(auth, approveHeaders, userCode, "approve"),
          decideDeviceRequest(auth, denyHeaders, userCode, "deny"),
        ]);

        const outcomes = [approved, denied].filter((result) => result.kind !== "error");
        expect(outcomes).toHaveLength(1);
        const loser = approved.kind === "error" ? approved : denied;
        expect(loser).toEqual({ kind: "error", reason: "already-decided" });
        expect((await row(code))?.status).toBe(
          outcomes[0]?.kind === "approved" ? "approved" : "denied",
        );
      }
    });
  });

  describe("approval request checks", () => {
    it.each([
      ["no Origin", (headers: Headers) => headers.delete("origin")],
      ["another Origin", (headers: Headers) => headers.set("origin", "https://evil.example")],
      ["a cross-site fetch", (headers: Headers) => headers.set("sec-fetch-site", "cross-site")],
    ])("refuses a decision with %s and changes nothing", async (_case, tamper) => {
      const user = await newUser();
      const { deviceCode: code, userCode } = await deviceCode();
      await view(user.id, userCode);
      const headers = await browserHeaders(user.id);
      tamper(headers);

      expect(await decideDeviceRequest(auth, headers, userCode, "approve")).toEqual({
        kind: "error",
        reason: "cross-origin",
      });
      expect((await row(code))?.status).toBe("pending");
    });

    it("authenticates only with the cookie login session, never a bearer token", async () => {
      const user = await newUser();
      const { token } = await test.login({ userId: user.id });
      const { deviceCode: code, userCode } = await deviceCode();
      const bearerOnly = new Headers({
        host: HOST,
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
      });

      // Viewing with only a bearer token does not bind the code.
      expect(await viewDeviceRequest(auth, bearerOnly, userCode)).toEqual({
        kind: "unavailable",
      });
      expect(await row(code)).toEqual({ status: "pending", user_id: null });

      await view(user.id, userCode);
      expect(await decideDeviceRequest(auth, bearerOnly, userCode, "approve")).toEqual({
        kind: "error",
        reason: "signed-out",
      });
      expect((await row(code))?.status).toBe("pending");
    });

    it.each(DEVICE_DECISION_PATHS_DISABLED.flatMap((path) => [path, `${path}/`]))(
      "answers 404 for %s over HTTP, even with a cookie login session",
      async (path) => {
        const user = await newUser();
        const { deviceCode: code, userCode } = await deviceCode();
        await view(user.id, userCode);
        const headers = await browserHeaders(user.id);
        headers.set("content-type", "application/json");

        const response = await auth.handler(
          new Request(`${ORIGIN}/api/auth${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify({ userCode }),
          }),
        );

        expect(response.status).toBe(404);
        expect((await row(code))?.status).toBe("pending");
      },
    );
  });

  describe("bearer login session on better-auth routes", () => {
    async function getSessionWith(headers: Record<string, string>) {
      const response = await auth.handler(
        new Request(`${ORIGIN}/api/auth/get-session`, { headers }),
      );
      return (await response.json()) as { user?: { id: string } } | null;
    }

    it("does not fall back to the cookie for an unsigned invalid bearer token", async () => {
      const user = await newUser();
      const cookie = (await test.getAuthHeaders({ userId: user.id })).get("cookie") ?? "";

      expect(await getSessionWith({ cookie })).toMatchObject({ user: { id: user.id } });
      expect(await getSessionWith({ cookie, authorization: "Bearer not-a-real-token" })).toBeNull();
    });

    // Recorded for /api/v1, which removes cookies before resolving a bearer
    // principal: on better-auth's own routes, a bearer token whose signature
    // does not verify is ignored, and the request's cookie still counts.
    it("falls back to the cookie for a signed-format bearer token that does not verify", async () => {
      const user = await newUser();
      const cookie = (await test.getAuthHeaders({ userId: user.id })).get("cookie") ?? "";

      expect(
        await getSessionWith({ cookie, authorization: "Bearer forged.signature" }),
      ).toMatchObject({
        user: { id: user.id },
      });
      expect(await getSessionWith({ authorization: "Bearer forged.signature" })).toBeNull();
    });
  });
});
