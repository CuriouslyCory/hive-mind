import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  createClient,
  createPool,
  describeConnectionError,
  describeFailure,
} from "../src/connection.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";

// Without the `error` listeners these tests do not fail an assertion: the
// terminated connection's `error` event is thrown as an uncaughtException,
// which Vitest reports as an unhandled error and fails the run.

describe("describeConnectionError", () => {
  it("keeps the code and message", () => {
    const error = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
    });
    expect(describeConnectionError(error)).toBe(
      "(57P01) terminating connection due to administrator command",
    );
  });

  it("leaves out the client pg-pool attaches, and with it the password", () => {
    const error = Object.assign(new Error("Connection terminated unexpectedly"), {
      client: { connectionParameters: { password: "hunter2-secret" } },
    });
    const text = describeConnectionError(error);
    expect(text).toBe("(no code) Connection terminated unexpectedly");
    expect(text).not.toContain("hunter2-secret");
  });
});

describe("describeFailure", () => {
  it("describes an Error by code and message, and anything else generically", () => {
    const error = Object.assign(new Error("Connection terminated unexpectedly"), {
      client: { connectionParameters: { password: "hunter2-secret" } },
    });
    expect(describeFailure(error)).toBe("(no code) Connection terminated unexpectedly");
    expect(describeFailure({ password: "hunter2-secret" })).toBe("unknown failure");
    const wrapped = new Error("Failed query: select 1", { cause: error });
    expect(describeFailure(wrapped)).toBe(
      "(no code) Failed query: select 1; cause: (no code) Connection terminated unexpectedly",
    );
  });
});

describeDb("connections the server closes", () => {
  let testDb: TestDatabase;
  let logged: MockInstance<typeof console.error>;

  beforeAll(async () => {
    testDb = await createTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function backendPid(queryable: pg.Pool | pg.Client): Promise<number> {
    const result = await queryable.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = result.rows[0]?.pid;
    if (pid === undefined) throw new Error("no backend pid");
    return pid;
  }

  /** What pg_terminate_backend does to idle connections when Neon or PgBouncer drops them. */
  async function terminate(pid: number): Promise<void> {
    await testDb.pool.query("select pg_terminate_backend($1)", [pid]);
  }

  /** Every console.error call so far, joined; asserts each argument was a string. */
  function loggedText(): string {
    const args = logged.mock.calls.flat();
    for (const arg of args) expect(typeof arg).toBe("string");
    return args.join("\n");
  }

  it("a pool logs and discards an idle client, then reconnects", async () => {
    const pool = createPool({ connectionString: testDb.url, max: 1 });
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const firstPid = await backendPid(pool);
      expect(pool.idleCount).toBe(1);

      await terminate(firstPid);
      await vi.waitFor(() => expect(logged).toHaveBeenCalledOnce());

      expect(pool.totalCount).toBe(0);
      const text = loggedText();
      expect(text).toContain("57P01");
      expect(text).not.toContain(testDb.url);
      expect(await backendPid(pool)).not.toBe(firstPid);
    } finally {
      logged.mockRestore();
      await pool.end();
    }
  });

  it("a single client logs the loss, and its next query fails", async () => {
    const client = createClient({ connectionString: testDb.url });
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await client.connect();
      await terminate(await backendPid(client));
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());

      expect(loggedText()).not.toContain(testDb.url);
      await expect(client.query("select 1")).rejects.toThrow();
    } finally {
      logged.mockRestore();
      await client.end().catch(() => undefined);
    }
  });
});
