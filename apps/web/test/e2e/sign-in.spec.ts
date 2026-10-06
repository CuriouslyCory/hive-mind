import { expect, test } from "@playwright/test";

// The sign-in page (apps/web/src/app/sign-in) on the site frame
// (apps/web/src/site): its landmarks and links, the pending and failed
// states of the GitHub button, and its width on small screens. Where the
// button sends the browser, and the return path, are in
// device-approval.spec.ts.

const SOCIAL_SIGN_IN = "**/api/auth/sign-in/social";

test("shows the sign-in card inside the site frame", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page).toHaveTitle("Sign in · HiveMind");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to HiveMind");
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  await expect(page.getByRole("main")).toContainText("hivemind login");

  const banner = page.getByRole("banner");
  await expect(banner.getByRole("link", { name: "HiveMind home" })).toHaveAttribute("href", "/");
  await expect(banner.getByRole("link", { name: "Back to HiveMind" })).toHaveAttribute("href", "/");
  await expect(
    page.getByRole("contentinfo").getByRole("navigation", { name: "Footer" }).getByRole("link"),
  ).toHaveText(["GitHub", "CLI docs", "Dashboard docs", "Decisions"]);
});

test("the skip link moves focus to the sign-in card", async ({ page }) => {
  await page.goto("/sign-in");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeFocused();
});

test("Back to HiveMind opens the landing page, and Back returns to sign-in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Back to HiveMind" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Many agents, one codebase, no collisions.",
  );
  await page.goBack();
  await expect(page).toHaveURL("/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to HiveMind");
});

test("the button says it is signing in, then reports a failure and can be retried", async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Held, then failed as a network error would.
  await page.route(SOCIAL_SIGN_IN, async (route) => {
    await held;
    await route.abort();
  });
  await page.goto("/sign-in");
  const button = page.getByRole("button", { name: "Sign in with GitHub" });
  // Inside main: Next's route announcer is an alert too.
  const alert = page.getByRole("main").getByRole("alert");
  await button.click();

  const pending = page.getByRole("button", { name: "Signing in…" });
  await expect(pending).toBeDisabled();
  await expect(alert).toHaveCount(0);

  release();
  await expect(alert).toContainText("Sign-in failed.");
  await expect(alert).toContainText("Try again.");
  await expect(button).toBeEnabled();

  // A second attempt clears the failure while it runs.
  await page.unroute(SOCIAL_SIGN_IN);
  await page.route(SOCIAL_SIGN_IN, () => new Promise(() => {}));
  await button.click();
  await expect(pending).toBeDisabled();
  await expect(alert).toHaveCount(0);
});

for (const width of [320, 390]) {
  test(`the page does not scroll sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
}
