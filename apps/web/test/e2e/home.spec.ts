import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { e2eDatabaseUrl } from "./e2e-env";
import {
  type CoordinationApi,
  coordinationApi,
  expectInert,
  HOSTILE,
  organizationName,
  PWNED_GLOBAL,
  personalOrganizationId,
  signedInPage,
  testUsers,
  watchDialogs,
} from "./support";

// The signed-in home page, `/` (docs/dashboard.md → Home page), rendered from
// data written through `/api/v1`: the Projects rail, the summary cells, the
// Sessions and Plans tables, scoping to one Project, the filter, the list
// views and their breadcrumb, Decisions, and the 15-second refresh that
// keeps it current (it opens no Event stream). Every state is in the URL.

/** `HOME_REFRESH_MS` in `apps/web/src/app/(app)/_home/freshness-controller.ts`. */
const HOME_REFRESH_MS = 15_000;

let pool: pg.Pool;
let users: TestHelpers;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
});

test.afterAll(async () => {
  await pool?.end();
});

/** Two Projects in the User's Organization: one with a parser Session and six Plans, one with a docs Session and one Plan. */
async function seedTwoProjects(api: CoordinationApi, organizationId: string) {
  const suffix = randomUUID().slice(0, 6);
  const alpha = await api.createProject(organizationId, `Home alpha ${suffix}`);
  const beta = await api.createProject(organizationId, `Home beta ${suffix}`);
  // Older Plans first: the home page's Plans table shows the five most
  // recently updated, so the named ones are among them.
  for (let n = 1; n <= 5; n++) await api.createPlan(alpha.id, { title: `Filler plan ${n}` });

  const parserSession = await api.startSession(alpha.id, {
    agent: "parser-agent",
    intent: "Tune the parser",
    gitBranch: "feat/parser",
  });
  const parserPlan = await api.createPlan(alpha.id, {
    title: "Parser speedup",
    sessionId: parserSession,
  });
  const task = await api.addTask(alpha.id, parserPlan.key, "Profile the lexer", parserSession);
  await api.claim(alpha.id, task, parserSession);
  await api.startTask(alpha.id, task, parserSession);

  const docsSession = await api.startSession(beta.id, {
    agent: "docs-agent",
    intent: "Write the guide",
    gitBranch: "docs/guide",
  });
  const docsPlan = await api.createPlan(beta.id, { title: "Docs refresh", sessionId: docsSession });
  return { alpha, beta, parserSession, parserPlan, docsPlan };
}

function sessionsTable(page: Page) {
  return page.getByTestId("home-sessions");
}

function plansTable(page: Page) {
  return page.getByTestId("home-plans");
}

