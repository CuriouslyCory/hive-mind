import { randomUUID } from "node:crypto";
import { expect, type Page, type Request, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { e2eDatabaseUrl } from "./e2e-env";
import {
  addMember,
  coordinationApi,
  expectInert,
  HOSTILE,
  loginSessionToken,
  personalOrganizationId,
  removeMember,
  revokeLoginSession,
  signedInPage,
  testUsers,
  watchDialogs,
} from "./support";

// Live updates on the dashboard (issue #11, step 7): real M2 mutations through
// `/api/v1` change open pages without a reload, through the real cookie Event
// stream. Transport faults come from routing the stream in the browser; access
// loss from removing a membership or a login session while a page is open.

/** Long enough for a 1-second poll, the refresh and a reconnect backoff or two. */
const LIVE = { timeout: 20_000 };

/** The browser's Event stream, for every Project. */
const STREAM = "**/api/dashboard/projects/*/events/stream";

let pool: pg.Pool;
let users: TestHelpers;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
});

test.afterAll(async () => {
  await pool?.end();
});

async function expectLive(page: Page) {
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-state", "live", LIVE);
}

/** Opens `path` and marks the document, so a spec can tell it was never reloaded. */
async function openLive(page: Page, path: string) {
  await page.goto(path);
  await expectLive(page);
  await page.evaluate(() => {
    (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
  });
}

async function expectNotReloaded(page: Page) {
  expect(
    await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
  ).toBe(true);
}

/** A User with a Project, a Session attached to an active Plan, and a Task. */
async function livePlan(browser: Parameters<typeof signedInPage>[0], agent: string) {
  const signedIn = await signedInPage(browser, users);
  const api = await coordinationApi(users, signedIn.user.id);
  const organizationId = await personalOrganizationId(pool, signedIn.user.id);
  const project = await api.createProject(organizationId, `Live ${randomUUID().slice(0, 6)}`);
  const sessionId = await api.startSession(project.id, { agent, intent: `Work as ${agent}` });
  const plan = await api.createPlan(project.id, { title: "Live plan", sessionId });
  const taskId = await api.addTask(project.id, plan.key, "Live task", sessionId);
  await api.attach(project.id, sessionId, plan.key);
  return { ...signedIn, api, organizationId, project, sessionId, plan, taskId };
}

test("a claim, heartbeat, Scope change and Session end update the open overview, Plan and Session pages", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page, api, project, sessionId, plan, taskId } = await livePlan(
    browser,
    "parser-agent",
  );
  const overviewPage = page;
  const planPage = await context.newPage();
  const sessionPage = await context.newPage();
  await openLive(overviewPage, `/projects/${project.id}`);
  await openLive(planPage, `/projects/${project.id}/plans/${plan.key}`);
  await openLive(sessionPage, `/projects/${project.id}/sessions/${sessionId}`);

  const overview = overviewPage.getByTestId("project-overview");
  const liveRow = overview
    .getByRole("table", { name: /Live Sessions/ })
    .getByRole("row")
    .filter({ hasText: "parser-agent" });
  const taskRow = planPage.getByTestId("task-row");
  const sessionDetail = sessionPage.getByTestId("session-detail");
  const sessionStatus = sessionDetail.getByRole("definition").first();
  await expect(liveRow).not.toContainText("claim");
  await expect(taskRow).toContainText("unclaimed");

  await test.step("claim", async () => {
    await api.claim(project.id, taskId, sessionId);
    await expect(liveRow).toContainText("1 claim", LIVE);
    await expect(taskRow.getByRole("link", { name: "parser-agent" })).toBeVisible(LIVE);
    await expect(
      sessionDetail.locator('[data-testid="timeline-item"][data-event-type="task.claimed"]'),
    ).toHaveCount(1, LIVE);
  });

  await test.step("start the Task", async () => {
    await api.startTask(project.id, taskId, sessionId);
    await expect(taskRow).toHaveAttribute("data-task-status", "in_progress", LIVE);
    await expect(overview.getByTestId("plan-progress")).toHaveText(
      "0 of 1 Tasks done (1 in progress)",
      LIVE,
    );
  });

  await test.step("heartbeat to idle", async () => {
    await api.heartbeat(project.id, sessionId, "idle");
    await expect(liveRow).toContainText("Idle", LIVE);
    await expect(sessionStatus).toHaveText(/Idle/, LIVE);
    await expect(
      sessionDetail.locator('[data-testid="timeline-item"][data-event-type="session.heartbeat"]'),
    ).toHaveCount(1, LIVE);
  });

  await test.step("declare a Scope", async () => {
    await api.addScope(project.id, sessionId, "src/parser/**");
    await expect(liveRow).toContainText("src/parser/**", LIVE);
    await expect(sessionDetail.getByRole("table", { name: /Scopes/ })).toContainText(
      "src/parser/**",
      LIVE,
    );
  });

  await test.step("end the Session", async () => {
    await api.endSession(project.id, sessionId, "Parsed **everything**.");
    await expect(overview).toContainText("No live Sessions.", LIVE);
    await expect(overview.getByRole("table", { name: /Ended and abandoned/ })).toContainText(
      "parser-agent",
      LIVE,
    );
    await expect(sessionStatus).toHaveText(/Ended/, LIVE);
    await expect(sessionDetail.locator("strong", { hasText: "everything" })).toBeVisible(LIVE);
    // Ending released the claim.
    await expect(taskRow).toContainText("unclaimed", LIVE);
  });

  for (const open of [overviewPage, planPage, sessionPage]) await expectNotReloaded(open);
});

