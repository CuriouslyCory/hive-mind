import { expect, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { E2E_BASE_URL, E2E_SERVES_BUILD, e2eDatabaseUrl } from "./e2e-env";
import { signedInPage, testUsers } from "./support";

// The dev tracker page (docs/tracker.md). Under `next dev` a signed-in User
// works the Backlog (Up next, copying a prompt completes its step) and the
// Changelog, and the selected tab lives in `?tab=`. Under `next start`
// (E2E_SERVER=start) the page is a 404, with that HTTP status, even when
// signed in.

let pool: pg.Pool;
let users: TestHelpers;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
});

test.afterAll(async () => {
  await pool?.end();
});

test("under next dev, a signed-in User works the Backlog and the Changelog", async ({
  browser,
}) => {
  test.skip(E2E_SERVES_BUILD, "The tracker is a 404 outside next dev (the next test).");
  const { context, page } = await signedInPage(browser, users);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_BASE_URL });
  const status = page.getByRole("status");

  await page.goto("/tracker");
  await expect(page.getByRole("heading", { level: 1, name: "Development tracker" })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  const backlogTab = page.getByRole("tab", { name: "Backlog" });
  await expect(backlogTab).toHaveAttribute("aria-selected", "true");
  const backlog = page.getByRole("tabpanel", { name: "Backlog" });
  const upNext = backlog.getByRole("region", { name: "Up next" });
  await expect(upNext).toContainText("No unfinished step in an open issue.");

  // A phase, then an issue in it, which gets the two default steps.
  await backlog.getByRole("button", { name: "Add phase" }).click();
  await expect(backlog.getByLabel("Phase title")).toBeFocused();
  await backlog.getByLabel("Phase title").fill("M4: ADRs");
  await backlog.getByRole("button", { name: "Save phase" }).click();
  await expect(status).toHaveText("Phase added.");
  const phase = backlog.getByRole("region", { name: "M4: ADRs" });
  await expect(phase).toBeVisible();

  await phase.getByRole("button", { name: "Add issue to M4: ADRs" }).click();
  await phase.getByLabel("GitHub issue number").fill("4242");
  await phase.getByLabel("Title", { exact: true }).fill("Write the ADR index");
  await phase.getByRole("button", { name: "Save issue" }).click();
  await expect(status).toHaveText("Issue #4242 added.");
  const issue = phase.getByRole("article", { name: "#4242 Write the ADR index" });
  await expect(issue.getByRole("link", { name: "#4242" })).toHaveAttribute(
    "href",
    "https://github.com/CuriouslyCory/hive-mind/issues/4242",
  );
  await expect(issue).toContainText("Open");
  const plan = issue.getByRole("checkbox", { name: "Step 1 · Plan" });
  await expect(plan).not.toBeChecked();
  await expect(issue.getByRole("checkbox", { name: "Step 2 · Implement + PR" })).not.toBeChecked();

  // Up next is step 1; copying its prompt completes it, and Up next moves on.
  await expect(upNext).toContainText("#4242 Write the ADR index");
  await expect(upNext).toContainText("Step 1 · Plan");
  await upNext.getByRole("button", { name: "Copy prompt for Step 1 · Plan" }).click();
  await expect(status).toHaveText(
    "Copied the prompt for Step 1 · Plan and marked the step complete.",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "/bulletproof-plan https://github.com/CuriouslyCory/hive-mind/issues/4242",
  );
  await expect(upNext).toContainText("Step 2 · Implement + PR");
  await expect(plan).toBeChecked();
  await expect(issue).toContainText("1 of 2 steps complete");

  // With completed issues hidden, completing the last step hides the issue
  // and its checkbox; focus moves to Up next rather than to <body>.
  await backlog.getByLabel("Hide completed issues").check();
  await issue.getByRole("checkbox", { name: "Step 2 · Implement + PR" }).check();
  await expect(status).toHaveText("Marked Step 2 · Implement + PR complete.");
  await expect(issue).toBeHidden();
  await expect(upNext.getByRole("heading", { name: "Up next" })).toBeFocused();
  await expect(upNext).toContainText("No unfinished step in an open issue.");

  // The tabs by keyboard: ArrowRight from Backlog selects Changelog.
  await backlogTab.focus();
  await page.keyboard.press("ArrowRight");
  const changelogTab = page.getByRole("tab", { name: "Changelog" });
  await expect(changelogTab).toBeFocused();
  await expect(changelogTab).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/tracker\?tab=changelog$/);
  await expect(backlog).toBeHidden();

  const changelog = page.getByRole("tabpanel", { name: "Changelog" });
  await expect(changelog.getByRole("region", { name: "Git history scan" })).toContainText("Never");
  await changelog.getByRole("button", { name: "Add entry" }).click();
  await changelog.getByLabel("UTC merge date").fill("2026-10-02");
  await changelog.getByLabel("Category").fill("Dashboard");
  await changelog.getByLabel("Title", { exact: true }).fill("Live updates on the Project page");
  await changelog
    .getByLabel("What changed for users")
    .fill("The Project page now updates as agents work.");
  await changelog.getByLabel("PR numbers").fill("18, #17");
  await changelog.getByRole("button", { name: "Save entry" }).click();
  await expect(status).toHaveText("Changelog entry added.");
  const entry = changelog
    .getByRole("region", { name: "October 2, 2026" })
    .getByRole("article", { name: "Live updates on the Project page" });
  await expect(entry).toContainText("Dashboard");
  await expect(entry.getByRole("link", { name: "PR #18" })).toHaveAttribute(
    "href",
    "https://github.com/CuriouslyCory/hive-mind/pull/18",
  );
  await expect(entry.getByRole("link", { name: "PR #17" })).toBeVisible();

  // A reload keeps the tab from the URL.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Changelog" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(entry).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Backlog" })).toBeHidden();

  await context.close();
});

test("under next start, /tracker is a 404 even for a signed-in User", async ({ browser }) => {
  test.skip(!E2E_SERVES_BUILD, "Only a build served with next start is a 404.");
  const { context, page } = await signedInPage(browser, users);

  const response = await page.goto("/tracker");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Development tracker" })).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);

  await context.close();
});
