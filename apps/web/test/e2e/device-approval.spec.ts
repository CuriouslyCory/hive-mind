import { createDb } from "@hivemind/db";
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import { type TestHelpers, testUtils } from "better-auth/plugins";
import pg from "pg";
import { CLI_CLIENT_ID, createAuth } from "../../src/server/auth";
import { E2E_AUTH_ENV, E2E_BASE_URL, E2E_SERVES_BUILD, e2eDatabaseUrl } from "./e2e-env";

// The CLI's device login in a real browser: the CLI side speaks the protocol
// over HTTP, and a signed-in browser approves or denies on /device. Users and
// their login sessions are written directly (better-auth's testUtils, with
// the app's secret), never through GitHub.

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

let pool: pg.Pool;
let users: TestHelpers;
/** The CLI: no cookies, only the device protocol. */
let cli: APIRequestContext;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
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
  users = ((await auth.$context) as unknown as { test: TestHelpers }).test;
  cli = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
});

test.afterAll(async () => {
  await cli?.dispose();
  await pool?.end();
});

/** A new User, and a page signed in as them with a login session cookie. */
async function signedInPage(browser: Browser) {
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

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const response = await cli.post("/api/auth/device/code", { data: { client_id: CLI_CLIENT_ID } });
  expect(response.status()).toBe(200);
  return (await response.json()) as DeviceCodeResponse;
}

async function pollOnce(deviceCode: string) {
  const response = await cli.post("/api/auth/device/token", {
    data: { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLI_CLIENT_ID },
  });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

/**
 * Polls as the CLI must after its first request: wait `interval` seconds
 * before each request, and five seconds more after each slow_down. Returns
 * the first answer that is neither slow_down nor authorization_pending.
 */
async function pollUntilDecided(flow: DeviceCodeResponse) {
  let interval = flow.interval;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const result = await pollOnce(flow.device_code);
    if (result.body.error === "slow_down") interval += 5;
    else if (result.body.error !== "authorization_pending") return result;
  }
  throw new Error("The device code was never approved or denied.");
}

async function storedStatus(userCode: string) {
  const result = await pool.query<{ status: string }>(
    "select status from device_code where user_code = $1",
    [userCode],
  );
  return result.rows[0]?.status;
}