test("the home page shows every readable Project, scopes to one, filters and opens the list views", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const { alpha, beta } = await seedTwoProjects(api, organizationId);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("home-freshness")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("home-freshness").getByRole("status")).toHaveText("Live");

  // The rail: all Projects, then each one under its Organization's name.
  const rail = page.getByRole("navigation", { name: "Projects" });
  const allProjects = rail.getByRole("link").filter({ hasText: "All Projects" });
  await expect(allProjects).toHaveAttribute("aria-current", "page");
  await expect(allProjects).toContainText("2 Projects");
  const orgName = await organizationName(pool, organizationId);
  for (const project of [alpha, beta]) {
    await expect(rail.getByRole("link").filter({ hasText: project.name })).toContainText(orgName);
  }

  // The summary cells count across both Projects.
  const cells = page.getByRole("list", { name: "Summary" });
  await expect(cells.getByRole("link", { name: /^Active Plans: 7\./ })).toBeVisible();
  await expect(cells.getByRole("link", { name: /^Buzzing: 2\./ })).toBeVisible();
  await expect(cells.getByRole("link", { name: /^Open Tasks: 1\./ })).toBeVisible();

  // Both tables span both Projects.
  await expect(sessionsTable(page)).toContainText("Tune the parser");
  await expect(sessionsTable(page)).toContainText("Write the guide");
  await expect(sessionsTable(page)).toContainText("parser-agent");
  await expect(plansTable(page)).toContainText("Parser speedup");
  await expect(plansTable(page)).toContainText("Docs refresh");
  await expect(plansTable(page)).toContainText("Showing 5 of 7 Plans");

  // Choosing a Project in the rail scopes the whole page to it.
  await rail.getByRole("link").filter({ hasText: beta.name }).click();
  await expect(page).toHaveURL(`/?project=${beta.id}`);
  await expect(page.getByRole("heading", { level: 1, name: beta.name })).toBeVisible();
  await expect(sessionsTable(page)).toContainText("Write the guide");
  await expect(sessionsTable(page)).not.toContainText("Tune the parser");
  await expect(plansTable(page)).toContainText("Docs refresh");
  await expect(plansTable(page)).not.toContainText("Parser speedup");
  await expect(cells.getByRole("link", { name: /^Active Plans: 1\./ })).toBeVisible();
  await rail.getByRole("link").filter({ hasText: "All Projects" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  // Typing in the filter puts it in the URL, and the tables follow.
  const filter = page.getByRole("searchbox", { name: "Filter Plans and Sessions" });
  await filter.fill("parser");
  await expect(page).toHaveURL("/?q=parser");
  await expect(sessionsTable(page)).not.toContainText("Write the guide");
  await expect(sessionsTable(page)).toContainText("Tune the parser");
  await expect(plansTable(page)).not.toContainText("Docs refresh");
  await expect(plansTable(page)).toContainText("Parser speedup");
  await expect(filter).toHaveValue("parser");
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL("/");
  await expect(filter).toHaveValue("");
  await expect(plansTable(page)).toContainText("Showing 5 of 7 Plans");

  // "See all" opens the Plans list, and the breadcrumb leads back.
  await plansTable(page).getByRole("link", { name: "See all 7 Plans" }).click();
  await expect(page).toHaveURL("/?view=plans");
  await expect(page.getByRole("heading", { level: 1, name: "Plans" })).toBeVisible();
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("Plans");
  await expect(plansTable(page)).toContainText("Showing 7 of 7 Plans");
  await expect(sessionsTable(page)).toHaveCount(0);
  await breadcrumb.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(sessionsTable(page)).toBeVisible();

  await page.context().close();
});

test("a decision recorded through the API reaches an open home page on its next refresh", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const { alpha, parserPlan, parserSession } = await seedTwoProjects(api, organizationId);

  // A controllable clock: the refresh runs on a 15-second interval, and the
  // test moves time forward instead of waiting for it.
  await page.clock.install();
  await page.goto("/");
  const decisions = page.getByTestId("home-decisions");
  await expect(decisions).toContainText("No decisions recorded here yet.");
  await expect(page.getByTestId("home-freshness")).toHaveAttribute("data-state", "live");

  const text = `Keep the hand-written lexer ${randomUUID().slice(0, 6)}`;
  await api.recordDecision(alpha.id, parserPlan.key, text, parserSession);
  await page.clock.runFor(HOME_REFRESH_MS);

  const item = decisions.getByRole("listitem").filter({ hasText: text });
  await expect(item).toBeVisible();
  await expect(item).toContainText(`${alpha.name} · ${parserPlan.key}`);
  await expect(item).toContainText("parser-agent");
  await expect(
    item.getByRole("link", { name: `${alpha.name} · ${parserPlan.key}` }),
  ).toHaveAttribute("href", `/projects/${alpha.id}/plans/${parserPlan.key}`);
  await expect(page.getByTestId("home-freshness")).toHaveAttribute("data-state", "live");

  await page.context().close();
});

