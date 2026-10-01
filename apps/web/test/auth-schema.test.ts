import { createDb } from "@hivemind/db";
import * as schema from "@hivemind/db/schema";
import { type BetterAuthDBSchema, getAuthTables } from "better-auth/db";
import { is } from "drizzle-orm";
import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/server/auth";

// Checks packages/db/src/schema/auth.ts against the tables better-auth writes
// for the plugins configured in createAuth (organization, device
// authorization, api-key). Adding a plugin without its tables, or dropping a
// field, fails here instead of at runtime.

// The pool never connects: the auth instance is built only to read its options.
const auth = createAuth({
  db: createDb(new pg.Pool({ connectionString: "postgres://unused@127.0.0.1:1/unused" })),
  secret: "x".repeat(32),
  github: { clientId: "id", clientSecret: "secret" },
  oauthProxySecret: "y".repeat(32),
  allowedHosts: ["localhost:3000"],
});

// better-auth field types and the SQL types that can hold them. Strings are
// text, or uuid for ids and foreign keys (`generateId: "uuid"`).
const SQL_TYPES: Record<string, string[]> = {
  string: ["text", "uuid"],
  boolean: ["boolean"],
  date: ["timestamp with time zone"],
  number: ["integer", "bigint", "double precision"],
};

/** `deviceCode` -> `device_code`: the SQL name for a better-auth model name. */
function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** One message per mismatch between better-auth's tables and the Drizzle schema. */
function schemaDrift(expected: BetterAuthDBSchema): string[] {
  const tables = schema as Record<string, unknown>;
  const problems: string[] = [];
  for (const { modelName, fields } of Object.values(expected)) {
    // The Drizzle adapter looks each table up by its export name.
    const table = tables[modelName];
    if (!is(table, PgTable)) {
      problems.push(`${modelName}: no table exported under this name`);
      continue;
    }
    const config = getTableConfig(table);
    if (config.name !== snakeCase(modelName)) {
      problems.push(`${modelName}: SQL table is named ${config.name}`);
    }
    const columns = table as unknown as Record<string, PgColumn | undefined>;
    if (columns.id?.getSQLType() !== "uuid" || !columns.id.primary) {
      problems.push(`${modelName}.id: not a uuid primary key`);
    }
    for (const [key, field] of Object.entries(fields)) {
      const name = field.fieldName ?? key;
      const column = columns[name];
      if (!column) {
        problems.push(`${modelName}.${name}: missing`);
        continue;
      }
      const type = typeof field.type === "string" ? field.type : "string";
      if (!SQL_TYPES[type]?.includes(column.getSQLType())) {
        problems.push(`${modelName}.${name}: ${column.getSQLType()} cannot hold a ${type}`);
      }
      const required = field.required !== false;
      if (required && !column.notNull) {
        problems.push(`${modelName}.${name}: nullable, but better-auth requires it`);
      }
      if (!required && column.notNull && !column.hasDefault) {
        problems.push(`${modelName}.${name}: not null without a default, but optional`);
      }
    }
  }
  return problems;
}

describe("auth schema", () => {
  const expected = getAuthTables(auth.options);

  it("covers the core, organization, device authorization and api-key tables", () => {
    expect(Object.values(expected).map((table) => table.modelName)).toEqual(
      expect.arrayContaining([
        "user",
        "session",
        "account",
        "verification",
        "organization",
        "member",
        "invitation",
        "deviceCode",
        "apikey",
      ]),
    );
  });

  it("has every table and field better-auth writes", () => {
    expect(schemaDrift(expected)).toEqual([]);
  });

  it("reports a missing field", () => {
    const withExtraField: BetterAuthDBSchema = Object.fromEntries(
      Object.entries(expected).map(([key, table]) => [
        key,
        table.modelName === "user"
          ? { ...table, fields: { ...table.fields, favoriteColor: { type: "string" } } }
          : table,
      ]),
    );
    expect(schemaDrift(withExtraField)).toEqual(["user.favoriteColor: missing"]);
  });
});
