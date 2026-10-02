import { randomUUID } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { E2E_AUTH_ENV, E2E_BASE_URL, E2E_SERVES_BUILD } from "./test/e2e/e2e-env";

// Browser tests for the CLI's device approval page and the compiled CLI
// against the real app (issues #3 and #12; the dashboard's browser tests are
// M3's). Run with `pnpm test:e2e` from
// apps/web; they are not part of `pnpm test`, which needs no browser.
//
// The app runs against its own database on the TEST_DATABASE_URL server,
// created and migrated by global-setup.ts and dropped afterwards. The app
// must be served as localhost:3000: that is the only host local development
// trusts (allowedHosts in src/server/auth.ts).

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run the browser tests.");
}
// Set once in the runner; its workers inherit it, so all agree on the database.
if (!process.env.E2E_DATABASE_URL) {
  const url = new URL(testDatabaseUrl);
  url.pathname = `/hivemind_e2e_${randomUUID().replaceAll("-", "")}`;
  process.env.E2E_DATABASE_URL = url.toString();
}

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./test/e2e/global-setup.ts",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // The tests share one app server and database; they create their own Users.
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: E2E_SERVES_BUILD ? "pnpm exec next start" : "pnpm exec next dev",
    // Answers without touching the database, which may not exist yet.
    url: `${E2E_BASE_URL}/api/auth/ok`,
    // Never test against some other server already on port 3000.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: "3000",
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      ...E2E_AUTH_ENV,
    },
  },
});
