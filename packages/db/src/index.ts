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
export {
  type CanonicalJson,
  canonicalJson,
  creationFingerprint,
  FingerprintInputTooLargeError,
  MAX_FINGERPRINT_INPUT_BYTES,
  sha256Hex,
} from "./fingerprint.ts";
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
export { schema };
