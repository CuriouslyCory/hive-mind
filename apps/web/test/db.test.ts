import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { getDb as GetDb } from "../src/server/db";

// The app's pool must survive Postgres closing an idle connection (Neon does
// this; so does the browser tests' teardown). Without the pool's `error`
// listener this test fails with an unhandled error: the event is thrown as an
// uncaughtException, which in the server would end the process.

describeDb("getDb", () => {
  let testDb: TestDatabase;
  let getDb: typeof GetDb;

  beforeAll(async () => {
    testDb = await createTestDatabase({ migrate: false });
    vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-0123456789abcdef");
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("OAUTH_PROXY_SECRET", "test-oauth-proxy-secret-0123456789abcdef");
    vi.stubEnv("DATABASE_URL", testDb.url);
    vi.resetModules();
    ({ getDb } = await import("../src/server/db"));
    // Creates the pool now: the environment is read on first use, and the
    // config's unstubEnvs undoes these stubs before each test.
    getDb();
  });

  afterAll(async () => {
    await getDb?.().$client.end();
    await testDb?.drop();
  });

  async function backendPid(): Promise<number> {
    const result = await getDb().execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const pid = result.rows[0]?.pid;
    if (pid === undefined) throw new Error("no backend pid");
    return pid;
  }

  it("keeps serving after Postgres terminates an idle connection", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const firstPid = await backendPid();
    await testDb.pool.query("select pg_terminate_backend($1)", [firstPid]);
    await vi.waitFor(() => expect(logged).toHaveBeenCalledOnce());

    const [message] = logged.mock.calls[0] ?? [];
    expect(message).toEqual(expect.stringContaining("57P01"));
    expect(message).not.toContain(testDb.url);
    expect(await backendPid()).not.toBe(firstPid);
  });
});
