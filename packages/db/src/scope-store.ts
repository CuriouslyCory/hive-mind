import { and, asc, count, eq, gt, inArray, ne, or, type SQL } from "drizzle-orm";
import {
  type CoordinationContext,
  type Transaction,
  withCoordinationLock,
  withCoordinationRead,
} from "./coordination.ts";
import { type EventPayloads, insertEvent } from "./event.ts";
import { sha256Hex } from "./fingerprint.ts";
import type { Db } from "./index.ts";
import { effectiveSessionStatus, isSessionLive, liveSessionCondition } from "./liveness.ts";
import { type Principal, samePrincipal, sessionOwner } from "./principal.ts";
import { type AgentSession, agentSession } from "./schema/coordination.ts";
import { type Scope, type ScopeSource, scope, scopeCollectionBatch } from "./schema/scope.ts";
import {
  findScopeOverlaps,
  normalizeDeclaredPattern,
  normalizeTouchedPath,
  type ScopeEntry,
  type ScopeIncompleteReason,
  ScopeMatchContext,
  type ScopeOverlap,
} from "./scope.ts";

// Stored Scopes, touched-path collections and overlap checks (issue #12,
// "Scopes and overlap"; ADR-0014). Mutations run under the Project's
// coordination lock and act only on the caller's own, effectively live
// Session. Reads use one database timestamp and write nothing. Every
// function returns a plain outcome; apps/web maps it to HTTP (ok 200,
// not_found 404, forbidden 403, conflict 409, invalid 400).

/** Most declared Scopes one Session may have. */
export const MAX_DECLARED_SCOPES_PER_SESSION = 32;
/** Most touched Scopes one Session may have; more lose coverage for good. */
export const MAX_TOUCHED_SCOPES_PER_SESSION = 96;
/** Most paths in one collection batch. */
export const MAX_COLLECTION_BATCH_PATHS = 16;
/** Most paths one collection manifest may describe (and so most batches). */
export const MAX_COLLECTION_PATHS = 1024;
/** Page size bounds for Scope lists and overlap results and candidates. */
export const SCOPE_PAGE_DEFAULT_LIMIT = 50;
export const SCOPE_PAGE_MAX_LIMIT = 100;

export type ScopeConflictReason =
  /** The Session is effectively stale, ended or abandoned. */
  | "session_not_live"
  /** The Session already has `MAX_DECLARED_SCOPES_PER_SESSION` declared Scopes. */
  | "declared_capacity"
  /** Touched Scopes are evidence of work and cannot be removed. */
  | "touched_scope"
  /** The Session has no collection yet (no heartbeat opened one). */
  | "no_collection"
  /** A newer heartbeat replaced this collection. */
  | "obsolete_collection"
  /** A different manifest was already registered for this collection. */
  | "manifest_conflict"
  /** Batches and finalize need the collection's manifest first. */
  | "manifest_missing"
  /** The batch index is not below the manifest's batch count. */
  | "batch_out_of_range"
  /** Different paths were already accepted at this batch index. */
  | "batch_conflict"
  /** A batch held paths that cannot be stored; coverage is now incomplete for good. */
  | "unrepresentable_paths"
  /** Finalize found batches missing. */
  | "batches_missing"
  /** Finalize found the accepted paths do not match the manifest. */
  | "manifest_mismatch";

export type ScopeStoreFailure =
  | { status: "not_found" }
  /** The Session is visible in the Project but not the principal's own. */
  | { status: "forbidden" }
  | { status: "conflict"; reason: ScopeConflictReason; message: string }
  | { status: "invalid"; reason: string; message: string };

export type ScopeStoreOutcome<T> = ({ status: "ok" } & T) | ScopeStoreFailure;

/** Identifies the caller's own Session. `principal` comes from authentication. */
export interface OwnSessionInput {
  projectId: string;
  sessionId: string;
  principal: Principal;
}

/**
 * Whether a Session's touched-path coverage is a reliable record: its current
 * collection was finalized and no earlier coverage was lost. Overlap checks
 * that involve a Session for which this is false are never complete.
 */
export function isScopeComplete(
  session: Pick<AgentSession, "collectionComplete" | "scopeHistoryIncomplete">,
): boolean {
  return session.collectionComplete && !session.scopeHistoryIncomplete;
}

// --- Canonical collection manifest -----------------------------------------
//
// The CLI computes the same values without importing this package, so the
// algorithm is fixed:
// 1. Take the collection's distinct touched paths (exact strings, no
//    normalization).
// 2. Sort them by Unicode code point, which is the byte order of their UTF-8
//    encoding (not JavaScript's default UTF-16 order).
// 3. contentHash = lowercase hex SHA-256 of the UTF-8 bytes of every path
//    followed by one NUL, concatenated. No paths hash the empty string.
// Batches are consecutive runs of that sorted list, at most 16 paths each
// (fewer when the request body would exceed 16 KiB), indexed from 0, so a
// retry reproduces identical batches.

/** Orders touched paths by Unicode code point. */
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

/** The distinct paths in manifest order. */
export function canonicalTouchedPaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort(compareTouchedPaths);
}

/** The manifest `contentHash` of a collection's paths (see the algorithm above). */
export function touchedPathsContentHash(paths: Iterable<string>): string {
  return sha256Hex(
    canonicalTouchedPaths(paths)
      .map((path) => `${path}\0`)
      .join(""),
  );
}

