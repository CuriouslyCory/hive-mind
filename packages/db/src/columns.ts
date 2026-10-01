import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

// Column helpers that encode the database conventions (ADR-0005): uuid primary
// keys and timestamptz everywhere. Column names are omitted because Drizzle's
// `casing: "snake_case"` derives them from the property key. Each helper
// returns a new builder, so the same helper can be used in many tables.

/**
 * A uuid primary key with a database default of `gen_random_uuid()`. Inserts
 * may supply their own id (better-auth does, with `generateId: "uuid"`) or
 * omit it and let Postgres generate one, including inserts made in raw SQL.
 */
export const id = () => uuid().primaryKey().defaultRandom();

/** A `timestamp with time zone` column, read and written as a `Date`. */
export const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

/** When the row was inserted. */
export const createdAt = () => timestamptz().notNull().defaultNow();

/**
 * When the row was last updated. Drizzle sets it on every `update()`; updates
 * made in raw SQL must set it themselves.
 */
export const updatedAt = () =>
  timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * A Postgres `xid8` (64-bit transaction id), read as a decimal string. node-postgres
 * returns types it has no parser for as text, and this type never converts that
 * text to a JavaScript number, which would lose precision above 2^53.
 */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

/**
 * A `bigserial` column, read as a decimal string for the same reason as `xid8`
 * (node-postgres returns int8 as text). Postgres generates the value from the
 * column's own sequence; the type tells Drizzle the column is never null and
 * has a default, so inserts omit it and Drizzle sends `default`.
 */
export const bigserialString = customType<{
  data: string;
  driverData: string;
  notNull: true;
  default: true;
}>({
  dataType: () => "bigserial",
});
