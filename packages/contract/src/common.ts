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

// Lowercased once on parse. Postgres compares uuids case-insensitively, but
// code that compares ids as strings (creation replay, a Project key's bound
// Project, a Session's collection) would otherwise treat the same record
// sent in uppercase as a different one. The JSON Schema is unchanged.
export const idSchema = z.uuid().toLowerCase();

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

const utf8 = new TextEncoder();

/** Size of `value` in UTF-8, the unit of every byte limit in the contract. */
export function utf8ByteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

/** Largest markdown body, Plan log message, Session summary or block reason. */
export const MAX_MARKDOWN_BYTES = 8 * 1024;

// Control characters other than tab, line feed and carriage return. Markdown
// needs line breaks; an escape sequence in stored text would reach terminals.
const CONTROL_CHARACTERS_EXCEPT_WHITESPACE = /[^\P{Cc}\t\n\r]/u;

/**
 * Bounded markdown or multi-line plain text: 1 to `maxBytes` bytes of UTF-8,
 * not only whitespace, no control characters except tab and line breaks, and
 * well-formed UTF-16 (a lone surrogate has no UTF-8 encoding). The code-unit
 * `max` is implied by the byte bound and shows the limit in OpenAPI.
 */
export function markdownSchema(maxBytes: number = MAX_MARKDOWN_BYTES) {
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine((value) => value.isWellFormed(), "Must be valid Unicode text.")
    .refine((value) => utf8ByteLength(value) <= maxBytes, `Must be at most ${maxBytes} bytes.`)
    .refine((value) => value.trim().length > 0, "Must not be blank.")
    .refine(
      (value) => !CONTROL_CHARACTERS_EXCEPT_WHITESPACE.test(value),
      "Must not contain control characters other than tabs and line breaks.",
    );
}

/**
 * Single-line text such as a Session's agent or intent: `nameSchema` plus
 * well-formed UTF-16. M1 names keep `nameSchema` unchanged.
 */
export function textSchema(max: number) {
  return nameSchema(max).refine((value) => value.isWellFormed(), "Must be valid Unicode text.");
}

/**
 * Single-line plain text that is trimmed on parse: surrounding whitespace is
 * removed first, then the result must be 1 to `max` UTF-16 code units of
 * well-formed text with no control characters (so no line breaks). The
 * stored value is always the trimmed one.
 */
export function trimmedTextSchema(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => value.isWellFormed(), "Must be valid Unicode text.")
    .refine((value) => !CONTROL_CHARACTERS.test(value), "Must not contain control characters.");
}

/**
 * Unsigned 64-bit integers (an Event's `seq` and `writerXid`) as decimal
 * strings. A JavaScript number loses precision above 2^53, so they never
 * travel as numbers.
 */
export const decimalStringSchema = z
  .string()
  .max(20)
  .regex(/^(?:0|[1-9][0-9]*)$/, "Must be a decimal integer string.");

/** A non-negative count. */
export const countSchema = z.int().min(0);

/**
 * A bounded list inside a larger response (a status section, the claims a
 * heartbeat renewed). `complete: false` means more records exist than the
 * response holds; the field's documentation names the paged route that
 * lists them all. It is never a silent truncation.
 */
export function boundedListSchema<T extends z.ZodType>(item: T, max: number) {
  return z.strictObject({
    items: z.array(item).max(max),
    complete: z.boolean(),
  });
}
