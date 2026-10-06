import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { e2eDatabaseUrl } from "./e2e-env";
import {
  canary,
  coordinationApi,
  expectInert,
  followByKeyboard,
  HOSTILE,
  insertFutureEvent,
  organizationName,
  personalOrganizationId,
  signedInPage,
  testUsers,
  watchDialogs,
} from "./support";

// The dashboard's pages, rendered from real M2 data (issue #11, step 7):
// keyboard navigation through `/` → Project → Plan → Session, empty states,
// one not-found answer for everything a User cannot read, the sign-in
// redirect, and untrusted markdown and labels staying inert. Live updates are
// in dashboard-live.spec.ts. Events written by a newer deployment render as
// unavailable, without their details (issue #15).

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let pool: pg.Pool;
let users: TestHelpers;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
});

test.afterAll(async () => {
  await pool?.end();
});

/** Waits for the Project page's subscription to be live, so it renders from the server. */
async function expectLive(page: Page) {
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-state", "live", {
    timeout: 20_000,
  });
}

/** The "Not found" page, and none of the Project's pages. */
async function expectNotFound(page: Page, secrets: string[]) {
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  for (const testId of ["project-overview", "plan-detail", "session-detail"]) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
  const body = page.locator("body");
  for (const secret of secrets) await expect(body).not.toContainText(secret);
}

