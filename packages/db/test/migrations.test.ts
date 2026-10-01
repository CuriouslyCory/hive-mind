import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder, runMigrations } from "../src/migrate.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { databaseKeys, describeTable, schemaKeys, schemaTables } from "./support/schema.ts";

const journal = JSON.parse(
  readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: unknown[] };

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
});
