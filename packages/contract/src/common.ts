import { z } from "zod";

// Conventions shared by every schema in the contract:
// - JSON field names are camelCase.
// - IDs are UUIDs (the database generates every ID as a uuid).
// - Timestamps are ISO 8601 strings, not Date objects, so the typed client and
//   the JSON on the wire agree without a custom serializer.
// - Response objects are strict: the server's output validation fails rather
//   than send a field the contract does not declare. That is what keeps secret
//   material out of key metadata. Clients must not parse responses with these
//   strict schemas, or a field added later would break installed CLIs.

export const idSchema = z.uuid();

export const timestampSchema = z.iso.datetime({ offset: true });

// C0 and C1 control characters. Names are shown in terminals; rejecting them on
// input is cheaper than relying only on escaping at every place they print.
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * A human-readable name: 1 to `max` UTF-16 code units, not only whitespace,
 * and no control characters.
 */
export function nameSchema(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank.")
    .refine((value) => !CONTROL_CHARACTERS.test(value), "Must not contain control characters.");
}

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_CURSOR_LENGTH = 512;

/**
 * List routes take `limit` and `cursor` as query parameters, which reach the
 * server as strings. A typed client may pass a number; both forms are accepted
 * and must be a plain decimal integer in range (no `1e2`, `0x10` or spaces,
 * which `z.coerce.number()` would let through). The range is on both branches
 * so the generated OpenAPI document shows it.
 */
const pageLimitNumberSchema = z.int().min(1).max(MAX_PAGE_LIMIT);

export const pageLimitSchema = z.union([
  pageLimitNumberSchema,
  z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(pageLimitNumberSchema),
]);

/** An opaque continuation token from a previous page's `nextCursor`. */
export const cursorSchema = z
  .string()
  .min(1)
  .max(MAX_CURSOR_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "Must be a cursor returned by a previous page.");

export const paginationInputShape = {
  limit: pageLimitSchema.optional(),
  cursor: cursorSchema.optional(),
};

/** A page of `item`; `nextCursor` is null on the last page. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item).max(MAX_PAGE_LIMIT),
    nextCursor: cursorSchema.nullable(),
  });
}
