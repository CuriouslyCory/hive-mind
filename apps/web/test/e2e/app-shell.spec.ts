import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { e2eDatabaseUrl } from "./e2e-env";
import {
  coordinationApi,
  expectLive,
  personalOrganizationId,
  signedInPage,
  testUsers,
} from "./support";

// The design system as every page's baseline and the signed-in pages' app
// shell (ADR-0019, docs/design-system.md → App shell): one top bar and one
// main on `/` and on the Project pages, a breadcrumb per page, the brand's
// fonts and surfaces on pages with no stylesheet of their own, and one theme
// for the whole document.

let pool: pg.Pool;
let users: TestHelpers;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
});

test.afterAll(async () => {
  await pool?.end();
});

/** The shell's top bar: the logo, the Primary navigation, the theme switch and the viewer. */
async function expectShell(page: Page, userName: string) {
  const banner = page.getByRole("banner");
  await expect(banner).toHaveCount(1);
  await expect(banner.getByRole("link", { name: "HiveMind home" })).toHaveAttribute("href", "/");
  await expect(
    banner.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Dashboard" }),
  ).toBeVisible();
  await expect(banner.getByRole("switch", { name: "Dark theme" })).toBeVisible();
  await expect(banner).toContainText(userName);
  await expect(banner.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
}

test("every signed-in page has the same shell, its own breadcrumb and the brand's type", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const project = await api.createProject(organizationId, `Shell ${randomUUID().slice(0, 6)}`);
  const plan = await api.createPlan(project.id, { title: "Shell plan" });

  await page.goto("/");
  await expectShell(page, user.name);
  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(primary.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.goto(`/projects/${project.id}/plans/${plan.key}`);
  await expectLive(page);
  await expectShell(page, user.name);
  await expect(primary.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb.getByRole("link")).toHaveText(["Dashboard", project.name]);
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(plan.key);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(`${plan.key}: Shell plan`);
  // The design system's faces, from the baseline rather than a page rule.
  await expect(heading).toHaveCSS("font-family", /Sora|hm-font-sora/i);
  await expect(page.locator("body")).toHaveCSS("font-family", /Nunito|hm-font-nunito/i);

  // Following the breadcrumb is a client navigation inside the same shell.
  await breadcrumb.getByRole("link", { name: project.name }).click();
  await expect(page).toHaveURL(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  await expectShell(page, user.name);

  await page.context().close();
});

test("the skip link moves focus past the top bar to main", async ({ browser }) => {
  const { page } = await signedInPage(browser, users);
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.context().close();
});

test("the shell's theme switch themes the whole document, and the choice holds across pages", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const project = await api.createProject(organizationId, `Theme ${randomUUID().slice(0, 6)}`);

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/projects/${project.id}`);
  await expectLive(page);
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "system");
  // Light surface-sunken behind the page.
  const ground = page.locator(".app-shell");
  await expect(ground).toHaveCSS("background-color", "rgb(244, 246, 250)");

  const toggle = page.getByRole("switch", { name: "Dark theme" });
  await expect(async () => {
    await toggle.click();
    await expect(root).toHaveAttribute("data-theme", "dark", { timeout: 500 });
  }).toPass();
  await expect(ground).toHaveCSS("background-color", "rgb(7, 15, 28)");

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Dashboard" })
    .click();
  await expect(page).toHaveURL("/");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.context().close();
});

test("a Project page fits a 375px screen: wide tables scroll inside their cards", async ({
  browser,
}) => {
  const { user, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const project = await api.createProject(organizationId, `Narrow ${randomUUID().slice(0, 6)}`);
  const sessionId = await api.startSession(project.id, { agent: "narrow-agent", intent: "Fit" });
  const plan = await api.createPlan(project.id, { title: "Narrow plan", sessionId });
  const task = await api.addTask(project.id, plan.key, "A task", sessionId);
  await api.attach(project.id, sessionId, plan.key, task);
  await api.claim(project.id, task, sessionId);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/projects/${project.id}/plans/${plan.key}`);
  await expectLive(page);
  await expect(page.getByTestId("task-row")).toContainText("A task");
  // Visually hidden status words sit in the scrolled-off columns; they must
  // not widen the document.
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await page.context().close();
});
