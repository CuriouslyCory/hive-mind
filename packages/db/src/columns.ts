import { timestamp, uuid } from "drizzle-orm/pg-core";

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
