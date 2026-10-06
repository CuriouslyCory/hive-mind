import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reserveAdr } from "../src/adr.ts";
import { listAdrs } from "../src/adr-read.ts";
import { migrationsFolder, runMigrations } from "../src/migrate.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { adrFiles, uploadAndSync } from "./support/adr.ts";
import { migrateFrom, migrationsFolderWith } from "./support/migrations.ts";
import { databaseKeys, describeTable, schemaKeys, schemaTables } from "./support/schema.ts";

const journal = JSON.parse(
  readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: { tag: string }[] };

/** The migrations M3 and the dev tracker shipped, before M4's ADR tables (issue #19). */
const PRE_M4_MIGRATIONS = [
  "0000_auth",
  "0001_account_provider_unique",
  "0002_project_device_code_api_key",
  "0003_m2_coordination",
  "0004_collection_omitted_path_count",
  "0005_dev_tracker",
];

describeDb("migrations", () => {
  // createTestDatabase applies the migrations to a new, empty database.
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function appliedMigrationCount(database: TestDatabase): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      "select count(*) from drizzle.__drizzle_migrations",
    );
    return Number(result.rows[0]?.count);
  }

  /** Schema columns (`schema.table.column`) that the database lacks. */
  async function missingColumns(database: TestDatabase): Promise<string[]> {
    const result = await database.pool.query<{ name: string }>(`
      select table_schema || '.' || table_name || '.' || column_name as name
      from information_schema.columns
    `);
    const actual = new Set(result.rows.map((row) => row.name));
    const expected = schemaTables().flatMap((table) => {
      const { name, columns } = describeTable(table);
      return columns.map((column) => `${name}.${column}`);
    });
    return expected.filter((column) => !actual.has(column));
  }

  it("records every journal entry as applied", async () => {
    expect(await appliedMigrationCount(testDb)).toBe(journal.entries.length);
  });

  it("creates every table and column declared in the schema", async () => {
    expect(await missingColumns(testDb)).toEqual([]);
  });

  // The drift check compares the schema with the migration snapshots, not the
  // SQL, so a statement deleted from a migration's SQL would pass it.
  it("creates every primary key, unique constraint, foreign key and index declared in the schema", async () => {
    expect(await databaseKeys(testDb.pool)).toEqual(schemaKeys(schemaTables()));
  });

  it("applies each migration once when runs race on an unmigrated database", async () => {
    const unmigrated = await createTestDatabase({ migrate: false });
    try {
      // allSettled, so every run has ended before the database is dropped.
      const runs = await Promise.allSettled([
        runMigrations(unmigrated.url),
        runMigrations(unmigrated.url),
        runMigrations(unmigrated.url),
      ]);
      expect(runs.filter((run) => run.status === "rejected")).toEqual([]);
      expect(await appliedMigrationCount(unmigrated)).toBe(journal.entries.length);
      expect(await missingColumns(unmigrated)).toEqual([]);
    } finally {
      await unmigrated.drop();
    }
  });

  it("upgrades a populated M2/M3 database, and pre-M4 writes keep working", async () => {
    const upgraded = await createTestDatabase({ migrate: false });
    const folder = migrationsFolderWith(PRE_M4_MIGRATIONS);
    try {
      await migrateFrom(upgraded.url, folder);
      // Written in SQL with the pre-M4 columns, as the running deployment
      // writes while the new one migrates.
      const insertPreM4Project = async () => {
        const slug = `org-${randomUUID().slice(0, 8)}`;
        const result = await upgraded.pool.query<{ id: string; organization_id: string }>(
          `with org as (insert into organization (name, slug) values ($1, $1) returning id)
           insert into project (organization_id, slug, name, repo_url, next_plan_number)
           select id, 'app', 'App', null, 3 from org returning id, organization_id`,
          [slug],
        );
        const row = result.rows[0];
        if (!row) throw new Error("project insert returned no row");
        return row;
      };
      const existing = await insertPreM4Project();
      const userResult = await upgraded.pool.query<{ id: string }>(
        `insert into "user" (name, email, github_login) values ('Mona', 'mona@example.com', 'mona')
         returning id`,
      );
      const userId = userResult.rows[0]?.id;
      if (!userId) throw new Error("user insert returned no row");
      await upgraded.pool.query(
        "insert into member (organization_id, user_id, role) values ($1, $2, 'owner')",
        [existing.organization_id, userId],
      );
      const fingerprint = "0".repeat(64);
      const planResult = await upgraded.pool.query<{ id: string }>(
        `insert into plan (project_id, number, title, status, created_by_kind, created_by_user_id, creation_fingerprint)
         values ($1, 1, 'Plan', 'active', 'user', $2, $3) returning id`,
        [existing.id, userId, fingerprint],
      );
      const planId = planResult.rows[0]?.id;
      await upgraded.pool.query(
        `insert into task (project_id, plan_id, title, position, created_by_kind, created_by_user_id, creation_fingerprint)
         values ($1, $2, 'Task', 1, 'user', $3, $4)`,
        [existing.id, planId, userId, fingerprint],
      );
      await upgraded.pool.query(
        `insert into agent_session (project_id, owner_kind, user_id, agent, intent, creation_fingerprint)
         values ($1, 'user', $2, 'claude-code', 'Test', $3)`,
        [existing.id, userId, fingerprint],
      );
      await upgraded.pool.query(
        `insert into event (project_id, type, payload_version, payload, actor_kind, actor_user_id, plan_id, effective_at)
         values ($1, 'plan.created', 1, '{"key":"PLAN-1","title":"Plan","status":"active"}', 'user', $2, $3, now())`,
        [existing.id, userId, planId],
      );
      const counts = async () => {
        const result = await upgraded.pool.query<Record<string, string>>(
          `select (select count(*) from plan) as plans, (select count(*) from task) as tasks,
             (select count(*) from agent_session) as sessions, (select count(*) from event) as events`,
        );
        return result.rows[0];
      };
      const before = await counts();

      await runMigrations(upgraded.url);

      expect(await appliedMigrationCount(upgraded)).toBe(journal.entries.length);
      expect(await missingColumns(upgraded)).toEqual([]);
      expect(await counts()).toEqual(before);
      const afterInsert = await insertPreM4Project();
      const projects = await upgraded.pool.query(
        `select id, next_plan_number, next_adr_number, adr_synced_commit_sha, adr_synced_at,
           adr_synced_by_kind, adr_synced_by_user_id, adr_synced_by_key_id
         from project order by id`,
      );
      const defaults = {
        next_plan_number: 3,
        next_adr_number: 1,
        adr_synced_commit_sha: null,
        adr_synced_at: null,
        adr_synced_by_kind: null,
        adr_synced_by_user_id: null,
        adr_synced_by_key_id: null,
      };
      expect(projects.rows).toEqual(
        expect.arrayContaining([
          { id: existing.id, ...defaults },
          { id: afterInsert.id, ...defaults },
        ]),
      );

      const principal = { kind: "user" as const, userId };
      const context = { projectId: existing.id, principal };
      expect((await listAdrs(upgraded.db, { ...context, limit: 10 })).sync).toBeNull();
      await expect(
        reserveAdr(upgraded.db, { ...context, id: randomUUID(), title: "First", slug: "first" }),
      ).resolves.toMatchObject({ status: "created", adr: { number: 1 } });
      await expect(uploadAndSync(upgraded.db, context, adrFiles(3))).resolves.toMatchObject({
        status: "ok",
        summary: { added: 3, nextNumber: 4 },
      });
    } finally {
      rmSync(folder, { recursive: true });
      await upgraded.drop();
    }
  });
});