test("a Member follows / → Project → Plan → Session by keyboard and sees each page's fields", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const project = await api.createProject(organizationId, `Dashboard ${randomUUID().slice(0, 6)}`);
  const sessionId = await api.startSession(project.id, {
    agent: "lexer-agent",
    intent: "Rewrite the lexer",
    hostname: "build-box-1",
    gitBranch: "feat/lexer",
    gitCommit: COMMIT,
  });
  const plan = await api.createPlan(project.id, {
    title: "Lexer rewrite",
    body: "## Goal\n\nShip a **faster** lexer. See [the notes](https://example.com/lexer).\n",
    sessionId,
  });
  const first = await api.addTask(project.id, plan.key, "Tokenize identifiers", sessionId);
  await api.addTask(project.id, plan.key, "Tokenize numbers", sessionId);
  await api.attach(project.id, sessionId, plan.key, first);
  await api.claim(project.id, first, sessionId);
  await api.startTask(project.id, first, sessionId);
  await api.addScope(project.id, sessionId, "src/lexer/**");
  const emptyPlan = await api.createPlan(project.id, { title: "Nothing here yet" });

  // `/`: the home page's rail lists the User's Projects, each under its
  // Organization's name. Choosing one scopes the page to it, and Open
  // Project leads to the Project overview.
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Projects" });
  const projectLink = rail.getByRole("link").filter({ hasText: project.name });
  await expect(projectLink).toContainText(await organizationName(pool, organizationId));
  await followByKeyboard(page, projectLink);
  await expect(page).toHaveURL(`/?project=${project.id}`);
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  await followByKeyboard(page, page.getByRole("link", { name: "Open Project" }));

  // The Project overview.
  await expect(page).toHaveURL(`/projects/${project.id}`);
  const overview = page.getByTestId("project-overview");
  await expect(overview.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  await expectLive(page);
  const planRow = overview.getByRole("row").filter({ hasText: `${plan.key}: Lexer rewrite` });
  await expect(planRow.getByTestId("plan-progress")).toHaveText(
    "0 of 2 Tasks done (1 in progress, 1 to do)",
  );
  await expect(
    overview.getByRole("row").filter({ hasText: `${emptyPlan.key}: Nothing here yet` }),
  ).toContainText("No Tasks yet");
  const sessionRow = overview
    .getByRole("table", { name: /Live Sessions/ })
    .getByRole("row")
    .filter({ hasText: "lexer-agent" });
  for (const text of [
    "Rewrite the lexer",
    "Active",
    user.name,
    "build-box-1",
    "feat/lexer",
    plan.key,
    "Tokenize identifiers",
    "1 claim",
    "src/lexer/**",
  ]) {
    await expect(sessionRow).toContainText(text);
  }
  await expect(overview).toContainText("No overlaps.");
  await expect(overview).toContainText("No ended or abandoned Sessions.");
  await followByKeyboard(page, planRow.getByRole("link", { name: `${plan.key}: Lexer rewrite` }));

  // The Plan.
  await expect(page).toHaveURL(`/projects/${project.id}/plans/${plan.key}`);
  const planPage = page.getByTestId("plan-detail");
  await expect(planPage.getByRole("heading", { level: 1 })).toHaveText(
    `${plan.key}: Lexer rewrite`,
  );
  await expect(planPage.getByRole("link", { name: project.name })).toBeVisible();
  const facts = planPage.getByRole("definition");
  await expect(facts.nth(0)).toContainText("Active");
  await expect(facts.nth(1)).toContainText("0 of 2 Tasks done");
  await expect(facts.nth(2)).toContainText(user.name);
  // The body as sanitized markdown, its heading shifted below the page's.
  await expect(planPage.getByRole("heading", { name: "Goal" })).toBeVisible();
  await expect(planPage.locator("strong", { hasText: "faster" })).toBeVisible();
  await expect(planPage.getByRole("link", { name: "the notes" })).toHaveAttribute(
    "href",
    "https://example.com/lexer",
  );
  const tasks = planPage.getByTestId("task-row");
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toHaveAttribute("data-task-status", "in_progress");
  await expect(tasks.nth(0)).toContainText("Tokenize identifiers");
  await expect(tasks.nth(0)).toContainText("In progress");
  await expect(tasks.nth(0)).toContainText("lexer-agent");
  await expect(tasks.nth(1)).toHaveAttribute("data-task-status", "todo");
  await expect(tasks.nth(1)).toContainText("unclaimed");
  await expect(
    planPage.getByRole("table", { name: /Sessions attached to this Plan/ }),
  ).toContainText("lexer-agent");
  const activity = planPage.getByTestId("timeline-item");
  for (const type of ["plan.created", "task.added", "task.claimed", "task.started"]) {
    await expect(activity.and(page.locator(`[data-event-type="${type}"]`)).first()).toBeVisible();
  }
  await followByKeyboard(page, tasks.nth(0).getByRole("link", { name: "lexer-agent" }));

  // The Session.
  await expect(page).toHaveURL(`/projects/${project.id}/sessions/${sessionId}`);
  const sessionPage = page.getByTestId("session-detail");
  await expect(sessionPage.getByRole("heading", { level: 1 })).toHaveText("Session: lexer-agent");
  await expect(sessionPage).toContainText("Rewrite the lexer");
  const sessionFacts = sessionPage.getByRole("definition");
  await expect(sessionFacts.nth(0)).toContainText("Active");
  await expect(sessionFacts.nth(1)).toContainText(user.name);
  await expect(sessionFacts.nth(2)).toHaveText("build-box-1");
  await expect(sessionFacts.nth(3)).toHaveText(`feat/lexer at ${COMMIT.slice(0, 12)}`);
  await expect(sessionFacts.nth(4)).toContainText(`${plan.key}, Task`);
  await expect(sessionFacts.nth(4)).toContainText("Tokenize identifiers");
  await expect(sessionPage).toContainText("The Session has not ended.");
  await expect(sessionPage.getByRole("table", { name: /Scopes/ })).toContainText("src/lexer/**");
  await expect(sessionPage.getByRole("table", { name: /Scopes/ })).toContainText("Declared");
  const timeline = sessionPage.getByTestId("timeline-item");
  for (const type of ["session.started", "session.attached", "scope.added"]) {
    await expect(timeline.and(page.locator(`[data-event-type="${type}"]`)).first()).toBeVisible();
  }

  // A Plan with nothing in it says so.
  await page.goto(`/projects/${project.id}/plans/${emptyPlan.key}`);
  const empty = page.getByTestId("plan-detail");
  await expect(empty).toContainText("No description.");
  await expect(empty).toContainText("No Tasks yet.");
  await expect(empty).toContainText("No Sessions are attached to this Plan.");
});

test("a User with no Projects is told how to create one, and an empty Project says what it lacks", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  await page.goto("/");
  await expect(page.getByRole("main")).toContainText("You have no Projects yet.");
  await expect(page.getByRole("main").locator("code", { hasText: "hivemind init" })).toBeVisible();

  const api = await coordinationApi(users, user.id);
  const project = await api.createProject(
    await personalOrganizationId(pool, user.id),
    "Empty project",
  );
  await page.reload();
  await page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("link")
    .filter({ hasText: "Empty project" })
    .click();
  await expect(page).toHaveURL(`/?project=${project.id}`);
  await page.getByRole("link", { name: "Open Project" }).click();
  const overview = page.getByTestId("project-overview");
  for (const text of [
    "No active Plans.",
    "No overlaps.",
    "No live Sessions.",
    "No ended or abandoned Sessions.",
  ]) {
    await expect(overview).toContainText(text);
  }
  await expect(page).toHaveURL(`/projects/${project.id}`);
});

