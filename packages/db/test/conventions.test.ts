import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createdAt, id, timestamptz, updatedAt } from "../src/columns.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import {
  databaseConventionViolations,
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
