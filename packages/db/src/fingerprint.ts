import { createHash } from "node:crypto";

// Canonical fingerprints of creation inputs (issue #12, "Transaction, identity
// and Event invariants"). A creation that reuses a caller-generated UUID is a
// replay only if its fingerprint equals the one stored with the original, so
// the encoding must not depend on key order or on how a client serialized
// the request.

/** A JSON value. `undefined` object properties are omitted, as JSON.stringify does. */
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson | undefined };

/**
 * Upper bound on a canonical input, in UTF-8 bytes. Requests are capped at
 * 16 KiB before parsing, so a creation input never comes near it; the bound
 * keeps a caller's mistake from hashing an unbounded value.
 */
export const MAX_FINGERPRINT_INPUT_BYTES = 64 * 1024;

export class FingerprintInputTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Fingerprint input is ${bytes} bytes; the limit is ${MAX_FINGERPRINT_INPUT_BYTES}.`);
    this.name = "FingerprintInputTooLargeError";
  }
}

/**
 * JSON with object keys sorted (by UTF-16 code unit, which is what `sort`
 * does) and no whitespace. Throws on numbers JSON cannot represent.
 */
export function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${value} has no JSON representation.`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: CanonicalJson) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as { readonly [key: string]: CanonicalJson | undefined };
  const members = Object.keys(object)
    .sort()
    .flatMap((key) => {
      const member = object[key];
      return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
    });
  return `{${members.join(",")}}`;
}

/** Lowercase hex sha256 of a string's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The fingerprint stored as `creation_fingerprint`: the sha256 of the
 * canonical JSON of the creation input. Include every field that defines what
 * was asked for (and the target, such as the Plan a Task is added to), but not
 * the principal, which is stored and compared separately.
 */
export function creationFingerprint(input: CanonicalJson): string {
  const canonical = canonicalJson(input);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > MAX_FINGERPRINT_INPUT_BYTES) throw new FingerprintInputTooLargeError(bytes);
  return sha256Hex(canonical);
}