test("another User's Project, another Project's Plan and Session, and bogus ids all show the same not-found page", async ({
  browser,
}) => {
  const owner = await signedInPage(browser, users);
  const ownerApi = await coordinationApi(users, owner.user.id);
  const secretProject = await ownerApi.createProject(
    await personalOrganizationId(pool, owner.user.id),
    "Secret project",
  );
  const secretSession = await ownerApi.startSession(secretProject.id, {
    agent: "secret-agent",
    intent: "Secret intent",
  });
  const secretPlan = await ownerApi.createPlan(secretProject.id, {
    title: "Secret plan alpha",
    body: "Secret plan body",
    sessionId: secretSession,
  });
  await owner.page.close();

  // The viewer's own Project has no Plans or Sessions.
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const own = await api.createProject(await personalOrganizationId(pool, user.id), "Own project");
  const secrets = ["Secret project", "Secret plan", "secret-agent", "Secret intent"];

  for (const path of [
    `/projects/${secretProject.id}`,
    `/projects/${secretProject.id}/plans/${secretPlan.key}`,
    `/projects/${secretProject.id}/sessions/${secretSession}`,
    `/projects/${own.id}/plans/${secretPlan.key}`,
    `/projects/${own.id}/plans/${secretPlan.id}`,
    `/projects/${own.id}/sessions/${secretSession}`,
    `/projects/${own.id}/sessions/${randomUUID()}`,
    `/projects/${own.id}/sessions/not-a-session-id`,
    `/projects/${randomUUID()}`,
    "/projects/not-a-project-id",
  ]) {
    await test.step(path, async () => {
      await page.goto(path);
      await expectNotFound(page, secrets);
    });
  }
});