test("after the stream fails, the page resumes from its cursor and converges without duplicate timeline entries", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page, api, project, sessionId } = await livePlan(browser, "flaky-agent");

  // Every connection attempt, and whether it was let through.
  const attempts: { lastEventId: string | undefined; failed: boolean }[] = [];
  let failing = false;
  await page.route(STREAM, async (route) => {
    const request: Request = route.request();
    attempts.push({ lastEventId: request.headers()["last-event-id"], failed: failing });
    if (failing) await route.abort("connectionfailed");
    else await route.continue();
  });

  const path = `/projects/${project.id}/sessions/${sessionId}`;
  await openLive(page, path);
  const detail = page.getByTestId("session-detail");
  const scopes = detail.getByRole("table", { name: /Scopes/ });
  const status = detail.getByRole("definition").first();
  const fence = attempts[0]?.lastEventId;
  expect(fence).toBeTruthy();

  // One change while connected, so the cursor moves past the fence.
  await api.addScope(project.id, sessionId, "src/before/**");
  await expect(scopes).toContainText("src/before/**", LIVE);

  // Disconnect: going offline closes the stream, and every reconnect fails.
  failing = true;
  await context.setOffline(true);
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-state", "offline", LIVE);
  await api.addScope(project.id, sessionId, "src/offline/**");
  await context.setOffline(false);
  await expect.poll(() => attempts.filter((a) => a.failed).length, LIVE).toBeGreaterThan(0);
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-state", "reconnecting", LIVE);
  await api.heartbeat(project.id, sessionId, "idle");
  await api.addScope(project.id, sessionId, "src/failing/**");

  // Let the next attempt through: it resumes from the processed cursor.
  failing = false;
  await expectLive(page);
  for (const pattern of ["src/before/**", "src/offline/**", "src/failing/**"]) {
    await expect(scopes).toContainText(pattern, LIVE);
  }
  await expect(status).toHaveText(/Idle/, LIVE);
  const resumed = attempts.filter((a) => !a.failed).at(-1);
  expect(attempts.length).toBeGreaterThan(2);
  expect(resumed?.lastEventId).toBeTruthy();
  expect(resumed?.lastEventId).not.toBe(fence);
  await expectNotReloaded(page);

  // The timeline the live page converged to is the one a fresh read renders:
  // no Event twice, none missing.
  const timeline = detail.getByTestId("timeline-item");
  const types = () => timeline.evaluateAll((items) => items.map((i) => i.dataset.eventType));
  await expect
    .poll(async () => (await types()).filter((type) => type === "scope.added").length, LIVE)
    .toBe(3);
  const live = await types();
  expect(live.filter((type) => type === "session.heartbeat")).toHaveLength(1);
  await page.reload();
  await expectLive(page);
  await expect(timeline.first()).toBeVisible();
  expect(await types()).toEqual(live);
});

