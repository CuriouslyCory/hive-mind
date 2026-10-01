import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema/index.ts";

/**
 * Creates the Drizzle client for a `pg` pool. The pool owns the connections;
 * the caller creates it (with `createPool`, on the pooled `DATABASE_URL` at
 * runtime) and ends it.
 *
 * node-postgres supports interactive transactions:
 * `db.transaction(async (tx) => { ... })` runs on one connection checked out of
 * the pool and rolls back if the callback throws.
 */
export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

export { createClient, createPool, describeConnectionError } from "./connection.ts";
export {
  allocatePlanNumber,
  COORDINATION_LOCK_NAMESPACE,
  type CoordinationContext,
  type Transaction,
  type TryCoordinationLockResult,
  tryWithCoordinationLock,
  withCoordinationLock,
  withCoordinationRead,
} from "./coordination.ts";
export {
  type CreationKind,
  type CreationOutcome,
  type CreationRequest,
  type CreationRows,
  createOnce,
} from "./creation.ts";
export {
  EVENT_PAYLOAD_VERSIONS,
  type EventInput,
  type EventPayloads,
  EventPayloadTooLargeError,
  type EventType,
  encodedJsonBytes,
  insertEvent,
  MAX_EVENT_DTO_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
} from "./event.ts";
export { type EventFilter, listEvents, projectHasSession } from "./event-read.ts";
export {
  type CanonicalJson,
  canonicalJson,
  creationFingerprint,
  FingerprintInputTooLargeError,
  MAX_FINGERPRINT_INPUT_BYTES,
  sha256Hex,
} from "./fingerprint.ts";
export {
  CLAIM_LEASE_MS,
  effectiveSessionStatus,
  HEARTBEAT_INTERVAL_MS,
  isClaimUsable,
  isSessionLive,
  LIVE_SESSION_STATUSES,
  liveSessionCondition,
  SESSION_ABANDONED_AFTER_MS,
  SESSION_STALE_AFTER_MS,
  type SessionLiveness,
} from "./liveness.ts";
export {
  type AddTaskOutcome,
  type AppendPlanLogOutcome,
  addTask,
  appendPlanLog,
  assertStorableText,
  type CreatePlanOutcome,
  type CreationFailure,
  createPlan,
  getPlan,
  type InitialPlanStatus,
  isTerminalPlanStatus,
  listPlans,
  listPlanTasks,
  PLAN_TRANSITIONS,
  type PlanClosed,
  type PlanNotFound,
  type PlanProgress,
  type PlanView,
  type PlanWriter,
  planKey,
  resolvePlan,
  type SessionEnded,
  type SessionNotFound,
  type SetPlanStatusOutcome,
  setPlanStatus,
  type TargetPlanStatus,
  type TaskView,
  UnstorableTextError,
  type UpdatePlanOutcome,
  type UsableClaim,
  updatePlan,
  usableClaim,
} from "./plan.ts";
export {
  type Actor,
  creatorColumns,
  type Principal,
  samePrincipal,
  sessionOwner,
  sessionOwnerColumns,
} from "./principal.ts";
export {
  type CreateOrReuseProjectResult,
  createOrReuseProject,
  type DbOrTransaction,
  type ProjectInput,
} from "./project.ts";
export {
  type AgentSession,
  CREATOR_KINDS,
  type CreatorKind,
  PLAN_STATUSES,
  type Plan,
  type PlanStatus,
  SESSION_OWNER_KINDS,
  SESSION_STATUSES,
  type SessionOwnerKind,
  type SessionStatus,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
} from "./schema/coordination.ts";
export { EVENT_ACTOR_KINDS, type Event, type EventActorKind } from "./schema/event.ts";
export type { Project } from "./schema/project.ts";
export type { ProjectApiKey } from "./schema/project-api-key.ts";
export {
  SCOPE_SOURCES,
  type Scope,
  type ScopeCollectionBatch,
  type ScopeSource,
} from "./schema/scope.ts";
export {
  type DeclaredPatternInvalidReason,
  type DeclaredPatternResult,
  displayScopeValue,
  findScopeOverlaps,
  normalizeDeclaredPattern,
  normalizeTouchedPath,
  SCOPE_COMPARISON_BUDGET,
  SCOPE_PAIR_STATE_BUDGET,
  SCOPE_VALUE_MAX_BYTES,
  type ScopeComparison,
  type ScopeEntry,
  type ScopeIncompleteReason,
  ScopeMatchContext,
  type ScopeOverlap,
  type ScopeOverlapReport,
  type ScopeValue,
  type TouchedPathResult,
} from "./scope.ts";
export {
  type AddDeclaredScopeInput,
  addDeclaredScope,
  type CheckScopeOverlapInput,
  type CollectionBatchInput,
  type CollectionBatchResult,
  type CollectionInput,
  type CollectionManifestInput,
  type CollectionState,
  canonicalTouchedPaths,
  checkScopeOverlap,
  compareTouchedPaths,
  finalizeCollection,
  isScopeComplete,
  type ListScopesInput,
  listScopes,
  MAX_COLLECTION_BATCH_PATHS,
  MAX_COLLECTION_PATHS,
  MAX_DECLARED_SCOPES_PER_SESSION,
  MAX_TOUCHED_SCOPES_PER_SESSION,
  type OverlapCursor,
  type OverlapIncompleteReason,
  type OverlapScope,
  type OwnSessionInput,
  type ProjectOverlapSummary,
  type RemoveScopeInput,
  recordCollectionManifest,
  removeScope,
  SCOPE_PAGE_DEFAULT_LIMIT,
  SCOPE_PAGE_MAX_LIMIT,
  type ScopeConflictReason,
  type ScopeCursor,
  type ScopeOverlapItem,
  type ScopeOverlapPage,
  type ScopeStoreFailure,
  type ScopeStoreOutcome,
  summarizeProjectOverlaps,
  touchedPathsContentHash,
  uploadCollectionBatch,
} from "./scope-store.ts";
export { schema };
