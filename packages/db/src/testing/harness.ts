import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, it } from "vitest";
import { createDb, type Db } from "../index.ts";
import { runMigrations } from "../migrate.ts";

// Test harness for code that needs a real Postgres database. Each test file
// gets its own freshly created and migrated database on the server named by
// TEST_DATABASE_URL, so files can run in parallel without sharing state.
//
// Locally, with `docker compose up -d` at the repo root:
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres

const testDatabaseUrl = process.env.TEST_DATABASE_URL || undefined;
const inCi = Boolean(process.env.CI) && process.env.CI !== "false" && process.env.CI !== "0";

export interface TestDatabase {
  /** A pool connected to the test database. `drop` ends it. */
  pool: pg.Pool;
  db: Db;
  /** Connection URL for the test database. */
  url: string;
  /** Ends the pool and drops the database. Call it in `afterAll`. */
  drop: () => Promise<void>;
}

/**
 * Creates a database with a random name on the TEST_DATABASE_URL server and
 * applies every migration to it. Throws if TEST_DATABASE_URL is unset, so call
 * it only inside `describeDb`.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  const name = `hivemind_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;

  await withAdminClient((client) => client.query(`create database "${name}"`));
  try {
    await runMigrations(url.toString());
  } catch (error) {
    await dropDatabase(name);
    throw error;
  }

  const pool = new pg.Pool({ connectionString: url.toString() });
  return {
    pool,
    db: createDb(pool),
    url: url.toString(),
    drop: async () => {
      await pool.end();
      await dropDatabase(name);
    },
  };
}

/**
 * `describe` for tests that need Postgres. Without TEST_DATABASE_URL the block
 * is skipped locally but fails in CI, so a misconfigured CI job cannot pass by
 * skipping every database test.
 */
export function describeDb(name: string, fn: () => void): void {
  if (testDatabaseUrl) {
    describe(name, fn);
  } else if (inCi) {
    describe(name, () => {
      it("requires TEST_DATABASE_URL in CI", () => {
        throw new Error("TEST_DATABASE_URL must be set when CI is set.");
      });
    });
  } else {
    // Vitest drops console output from files whose tests are all skipped.
    process.stderr.write(`Skipping "${name}": TEST_DATABASE_URL is not set.\n`);
    describe.skip(name, fn);
  }
}

async function dropDatabase(name: string): Promise<void> {
  await withAdminClient((client) => client.query(`drop database if exists "${name}" with (force)`));
}

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
