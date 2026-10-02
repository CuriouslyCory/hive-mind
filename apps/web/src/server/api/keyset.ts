import { createHash } from "node:crypto";
import { apiError } from "./authorize";

// Opaque cursors for the coordination lists of #12. Each one is bound to the
// list it came from: the route, the Project, the parent resource and the
// filters, hashed into the cursor. A cursor presented to any other list (another
// Project, Plan, Session or status filter) is 400, so a page can never
// continue a different query. The position itself is the list's keyset key
// (a Plan number, a Task's position and UUID, an Event's seq).
//
// The scope hash is unkeyed, so a caller can forge a cursor for a list it may
// read. That is accepted: a forged cursor only chooses where that list
// resumes, every position is reapplied in SQL within the authorized Project,
// and each field is range-checked here against the column it is compared
// with, so a forged value is 400 and never a database error.

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

/** Accepts one position field of a cursor. A RegExp is one. */
export interface PositionField {
  test(part: string): boolean;
}

/**
 * The position in a cursor this list returned, with one part per `fields`
 * entry that accepts it; 400 for a malformed cursor or one from another list.
 */
export function decodeKeysetCursor(
  scope: CursorScope,
  cursor: string,
  fields: readonly PositionField[],
): string[] {
  const [version, hash, ...position] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const valid =
    version === VERSION &&
    hash === scopeHash(scope) &&
    position.length === fields.length &&
    position.every((part, index) => fields[index]?.test(part));
  if (!valid) throw invalidCursor();
  return position;
}

/** The 400 for a malformed cursor or one another list returned. */
export function invalidCursor() {
  return apiError("BAD_REQUEST", "The cursor is not one this list returned.");
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** A canonical decimal integer in `[min, max]`. */
function decimalWithin(min: bigint, max: bigint): PositionField {
  const maxDigits = max.toString().length;
  return {
    test: (part) =>
      DECIMAL.test(part) && part.length <= maxDigits && BigInt(part) >= min && BigInt(part) <= max,
  };
}

/** An Event seq: a non-negative Postgres bigint. */
export const SEQ_POSITION = decimalWithin(0n, 9_223_372_036_854_775_807n);
/** A Plan number or a Task position: a positive Postgres integer. */
export const INT4_POSITION = decimalWithin(1n, 2_147_483_647n);
/**
 * Epoch milliseconds up to 9999-12-31T23:59:59.999Z: a valid Date whose ISO
 * form (four-digit year) Postgres parses as a timestamptz.
 */
export const EPOCH_MS_POSITION = decimalWithin(0n, 253_402_300_799_999n);
/** A count or offset that is exact as a JavaScript number. */
export const SAFE_INTEGER_POSITION = decimalWithin(0n, BigInt(Number.MAX_SAFE_INTEGER));
export const UUID_POSITION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
