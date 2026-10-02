import { sql } from "drizzle-orm";

// Check-constraint expressions shared by the schema modules. Not re-exported
// from schema/index.ts, which holds only tables.

/** `column in ('a', 'b')`. The values are schema constants, never input. */
export function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(", ")})`);
}

/** A lowercase sha256 hex digest, as `creationFingerprint` (src/fingerprint.ts) writes. */
export function isSha256Hex(column: string) {
  return sql.raw(`${column} ~ '^[0-9a-f]{64}$'`);
}