// --- Shared checks ----------------------------------------------------------

type SessionAccess = { status: "ok"; session: AgentSession } | ScopeStoreFailure;

/**
 * Loads the principal's own, effectively live Session under the lock. A
 * Session of another Project is not_found, like an absent one.
 */
async function ownLiveSession(
  { tx, now }: CoordinationContext,
  input: OwnSessionInput,
): Promise<SessionAccess> {
  const [session] = await tx
    .select()
    .from(agentSession)
    .where(and(eq(agentSession.id, input.sessionId), eq(agentSession.projectId, input.projectId)))
    .limit(1);
  if (!session) return { status: "not_found" };
  if (!samePrincipal(sessionOwner(session), input.principal)) return { status: "forbidden" };
  if (!isSessionLive(session, now)) {
    return conflict(
      "session_not_live",
      `Session ${session.id} is ${effectiveSessionStatus(session, now)}; its Scopes can no longer change.`,
    );
  }
  return { status: "ok", session };
}

function conflict(reason: ScopeConflictReason, message: string): ScopeStoreFailure {
  return { status: "conflict", reason, message };
}

function actorOf(input: OwnSessionInput) {
  return { ...input.principal, sessionId: input.sessionId };
}

/**
 * Sets the Session's sticky `scope_history_incomplete` and records why, once:
 * if it is already set, nothing is written.
 */
async function loseCoverage(
  { tx, now }: CoordinationContext,
  input: OwnSessionInput,
  session: AgentSession,
  payload: EventPayloads["scope.coverage_lost"],
): Promise<void> {
  if (session.scopeHistoryIncomplete) return;
  await tx
    .update(agentSession)
    .set({ scopeHistoryIncomplete: true, updatedAt: now })
    .where(eq(agentSession.id, session.id));
  session.scopeHistoryIncomplete = true;
  await insertEvent(tx, {
    projectId: input.projectId,
    type: "scope.coverage_lost",
    payload,
    actor: actorOf(input),
    sessionId: session.id,
    now,
  });
}

// --- Declared Scopes --------------------------------------------------------

export interface AddDeclaredScopeInput extends OwnSessionInput {
  /** The glob as the caller wrote it; it is validated and stored normalized. */
  pattern: string;
}

/**
 * Declares a glob for the caller's own live Session. An equal declared Scope
 * already present is returned with `created: false` and no Event.
 */
export async function addDeclaredScope(
  db: Db,
  input: AddDeclaredScopeInput,
): Promise<ScopeStoreOutcome<{ scope: Scope; created: boolean }>> {
  const normalized = normalizeDeclaredPattern(input.pattern);
  if (normalized.status === "invalid") {
    return { status: "invalid", reason: normalized.reason, message: normalized.message };
  }
  const value = normalized.pattern;

  return withCoordinationLock(db, input.projectId, async (context) => {
    const access = await ownLiveSession(context, input);
    if (access.status !== "ok") return access;
    const { tx, now } = context;

    const [existing] = await tx
      .select()
      .from(scope)
      .where(
        and(
          eq(scope.sessionId, input.sessionId),
          eq(scope.source, "declared"),
          eq(scope.value, value),
        ),
      )
      .limit(1);
    if (existing) return { status: "ok", scope: existing, created: false };

    const [declared] = await tx
      .select({ n: count() })
      .from(scope)
      .where(and(eq(scope.sessionId, input.sessionId), eq(scope.source, "declared")));
    if ((declared?.n ?? 0) >= MAX_DECLARED_SCOPES_PER_SESSION) {
      return conflict(
        "declared_capacity",
        `Session ${input.sessionId} already has ${MAX_DECLARED_SCOPES_PER_SESSION} declared Scopes; remove one first.`,
      );
    }

    const [row] = await tx
      .insert(scope)
      .values({
        projectId: input.projectId,
        sessionId: input.sessionId,
        source: "declared",
        value,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("scope insert returned no row");
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "scope.added",
      payload: { source: "declared", value },
      actor: actorOf(input),
      sessionId: input.sessionId,
      now,
    });
    return { status: "ok", scope: row, created: true };
  });
}

export interface RemoveScopeInput extends OwnSessionInput {
  scopeId: string;
}

/**
 * Removes one declared Scope of the caller's own live Session. A Scope the
 * Session does not have (already removed, or another Session's) is a no-op
 * with `removed: false` and no Event. Touched Scopes cannot be removed.
 */
export async function removeScope(
  db: Db,
  input: RemoveScopeInput,
): Promise<ScopeStoreOutcome<{ removed: boolean; scope: Scope | null }>> {
  return withCoordinationLock(db, input.projectId, async (context) => {
    const access = await ownLiveSession(context, input);
    if (access.status !== "ok") return access;
    const { tx, now } = context;

    const [row] = await tx
      .select()
      .from(scope)
      .where(and(eq(scope.id, input.scopeId), eq(scope.sessionId, input.sessionId)))
      .limit(1);
    if (!row) return { status: "ok", removed: false, scope: null };
    if (row.source === "touched") {
      return conflict(
        "touched_scope",
        `Scope ${row.id} is a touched path; touched Scopes stay for the Session's life.`,
      );
    }

    await tx.delete(scope).where(eq(scope.id, row.id));
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "scope.removed",
      payload: { source: row.source, value: row.value },
      actor: actorOf(input),
      sessionId: input.sessionId,
      now,
    });
    return { status: "ok", removed: true, scope: row };
  });
}