test("removing the viewer's membership hides the open Project", async ({ browser }) => {
  const owner = await livePlan(browser, "owner-agent");
  await owner.page.close();
  const { user, page } = await signedInPage(browser, users);
  await addMember(pool, owner.organizationId, user.id);

  await openLive(page, `/projects/${owner.project.id}`);
  await expect(page.getByTestId("project-overview")).toContainText("owner-agent");

  await removeMember(pool, owner.organizationId, user.id);
  await expect(page.getByTestId("project-access-lost")).toBeVisible(LIVE);
  await expect(page.getByTestId("project-access-lost")).toContainText(
    "You no longer have access to this Project",
  );
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-state", "access-lost");
  await expect(page.getByTestId("project-overview")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("owner-agent");
  await expect(page.locator("body")).not.toContainText(owner.project.name);

  // It stays hidden: a later change is not delivered, and a fresh navigation is not found.
  await owner.api.addScope(owner.project.id, owner.sessionId, "src/after-removal/**");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("src/after-removal/**");
});

test("revoking the viewer's login session hides the open Project", async ({ browser }) => {
  const { context, page, project, sessionId } = await livePlan(browser, "revoked-agent");
  const path = `/projects/${project.id}/sessions/${sessionId}`;
  await openLive(page, path);

  await revokeLoginSession(pool, await loginSessionToken(context));
  await expect(page.getByTestId("project-access-lost")).toContainText(
    "Your sign-in has ended",
    LIVE,
  );
  await expect(page.getByTestId("session-detail")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("revoked-agent");

  await page.reload();
  await expect(page).toHaveURL(`/sign-in?${new URLSearchParams({ returnTo: path })}`);
});

test("Back after losing access does not show a page rendered before the loss", async ({
  browser,
}) => {
  const { context, page, project, plan } = await livePlan(browser, "kept-agent");
  await openLive(page, `/projects/${project.id}`);
  await expect(page.getByTestId("project-overview")).toContainText("kept-agent");
  await page.locator(`a[href="/projects/${project.id}/plans/${plan.key}"]`).first().click();
  await expect(page.getByTestId("plan-detail")).toBeVisible();
  await expectLive(page);

  await revokeLoginSession(pool, await loginSessionToken(context));
  await expect(page.getByTestId("project-access-lost")).toContainText(
    "Your sign-in has ended",
    LIVE,
  );

  // Back shows the overview Next kept from before the loss, without a server
  // render. Record whether it is ever put back in the document.
  await page.evaluate(() => {
    const state = window as unknown as { __overviewShown?: boolean };
    state.__overviewShown = false;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('[data-testid="project-overview"]') ||
              node.querySelector('[data-testid="project-overview"]'))
          ) {
            state.__overviewShown = true;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const recheck = page.waitForResponse(
    (response) => response.url().includes("/events/stream") && response.status() === 401,
    LIVE,
  );
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}`);
  await recheck;

  await expect(page.getByTestId("project-access-lost")).toContainText("Your sign-in has ended");
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-state", "access-lost");
  await expect(page.getByTestId("project-overview")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __overviewShown?: boolean }).__overviewShown),
  ).toBe(false);
  await expectNotReloaded(page);
});

test("hostile text that arrives live stays inert, then and after a reload", async ({ browser }) => {
  const { page, api, project, sessionId, plan } = await livePlan(browser, "hostile-live-agent");
  const dialogs = watchDialogs(page);
  await openLive(page, `/projects/${project.id}/plans/${plan.key}`);
  const detail = page.getByTestId("plan-detail");

  await api.appendLog(project.id, plan.key, HOSTILE.markdown, sessionId);
  await api.addTask(project.id, plan.key, HOSTILE.label, sessionId);
  const logEntry = detail.locator(
    '[data-testid="timeline-item"][data-event-type="plan.log_appended"]',
  );
  await expect(logEntry.locator("strong", { hasText: "safe bold" })).toBeVisible(LIVE);
  await expect(detail.getByTestId("task-row").getByText(HOSTILE.label)).toBeVisible(LIVE);
  await expect(logEntry.getByText("click me")).toBeVisible();
  await expectInert(detail);
  await expectNotReloaded(page);

  await page.reload();
  await expectLive(page);
  await expect(logEntry.locator("strong", { hasText: "safe bold" })).toBeVisible();
  await expect(logEntry.getByRole("link", { name: "safe link" })).toHaveAttribute(
    "href",
    "https://example.com/docs",
  );
  await expectInert(detail);
  expect(dialogs).toEqual([]);
});