/** "ABCDEFGH" as the page shows it. */
function shown(userCode: string) {
  return `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
}

/** Captures the next request the page sends that `matches`, and aborts it. */
function captureRequest(page: Page, matches: (url: URL, method: string) => boolean) {
  return new Promise<{ headers: Record<string, string>; body: Buffer }>((resolve) => {
    void page.route(
      (url) => url.origin === E2E_BASE_URL,
      async (route) => {
        const request = route.request();
        if (!matches(new URL(request.url()), request.method())) return route.continue();
        resolve({ headers: request.headers(), body: request.postDataBuffer() ?? Buffer.alloc(0) });
        return route.abort();
      },
    );
  });
}

test.describe("signed out", () => {
  test("opening the verification link leads to sign-in and back to the same code", async ({
    page,
  }) => {
    await page.goto("/device?user_code=ABCD-EFGH");
    await expect(page).toHaveURL("/sign-in?returnTo=%2Fdevice%3Fuser_code%3DABCD-EFGH");

    const signIn = captureRequest(
      page,
      (url, method) => method === "POST" && url.pathname === "/api/auth/sign-in/social",
    );
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    const { body } = await signIn;
    expect(JSON.parse(body.toString())).toMatchObject({
      provider: "github",
      callbackURL: "/device?user_code=ABCD-EFGH",
    });
  });

  for (const returnTo of [
    "//evil.example/device",
    "https://evil.example/device",
    "/\\evil.example",
  ]) {
    test(`ignores the off-site return path ${returnTo}`, async ({ page }) => {
      await page.goto(`/sign-in?${new URLSearchParams({ returnTo })}`);
      const signIn = captureRequest(
        page,
        (url, method) => method === "POST" && url.pathname === "/api/auth/sign-in/social",
      );
      await page.getByRole("button", { name: "Sign in with GitHub" }).click();
      expect(JSON.parse((await signIn).body.toString())).toMatchObject({ callbackURL: "/" });
    });
  }
});

test.describe("signed in", () => {
  test.setTimeout(60_000);

  test("approving signs the CLI in once, with a working bearer token", async ({ browser }) => {
    const { user, page } = await signedInPage(browser);
    const flow = await startDeviceFlow();
    expect(await pollOnce(flow.device_code)).toMatchObject({
      status: 400,
      body: { error: "authorization_pending" },
    });

    await page.goto(flow.verification_uri_complete);
    await expect(page.getByText(shown(flow.user_code), { exact: true })).toBeVisible();
    await expect(page.getByText(user.email, { exact: false })).toBeVisible();
    // Opening the link twice is still not consent.
    await page.reload();
    expect(await storedStatus(flow.user_code)).toBe("pending");

    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText(/Approved/);

    const granted = await pollUntilDecided(flow);
    expect(granted).toMatchObject({ status: 200, body: { token_type: "Bearer" } });
    const loginSession = await cli.get("/api/auth/get-session", {
      headers: { authorization: `Bearer ${String(granted.body.access_token)}` },
    });
    expect(await loginSession.json()).toMatchObject({ user: { id: user.id } });

    // Redeemed: the code is gone, so even an immediate poll finds nothing.
    expect(await pollOnce(flow.device_code)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
  });

  test("denying tells the CLI access_denied", async ({ browser }) => {
    const { page } = await signedInPage(browser);
    const flow = await startDeviceFlow();

    await page.goto("/device");
    await page.getByLabel("Code from your terminal").fill(shown(flow.user_code).toLowerCase());
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(shown(flow.user_code), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText(/Denied/);

    expect(await pollUntilDecided(flow)).toMatchObject({
      status: 400,
      body: { error: "access_denied" },
    });
  });

  test("another User cannot approve a code someone else opened", async ({ browser }) => {
    const owner = await signedInPage(browser);
    const other = await signedInPage(browser);
    const flow = await startDeviceFlow();

    await owner.page.goto(flow.verification_uri_complete);
    await expect(owner.page.getByRole("button", { name: "Approve" })).toBeVisible();
    await other.page.goto(flow.verification_uri_complete);

    await expect(other.page.getByRole("main").getByRole("alert")).toHaveText(
      "This code cannot be approved from this account.",
    );
    await expect(other.page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    expect(await storedStatus(flow.user_code)).toBe("pending");
  });

  test("an unknown code says so", async ({ browser }) => {
    const { page } = await signedInPage(browser);
    await page.goto("/device?user_code=BCDF-GHJK");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(/That code was not found/);
  });

  test("the Approve action refuses a cross-origin or Origin-less POST", async ({ browser }) => {
    const { page } = await signedInPage(browser);
    const flow = await startDeviceFlow();
    await page.goto(flow.verification_uri_complete);

    // The exact server action request the Approve button sends, not sent.
    const action = captureRequest(
      page,
      (url, method) => method === "POST" && url.pathname === "/device",
    );
    await page.getByRole("button", { name: "Approve" }).click();
    const { headers, body } = await action;
    expect(headers["next-action"]).toBeTruthy();
    const replayHeaders = Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => !["cookie", "content-length", "host"].includes(name),
      ),
    );
    /** Sends the captured action again with the page's cookies and `origin`. */
    async function replay(origin: string | undefined) {
      const { origin: _captured, ...rest } = replayHeaders;
      const response = await page.request.post(flow.verification_uri_complete, {
        headers: origin === undefined ? rest : { ...rest, origin },
        data: body,
        failOnStatusCode: false,
      });
      return { status: response.status(), text: await response.text() };
    }

    // Next.js rejects an action whose Origin names another host.
    const crossOrigin = await replay("https://evil.example");
    expect(crossOrigin.status).not.toBe(200);
    expect(await storedStatus(flow.user_code)).toBe("pending");

    // Next.js runs an action with no Origin at all; the action refuses it.
    const noOrigin = await replay(undefined);
    expect(noOrigin.text).toContain("cross-origin");
    expect(await storedStatus(flow.user_code)).toBe("pending");

    // The same request from the page's own origin works, so the two above
    // failed because of their origin and nothing else.
    await replay(E2E_BASE_URL);
    expect(await storedStatus(flow.user_code)).toBe("approved");
  });
});