test("a long Project name is cut off in the rail and leaves room for both columns", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const name = `A Project whose name is far too long for the rail ${randomUUID().slice(0, 6)}`;
  await api.createProject(organizationId, name);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const projectName = page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("link")
    .filter({ hasText: name })
    .locator(".home-rail-name");
  await expect(projectName).toHaveAttribute("title", name);
  const cut = await projectName.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(cut).toBe(true);

  // The feeds sit beside the tables, not under them.
  const sessions = await sessionsTable(page).boundingBox();
  const decisions = await page.getByTestId("home-decisions").boundingBox();
  expect(sessions && decisions).toBeTruthy();
  if (sessions && decisions) expect(decisions.x).toBeGreaterThan(sessions.x + sessions.width);

  await page.context().close();
});

test("a signed-out link to a home-page view goes to sign-in and keeps the view as the return path", async ({
  page,
}) => {
  await page.goto("/?view=plans");
  await expect(page).toHaveURL(`/sign-in?${new URLSearchParams({ returnTo: "/?view=plans" })}`);
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("hostile Session intents, Plan titles and decisions render as literal text on the home page", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const dialogs = watchDialogs(page);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const project = await api.createProject(
    organizationId,
    `Hostile home ${randomUUID().slice(0, 6)}`,
  );
  const sessionId = await api.startSession(project.id, {
    agent: "hostile-agent",
    intent: HOSTILE.label,
  });
  const title = `**${HOSTILE.label}** [click me](javascript:alert(1))`;
  const plan = await api.createPlan(project.id, { title, body: HOSTILE.markdown, sessionId });
  const decision = `<script>window.${PWNED_GLOBAL}='decision'</script> _not italic_ [raw](javascript:alert(2))`;
  await api.recordDecision(project.id, plan.key, decision, sessionId);
  await api.appendLog(project.id, plan.key, HOSTILE.markdown, sessionId);

  await page.goto("/");
  const main = page.locator("main");
  await expect(sessionsTable(page).getByRole("link", { name: HOSTILE.label })).toBeVisible();
  await expect(plansTable(page).getByRole("link", { name: title })).toBeVisible();
  await expect(
    page.getByTestId("home-decisions").getByText(decision, { exact: true }),
  ).toBeVisible();
  // The markdown links are text inside the Plan's own link, never links.
  await expect(main.getByRole("link", { name: "click me", exact: true })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "raw", exact: true })).toHaveCount(0);
  await expectInert(main);

  // The filter is shown as typed, in the heading and in the field.
  await page.goto(`/?view=sessions&q=${encodeURIComponent(HOSTILE.label)}`);
  await expect(page.locator(".home-meta")).toHaveText(
    `1 active Session in all Projects matching “${HOSTILE.label}”.`,
  );
  await expect(page.getByRole("searchbox", { name: "Filter Plans and Sessions" })).toHaveValue(
    HOSTILE.label,
  );
  await expect(sessionsTable(page).getByRole("link", { name: HOSTILE.label })).toBeVisible();
  await expectInert(page.locator("main"));
  expect(dialogs).toEqual([]);

  await page.context().close();
});

test("the Sessions tabs move focus with the arrow keys and load a tab only when it is chosen", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  await seedTwoProjects(api, organizationId);

  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "Session status" });
  const active = tabs.getByRole("tab", { name: /^Active/ });
  const ended = tabs.getByRole("tab", { name: /^Ended/ });
  await expect(active).toHaveAttribute("aria-selected", "true");
  // The tab reads its count after a separator ("Active, 2", where the
  // browser may add a space before the comma: the chip is a flex item), and
  // controls the table's panel.
  await expect(active).toHaveAccessibleName(/^Active ?, 2$/);
  await expect(active).toHaveAttribute("aria-controls", "home-sessions-panel");

  await active.focus();
  await page.keyboard.press("ArrowRight");
  await expect(ended).toBeFocused();
  await expect(active).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL("/");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/?sessions=ended");
  await expect(ended).toHaveAttribute("aria-selected", "true");
  const endedId = await ended.getAttribute("id");
  await expect(page.locator("#home-sessions-panel")).toHaveAttribute(
    "aria-labelledby",
    endedId ?? "",
  );

  await page.context().close();
});
