import type { Db } from "@hivemind/db";
import { trackerBacklogPhase } from "@hivemind/db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { TrackerRuleError } from "@hivemind/tracker";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeTrackerAction, TRACKER_ACTION_FAILED } from "../src/server/tracker-action";

// What the tracker page's server action answers (apps/web/src/app/(app)/
// tracker/actions.ts): the command's result, a TrackerError's own message,
// or a generic message for anything else, which is logged.

/** A Db whose transactions fail with `error`, for the error paths. */
function failingDb(error: unknown): Db {
  return {
    transaction: async () => {
      throw error;
    },
  } as unknown as Db;
}

describe("executeTrackerAction errors", () => {
  it("refuses an unknown command without touching the database", async () => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as Db;
    await expect(executeTrackerAction(db, "drop-everything", {})).resolves.toEqual({
      ok: false,
      error: "Unknown tracker command.",
    });
    await expect(executeTrackerAction(db, 42, {})).resolves.toMatchObject({ ok: false });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("passes a TrackerError's message through", async () => {
    const result = await executeTrackerAction(
      failingDb(new TrackerRuleError("A phase with issues cannot be deleted.")),
      "delete-phase",
      {},
    );
    expect(result).toEqual({ ok: false, error: "A phase with issues cannot be deleted." });
  });

  it("logs anything else and answers with a generic message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await executeTrackerAction(
      failingDb(new Error("connection to 10.0.0.5 refused, password=hunter2")),
      "save-phase",
      {},
    );
    expect(result).toEqual({ ok: false, error: TRACKER_ACTION_FAILED });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("save-phase");
  });
});

describeDb("executeTrackerAction against the database", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it("runs a command and returns its result", async () => {
    const result = await executeTrackerAction(testDb.db, "save-phase", {
      title: "  M4: ADRs  ",
      description: "",
      sortOrder: 0,
    });
    expect(result).toEqual({ ok: true, result: { id: expect.any(String) } });
    const id = (result as { result: { id: string } }).result.id;
    const [row] = await testDb.db
      .select()
      .from(trackerBacklogPhase)
      .where(eq(trackerBacklogPhase.id, id));
    expect(row).toMatchObject({ title: "M4: ADRs", description: null });
  });

  it("answers invalid input with the fields that failed", async () => {
    const result = await executeTrackerAction(testDb.db, "save-phase", {
      title: "",
      description: null,
      sortOrder: 0,
      colour: "red",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("title");
    expect(result.error).not.toBe(TRACKER_ACTION_FAILED);
  });
});
