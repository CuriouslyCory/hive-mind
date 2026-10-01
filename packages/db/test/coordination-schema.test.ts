import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { allocatePlanNumber, withCoordinationLock } from "../src/coordination.ts";
import {
  EventPayloadTooLargeError,
  encodedJsonBytes,
  insertEvent,
  MAX_EVENT_DTO_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
} from "../src/event.ts";
import { runMigrations } from "../src/migrate.ts";
import type { Principal } from "../src/principal.ts";
import { agentSession, plan, task } from "../src/schema/coordination.ts";
import { event } from "../src/schema/event.ts";
import { project } from "../src/schema/project.ts";
import { scope, scopeCollectionBatch } from "../src/schema/scope.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import {
  FINGERPRINT,
  insertPlan,
  insertProject,
  insertSession,
  insertTask,
} from "./support/fixtures.ts";
import { migrateFrom, migrationsFolderWith } from "./support/migrations.ts";

/** The migrations M1 shipped. */
const M1_MIGRATIONS = [
  "0000_auth",
  "0001_account_provider_unique",
  "0002_project_device_code_api_key",
];

let testDb: TestDatabase;

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

/** Two Projects, each with a User, an active Plan with one Task, and a Session. */
async function twoProjects() {
  const sides = [];
  for (let i = 0; i < 2; i++) {
    const seeded = await insertProject(testDb.db);
    const principal: Principal = { kind: "user", userId: seeded.user.id };
    const p = await insertPlan(testDb.db, seeded.project.id, principal);
    const t = await insertTask(testDb.db, seeded.project.id, p.id, principal);
    const s = await insertSession(testDb.db, seeded.project.id, principal);
    sides.push({ ...seeded, principal, plan: p, task: t, session: s });
  }
  const [a, b] = sides;
  if (!a || !b) throw new Error("unreachable");
  return { a, b };
}

const violation = (code: string, constraint: string) => ({ cause: { code, constraint } });

