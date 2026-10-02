import { randomUUID } from "node:crypto";
import { createDb } from "@hivemind/db";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { type TestHelpers, testUtils } from "better-auth/plugins";
import type pg from "pg";
import { createAuth } from "../../src/server/auth";
import { E2E_AUTH_ENV, E2E_BASE_URL, E2E_SERVES_BUILD } from "./e2e-env";

// Fixtures shared by the browser specs. Users, their login sessions and
// organization memberships are written directly (better-auth's testUtils,
// with the app server's secret), never through GitHub. Projects and
// coordination data (Plans, Tasks, claims, Sessions, Scopes) are written only
// through the app's `/api/v1` with a bearer token, so every change writes the
// same M2 Events a CLI would.

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
  return { user, context, page: await context.newPage() };
}

/** The login session token in a signed-in context's cookie (the part before the signature). */
export async function loginSessionToken(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => /\.session_token$/.test(c.name));
  if (!cookie) throw new Error("The context has no login session cookie.");
  return decodeURIComponent(cookie.value).split(".")[0] as string;
}

/** Ends a login session, as signing out elsewhere or an administrator would. */
export async function revokeLoginSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query("delete from session where token = $1", [token]);
}

/** Adds a User to an organization (there is no invitation flow yet; ADR-0007). */
export async function addMember(pool: pg.Pool, organizationId: string, userId: string) {
  await pool.query(
    "insert into member (organization_id, user_id, role) values ($1, $2, 'member')",
    [organizationId, userId],
  );
}

export async function removeMember(pool: pg.Pool, organizationId: string, userId: string) {
  await pool.query("delete from member where organization_id = $1 and user_id = $2", [
    organizationId,
    userId,
  ]);
}

/** The User's personal organization, created with the User. */
export async function personalOrganizationId(pool: pg.Pool, userId: string): Promise<string> {
  const { rows } = await pool.query<{ organization_id: string }>(
    "select organization_id from member where user_id = $1 and role = 'owner' limit 1",
    [userId],
  );
  const id = rows[0]?.organization_id;
  if (!id) throw new Error(`User ${userId} has no personal organization.`);
  return id;
}

/** A `/api/v1` answer that was not 2xx. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: ${status} ${body}`);
  }
}

/**
 * A `/api/v1` client authenticated as `userId` with a new login session's
 * bearer token, as the CLI is after device login. Each method is one request
 * and returns the parsed JSON answer.
 */
export async function coordinationApi(users: TestHelpers, userId: string) {
  const { token } = await users.login({ userId });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${E2E_BASE_URL}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new ApiError(response.status, text, `${method} ${path}`);
    return JSON.parse(text) as T;
  }

  return {
    call,
    async createProject(organizationId: string, name: string) {
      const slug = `e2e-${randomUUID().slice(0, 12)}`;
      const { project } = await call<{ project: { id: string; name: string; slug: string } }>(
        "POST",
        "/projects",
        { organizationId, name, slug },
      );
      return project;
    },
    async startSession(
      projectId: string,
      input: {
        agent: string;
        intent: string;
        hostname?: string;
        gitBranch?: string;
        gitCommit?: string;
      },
    ) {
      const { session } = await call<{ session: { id: string } }>(
        "POST",
        `/projects/${projectId}/sessions`,
        { sessionId: randomUUID(), ...input },
      );
      return session.id;
    },
    async createPlan(
      projectId: string,
      input: { title: string; body?: string; sessionId?: string },
    ) {
      const { plan } = await call<{ plan: { id: string; key: string } }>(
        "POST",
        `/projects/${projectId}/plans`,
        { planId: randomUUID(), status: "active", ...input },
      );
      return plan;
    },
    async addTask(projectId: string, planKey: string, title: string, sessionId?: string) {
      const { task } = await call<{ task: { id: string } }>(
        "POST",
        `/projects/${projectId}/plans/${planKey}/tasks`,
        { taskId: randomUUID(), title, sessionId },
      );
      return task.id;
    },
    attach(projectId: string, sessionId: string, planRef: string, taskId?: string) {
      return call("POST", `/projects/${projectId}/sessions/${sessionId}/attach`, {
        planRef,
        taskId,
      });
    },
    claim(projectId: string, taskId: string, sessionId: string) {
      return call("POST", `/projects/${projectId}/tasks/${taskId}/claim`, { sessionId });
    },
    startTask(projectId: string, taskId: string, sessionId: string) {
      return call("POST", `/projects/${projectId}/tasks/${taskId}/start`, { sessionId });
    },
    heartbeat(projectId: string, sessionId: string, status?: "active" | "idle") {
      return call("POST", `/projects/${projectId}/sessions/${sessionId}/heartbeat`, { status });
    },
    addScope(projectId: string, sessionId: string, pattern: string) {
      return call("POST", `/projects/${projectId}/sessions/${sessionId}/scopes`, { pattern });
    },
    endSession(projectId: string, sessionId: string, summary: string) {
      return call("POST", `/projects/${projectId}/sessions/${sessionId}/end`, { summary });
    },
    appendLog(projectId: string, planKey: string, message: string, sessionId?: string) {
      return call("POST", `/projects/${projectId}/plans/${planKey}/log`, {
        eventId: randomUUID(),
        message,
        sessionId,
      });
    },
  };
}

