import {
  getTableConfig,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createdAt, id, timestamptz, updatedAt } from "../src/columns.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import {
  databaseConventionViolations,
  describeTable,
  schemaConventionViolations,
  schemaTables,
} from "./support/schema.ts";

// Fixture tables for testing the checkers themselves. They are not part of the
// schema, so they never reach a migration.
const conforming = pgTable("conforming_fixture", {
  id: id(),
  happenedAt: timestamptz(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const textKeyAndPlainTimestamp = pgTable("violating_fixture", {
  id: text().primaryKey(),
  happenedAt: timestamp(),
  precise: timestamp({ precision: 3, mode: "string" }),
  zoned: timestamp({ withTimezone: true }),
});

const compositeKey = pgTable(
  "composite_fixture",
  {
    ownerId: uuid().notNull(),
    position: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.position] })],
);

describe("schemaConventionViolations", () => {
  it("accepts tables built from the column helpers", () => {
    expect(schemaConventionViolations([conforming])).toEqual([]);
  });

  it("rejects a non-uuid primary key and timestamps without a time zone", () => {
    expect(schemaConventionViolations([textKeyAndPlainTimestamp])).toEqual([
      "public.violating_fixture.happened_at: timestamp, not timestamp with time zone",
      "public.violating_fixture.id: primary key is text, not uuid",
      "public.violating_fixture.precise: timestamp(3), not timestamp with time zone",
    ]);
  });

  it("checks every column of a composite primary key", () => {
    expect(schemaConventionViolations([compositeKey])).toEqual([
      "public.composite_fixture.position: primary key is integer, not uuid",
    ]);
  });

  it("finds no violations in the schema", () => {
    expect(schemaConventionViolations(schemaTables())).toEqual([]);
  });
});

describe("table names and Project ownership", () => {
  // The M2 coordination tables (issue #12) and M4's ADR tables (issue #19).
  // Each stores the Project it belongs to, so composite foreign keys can keep
  // references within it.
  const coordinationTables = [
    "adr",
    "adr_content",
    "agent_session",
    "event",
    "plan",
    "scope",
    "scope_collection_batch",
    "task",
  ];

  it("names every table in singular snake_case", () => {
    const names = schemaTables().map((table) => describeTable(table).name.replace(/^public\./, ""));
    expect(names.filter((name) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name))).toEqual([]);
    // Plural names end in "s"; no table name here legitimately does.
    expect(names.filter((name) => name.endsWith("s"))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(coordinationTables));
  });

  it("gives every coordination table a non-null project_id", () => {
    const missing = schemaTables()
      .map((table) => ({ name: getTableConfig(table).name, config: getTableConfig(table) }))
      .filter(({ name }) => coordinationTables.includes(name))
      .filter(({ config }) => {
        const column = config.columns.find(
          (c) => c.name === "projectId" || c.name === "project_id",
        );
        return !column?.notNull;
      })
      .map(({ name }) => name);
    expect(missing).toEqual([]);
  });

  it("keeps every reference between Project-owned tables inside one Project", () => {
    // References to project itself and to user carry no project_id.
    const references = schemaTables()
      .map((table) => getTableConfig(table))
      .filter((config) => coordinationTables.includes(config.name))
      .flatMap((config) =>
        config.foreignKeys.map((foreignKey) => ({ table: config.name, foreignKey })),
      )
      .filter(({ foreignKey }) =>
        coordinationTables.includes(getTableConfig(foreignKey.reference().foreignTable).name),
      )
      .map(({ table, foreignKey }) => ({
        name: `${table}: ${foreignKey.getName()}`,
        scoped: foreignKey
          .reference()
          .columns.some((column) => column.name === "projectId" || column.name === "project_id"),
      }));
    expect(references.map((reference) => reference.name)).toEqual(
      expect.arrayContaining(["adr: adr_content_sha256_fk", "adr: adr_reserved_session_fk"]),
    );
    expect(references.filter((reference) => !reference.scoped)).toEqual([]);
  });
});

describeDb("databaseConventionViolations", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it("finds no violations in the migrated database", async () => {
    expect(await databaseConventionViolations(testDb.pool)).toEqual([]);
  });

  it("rejects a non-uuid primary key and timestamps without a time zone", async () => {
    await testDb.pool.query(`
      create table violating_fixture (
        id text primary key,
        happened_at timestamp,
        zoned_at timestamptz
      )
    `);
    try {
      const violations = await databaseConventionViolations(testDb.pool);
      expect(violations.filter((v) => v.startsWith("public.violating_fixture."))).toEqual([
        "public.violating_fixture.happened_at: timestamp without time zone, not timestamp with time zone",
        "public.violating_fixture.id: primary key is text, not uuid",
      ]);
    } finally {
      await testDb.pool.query("drop table violating_fixture");
    }
  });
});