describeDb("coordination schema: cross-Project references", () => {
  it("rejects a Task whose Plan is in another Project", async () => {
    const { a, b } = await twoProjects();
    await expect(insertTask(testDb.db, b.project.id, a.plan.id, b.principal)).rejects.toMatchObject(
      violation("23503", "task_plan_fk"),
    );
  });

  it("rejects a claim held by a Session of another Project", async () => {
    const { a, b } = await twoProjects();
    const now = new Date();
    await expect(
      testDb.db
        .update(task)
        .set({ claimedBySessionId: b.session.id, claimedAt: now, leaseExpiresAt: now })
        .where(eq(task.id, a.task.id)),
    ).rejects.toMatchObject(violation("23503", "task_claimed_by_session_fk"));
  });

  it("rejects Session attachments across Projects or to a Task of another Plan", async () => {
    const { a, b } = await twoProjects();
    const otherPlan = await insertPlan(testDb.db, a.project.id, a.principal);
    const attach = (values: Partial<typeof agentSession.$inferInsert>) =>
      testDb.db.update(agentSession).set(values).where(eq(agentSession.id, a.session.id));

    await expect(attach({ attachedPlanId: b.plan.id })).rejects.toMatchObject(
      violation("23503", "agent_session_attached_plan_fk"),
    );
    await expect(
      attach({ attachedPlanId: otherPlan.id, attachedTaskId: a.task.id }),
    ).rejects.toMatchObject(violation("23503", "agent_session_attached_task_fk"));
    await expect(attach({ attachedTaskId: a.task.id })).rejects.toMatchObject(
      violation("23514", "agent_session_attached_task_check"),
    );
    await expect(
      attach({ attachedPlanId: a.plan.id, attachedTaskId: a.task.id }),
    ).resolves.toBeDefined();
  });

  it("rejects Event references to another Project's records", async () => {
    const { a, b } = await twoProjects();
    const base = {
      projectId: a.project.id,
      type: "test",
      payloadVersion: 1,
      payload: {},
      actorKind: "user" as const,
      actorUserId: a.user.id,
      effectiveAt: new Date(),
    };
    const cases: [Partial<typeof event.$inferInsert>, string][] = [
      [{ planId: b.plan.id }, "event_plan_fk"],
      [{ taskId: b.task.id }, "event_task_fk"],
      [{ sessionId: b.session.id }, "event_session_fk"],
      [{ actorSessionId: b.session.id }, "event_actor_session_fk"],
    ];
    for (const [references, constraint] of cases) {
      await expect(
        testDb.db.insert(event).values({ ...base, ...references }),
      ).rejects.toMatchObject(violation("23503", constraint));
    }
    await expect(
      testDb.db.insert(event).values({
        ...base,
        planId: a.plan.id,
        taskId: a.task.id,
        sessionId: a.session.id,
        actorSessionId: a.session.id,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects Scopes and collection receipts of another Project's Session", async () => {
    const { a, b } = await twoProjects();
    await expect(
      testDb.db.insert(scope).values({
        projectId: a.project.id,
        sessionId: b.session.id,
        source: "declared",
        value: "src/**",
      }),
    ).rejects.toMatchObject(violation("23503", "scope_session_fk"));
    await expect(
      testDb.db.insert(scopeCollectionBatch).values({
        projectId: a.project.id,
        sessionId: b.session.id,
        collectionId: randomUUID(),
        batchIndex: 0,
        paths: ["a.ts"],
        fingerprint: FINGERPRINT,
      }),
    ).rejects.toMatchObject(violation("23503", "scope_collection_batch_session_fk"));
  });
});

describeDb("coordination schema: row checks", () => {
  it("requires exactly one Session owner, matching owner_kind", async () => {
    const { a } = await twoProjects();
    const keyId = randomUUID();
    const bad: Partial<typeof agentSession.$inferInsert>[] = [
      { ownerKind: "user", userId: a.user.id, keyId },
      { ownerKind: "user", userId: null, keyId: null },
      { ownerKind: "key", userId: null, keyId: null },
      { ownerKind: "key", userId: a.user.id, keyId: null },
    ];
    for (const owner of bad) {
      await expect(
        insertSession(testDb.db, a.project.id, a.principal, owner),
      ).rejects.toMatchObject(violation("23514", "agent_session_owner_check"));
    }
    // A key id is historical identity with no foreign key: any UUID is accepted.
    const keyOwned = await insertSession(testDb.db, a.project.id, { kind: "project_key", keyId });
    expect(keyOwned).toMatchObject({ ownerKind: "key", keyId, userId: null });
  });

  it("allows a Plan number once per Project", async () => {
    const { a, b } = await twoProjects();
    await insertPlan(testDb.db, a.project.id, a.principal, { number: 7 });
    await expect(
      insertPlan(testDb.db, a.project.id, a.principal, { number: 7 }),
    ).rejects.toMatchObject(violation("23505", "plan_project_id_number_unique"));
    await expect(
      insertPlan(testDb.db, b.project.id, b.principal, { number: 7 }),
    ).resolves.toBeDefined();
  });

  it("keeps a Task's claim columns together and clears the claim when done", async () => {
    const { a } = await twoProjects();
    const now = new Date();
    await expect(
      testDb.db
        .update(task)
        .set({ claimedBySessionId: a.session.id })
        .where(eq(task.id, a.task.id)),
    ).rejects.toMatchObject(violation("23514", "task_claim_check"));
    await expect(
      testDb.db
        .update(task)
        .set({
          status: "done",
          claimedBySessionId: a.session.id,
          claimedAt: now,
          leaseExpiresAt: now,
        })
        .where(eq(task.id, a.task.id)),
    ).rejects.toMatchObject(violation("23514", "task_done_unclaimed_check"));
    await expect(
      testDb.db.update(task).set({ status: "blocked" }).where(eq(task.id, a.task.id)),
    ).rejects.toMatchObject(violation("23514", "task_block_reason_check"));
  });

  it("gives a system actor no principal or Session", async () => {
    const { a } = await twoProjects();
    await expect(
      testDb.db.insert(event).values({
        projectId: a.project.id,
        type: "test",
        payloadVersion: 1,
        payload: {},
        actorKind: "system",
        actorSessionId: a.session.id,
        effectiveAt: new Date(),
      }),
    ).rejects.toMatchObject(violation("23514", "event_actor_check"));
  });
});

describeDb("coordination schema: Event ordering columns", () => {
  it("has database defaults for seq and writer_xid", async () => {
    const result = await testDb.pool.query<{ column_name: string; column_default: string }>(`
      select column_name, column_default from information_schema.columns
      where table_name = 'event' and column_name in ('seq', 'writer_xid')
      order by column_name
    `);
    expect(result.rows).toEqual([
      { column_name: "seq", column_default: "nextval('event_seq_seq'::regclass)" },
      { column_name: "writer_xid", column_default: "pg_current_xact_id()" },
    ]);
  });

  it("fills seq and writer_xid from Postgres, as decimal strings", async () => {
    const { a } = await twoProjects();
    const { rows, xid } = await withCoordinationLock(
      testDb.db,
      a.project.id,
      async ({ tx, now }) => {
        const insert = () =>
          insertEvent(tx, {
            projectId: a.project.id,
            type: "plan.log_appended",
            payload: { message: "hello" },
            actor: { ...a.principal, sessionId: a.session.id },
            planId: a.plan.id,
            now,
          });
        const rows = [await insert(), await insert()];
        const current = await tx.execute<{ xid: string }>(
          sql`select pg_current_xact_id()::text as xid`,
        );
        return { rows, xid: current.rows[0]?.xid };
      },
    );
    const [first, second] = rows;
    if (!first || !second) throw new Error("missing rows");
    expect(first.seq).toMatch(/^\d+$/);
    expect(BigInt(second.seq)).toBeGreaterThan(BigInt(first.seq));
    expect(first.writerXid).toBe(xid);
    expect(second.writerXid).toBe(xid);
    expect(first).toMatchObject({
      payloadVersion: 1,
      actorKind: "user",
      actorUserId: a.user.id,
      actorSessionId: a.session.id,
      planId: a.plan.id,
    });
  });

  it("round-trips seq and writer_xid above 2^53 exactly", async () => {
    const { a } = await twoProjects();
    await testDb.pool.query(
      "select setval(pg_get_serial_sequence('event', 'seq'), 9007199254740993)",
    );
    const inserted = await withCoordinationLock(testDb.db, a.project.id, ({ tx, now }) =>
      insertEvent(tx, {
        projectId: a.project.id,
        type: "task.done",
        payload: {},
        actor: { kind: "system" },
        taskId: a.task.id,
        now,
      }),
    );
    expect(inserted.seq).toBe("9007199254740994");

    // No transaction id this high exists yet, so write one directly.
    const maxXid = "18446744073709551615";
    await testDb.pool.query("update event set writer_xid = $1::xid8 where id = $2", [
      maxXid,
      inserted.id,
    ]);
    const [read] = await testDb.db.select().from(event).where(eq(event.id, inserted.id));
    expect(read).toMatchObject({ seq: "9007199254740994", writerXid: maxXid });
  });

  it("bounds the payload, with room for the largest legitimate one", async () => {
    const { a } = await twoProjects();
    // 8 KiB of a character JSON escapes as six bytes.
    const message = "\u0001".repeat(8 * 1024);
    const stored = await withCoordinationLock(testDb.db, a.project.id, ({ tx, now }) =>
      insertEvent(tx, {
        projectId: a.project.id,
        type: "plan.log_appended",
        payload: { message },
        actor: a.principal,
        planId: a.plan.id,
        now,
      }),
    );
    expect(encodedJsonBytes(stored.payload)).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
    expect(encodedJsonBytes(stored)).toBeLessThanOrEqual(MAX_EVENT_DTO_BYTES);

    await expect(
      withCoordinationLock(testDb.db, a.project.id, ({ tx, now }) =>
        insertEvent(tx, {
          projectId: a.project.id,
          type: "plan.log_appended",
          payload: { message: "x".repeat(MAX_EVENT_PAYLOAD_BYTES) },
          actor: a.principal,
          now,
        }),
      ),
    ).rejects.toBeInstanceOf(EventPayloadTooLargeError);
  });
});

describeDb("coordination schema: upgrade from M1", () => {
  it("adds the Plan counter to existing Projects and keeps M1 inserts working", async () => {
    const upgraded = await createTestDatabase({ migrate: false });
    const m1Folder = migrationsFolderWith(M1_MIGRATIONS);
    try {
      await migrateFrom(upgraded.url, m1Folder);
      const insertM1Project = async (slug: string) => {
        const result = await upgraded.pool.query<{ id: string }>(
          `with org as (insert into organization (name, slug) values ($1, $1) returning id)
           insert into project (organization_id, slug, name, repo_url)
           select id, 'app', 'App', null from org returning id`,
          [slug],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("project insert returned no row");
        return id;
      };
      const existing = await insertM1Project(`m1-${randomUUID().slice(0, 8)}`);

      await runMigrations(upgraded.url);

      const afterInsert = await insertM1Project(`m2-${randomUUID().slice(0, 8)}`);
      const rows = await upgraded.db
        .select({
          id: project.id,
          nextPlanNumber: project.nextPlanNumber,
          coordinationSweptAt: project.coordinationSweptAt,
        })
        .from(project);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: existing, nextPlanNumber: 1, coordinationSweptAt: null },
          { id: afterInsert, nextPlanNumber: 1, coordinationSweptAt: null },
        ]),
      );
      const number = await withCoordinationLock(upgraded.db, existing, ({ tx }) =>
        allocatePlanNumber(tx, existing),
      );
      expect(number).toBe(1);
      expect(await upgraded.db.select().from(plan)).toEqual([]);
    } finally {
      rmSync(m1Folder, { recursive: true });
      await upgraded.drop();
    }
  });
});