test("a signed-out visitor sees the landing page at /, and is sent to sign in from other pages", async ({
  page,
}) => {
  // The proxy rewrites `/` to the landing page, so the URL stays `/`.
  await page.goto("/");
  await expect(page).toHaveURL("/");
  // The landing headline only renders on the landing page, so this waits for
  // it rather than passing before the home page could stream in.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Many agents, one codebase, no collisions.",
  );
  await expect(page.getByRole("navigation", { name: "Projects" })).toHaveCount(0);

  // A query the home page ignores (here the old Projects list's cursor, an
  // unknown view and an empty filter) still shows the landing page.
  for (const query of ["?cursor=abc", "?view=agents", "?q="]) {
    await page.goto(`/${query}`);
    await expect(page).toHaveURL(`/${query}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Many agents, one codebase, no collisions.",
    );
  }

  // A link to a state of the home page redirects like any other signed-in
  // page (home.spec.ts).

  const path = `/projects/${randomUUID()}/plans/PLAN-1`;
  await page.goto(path);
  await expect(page).toHaveURL(`/sign-in?${new URLSearchParams({ returnTo: path })}`);
  await expect(page.getByTestId("plan-detail")).toHaveCount(0);
});

test("hostile Plan markdown, summaries and labels render as inert text", async ({ browser }) => {
  const { user, page } = await signedInPage(browser, users);
  const dialogs = watchDialogs(page);
  const api = await coordinationApi(users, user.id);
  const project = await api.createProject(
    await personalOrganizationId(pool, user.id),
    "Hostile project",
  );
  const sessionId = await api.startSession(project.id, {
    agent: "hostile-agent",
    intent: HOSTILE.label,
  });
  const plan = await api.createPlan(project.id, {
    title: "Hostile plan",
    body: HOSTILE.markdown,
    sessionId,
  });
  await api.addTask(project.id, plan.key, HOSTILE.label, sessionId);
  await api.appendLog(project.id, plan.key, HOSTILE.markdown, sessionId);
  await api.endSession(project.id, sessionId, HOSTILE.markdown);

  for (const [path, testId] of [
    [`/projects/${project.id}/plans/${plan.key}`, "plan-detail"],
    [`/projects/${project.id}/sessions/${sessionId}`, "session-detail"],
    [`/projects/${project.id}`, "project-overview"],
  ] as const) {
    await test.step(path, async () => {
      await page.goto(path);
      const content = page.getByTestId(testId);
      await expect(content).toBeVisible();
      await expectLive(page);
      if (testId !== "project-overview") {
        // Safe formatting stays readable; the javascript: link is plain text.
        await expect(content.locator("strong", { hasText: "safe bold" }).first()).toBeVisible();
        await expect(content.getByRole("link", { name: "safe link" }).first()).toHaveAttribute(
          "href",
          "https://example.com/docs",
        );
        await expect(content.getByText("click me").first()).toBeVisible();
        await expect(content.getByRole("link", { name: "click me" })).toHaveCount(0);
        await expect(content.getByRole("link", { name: "raw link" })).toHaveCount(0);
        // The label is shown as the text it is.
        await expect(content.getByText(HOSTILE.label).first()).toBeVisible();
      }
      await expectInert(content);
    });
  }
  expect(dialogs).toEqual([]);
});

test("Events from a newer deployment show as unavailable in place, without their details", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const project = await api.createProject(
    await personalOrganizationId(pool, user.id),
    `Future ${randomUUID().slice(0, 6)}`,
  );
  const sessionId = await api.startSession(project.id, {
    agent: "future-agent",
    intent: "Read newer Events",
  });
  const plan = await api.createPlan(project.id, { title: "Mixed vocabulary", sessionId });
  const taskId = await api.addTask(project.id, plan.key, "Survive newer Events", sessionId);
  await api.attach(project.id, sessionId, plan.key, taskId);
  await api.appendLog(project.id, plan.key, "Known entry before", sessionId);

  // Between two known log entries, three Events this build cannot read: an
  // unknown type, a known type with a newer reason, and a known type at a
  // newer payload version whose familiar field holds the secret.
  const secret = canary();
  const future = { projectId: project.id, actorUserId: user.id, actorSessionId: sessionId };
  await insertFutureEvent(pool, {
    ...future,
    type: "plan.reviewed",
    payloadVersion: 1,
    payload: { secret },
    planId: plan.id,
  });
  await insertFutureEvent(pool, {
    ...future,
    type: "task.released",
    payloadVersion: 1,
    payload: { reason: secret },
    planId: plan.id,
    taskId,
    sessionId,
  });
  await insertFutureEvent(pool, {
    ...future,
    type: "plan.log_appended",
    payloadVersion: 2,
    payload: { message: secret },
    planId: plan.id,
  });
  await api.appendLog(project.id, plan.key, "Known entry after", sessionId);

  const unavailable = "event.unavailable";
  for (const [path, testId] of [
    [`/projects/${project.id}/plans/${plan.key}`, "plan-detail"],
    [`/projects/${project.id}/sessions/${sessionId}`, "session-detail"],
  ] as const) {
    await test.step(path, async () => {
      await page.goto(path);
      await expectLive(page);
      const items = page.getByTestId(testId).getByTestId("timeline-item");
      // Newest first: each in its feed position between the known entries.
      const expected = [
        "plan.log_appended",
        unavailable,
        unavailable,
        unavailable,
        "plan.log_appended",
      ];
      for (const [index, type] of expected.entries()) {
        await expect(items.nth(index)).toHaveAttribute("data-event-type", type);
      }
      await expect(items.nth(0)).toContainText("Known entry after");
      await expect(items.nth(4)).toContainText("Known entry before");
      for (const index of [1, 2, 3]) {
        const item = items.nth(index);
        // The fixed text, with the attribution and affected records kept.
        await expect(item).toContainText(`${user.name}: Event details unavailable`);
        await expect(item.getByRole("link", { name: plan.key })).toBeVisible();
      }
      // The newer release keeps its Task and Session.
      await expect(items.nth(2)).toContainText("Survive newer Events");
      await expect(
        items.nth(2).getByRole("link", { name: "Session", exact: true }),
      ).toHaveAttribute("href", `/projects/${project.id}/sessions/${sessionId}`);
      await expect(page.locator("body")).not.toContainText(secret);
      // The HTML includes the inline Server Component payload.
      expect(await page.content()).not.toContain(secret);
    });
  }

  await test.step("the Project overview", async () => {
    // The overview has no timeline; it still renders, without the details.
    await page.goto(`/projects/${project.id}`);
    await expectLive(page);
    await expect(page.getByTestId("project-overview")).toContainText("future-agent");
    await expect(page.locator("body")).not.toContainText(secret);
    expect(await page.content()).not.toContain(secret);
  });
});