export type CoordinationApi = Awaited<ReturnType<typeof coordinationApi>>;

/**
 * Moves focus with Tab until `target` has it, then follows it with Enter:
 * keyboard-only navigation. Fails if `target` is not reached within `limit`
 * presses.
 */
export async function followByKeyboard(page: Page, target: Locator, limit = 60) {
  await target.waitFor();
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab did not reach ${target} within ${limit} presses.`);
}

/** What hostile content tries to set when it runs. */
export const PWNED_GLOBAL = "__hivemindPwned";

/**
 * Markdown and labels that would run script, load a resource or link to a
 * `javascript:` URL if they were rendered as HTML, around formatting that
 * must stay readable.
 */
export const HOSTILE = {
  markdown: [
    "## Hostile notes",
    "",
    `<script>window.${PWNED_GLOBAL} = "script"; alert("script")</script>`,
    "",
    `<img src="x" onerror="window.${PWNED_GLOBAL} = 'img'; alert('img')">`,
    "",
    `[click me](javascript:alert(document.domain))`,
    "",
    `<a href="javascript:alert('raw')">raw link</a> <iframe src="javascript:alert('frame')"></iframe>`,
    "",
    `![tracker](https://example.com/pixel.png)`,
    "",
    "Some **safe bold** text and a [safe link](https://example.com/docs).",
  ].join("\n"),
  label: `<img src=x onerror="window.${PWNED_GLOBAL}='label'">`,
};

/** Records (and dismisses) every dialog `page` opens, so a spec can check none did. */
export function watchDialogs(page: Page): string[] {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
}

/**
 * Checks that the untrusted content rendered inside `container` is inert: no
 * script, frame, image or style element, no event-handler attribute, no link
 * other than http(s), mailto or same-origin, and nothing ran.
 */
export async function expectInert(container: Locator) {
  const report = await container.evaluate((root, global) => {
    const elements = [...root.querySelectorAll("*")];
    return {
      active: root.querySelectorAll("script, iframe, object, embed, img, style").length,
      handlers: elements.flatMap((element) =>
        [...element.attributes].filter((a) => a.name.startsWith("on")).map((a) => a.name),
      ),
      unsafeLinks: [...root.querySelectorAll("a")]
        .map((a) => a.getAttribute("href") ?? "")
        .filter((href) => !/^(https?:|mailto:|\/(?!\/))/i.test(href.trim())),
      ran: (window as unknown as Record<string, unknown>)[global] ?? null,
    };
  }, PWNED_GLOBAL);
  expect(report).toEqual({ active: 0, handlers: [], unsafeLinks: [], ran: null });
}
