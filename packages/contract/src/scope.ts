import { z } from "zod";
import {
  countSchema,
  cursorSchema,
  idSchema,
  MAX_PAGE_LIMIT,
  pageSchema,
  paginationInputShape,
  timestampSchema,
  utf8ByteLength,
} from "./common.ts";

/** Largest declared pattern or touched path, in bytes of UTF-8. */
export const MAX_SCOPE_VALUE_BYTES = 256;
export const MAX_DECLARED_SCOPES_PER_SESSION = 32;
export const MAX_TOUCHED_SCOPES_PER_SESSION = 96;

/** Most paths in one collection batch. A client also keeps each batch body within 16 KiB. */
export const MAX_COLLECTION_BATCH_PATHS = 16;
/** Most paths one collection manifest can describe; more are reported as omitted. */
export const MAX_COLLECTION_PATHS = 1024;

/** Product states the overlap search may visit for one pair of patterns. */
export const OVERLAP_STATE_BUDGET = 65_536;
/** Scope pairs one request may compare. */
export const OVERLAP_COMPARISON_BUDGET = 4096;
/** Longest overlap witness, in UTF-16 code units. */
export const MAX_OVERLAP_WITNESS_LENGTH = 1024;

/**
 * `declared`: a glob a Session says it will work in (`scope add`). `touched`:
 * a path git reported as changed in its worktree (heartbeat collections).
 * The same value can exist once per source.
 */
export const SCOPE_SOURCES = ["declared", "touched"] as const;

export const scopeSourceSchema = z.enum(SCOPE_SOURCES);

export type ScopeSource = z.infer<typeof scopeSourceSchema>;

function withinScopeBytes(value: string): boolean {
  return value.isWellFormed() && utf8ByteLength(value) <= MAX_SCOPE_VALUE_BYTES;
}

function validSegments(value: string): boolean {
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// Characters a declared glob may not use: control characters, backslashes,
// and the brackets and braces of character classes and alternation.
const UNSUPPORTED_GLOB_CHARACTERS = /[\p{Cc}\\[\]{}]/u;
// Extglob groups such as `@(a|b)` or `!(x)`.
const EXTGLOB = /[?*+@!]\(/;

/**
 * Whether `value` is a declared Scope glob: a repository-relative POSIX path
 * of literal segments, where `*` and `?` match within one segment and `**`,
 * only as a whole segment, matches zero or more segments. No leading `/`,
 * empty, `.` or `..` segments, backslashes, control characters, negation,
 * braces, character classes or extglobs; at most 256 bytes. This is the
 * contract's check; the server's matcher validates again.
 */
export function isDeclaredScopePattern(value: string): boolean {
  if (value === "" || !withinScopeBytes(value)) return false;
  if (UNSUPPORTED_GLOB_CHARACTERS.test(value) || value.startsWith("!") || EXTGLOB.test(value)) {
    return false;
  }
  if (!validSegments(value)) return false;
  return value.split("/").every((segment) => segment === "**" || !segment.includes("**"));
}

/**
 * Whether `value` is a touched path: an exact repository-relative POSIX path
 * of at most 256 bytes, without NUL, a leading `/`, or empty, `.` or `..`
 * segments. It is never a glob: `*`, `?`, newlines and backslashes are
 * literal characters of the name. Clients escape control characters when
 * they display one.
 */
export function isTouchedPath(value: string): boolean {
  return value !== "" && withinScopeBytes(value) && !value.includes("\0") && validSegments(value);
}

export const declaredScopePatternSchema = z
  .string()
  .min(1)
  .max(MAX_SCOPE_VALUE_BYTES)
  .refine(isDeclaredScopePattern, "Must be a repository-relative glob of at most 256 bytes.");

export const touchedPathSchema = z
  .string()
  .min(1)
  .max(MAX_SCOPE_VALUE_BYTES)
  .refine(isTouchedPath, "Must be a repository-relative path of at most 256 bytes.");

/**
 * Orders touched paths by Unicode code point, which is the byte order of their
 * UTF-8 encoding. Collection batches and manifests use this order.
 */
export function compareTouchedPaths(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done || r.done) return (l.done ? 0 : 1) - (r.done ? 0 : 1);
    const difference = (l.value.codePointAt(0) ?? 0) - (r.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}

/**
 * The canonical text of a collection's paths: each distinct path once, in
 * `compareTouchedPaths` order, each followed by NUL (which no path contains).
 * The manifest's `contentHash` is the SHA-256 of its UTF-8 bytes; the server
 * recomputes it from the accepted batches at finalize.
 */
export function touchedPathsManifestText(paths: readonly string[]): string {
  return [...new Set(paths)]
    .sort(compareTouchedPaths)
    .map((path) => `${path}\0`)
    .join("");
}

/** The manifest `contentHash` of `paths`: lowercase hex SHA-256 of `touchedPathsManifestText`. */
export async function touchedPathsContentHash(paths: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(touchedPathsManifestText(paths));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const contentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Must be a lowercase hex SHA-256 digest.");

/** A stored declared pattern or touched path, as the server returns it. */
export const scopeValueSchema = z
  .string()
  .min(1)
  .max(MAX_SCOPE_VALUE_BYTES)
  .refine(withinScopeBytes, "Must be at most 256 bytes.");

export const scopeSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  sessionId: idSchema,
  source: scopeSourceSchema,
  value: scopeValueSchema,
  createdAt: timestampSchema,
});

export type Scope = z.infer<typeof scopeSchema>;

export const scopePageSchema = pageSchema(scopeSchema);

export type ScopePage = z.infer<typeof scopePageSchema>;

/** `GET /projects/{id}/sessions/{sessionId}/scopes`: any Session of the Project, oldest first. */
export const listSessionScopesInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  source: scopeSourceSchema.optional(),
  ...paginationInputShape,
});

