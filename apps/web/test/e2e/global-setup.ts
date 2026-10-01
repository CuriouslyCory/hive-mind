import { execFileSync } from "node:child_process";
import pg from "pg";
import { e2eDatabaseUrl } from "./e2e-env";

/**
 * Creates and migrates the app's database for the browser tests, and returns
 * the teardown that drops it. The name comes from playwright.config.ts.
 */
export default async function globalSetup() {
  const databaseUrl = new URL(e2eDatabaseUrl());
  const name = databaseUrl.pathname.slice(1);
  if (!/^hivemind_e2e_[0-9a-f]{32}$/.test(name)) {
    throw new Error("E2E_DATABASE_URL must name a hivemind_e2e_ database.");
  }
  // The TEST_DATABASE_URL database, as the Vitest harness uses it.
  const admin = new URL(process.env.TEST_DATABASE_URL ?? "");

  // `with (force)` ends the app server's connections, if it still has any.
  const dropDatabase = () =>
    withClient(admin, (client) => client.query(`drop database if exists "${name}" with (force)`));

  await withClient(admin, (client) => client.query(`create database "${name}"`));
  try {
    execFileSync("pnpm", ["--filter", "@hivemind/db", "db:migrate"], {
      env: { ...process.env, DATABASE_URL_UNPOOLED: databaseUrl.toString() },
      stdio: "inherit",
    });
  } catch (error) {
    // Playwright runs no teardown when global setup throws, and every run
    // names a new database, so drop it here or it is left behind. A failed
    // drop is reported but does not replace the migration error.
    await dropDatabase().catch((dropError: unknown) => {
      console.error(`could not drop ${name}:`, dropError);
    });
    throw error;
  }

  return async () => {
    await dropDatabase();
  };
}

async function withClient<T>(url: URL, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
