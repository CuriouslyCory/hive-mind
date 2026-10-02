import {
  addDeclaredScope,
  checkScopeOverlap,
  finalizeCollection as finalizeCollectionRecord,
  listScopes,
  type OverlapCursor,
  recordCollectionManifest,
  removeScope,
  type ScopeCursor,
  uploadCollectionBatch as uploadCollectionBatchRecord,
} from "@hivemind/db";
import { authorizeProject, lifecycleError, sessionNotFound } from "./coordination-auth";
import { toCollectionDto, toOverlapDto, toScopeDto } from "./coordination-dto";
import { api } from "./implementer";
import {
  type CursorScope,
  decodeKeysetCursor,
  EPOCH_MS_POSITION,
  encodeKeysetCursor,
  SAFE_INTEGER_POSITION,
  UUID_POSITION,
} from "./keyset";

// Scopes (issue #12 step 7): a Session's declared and touched Scopes, the
// touched-path collection protocol, and the overlap check. Lists and the
// overlap check read any Session of the Project; changes need the caller's
// own live Session (`@hivemind/db` scope-store.ts), and another principal's
// Session of the Project is 403.

/** `GET /projects/{id}/sessions/{sessionId}/scopes`: oldest first, optionally one source. */
export const listSessionScopes = api.projects.sessions.scopes.list.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["scope:read"]);
    const scope = ["session-scopes", input.id, input.sessionId, input.source];
    let after: ScopeCursor | null = null;
    if (input.cursor) {
      const [ms = "", id = ""] = decodeKeysetCursor(scope, input.cursor, [
        EPOCH_MS_POSITION,
        UUID_POSITION,
      ]);
      after = { createdAt: new Date(Number(ms)), id };
    }
    const page = await listScopes(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      source: input.source,
      limit: input.limit,
      after,
    });
    if (page.status !== "ok") throw lifecycleError(page, sessionNotFound);
    // Scope timestamps are written with millisecond precision
    // (scope-store.ts), so the epoch milliseconds are the exact position.
    const next = page.nextCursor;
    return {
      items: page.items.map(toScopeDto),
      nextCursor: next
        ? encodeKeysetCursor(scope, [String(next.createdAt.getTime()), next.id])
        : null,
    };
  },
);

/** `POST /projects/{id}/sessions/{sessionId}/scopes`: declare a glob, idempotent by value. */
export const addSessionScope = api.projects.sessions.scopes.add.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["scope:write"]);
    const outcome = await addDeclaredScope(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      pattern: input.pattern,
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return { scope: toScopeDto(outcome.scope), created: outcome.created };
  },
);

/** `DELETE /projects/{id}/sessions/{sessionId}/scopes/{scopeId}`: remove a declared Scope. */
export const removeSessionScope = api.projects.sessions.scopes.remove.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["scope:write"]);
    const outcome = await removeScope(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      scopeId: input.scopeId,
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return { id: input.scopeId, sessionId: input.sessionId, removed: outcome.removed };
  },
);

const OVERLAP_START = "start";
const OVERLAP_CANDIDATE = new RegExp(`^(?:${OVERLAP_START}|${UUID_POSITION.source.slice(1, -1)})$`);
const OVERLAP_FLAG = /^[01]$/;

function encodeOverlapCursor(scope: CursorScope, cursor: OverlapCursor): string {
  return encodeKeysetCursor(scope, [
    cursor.candidatesAfter ?? OVERLAP_START,
    String(cursor.resultOffset),
    cursor.earlierIncomplete ? "1" : "0",
  ]);
}

function decodeOverlapCursor(scope: CursorScope, cursor: string): OverlapCursor {
  const [candidatesAfter = "", resultOffset = "", earlierIncomplete = ""] = decodeKeysetCursor(
    scope,
    cursor,
    [OVERLAP_CANDIDATE, SAFE_INTEGER_POSITION, OVERLAP_FLAG],
  );
  return {
    candidatesAfter: candidatesAfter === OVERLAP_START ? null : candidatesAfter,
    resultOffset: Number(resultOffset),
    earlierIncomplete: earlierIncomplete === "1",
  };
}

/**
 * `GET /projects/{id}/sessions/{sessionId}/overlaps`: the Session's Scopes
 * against those of the Project's other live Sessions. `complete` carries
 * forward through the cursor, so only the last page's value covers the whole
 * check; any gap (budget, capping, incomplete coverage) makes it false.
 */
export const checkSessionOverlaps = api.projects.sessions.overlaps.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["session:read", "scope:read"]);
    const scope = ["overlaps", input.id, input.sessionId];
    const page = await checkScopeOverlap(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      cursor: input.cursor ? decodeOverlapCursor(scope, input.cursor) : null,
      candidateLimit: input.limit,
      resultLimit: input.limit,
    });
    if (page.status !== "ok") throw lifecycleError(page, sessionNotFound);
    return {
      items: page.items.map(toOverlapDto),
      nextCursor: page.nextCursor ? encodeOverlapCursor(scope, page.nextCursor) : null,
      complete: page.complete,
      incompleteSessionIds: page.incompleteSessionIds,
    };
  },
);

/** `POST .../collections/{collectionId}/manifest`: register the collection's manifest. */
export const registerCollectionManifest = api.projects.sessions.collections.manifest.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["scope:write"]);
    const outcome = await recordCollectionManifest(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      collectionId: input.collectionId,
      expectedBatches: input.batchCount,
      pathCount: input.pathCount,
      contentHash: input.contentHash,
      omittedPathCount: input.omittedPathCount,
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return { collection: toCollectionDto(outcome.collection), changed: outcome.changed };
  },
);

/** `POST .../collections/{collectionId}/batches`: one batch of touched paths. */
export const uploadCollectionBatch = api.projects.sessions.collections.batch.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["scope:write"]);
    const outcome = await uploadCollectionBatchRecord(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      collectionId: input.collectionId,
      batchIndex: input.batchIndex,
      paths: input.paths,
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return {
      collection: toCollectionDto(outcome.collection),
      changed: outcome.changed,
      storedPathCount: outcome.storedPathCount,
      overCapacityPathCount: outcome.overCapacityPathCount,
    };
  },
);

/** `POST .../collections/{collectionId}/finalize`: verify against the manifest. */
export const finalizeCollection = api.projects.sessions.collections.finalize.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["scope:write"]);
    const outcome = await finalizeCollectionRecord(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      collectionId: input.collectionId,
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return { collection: toCollectionDto(outcome.collection), changed: outcome.changed };
  },
);
