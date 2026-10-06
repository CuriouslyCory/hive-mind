import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { E2E_BASE_URL, e2eDatabaseUrl } from "./e2e-env";
import { signedInPage, testUsers } from "./support";

// The public landing page (apps/web/src/app/(marketing)/welcome): what a
// signed-out visitor sees at `/`, its links, and its three client controls
// (the theme switch, the install command's Copy button and the dashboard
// mock's tabs). A signed-in User still gets the Projects list at `/`.

const HEADLINE = "Many agents, one codebase, no collisions.";

/** docs/cli.md → Install → Install script: the first line of its code block. */
function documentedInstallCommand(): string {
  const doc = readFileSync(new URL("../../../../docs/cli.md", import.meta.url), "utf8");
  const section = doc.slice(doc.indexOf("### Install script"));
  const command = /```[a-z]*\n(.+)\n/.exec(section)?.[1];
  if (!command) throw new Error("docs/cli.md has no install command.");
  return command;
}

let pool: pg.Pool;
let users: TestHelpers;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
});

test.afterAll(async () => {
  await pool?.end();
});

function landingRoot(page: Page) {
  return page.locator(".hm-landing");
}

test("a signed-out visitor gets the landing page at /, and at /welcome", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(HEADLINE);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page).toHaveTitle(/HiveMind/);

  await page.goto("/welcome");
  await expect(page).toHaveURL("/welcome");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(HEADLINE);
  await expect(
    page.getByRole("region", { name: "Example dashboard with sample data" }),
  ).toBeVisible();
});

test("every Sign in with GitHub link is the relative /sign-in, and the header one opens it", async ({
  page,
}) => {
  await page.goto("/");
  const signIns = page.getByRole("link", { name: "Sign in with GitHub" });
  await expect(signIns).toHaveCount(3);
  for (const link of await signIns.all()) {
    await expect(link).toHaveAttribute("href", "/sign-in");
  }

  await page.getByRole("banner").getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL("/sign-in");
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("the primary nav's anchors scroll to sections of the page", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  const anchors = await nav.locator('a[href^="#"]').all();
  expect(anchors).toHaveLength(4);
  for (const anchor of anchors) {
    const href = (await anchor.getAttribute("href")) as string;
    const section = page.locator(href);
    await expect(section).toHaveCount(1);
    await anchor.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(section).toBeInViewport();
  }
});

test("the theme switch reflects the system theme, then forces light or dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const root = landingRoot(page);
  const toggle = page.getByRole("switch", { name: "Dark theme" });
  await expect(root).toHaveAttribute("data-theme", "system");
  // Checked once mounted: the system theme is dark.
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

test("Copy puts the documented install command on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_BASE_URL });
  await page.goto("/");
  const copy = page.getByRole("button", { name: /^Cop(y|ied) install command$/ });
  // Retried until the page has hydrated and the click copies.
  await expect(async () => {
    await copy.click();
    await expect(copy).toHaveText(/^Copied/, { timeout: 500 });
  }).toPass();
  await expect(
    page.getByRole("status").filter({ hasText: "Copied the install command." }),
  ).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    documentedInstallCommand(),
  );
  // The label goes back after about 1.5 seconds.
  await expect(copy).toHaveText(/^Copy install command$/, { timeout: 5_000 });
});

test("the dashboard mock's tabs switch panels by click and by arrow keys", async ({ page }) => {
  await page.goto("/");
  const mock = page.getByRole("region", { name: "Example dashboard with sample data" });
  const tab = (name: RegExp) => mock.getByRole("tab", { name });
  const plans = tab(/^Plans/);
  const sessions = tab(/^Sessions/);
  const activity = tab(/^Activity/);

  await expect(sessions).toHaveAttribute("aria-selected", "true");
  await expect(mock.getByRole("tabpanel")).toContainText("Fix parser error positions");

  await expect(async () => {
    await plans.click();
    await expect(plans).toHaveAttribute("aria-selected", "true", { timeout: 500 });
  }).toPass();
  await expect(mock.getByRole("tabpanel")).toHaveCount(1);
  await expect(mock.getByRole("tabpanel")).toContainText("PLAN-1");
  await expect(mock.getByRole("tabpanel")).toContainText("PLAN-4");

  await page.keyboard.press("ArrowRight");
  await expect(sessions).toBeFocused();
  await expect(sessions).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(activity).toBeFocused();
  await expect(activity).toHaveAttribute("aria-selected", "true");
  await expect(mock.getByRole("tabpanel")).toContainText("claude-code claimed a Task on PLAN-3");
  await page.keyboard.press("ArrowRight");
  await expect(plans).toHaveAttribute("aria-selected", "true");
});

for (const width of [360, 390, 430]) {
  test(`the page does not scroll sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
}

test("a signed-in User at / gets the Projects list, not the landing page", async ({ browser }) => {
  const { page } = await signedInPage(browser, users);
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("heading", { name: HEADLINE })).toHaveCount(0);
  await expect(landingRoot(page)).toHaveCount(0);
  await page.context().close();
});