export type ListSessionScopesInput = z.input<typeof listSessionScopesInputSchema>;

/**
 * `POST /projects/{id}/sessions/{sessionId}/scopes`: declare one glob for the
 * caller's own Session (not ended or abandoned). An existing equal declared
 * Scope is returned with `created: false` and no Event; the 33rd distinct
 * declared Scope is CONFLICT.
 */
export const addSessionScopeInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  pattern: declaredScopePatternSchema,
});

export type AddSessionScopeInput = z.input<typeof addSessionScopeInputSchema>;

export const addSessionScopeOutputSchema = z.strictObject({
  scope: scopeSchema,
  created: z.boolean(),
});

export type AddSessionScopeOutput = z.infer<typeof addSessionScopeOutputSchema>;

/**
 * `DELETE /projects/{id}/sessions/{sessionId}/scopes/{scopeId}`: remove one of
 * the caller's declared Scopes. A Scope ID the Session does not have is a
 * no-op (`removed: false`); a touched Scope is CONFLICT, since touched paths
 * are evidence of work and stay for the Session's life.
 */
export const removeSessionScopeInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  scopeId: idSchema,
});

export type RemoveSessionScopeInput = z.input<typeof removeSessionScopeInputSchema>;

export const removeSessionScopeOutputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  removed: z.boolean(),
});

export type RemoveSessionScopeOutput = z.infer<typeof removeSessionScopeOutputSchema>;

/**
 * `overlap`: the two Scopes match a common path, `witness`. `possible`: the
 * search ran out of budget before deciding, so the pair may overlap
 * (`witness: null`). Neither blocks a claim.
 */
export const OVERLAP_KINDS = ["overlap", "possible"] as const;

export const overlapKindSchema = z.enum(OVERLAP_KINDS);

export const overlapScopeSchema = z.strictObject({
  id: idSchema,
  source: scopeSourceSchema,
  value: scopeValueSchema,
});

export const overlapSchema = z.strictObject({
  sessionId: idSchema,
  otherSessionId: idSchema,
  scope: overlapScopeSchema,
  otherScope: overlapScopeSchema,
  kind: overlapKindSchema,
  /** A valid repository path both Scopes match; null for `possible`. */
  witness: z.string().min(1).max(MAX_OVERLAP_WITNESS_LENGTH).nullable(),
});

export type Overlap = z.infer<typeof overlapSchema>;

/**
 * `GET /projects/{id}/sessions/{sessionId}/overlaps`: compares the Session's
 * Scopes with those of the Project's other live Sessions. Candidates and
 * results are paged independently behind one opaque cursor; keep following
 * `nextCursor` until it is null.
 */
export const checkSessionOverlapsInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  ...paginationInputShape,
});

export type CheckSessionOverlapsInput = z.input<typeof checkSessionOverlapsInputSchema>;

export const overlapPageSchema = z.strictObject({
  items: z.array(overlapSchema).max(MAX_PAGE_LIMIT),
  nextCursor: cursorSchema.nullable(),
  /**
   * False if this page's comparisons are not a reliable all-clear: a budget
   * ran out, candidates were capped, or a compared Session's touched-path
   * coverage is incomplete. Never true when an overlap could be missing.
   */
  complete: z.boolean(),
  /** Compared Sessions (including the checked one) whose `scopeComplete` is false. */
  incompleteSessionIds: z.array(idSchema).max(MAX_PAGE_LIMIT + 1),
});

