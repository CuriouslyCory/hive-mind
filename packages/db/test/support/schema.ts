import { is } from "drizzle-orm";
import { CasingCache, toSnakeCase } from "drizzle-orm/casing";
import { getTableConfig, IndexedColumn, type PgColumn, PgTable } from "drizzle-orm/pg-core";
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

const REFERENTIAL_ACTIONS: Record<string, string> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

/**
 * The primary keys, unique constraints, foreign keys and indexes the Drizzle
 * schema declares, one line each, sorted. Lines describe structure (tables,
 * columns, uniqueness, referential actions), not names: drizzle-kit derives
 * default names with the casing applied, which Drizzle's own `getName()` does
 * not. Compare with `databaseKeys`.
 */
export function schemaKeys(tables: PgTable[]): string[] {
  const lines: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const tableName = `${config.schema ?? "public"}.${config.name}`;
    const columnName = (column: PgColumn) => casing.getColumnCasing(column);

    const primaryKey = config.columns.filter((column) => column.primary).map(columnName);
    if (primaryKey.length > 0) lines.push(`primary key ${tableName} (${primaryKey.join(", ")})`);
    for (const key of config.primaryKeys) {
      lines.push(`primary key ${tableName} (${key.columns.map(columnName).join(", ")})`);
    }

    for (const column of config.columns.filter((column) => column.isUnique)) {
      lines.push(`unique ${tableName} (${columnName(column)})`);
    }
    for (const constraint of config.uniqueConstraints) {
      lines.push(`unique ${tableName} (${constraint.columns.map(columnName).join(", ")})`);
    }

    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const foreignConfig = getTableConfig(reference.foreignTable);
      lines.push(
        `foreign key ${tableName} (${reference.columns.map(columnName).join(", ")}) ` +
          `references ${foreignConfig.schema ?? "public"}.${foreignConfig.name} ` +
          `(${reference.foreignColumns.map(columnName).join(", ")}) ` +
          `on delete ${foreignKey.onDelete ?? "no action"} on update ${foreignKey.onUpdate ?? "no action"}`,
      );
    }

    for (const { config: index } of config.indexes) {
      const columns = index.columns.map((column) => {
        if (!is(column, IndexedColumn) || !column.name) {
          throw new Error(
            `${tableName}: expression indexes are not checked yet; extend schemaKeys.`,
          );
        }
        return column.keyAsName ? toSnakeCase(column.name) : column.name;
      });
      lines.push(`${index.unique ? "unique index" : "index"} ${tableName} (${columns.join(", ")})`);
    }
  }
  return lines.sort();
}

/**
 * The same lines as `schemaKeys`, read from the live database's catalog. An
 * index that only backs a primary key or unique constraint is listed as that
 * constraint, not as an index.
 */
export async function databaseKeys(client: pg.Pool | pg.Client): Promise<string[]> {
  const constraints = await client.query<{
    type: "p" | "u" | "f";
    table_name: string;
    columns: string[];
    foreign_table: string | null;
    foreign_columns: string[] | null;
    on_delete: string;
    on_update: string;
  }>(`
    select
      c.contype as type,
      n.nspname || '.' || t.relname as table_name,
      array(
        select a.attname::text
        from unnest(c.conkey) with ordinality as k(attnum, position)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        order by k.position
      ) as columns,
      fn.nspname || '.' || ft.relname as foreign_table,
      array(
        select a.attname::text
        from unnest(c.confkey) with ordinality as k(attnum, position)
        join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum
        order by k.position
      ) as foreign_columns,
      c.confdeltype as on_delete,
      c.confupdtype as on_update
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    left join pg_class ft on ft.oid = c.confrelid
    left join pg_namespace fn on fn.oid = ft.relnamespace
    where c.contype in ('p', 'u', 'f')
      and n.nspname not in ${EXCLUDED_SCHEMAS}
      and n.nspname not like 'pg\\_%'
  `);
  const indexes = await client.query<{
    table_name: string;
    is_unique: boolean;
    columns: string[];
  }>(`
    select
      n.nspname || '.' || t.relname as table_name,
      i.indisunique as is_unique,
      array(
        select a.attname::text
        from unnest(i.indkey::int2[]) with ordinality as k(attnum, position)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        order by k.position
      ) as columns
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname not in ${EXCLUDED_SCHEMAS}
      and n.nspname not like 'pg\\_%'
      and not exists (
        select 1 from pg_constraint c
        where c.conindid = i.indexrelid and c.contype in ('p', 'u', 'x')
      )
  `);

  const lines = constraints.rows.map((row) => {
    const columns = `(${row.columns.join(", ")})`;
    if (row.type === "p") return `primary key ${row.table_name} ${columns}`;
    if (row.type === "u") return `unique ${row.table_name} ${columns}`;
    return (
      `foreign key ${row.table_name} ${columns} ` +
      `references ${row.foreign_table} (${(row.foreign_columns ?? []).join(", ")}) ` +
      `on delete ${REFERENTIAL_ACTIONS[row.on_delete]} on update ${REFERENTIAL_ACTIONS[row.on_update]}`
    );
  });
  for (const row of indexes.rows) {
    lines.push(
      `${row.is_unique ? "unique index" : "index"} ${row.table_name} (${row.columns.join(", ")})`,
    );
  }
  return lines.sort();
}
