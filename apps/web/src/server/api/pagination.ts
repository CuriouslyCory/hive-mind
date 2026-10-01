import { DEFAULT_PAGE_LIMIT } from "@hivemind/contract";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { apiError } from "./authorize";

// Keyset pagination over (created_at, id), oldest first. The cursor holds
// the last row's position, so pages stay consistent while rows are added or
// deleted, and a page costs one indexed range scan however deep it is.
//
// `created_at` has microsecond precision but a JS Date only milliseconds, so
// the position is read from Postgres as text (UTC, microseconds) rather than
// round-tripped through a Date, which would repeat or skip rows created in
// the same millisecond.

export interface Position {
  createdAt: string;
  id: string;
}

const POSITION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const POSITION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The row's position as exact UTC text; select it alongside the row. */
export function positionOf(createdAt: AnyColumn): SQL<string> {
  return sql<string>`to_char(${createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Rows after `position` in (created_at, id) order. */
export function after(createdAt: AnyColumn, id: AnyColumn, position: Position): SQL {
  return sql`(${createdAt}, ${id}) > (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

export function encodeCursor(position: Position): string {
  return Buffer.from(`${position.createdAt}|${position.id}`).toString("base64url");
}

/** The position in a cursor from a previous page; 400 for anything else. */
export function decodeCursor(cursor: string): Position {
  const [createdAt = "", id = "", ...rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (rest.length > 0 || !POSITION_TIME.test(createdAt) || !POSITION_ID.test(id)) {
    throw apiError("BAD_REQUEST", "The cursor is not one this server returned.");
  }
  return { createdAt, id };
}

/**
 * Turns `limit + 1` fetched rows into a page: the first `limit` items, and a
 * cursor when the extra row shows there is more.
 */
export function toPage<Row extends { position: string; id: string }, Item>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => Item,
): { items: Item[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toItem),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ createdAt: last.position, id: last.id }) : null,
  };
}

export function pageLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_PAGE_LIMIT;
}
