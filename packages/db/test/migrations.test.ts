import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder, runMigrations } from "../src/migrate.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { describeTable, schemaTables } from "./support/schema.ts";

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

  async function appliedMigrationCount(): Promise<number> {
    const result = await testDb.pool.query<{ count: string }>(
      "select count(*) from drizzle.__drizzle_migrations",
    );
    return Number(result.rows[0]?.count);
  }

  it("records every journal entry as applied", async () => {
    expect(await appliedMigrationCount()).toBe(journal.entries.length);
  });

  it("creates every table and column declared in the schema", async () => {
    const result = await testDb.pool.query<{ name: string }>(`
      select table_schema || '.' || table_name || '.' || column_name as name
      from information_schema.columns
    `);
    const actual = new Set(result.rows.map((row) => row.name));
    const expected = schemaTables().flatMap((table) => {
      const { name, columns } = describeTable(table);
      return columns.map((column) => `${name}.${column}`);
    });
    expect(expected.filter((column) => !actual.has(column))).toEqual([]);
  });

  it("applies nothing twice when runs overlap", async () => {
    await Promise.all([
      runMigrations(testDb.url),
      runMigrations(testDb.url),
      runMigrations(testDb.url),
    ]);
    expect(await appliedMigrationCount()).toBe(journal.entries.length);
  });
});