export type OverlapPage = z.infer<typeof overlapPageSchema>;

// Touched-path collections. A heartbeat opens a collection and returns its
// UUID; the client then registers the manifest, uploads the batches and
// finalizes, all outside any server transaction. Every collection route
// requires the caller's own live Session and the current collection: an
// older one is CONFLICT. An identical replay of an accepted step is a no-op.

const collectionPathShape = {
  id: idSchema,
  sessionId: idSchema,
  collectionId: idSchema,
};

/**
 * `POST .../collections/{collectionId}/manifest`. `pathCount` distinct paths in
 * `batchCount` batches (zero and zero for a clean worktree), `contentHash`
 * from `touchedPathsContentHash`. `omittedPathCount` counts changed paths the
 * client could not upload (invalid UTF-8, over 256 bytes, or beyond
 * `MAX_COLLECTION_PATHS`); any omission leaves coverage incomplete for the
 * rest of the Session. A different manifest for the same collection is CONFLICT.
 */
export const registerCollectionManifestInputSchema = z
  .strictObject({
    ...collectionPathShape,
    pathCount: z.int().min(0).max(MAX_COLLECTION_PATHS),
    batchCount: z.int().min(0).max(MAX_COLLECTION_PATHS),
    omittedPathCount: countSchema,
    contentHash: contentHashSchema,
  })
  .refine(
    ({ pathCount, batchCount }) =>
      batchCount <= pathCount && batchCount >= Math.ceil(pathCount / MAX_COLLECTION_BATCH_PATHS),
    "batchCount must fit pathCount: at most 16 paths and at least one path per batch.",
  );

export type RegisterCollectionManifestInput = z.input<typeof registerCollectionManifestInputSchema>;

/**
 * `POST .../collections/{collectionId}/batches`: batch `batchIndex` (from 0) of
 * the manifest, its paths in strictly ascending `compareTouchedPaths` order.
 * Different paths at an accepted index are CONFLICT.
 */
export const uploadCollectionBatchInputSchema = z.strictObject({
  ...collectionPathShape,
  batchIndex: z
    .int()
    .min(0)
    .max(MAX_COLLECTION_PATHS - 1),
  paths: z
    .array(touchedPathSchema)
    .min(1)
    .max(MAX_COLLECTION_BATCH_PATHS)
    .refine(
      (paths) =>
        paths.every((path, i) => i === 0 || compareTouchedPaths(paths[i - 1] ?? "", path) < 0),
      "Paths must be distinct and in ascending order.",
    ),
});

export type UploadCollectionBatchInput = z.input<typeof uploadCollectionBatchInputSchema>;

/**
 * `POST .../collections/{collectionId}/finalize`: checks that every batch
 * arrived and that the accepted paths match the manifest's hash, then sets
 * `collectionComplete`. A missing batch or mismatch is CONFLICT.
 */
export const finalizeCollectionInputSchema = z.strictObject(collectionPathShape);

export type FinalizeCollectionInput = z.input<typeof finalizeCollectionInputSchema>;

/** Where a collection stands, as every collection route returns it. */
export const collectionStateSchema = z.strictObject({
  collectionId: idSchema,
  sessionId: idSchema,
  /** Null until a manifest is registered. */
  pathCount: countSchema.nullable(),
  batchCount: countSchema.nullable(),
  omittedPathCount: countSchema.nullable(),
  receivedBatchCount: countSchema,
  finalized: z.boolean(),
  /** Finalized with every path stored and none omitted. */
  collectionComplete: z.boolean(),
  /** False once coverage was lost earlier in the Session; it stays false. */
  historicalScopeComplete: z.boolean(),
  /** `collectionComplete && historicalScopeComplete`: the Session's `scopeComplete`. */
  scopeComplete: z.boolean(),
});

export type CollectionState = z.infer<typeof collectionStateSchema>;

/** Manifest and finalize. `changed: false` is an identical replay. */
export const collectionOutputSchema = z.strictObject({
  collection: collectionStateSchema,
  changed: z.boolean(),
});

export type CollectionOutput = z.infer<typeof collectionOutputSchema>;

export const uploadCollectionBatchOutputSchema = z.strictObject({
  collection: collectionStateSchema,
  changed: z.boolean(),
  /** Paths of this batch now stored as touched Scopes (new or already present). */
  storedPathCount: countSchema,
  /**
   * Paths of this batch not stored because the Session reached
   * `MAX_TOUCHED_SCOPES_PER_SESSION`; coverage is then incomplete for good.
   */
  overCapacityPathCount: countSchema,
});

export type UploadCollectionBatchOutput = z.infer<typeof uploadCollectionBatchOutputSchema>;
