import { beforeEach, describe, expect, it, vi } from "vitest";

// The tracker page's server action (apps/web/src/app/(app)/tracker/
// actions.ts) is a public POST endpoint, so it checks access itself before
// it opens the database or runs the command. The access check, the database
// and the command runner are stand-ins.

const access = vi.hoisted(() => ({ denial: null as Error | null }));
const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const DB = { name: "stand-in db" };

vi.mock("../src/server/tracker-access", () => ({
  requireTrackerAccess: vi.fn(async () => {
    if (access.denial) throw access.denial;
    return { user: { id: "user-1" }, loginSession: {} };
  }),
}));
vi.mock("../src/server/db", () => ({
  getDb: vi.fn(() => DB),
}));
vi.mock("../src/server/tracker-action", () => ({
  executeTrackerAction: vi.fn(async () => ({ ok: true, result: { id: "phase-1" } })),
}));

const { requireTrackerAccess } = await import("../src/server/tracker-access");
const { getDb } = await import("../src/server/db");
const { executeTrackerAction } = await import("../src/server/tracker-action");
const { runTrackerAction } = await import("../src/app/(app)/tracker/actions");

describe("runTrackerAction", () => {
  beforeEach(() => {
    access.denial = null;
    vi.clearAllMocks();
  });

  it("stops at a refused access check, before the database or the command", async () => {
    access.denial = NOT_FOUND;
    await expect(runTrackerAction("delete-phase", { id: "phase-1" })).rejects.toBe(NOT_FOUND);
    expect(requireTrackerAccess).toHaveBeenCalledOnce();
    expect(getDb).not.toHaveBeenCalled();
    expect(executeTrackerAction).not.toHaveBeenCalled();
  });

  it("runs the command after the access check passes", async () => {
    const input = { title: "M4: ADRs", description: "", sortOrder: 0 };
    await expect(runTrackerAction("save-phase", input)).resolves.toEqual({
      ok: true,
      result: { id: "phase-1" },
    });
    expect(executeTrackerAction).toHaveBeenCalledWith(DB, "save-phase", input);
    const checked = vi.mocked(requireTrackerAccess).mock.invocationCallOrder[0] ?? Infinity;
    const opened = vi.mocked(getDb).mock.invocationCallOrder[0] ?? -Infinity;
    expect(checked).toBeLessThan(opened);
  });
});
