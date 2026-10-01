import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  claimableCondition,
  effectiveSessionStatusSql,
  leaseExpired,
  materializeSessionStatus,
  releaseClaims,
} from "../src/lifecycle.ts";
import { effectiveSessionStatus } from "../src/liveness.ts";
import { agentSession, task } from "../src/schema/coordination.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertSession, insertTask } from "./support/fixtures.ts";
import { ago, dbNow, later, MINUTE, setupProject } from "./support/lifecycle.ts";

// The 5- and 30-minute Session thresholds and the 5-minute lease, exactly at
// their inclusive boundaries and one millisecond either side. The SQL and
// write paths take the transaction's `now` as a parameter, so the tests fix
// it instead of racing the database clock (session.test.ts checks the same
// thresholds through the public functions, with a margin).

let testDb: TestDatabase;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

const STALE = 5 * MINUTE;
const ABANDONED = 30 * MINUTE;
const AGES = [
  [STALE - 1, "active"],
  [STALE, "stale"],
  [STALE + 1, "stale"],
  [ABANDONED - 1, "stale"],
  [ABANDONED, "abandoned"],
  [ABANDONED + 1, "abandoned"],
] as const;

describeDb("liveness boundaries", () => {
  it("SQL and JavaScript agree on effective status at, before and after each threshold", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const now = await dbNow(testDb.db);
    const sessions = [];
    for (const [age, expected] of AGES) {
      const row = await insertSession(testDb.db, project.id, principal, {
        lastHeartbeatAt: ago(now, age),
      });
      expect(effectiveSessionStatus(row, now)).toBe(expected);
      sessions.push(row);
    }
    const rows = await testDb.db
      .select({ id: agentSession.id, effective: effectiveSessionStatusSql(now) })
      .from(agentSession)
      .where(eq(agentSession.projectId, project.id));
    const byId = new Map(rows.map((row) => [row.id, row.effective]));
    expect(sessions.map((row) => byId.get(row.id))).toEqual(AGES.map(([, expected]) => expected));
  });

  it("materializes stale at exactly 5 minutes and abandoned at exactly 30", async () => {
    const { project, principal } = await setupProject(testDb.db);
    const now = await dbNow(testDb.db);
    const written: string[][] = [];
    for (const [age] of AGES) {
      const row = await insertSession(testDb.db, project.id, principal, {
        lastHeartbeatAt: ago(now, age),
      });
      written.push(await testDb.db.transaction((tx) => materializeSessionStatus(tx, now, row)));
    }
    expect(written).toEqual([
      [],
      ["stale"],
      ["stale"],
      ["stale"],
      ["stale", "abandoned"],
      ["stale", "abandoned"],
    ]);
  });

  it("makes a claim takeable exactly at lease expiry or when the holder turns stale", async () => {
    const { project, principal, plan } = await setupProject(testDb.db);
    const now = await dbNow(testDb.db);
    const live = await insertSession(testDb.db, project.id, principal, {
      lastHeartbeatAt: ago(now, MINUTE),
    });
    const claimed = async (sessionId: string, leaseExpiresAt: Date) =>
      insertTask(testDb.db, project.id, plan.id, principal, {
        claimedBySessionId: sessionId,
        claimedAt: ago(now, MINUTE),
        leaseExpiresAt,
      });
    const holderAt = async (age: number) =>
      insertSession(testDb.db, project.id, principal, { lastHeartbeatAt: ago(now, age) });

    const cases = [
      [await claimed(live.id, later(now, 1)), false],
      [await claimed(live.id, now), true],
      [await claimed(live.id, ago(now, 1)), true],
      [await claimed((await holderAt(STALE - 1)).id, later(now, MINUTE)), false],
      [await claimed((await holderAt(STALE)).id, later(now, MINUTE)), true],
    ] as const;
    const takeable = await testDb.db
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          inArray(
            task.id,
            cases.map(([row]) => row.id),
          ),
          claimableCondition(now),
        ),
      );
    const ids = new Set(takeable.map((row) => row.id));
    expect(cases.map(([row]) => ids.has(row.id))).toEqual(cases.map(([, expected]) => expected));
  });

  it("releases a lease exactly at its expiry, not a millisecond before", async () => {
    const { project, principal, plan } = await setupProject(testDb.db);
    const now = await dbNow(testDb.db);
    const holder = await insertSession(testDb.db, project.id, principal, {
      lastHeartbeatAt: ago(now, MINUTE),
    });
    const lease = (leaseExpiresAt: Date) =>
      insertTask(testDb.db, project.id, plan.id, principal, {
        claimedBySessionId: holder.id,
        claimedAt: ago(now, MINUTE),
        leaseExpiresAt,
      });
    const atExpiry = await lease(now);
    await lease(later(now, 1));
    const released = await testDb.db.transaction((tx) =>
      releaseClaims(tx, {
        projectId: project.id,
        now,
        where: leaseExpired(now),
        reason: "lease_expired",
        actor: { kind: "system" },
      }),
    );
    expect(released.map((claim) => claim.taskId)).toEqual([atExpiry.id]);
  });
});
