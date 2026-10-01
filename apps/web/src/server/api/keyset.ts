import { createHash } from "node:crypto";
import { apiError } from "./authorize";

// Opaque cursors for the coordination lists of #12. Each one is bound to the
// list it came from: the route, the Project, the parent resource and the
// filters, hashed into the cursor. A cursor presented to any other list (another
// Project, Plan, Session or status filter) is 400, so a page can never
// continue a different query. The position itself is the list's keyset key
// (a Plan number, a Task's position and UUID, an Event's seq).

const VERSION = "c1";

/** Identifies one list: the route name and every input that shapes it. */
export type CursorScope = readonly (string | number | null | undefined)[];

function scopeHash(scope: CursorScope): string {
  return createHash("sha256")
    .update(JSON.stringify(scope.map((part) => part ?? null)))
    .digest("base64url")
    .slice(0, 16);
}

export function encodeKeysetCursor(scope: CursorScope, position: readonly string[]): string {
  return Buffer.from([VERSION, scopeHash(scope), ...position].join("|")).toString("base64url");
}

/**
 * The position in a cursor this list returned, with `parts` fields matching
 * `pattern`; 400 for a malformed cursor or one from another list.
 */
export function decodeKeysetCursor(
  scope: CursorScope,
  cursor: string,
  pattern: readonly RegExp[],
): string[] {
  const [version, hash, ...position] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const valid =
    version === VERSION &&
    hash === scopeHash(scope) &&
    position.length === pattern.length &&
    position.every((part, index) => pattern[index]?.test(part));
  if (!valid) throw invalidCursor();
  return position;
}

/** The 400 for a malformed cursor or one another list returned. */
export function invalidCursor() {
  return apiError("BAD_REQUEST", "The cursor is not one this list returned.");
}

export const DECIMAL_POSITION = /^(?:0|[1-9][0-9]{0,19})$/;
export const UUID_POSITION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