/** Keyset position after the last Scope of a page. */
export interface ScopeCursor {
  createdAt: Date;
  id: string;
}

export interface ListScopesInput {
  projectId: string;
  /** One Session's Scopes (any status); without it, the Scopes of the Project's live Sessions. */
  sessionId?: string;
  source?: ScopeSource;
  limit?: number;
  after?: ScopeCursor | null;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return SCOPE_PAGE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), SCOPE_PAGE_MAX_LIMIT);
}

/**
 * Lists Scopes oldest first, `limit` at a time. Authorization (Project read
 * access) is the caller's. A `sessionId` outside the Project is not_found.
 * The cursor relies on Scope timestamps having millisecond precision, which
 * holds because this module writes `created_at` from the transaction's `now`.
 */
export async function listScopes(
  db: Db,
  input: ListScopesInput,
): Promise<ScopeStoreOutcome<{ items: Scope[]; nextCursor: ScopeCursor | null }>> {
  const limit = pageLimit(input.limit);
  return withCoordinationRead(db, async ({ tx, now }) => {
    const conditions: (SQL | undefined)[] = [eq(scope.projectId, input.projectId)];
    if (input.sessionId !== undefined) {
      const [session] = await tx
        .select({ id: agentSession.id })
        .from(agentSession)
        .where(
          and(eq(agentSession.id, input.sessionId), eq(agentSession.projectId, input.projectId)),
        )
        .limit(1);
      if (!session) return { status: "not_found" };
      conditions.push(eq(scope.sessionId, input.sessionId));
    } else {
      conditions.push(
        inArray(
          scope.sessionId,
          tx
            .select({ id: agentSession.id })
            .from(agentSession)
            .where(and(eq(agentSession.projectId, input.projectId), liveSessionCondition(now))),
        ),
      );
    }
    if (input.source !== undefined) conditions.push(eq(scope.source, input.source));
    if (input.after) {
      conditions.push(
        or(
          gt(scope.createdAt, input.after.createdAt),
          and(eq(scope.createdAt, input.after.createdAt), gt(scope.id, input.after.id)),
        ),
      );
    }

    const rows = await tx
      .select()
      .from(scope)
      .where(and(...conditions))
      .orderBy(asc(scope.createdAt), asc(scope.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { status: "ok", items, nextCursor };
  });
}

// --- Touched-path collections -------------------------------------------------

/** Where the Session's current collection stands. */
export interface CollectionState {
  sessionId: string;
  collectionId: string;
  /** The registered manifest; null until it is registered. */
  expectedBatches: number | null;
  pathCount: number | null;
  contentHash: string | null;
  omittedPathCount: number | null;
  receivedBatchCount: number;
  /** The collection was finalized: every batch arrived and matched the manifest. */
  collectionComplete: boolean;
  /** Sticky: coverage was lost earlier in the Session. */
  scopeHistoryIncomplete: boolean;
  /** `collectionComplete && !scopeHistoryIncomplete`. */
  scopeComplete: boolean;
}

export interface CollectionInput extends OwnSessionInput {
  collectionId: string;
}

type CollectionAccess = { status: "ok"; session: AgentSession } | ScopeStoreFailure;

/** Owner, liveness and generation checks shared by the collection steps. */
async function currentCollection(
  context: CoordinationContext,
  input: CollectionInput,
): Promise<CollectionAccess> {
  const access = await ownLiveSession(context, input);
  if (access.status !== "ok") return access;
  const current = access.session.collectionId;
  if (current === null) {
    return conflict(
      "no_collection",
      `Session ${input.sessionId} has no collection; heartbeat to start one.`,
    );
  }
  if (current !== input.collectionId) {
    return conflict(
      "obsolete_collection",
      `Collection ${input.collectionId} is not current for Session ${input.sessionId}; a newer heartbeat replaced it.`,
    );
  }
  return access;
}

async function collectionState(
  tx: Transaction,
  session: AgentSession,
  collectionId: string,
): Promise<CollectionState> {
  const [received] = await tx
    .select({ n: count() })
    .from(scopeCollectionBatch)
    .where(
      and(
        eq(scopeCollectionBatch.sessionId, session.id),
        eq(scopeCollectionBatch.collectionId, collectionId),
      ),
    );
  const registered = session.collectionPathCount !== null;
  return {
    sessionId: session.id,
    collectionId,
    expectedBatches: session.collectionExpectedBatches,
    pathCount: session.collectionPathCount,
    contentHash: session.collectionContentHash,
    omittedPathCount: registered ? (session.collectionOmittedPathCount ?? 0) : null,
    receivedBatchCount: received?.n ?? 0,
    collectionComplete: session.collectionComplete,
    scopeHistoryIncomplete: session.scopeHistoryIncomplete,
    scopeComplete: isScopeComplete(session),
  };
}

export interface CollectionManifestInput extends CollectionInput {
  expectedBatches: number;
  /** Distinct paths the batches carry. */
  pathCount: number;
  /** Lowercase hex SHA-256 from `touchedPathsContentHash`. */
  contentHash: string;
  /** Changed paths the client could not upload. Any omission loses coverage for good. */
  omittedPathCount?: number;
}

const isCount = (value: number, max: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;

function manifestProblem(input: CollectionManifestInput): string | null {
  const { expectedBatches, pathCount } = input;
  if (!isCount(pathCount, MAX_COLLECTION_PATHS)) {
    return `pathCount must be an integer from 0 to ${MAX_COLLECTION_PATHS}.`;
  }
  if (!isCount(expectedBatches, MAX_COLLECTION_PATHS)) {
    return `expectedBatches must be an integer from 0 to ${MAX_COLLECTION_PATHS}.`;
  }
  if (
    expectedBatches > pathCount ||
    expectedBatches < Math.ceil(pathCount / MAX_COLLECTION_BATCH_PATHS)
  ) {
    return `expectedBatches must allow at most ${MAX_COLLECTION_BATCH_PATHS} and at least one path per batch.`;
  }
  if (!isCount(input.omittedPathCount ?? 0, Number.MAX_SAFE_INTEGER)) {
    return "omittedPathCount must be a nonnegative integer.";
  }
  if (!/^[0-9a-f]{64}$/.test(input.contentHash)) {
    return "contentHash must be a lowercase hex SHA-256 digest.";
  }
  return null;
}

/**
 * Registers the manifest of the Session's current collection. An identical
 * replay is a no-op (`changed: false`); a different manifest for the same
 * collection, or an obsolete collection, is a conflict. A nonzero
 * `omittedPathCount` sets the Session's sticky historical incompleteness.
 */
export async function recordCollectionManifest(
  db: Db,
  input: CollectionManifestInput,
): Promise<ScopeStoreOutcome<{ collection: CollectionState; changed: boolean }>> {
  const problem = manifestProblem(input);
  if (problem) return { status: "invalid", reason: "invalid_manifest", message: problem };
  const omitted = input.omittedPathCount ?? 0;

  return withCoordinationLock(db, input.projectId, async (context) => {
    const access = await currentCollection(context, input);
    if (access.status !== "ok") return access;
    const { session } = access;
    const { tx, now } = context;

    if (session.collectionPathCount !== null) {
      const same =
        session.collectionExpectedBatches === input.expectedBatches &&
        session.collectionPathCount === input.pathCount &&
        session.collectionContentHash === input.contentHash &&
        (session.collectionOmittedPathCount ?? 0) === omitted;
      if (!same) {
        return conflict(
          "manifest_conflict",
          `Collection ${input.collectionId} already has a different manifest.`,
        );
      }
      return {
        status: "ok",
        collection: await collectionState(tx, session, input.collectionId),
        changed: false,
      };
    }

    const manifest = {
      collectionExpectedBatches: input.expectedBatches,
      collectionPathCount: input.pathCount,
      collectionContentHash: input.contentHash,
      collectionOmittedPathCount: omitted,
    };
    await tx
      .update(agentSession)
      .set({ ...manifest, updatedAt: now })
      .where(eq(agentSession.id, session.id));
    Object.assign(session, manifest);
    if (omitted > 0) {
      await loseCoverage(context, input, session, {
        collectionId: input.collectionId,
        reason: "omitted_paths",
        pathCount: omitted,
      });
    }
    return {
      status: "ok",
      collection: await collectionState(tx, session, input.collectionId),
      changed: true,
    };
  });
}

export interface CollectionBatchInput extends CollectionInput {
  batchIndex: number;
  /** Distinct touched paths in strictly ascending `compareTouchedPaths` order. */
  paths: readonly string[];
}

export interface CollectionBatchResult {
  collection: CollectionState;
  /** False for an exact replay of an accepted batch. */
  changed: boolean;
  /** Paths of this batch that are stored as touched Scopes (new or already present). */
  storedPathCount: number;
  /** Paths of this batch not stored because the Session reached its touched-Scope limit. */
  overCapacityPathCount: number;
}

/**
 * Accepts one batch of the current collection: stores a receipt (so an exact
 * replay is a no-op and finalize can recompute the manifest) and adds its
 * paths as touched Scopes, deduplicated per Session. Paths beyond the
 * Session's touched-Scope limit are not stored; that sets the sticky
 * historical incompleteness and is reported, never silently dropped.
 *
 * A path that cannot be stored as written (invalid UTF-8, over 256 bytes) is
 * a representation failure: the batch is refused with `unrepresentable_paths`
 * and, unlike other refusals, the sticky incompleteness is committed with it.
 */
export async function uploadCollectionBatch(
  db: Db,
  input: CollectionBatchInput,
): Promise<ScopeStoreOutcome<CollectionBatchResult>> {
  const { paths, batchIndex } = input;
  if (!isCount(batchIndex, MAX_COLLECTION_PATHS - 1)) {
    return {
      status: "invalid",
      reason: "invalid_batch_index",
      message: `batchIndex must be an integer from 0 to ${MAX_COLLECTION_PATHS - 1}.`,
    };
  }
  if (paths.length === 0 || paths.length > MAX_COLLECTION_BATCH_PATHS) {
    return {
      status: "invalid",
      reason: "invalid_batch_size",
      message: `A batch carries 1 to ${MAX_COLLECTION_BATCH_PATHS} paths.`,
    };
  }
  let unrepresentable = 0;
  for (const [index, path] of paths.entries()) {
    const result = normalizeTouchedPath(path);
    if (result.status === "invalid") {
      return {
        status: "invalid",
        reason: "invalid_path",
        message: `paths[${index}]: ${result.message}`,
      };
    }
    if (result.status === "incomplete") unrepresentable++;
    const previous = paths[index - 1];
    if (previous !== undefined && compareTouchedPaths(previous, path) >= 0) {
      return {
        status: "invalid",
        reason: "unordered_paths",
        message: "Batch paths must be distinct and in ascending code point order.",
      };
    }
  }
  // The receipt fingerprint, computed before the lock. Paths are already in
  // canonical order, so this is the batch's own manifest hash.
  const fingerprint = unrepresentable === 0 ? touchedPathsContentHash(paths) : null;

  return withCoordinationLock(db, input.projectId, async (context) => {
    const access = await currentCollection(context, input);
    if (access.status !== "ok") return access;
    const { session } = access;
    const { tx, now } = context;

    if (session.collectionExpectedBatches === null) {
      return conflict(
        "manifest_missing",
        `Register the manifest of collection ${input.collectionId} before uploading batches.`,
      );
    }
    if (batchIndex >= session.collectionExpectedBatches) {
      return conflict(
        "batch_out_of_range",
        `Collection ${input.collectionId} has ${session.collectionExpectedBatches} batches; index ${batchIndex} is out of range.`,
      );
    }
    if (fingerprint === null) {
      await loseCoverage(context, input, session, {
        collectionId: input.collectionId,
        reason: "unrepresentable_paths",
        pathCount: unrepresentable,
      });
      return conflict(
        "unrepresentable_paths",
        `${unrepresentable} path(s) are not valid UTF-8 or exceed 256 bytes; touched-path coverage is incomplete for the rest of this Session.`,
      );
    }

    const [receipt] = await tx
      .select()
      .from(scopeCollectionBatch)
      .where(
        and(
          eq(scopeCollectionBatch.sessionId, session.id),
          eq(scopeCollectionBatch.collectionId, input.collectionId),
          eq(scopeCollectionBatch.batchIndex, batchIndex),
        ),
      )
      .limit(1);
    const existing = await tx
      .select({ value: scope.value })
      .from(scope)
      .where(
        and(
          eq(scope.sessionId, session.id),
          eq(scope.source, "touched"),
          inArray(scope.value, [...paths]),
        ),
      );
    const present = new Set(existing.map((row) => row.value));

    if (receipt) {
      const replay =
        receipt.fingerprint === fingerprint &&
        receipt.paths.length === paths.length &&
        receipt.paths.every((path, index) => path === paths[index]);
      if (!replay) {
        return conflict(
          "batch_conflict",
          `Batch ${batchIndex} of collection ${input.collectionId} was already accepted with different paths.`,
        );
      }
      return {
        status: "ok",
        collection: await collectionState(tx, session, input.collectionId),
        changed: false,
        storedPathCount: present.size,
        overCapacityPathCount: paths.length - present.size,
      };
    }

    await tx.insert(scopeCollectionBatch).values({
      projectId: input.projectId,
      sessionId: session.id,
      collectionId: input.collectionId,
      batchIndex,
      paths: [...paths],
      fingerprint,
      createdAt: now,
    });

    const [touched] = await tx
      .select({ n: count() })
      .from(scope)
      .where(and(eq(scope.sessionId, session.id), eq(scope.source, "touched")));
    const room = Math.max(0, MAX_TOUCHED_SCOPES_PER_SESSION - (touched?.n ?? 0));
    const fresh = paths.filter((path) => !present.has(path));
    const accepted = fresh.slice(0, room);
    const overCapacity = fresh.length - accepted.length;

    if (accepted.length > 0) {
      await tx.insert(scope).values(
        accepted.map((value) => ({
          projectId: input.projectId,
          sessionId: session.id,
          source: "touched" as const,
          value,
          createdAt: now,
        })),
      );
      await insertEvent(tx, {
        projectId: input.projectId,
        type: "scope.touched",
        payload: { collectionId: input.collectionId, batchIndex, values: accepted },
        actor: actorOf(input),
        sessionId: session.id,
        now,
      });
    }
    if (overCapacity > 0) {
      await loseCoverage(context, input, session, {
        collectionId: input.collectionId,
        reason: "touched_capacity",
        pathCount: overCapacity,
      });
    }
    return {
      status: "ok",
      collection: await collectionState(tx, session, input.collectionId),
      changed: true,
      storedPathCount: present.size + accepted.length,
      overCapacityPathCount: overCapacity,
    };
  });
}

/**
 * Finalizes the Session's current collection: every expected batch must have
 * arrived, and the manifest recomputed from the stored receipts (distinct
 * path count and content hash, no path in two batches) must equal the
 * registered one. Only then is `collection_complete` set. A replay after
 * success is a no-op. Finalizing an older collection is a conflict, so a
 * delayed finalize never clears a newer collection's warning.
 */
export async function finalizeCollection(
  db: Db,
  input: CollectionInput,
): Promise<ScopeStoreOutcome<{ collection: CollectionState; changed: boolean }>> {
  return withCoordinationLock(db, input.projectId, async (context) => {
    const access = await currentCollection(context, input);
    if (access.status !== "ok") return access;
    const { session } = access;
    const { tx, now } = context;

    const expected = session.collectionExpectedBatches;
    if (expected === null || session.collectionPathCount === null) {
      return conflict(
        "manifest_missing",
        `Register the manifest of collection ${input.collectionId} before finalizing it.`,
      );
    }
    if (session.collectionComplete) {
      return {
        status: "ok",
        collection: await collectionState(tx, session, input.collectionId),
        changed: false,
      };
    }

    const receipts = await tx
      .select({ batchIndex: scopeCollectionBatch.batchIndex, paths: scopeCollectionBatch.paths })
      .from(scopeCollectionBatch)
      .where(
        and(
          eq(scopeCollectionBatch.sessionId, session.id),
          eq(scopeCollectionBatch.collectionId, input.collectionId),
        ),
      );
    const indexes = new Set(receipts.map((receipt) => receipt.batchIndex));
    let missing = 0;
    for (let index = 0; index < expected; index++) if (!indexes.has(index)) missing++;
    if (missing > 0) {
      return conflict(
        "batches_missing",
        `Collection ${input.collectionId} is missing ${missing} of ${expected} batches.`,
      );
    }

    const all = receipts.flatMap((receipt) => receipt.paths);
    const distinct = new Set(all);
    if (
      all.length !== distinct.size ||
      distinct.size !== session.collectionPathCount ||
      touchedPathsContentHash(distinct) !== session.collectionContentHash
    ) {
      return conflict(
        "manifest_mismatch",
        `The accepted batches of collection ${input.collectionId} do not match its manifest.`,
      );
    }

    await tx
      .update(agentSession)
      .set({ collectionComplete: true, updatedAt: now })
      .where(eq(agentSession.id, session.id));
    session.collectionComplete = true;
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "scope.collection_finalized",
      payload: { collectionId: input.collectionId, pathCount: distinct.size },
      actor: actorOf(input),
      sessionId: session.id,
      now,
    });
    return {
      status: "ok",
      collection: await collectionState(tx, session, input.collectionId),
      changed: true,
    };
  });
}

// --- Overlap ------------------------------------------------------------------

/** A Scope as overlap results show it. */
export interface OverlapScope {
  id: string;
  source: ScopeSource;
  value: string;
}

export interface ScopeOverlapItem {
  sessionId: string;
  otherSessionId: string;
  scope: OverlapScope;
  otherScope: OverlapScope;
  /** `possible`: the pair's search ran out of budget, so it may overlap (`witness: null`). */
  kind: "overlap" | "possible";
  /** A normalized repository path both Scopes match; null for `possible`. */
  witness: string | null;
}

/** Why a result is not a reliable all-clear. Each one means an overlap may be missing. */
export type OverlapIncompleteReason =
  /** More live candidate Sessions follow on later pages. */
  | { kind: "candidates_continued" }
  /** More results follow on later pages. */
  | { kind: "results_continued" }
  /** An earlier page of this check was incomplete for one of the reasons below. */
  | { kind: "earlier_page_incomplete" }
  /** Project-wide summary only: more live Sessions than it compares. */
  | { kind: "sessions_capped"; limit: number }
  | { kind: "comparison_budget_exhausted"; sessionIds: string[]; skippedComparisons: number }
  /** Pairs whose search ran out of state budget; they appear as `possible` items. */
  | { kind: "state_budget_exhausted"; pairs: number }
  /** A stored Scope failed validation and was not compared. */
  | { kind: "invalid_scope"; sessionId: string; scopeId: string | null }
  /** Compared Sessions whose touched-path coverage is incomplete (`isScopeComplete` false). */
  | { kind: "scope_incomplete"; sessionIds: string[] };

interface ComparedSession {
  id: string;
  collectionComplete: boolean;
  scopeHistoryIncomplete: boolean;
}

/** Scope rows keyed by Session, source and value (raw and normalized). */
function scopeIndex(rows: readonly Scope[]) {
  const byKey = new Map<string, Scope>();
  const key = (sessionId: string, source: ScopeSource, value: string) =>
    `${sessionId}\0${source}\0${value}`;
  for (const row of rows) {
    byKey.set(key(row.sessionId, row.source, row.value), row);
    if (row.source === "declared") {
      const normalized = normalizeDeclaredPattern(row.value);
      if (normalized.status === "valid") {
        const normalizedKey = key(row.sessionId, row.source, normalized.pattern);
        if (!byKey.has(normalizedKey)) byKey.set(normalizedKey, row);
      }
    }
  }
  return (sessionId: string, source: ScopeSource, value: string): OverlapScope => {
    const row = byKey.get(key(sessionId, source, value));
    // findScopeOverlaps reports only values it was given (declared ones
    // normalized), so every lookup finds its row.
    if (!row) throw new Error(`no stored Scope for ${sessionId} ${source} ${value}`);
    return { id: row.id, source: row.source, value: row.value };
  };
}

/**
 * Compares one selected Session with others and turns the matcher's report
 * into items with Scope ids, plus the reasons it is incomplete.
 */
function compareSelected(
  context: ScopeMatchContext,
  selectedSessionId: string,
  rows: readonly Scope[],
): { items: ScopeOverlapItem[]; reasons: OverlapIncompleteReason[] } {
  const entries: ScopeEntry[] = rows.map((row) => ({
    sessionId: row.sessionId,
    source: row.source,
    value: row.value,
  }));
  const report = findScopeOverlaps({ selectedSessionId, entries }, context);
  const lookup = scopeIndex(rows);
  const item = (overlap: ScopeOverlap, kind: "overlap" | "possible", witness: string | null) => ({
    sessionId: selectedSessionId,
    otherSessionId: overlap.sessionId,
    scope: lookup(selectedSessionId, overlap.selected.source, overlap.selected.value),
    otherScope: lookup(overlap.sessionId, overlap.other.source, overlap.other.value),
    kind,
    witness,
  });
  const items: ScopeOverlapItem[] = report.overlaps.map((overlap) =>
    item(overlap, "overlap", overlap.witness),
  );
  const reasons: OverlapIncompleteReason[] = [];
  let statePairs = 0;
  for (const reason of report.incomplete) {
    reasons.push(...matcherReason(reason, rows));
    if (reason.kind === "state_budget_exhausted") {
      statePairs++;
      items.push(
        item(
          {
            sessionId: reason.sessionId,
            selected: reason.selected,
            other: reason.other,
            witness: "",
          },
          "possible",
          null,
        ),
      );
    }
  }
  if (statePairs > 0) reasons.push({ kind: "state_budget_exhausted", pairs: statePairs });
  return { items, reasons };
}

function matcherReason(
  reason: ScopeIncompleteReason,
  rows: readonly Scope[],
): OverlapIncompleteReason[] {
  switch (reason.kind) {
    case "invalid_entry": {
      const row = rows.find(
        (candidate) =>
          candidate.sessionId === reason.sessionId &&
          candidate.source === reason.source &&
          candidate.value === reason.value,
      );
      return [{ kind: "invalid_scope", sessionId: reason.sessionId, scopeId: row?.id ?? null }];
    }
    case "comparison_budget_exhausted":
      return [
        {
          kind: "comparison_budget_exhausted",
          sessionIds: reason.sessionIds,
          skippedComparisons: reason.skippedComparisons,
        },
      ];
    case "state_budget_exhausted":
      // Counted by the caller, which adds one summary reason.
      return [];
  }
}

const sessionColumns = {
  id: agentSession.id,
  collectionComplete: agentSession.collectionComplete,
  scopeHistoryIncomplete: agentSession.scopeHistoryIncomplete,
};

function scopeIncompleteReason(sessions: readonly ComparedSession[]): OverlapIncompleteReason[] {
  const sessionIds = sessions.filter((session) => !isScopeComplete(session)).map((s) => s.id);
  return sessionIds.length > 0 ? [{ kind: "scope_incomplete", sessionIds }] : [];
}

function overlapWarning(reasons: readonly OverlapIncompleteReason[]): string | null {
  if (reasons.length === 0) return null;
  const kinds = [...new Set(reasons.map((reason) => reason.kind))].join(", ");
  return `Possible overlaps were not ruled out (${kinds}); this is not an all-clear.`;
}

/** Position in a paged overlap check. Opaque to clients; apps/web encodes it. */
export interface OverlapCursor {
  /** Candidates are the live Sessions with ids after this one (null: from the start). */
  candidatesAfter: string | null;
  /** Results of the current candidate page already returned. */
  resultOffset: number;
  /** An earlier page found a gap, so no later page may report `complete`. */
  earlierIncomplete: boolean;
}

export interface CheckScopeOverlapInput {
  projectId: string;
  /** The selected Session; any Session of the Project (authorization is the caller's). */
  sessionId: string;
  cursor?: OverlapCursor | null;
  /** Live candidate Sessions compared per page. */
  candidateLimit?: number;
  /** Results returned per page. */
  resultLimit?: number;
}

export interface ScopeOverlapPage {
  sessionId: string;
  /** Whether the selected Session itself is effectively live. */
  selectedLive: boolean;
  items: ScopeOverlapItem[];
  nextCursor: OverlapCursor | null;
  /**
   * True only on the last page of a check in which nothing was skipped:
   * no budget ran out, every compared Session has complete coverage, and
   * every Scope was valid. Never true when an overlap could be missing.
   */
  complete: boolean;
  reasons: OverlapIncompleteReason[];
  /** Compared Sessions (the selected one included) whose `isScopeComplete` is false. */
  incompleteSessionIds: string[];
  /** A one-line possible-overlap warning when `complete` is false. */
  warning: string | null;
}

/**
 * Compares the selected Session's Scopes with those of the Project's other
 * effectively live Sessions (stale, ended and abandoned ones are left out;
 * other Projects are never read), in one read transaction with one
 * `ScopeMatchContext`. Candidates are paged by Session id and results within
 * a candidate page by offset, independently; follow `nextCursor` to the end.
 * Overlaps are warnings only and never block a claim.
 */
export async function checkScopeOverlap(
  db: Db,
  input: CheckScopeOverlapInput,
): Promise<ScopeStoreOutcome<ScopeOverlapPage>> {
  const candidateLimit = pageLimit(input.candidateLimit);
  const resultLimit = pageLimit(input.resultLimit);
  const cursor = input.cursor ?? null;
  const resultOffset = Math.max(0, Math.trunc(cursor?.resultOffset ?? 0));

  return withCoordinationRead(db, async ({ tx, now }) => {
    const [selected] = await tx
      .select()
      .from(agentSession)
      .where(and(eq(agentSession.id, input.sessionId), eq(agentSession.projectId, input.projectId)))
      .limit(1);
    if (!selected) return { status: "not_found" };

    const conditions: (SQL | undefined)[] = [
      eq(agentSession.projectId, input.projectId),
      ne(agentSession.id, selected.id),
      liveSessionCondition(now),
    ];
    if (cursor?.candidatesAfter) conditions.push(gt(agentSession.id, cursor.candidatesAfter));
    const fetched = await tx
      .select(sessionColumns)
      .from(agentSession)
      .where(and(...conditions))
      .orderBy(asc(agentSession.id))
      .limit(candidateLimit + 1);
    const candidates = fetched.slice(0, candidateLimit);
    const moreCandidates = fetched.length > candidateLimit;

    const compared: ComparedSession[] = [selected, ...candidates];
    const rows = await tx
      .select()
      .from(scope)
      .where(
        and(
          eq(scope.projectId, input.projectId),
          inArray(
            scope.sessionId,
            compared.map((session) => session.id),
          ),
        ),
      )
      .orderBy(asc(scope.sessionId), asc(scope.source), asc(scope.value));

    const { items, reasons: gaps } = compareSelected(new ScopeMatchContext(), selected.id, rows);
    gaps.push(...scopeIncompleteReason(compared));

    const pageItems = items.slice(resultOffset, resultOffset + resultLimit);
    const moreResults = items.length > resultOffset + resultLimit;
    const earlierIncomplete = (cursor?.earlierIncomplete ?? false) || gaps.length > 0;

    const reasons: OverlapIncompleteReason[] = [...gaps];
    if (cursor?.earlierIncomplete) reasons.push({ kind: "earlier_page_incomplete" });
    if (moreResults) reasons.push({ kind: "results_continued" });
    if (moreCandidates) reasons.push({ kind: "candidates_continued" });

    let nextCursor: OverlapCursor | null = null;
    if (moreResults) {
      nextCursor = {
        candidatesAfter: cursor?.candidatesAfter ?? null,
        resultOffset: resultOffset + resultLimit,
        earlierIncomplete,
      };
    } else if (moreCandidates) {
      nextCursor = {
        candidatesAfter: candidates.at(-1)?.id ?? null,
        resultOffset: 0,
        earlierIncomplete,
      };
    }

    return {
      status: "ok",
      sessionId: selected.id,
      selectedLive: isSessionLive(selected, now),
      items: pageItems,
      nextCursor,
      complete: reasons.length === 0,
      reasons,
      incompleteSessionIds: compared.filter((s) => !isScopeComplete(s)).map((s) => s.id),
      warning: overlapWarning(reasons),
    };
  });
}

export interface ProjectOverlapSummary {
  /** Live Sessions compared, by id; at most `sessionLimit`. */
  sessionIds: string[];
  /** Overlaps between pairs of them, at most `overlapLimit`. */
  overlaps: ScopeOverlapItem[];
  /** False when an overlap may be missing (see `reasons`), including when either list was capped. */
  complete: boolean;
  reasons: OverlapIncompleteReason[];
  incompleteSessionIds: string[];
  warning: string | null;
}

/**
 * A bounded Project-wide overlap summary for `status`: every pair of the
 * Project's effectively live Sessions (the first `sessionLimit` by id),
 * sharing one `ScopeMatchContext`. Runs inside the caller's read transaction
 * so status uses one timestamp throughout.
 */
export async function summarizeProjectOverlaps(
  { tx, now }: CoordinationContext,
  input: { projectId: string; sessionLimit?: number; overlapLimit?: number },
): Promise<ProjectOverlapSummary> {
  const sessionLimit = pageLimit(input.sessionLimit);
  const overlapLimit = pageLimit(input.overlapLimit);

  const fetched = await tx
    .select(sessionColumns)
    .from(agentSession)
    .where(and(eq(agentSession.projectId, input.projectId), liveSessionCondition(now)))
    .orderBy(asc(agentSession.id))
    .limit(sessionLimit + 1);
  const sessions = fetched.slice(0, sessionLimit);
  const rows =
    sessions.length < 2
      ? []
      : await tx
          .select()
          .from(scope)
          .where(
            and(
              eq(scope.projectId, input.projectId),
              inArray(
                scope.sessionId,
                sessions.map((session) => session.id),
              ),
            ),
          )
          .orderBy(asc(scope.sessionId), asc(scope.source), asc(scope.value));

  const context = new ScopeMatchContext();
  const items: ScopeOverlapItem[] = [];
  const reasons: OverlapIncompleteReason[] = [];
  const bySession = Map.groupBy(rows, (row) => row.sessionId);
  sessions.forEach((selected, index) => {
    // Each pair once: the selected Session against those after it.
    const later = new Set(sessions.slice(index + 1).map((session) => session.id));
    const pairRows = [
      ...(bySession.get(selected.id) ?? []),
      ...rows.filter((row) => later.has(row.sessionId)),
    ];
    if (later.size === 0) return;
    const result = compareSelected(context, selected.id, pairRows);
    items.push(...result.items);
    // Invalid Scopes of later Sessions are reported once per comparison;
    // keep each only once.
    for (const reason of result.reasons) {
      if (!reasons.some((seen) => JSON.stringify(seen) === JSON.stringify(reason))) {
        reasons.push(reason);
      }
    }
  });
  if (sessions.length > 1) reasons.push(...scopeIncompleteReason(sessions));
  if (fetched.length > sessionLimit) reasons.push({ kind: "sessions_capped", limit: sessionLimit });
  if (items.length > overlapLimit) reasons.push({ kind: "results_continued" });

  return {
    sessionIds: sessions.map((session) => session.id),
    overlaps: items.slice(0, overlapLimit),
    complete: reasons.length === 0,
    reasons,
    incompleteSessionIds: sessions.filter((s) => !isScopeComplete(s)).map((s) => s.id),
    warning: overlapWarning(reasons),
  };
}
