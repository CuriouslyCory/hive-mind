import { is } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type pg from "pg";
import * as schema from "../../src/schema/index.ts";

// Must match the `casing` passed to Drizzle in src/index.ts and drizzle.config.ts.
const casing = new CasingCache("snake_case");

/** Every table exported from the Drizzle schema, so these checks grow as tables are added. */
export function schemaTables(): PgTable[] {
  return Object.values(schema as Record<string, unknown>).filter((value): value is PgTable =>
    is(value, PgTable),
  );
}

/** A table's `schema.table` name and its columns' database names. */
export function describeTable(table: PgTable): { name: string; columns: string[] } {
  const config = getTableConfig(table);
  return {
    name: `${config.schema ?? "public"}.${config.name}`,
    columns: config.columns.map((column) => casing.getColumnCasing(column)),
  };
}

/**
 * Checks Drizzle table definitions against the database conventions
 * (ADR-0005): every primary key column is `uuid` and every timestamp column is
 * `timestamp with time zone`. Returns one message per violation, sorted.
 */
export function schemaConventionViolations(tables: PgTable[]): string[] {
  const violations: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const tableName = `${config.schema ?? "public"}.${config.name}`;
    // Composite keys reference separate column instances, so match by name.
    const primaryKeyColumns = new Set([
      ...config.columns.filter((column) => column.primary).map((column) => column.name),
      ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
    ]);
    for (const column of config.columns) {
      const columnName = `${tableName}.${casing.getColumnCasing(column)}`;
      const type = column.getSQLType();
      if (primaryKeyColumns.has(column.name) && type !== "uuid") {
        violations.push(`${columnName}: primary key is ${type}, not uuid`);
      }
      if (isTimestampWithoutTimeZone(type)) {
        violations.push(`${columnName}: ${type}, not timestamp with time zone`);
      }
    }
  }
  return violations.sort();
}

function isTimestampWithoutTimeZone(sqlType: string): boolean {
  return sqlType.startsWith("timestamp") && !sqlType.endsWith("with time zone");
}

// Drizzle's migration bookkeeping lives in the `drizzle` schema and uses a
// serial id, so it is exempt.
const EXCLUDED_SCHEMAS = "('pg_catalog', 'information_schema', 'drizzle')";

/**
 * The same checks as `schemaConventionViolations`, run against the live
 * database through `information_schema`. This catches migrations that
 * disagree with the Drizzle schema, such as hand-edited SQL.
 */
export async function databaseConventionViolations(client: pg.Pool | pg.Client): Promise<string[]> {
  const primaryKeys = await client.query<{ name: string; data_type: string }>(`
    select c.table_schema || '.' || c.table_name || '.' || c.column_name as name, c.data_type
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_schema = tc.constraint_schema
      and kcu.constraint_name = tc.constraint_name
      and kcu.table_name = tc.table_name
    join information_schema.columns c
      on c.table_schema = kcu.table_schema
      and c.table_name = kcu.table_name
      and c.column_name = kcu.column_name
    where tc.constraint_type = 'PRIMARY KEY'
      and tc.table_schema not in ${EXCLUDED_SCHEMAS}
      and c.data_type <> 'uuid'
  `);
  const timestamps = await client.query<{ name: string; data_type: string }>(`
    select table_schema || '.' || table_name || '.' || column_name as name, data_type
    from information_schema.columns
    where table_schema not in ${EXCLUDED_SCHEMAS}
      and data_type = 'timestamp without time zone'
  `);
  return [
    ...primaryKeys.rows.map((row) => `${row.name}: primary key is ${row.data_type}, not uuid`),
    ...timestamps.rows.map((row) => `${row.name}: ${row.data_type}, not timestamp with time zone`),
  ].sort();
}
