import type { Transaction } from "./coordination.ts";
import type { Actor } from "./principal.ts";
import type { PlanStatus, SessionStatus, TaskStatus } from "./schema/coordination.ts";
import { type Event, event } from "./schema/event.ts";
import type { ScopeSource } from "./schema/scope.ts";

// Writing Events. Every M2 domain mutation inserts its Event in the same
// transaction as the change (issue #12), so a rollback removes both.

type Empty = Record<string, never>;

/**
 * The Event types and their payloads, at the payload version in
 * `EVENT_PAYLOAD_VERSIONS`. The records an Event is about (Plan, Task,
 * Session) and its actor are columns, not payload fields. Payloads hold only
 * what describes the change, never credentials or whole requests. Changing a
 * payload's shape means a new version, since stored Events keep the old one.
 */
export interface EventPayloads {
  // Plan Events and `task.added` have the names and payloads of the contract's
  // `eventSchema` (packages/contract/src/event.ts), which Event reads return
  // as stored.
  /** `key` is the Plan's PLAN-N key. */
  "plan.created": { key: string; title: string; status: PlanStatus };
  /** `title` is the new title, or null if unchanged; the body is not repeated. */
  "plan.updated": { title: string | null; bodyChanged: boolean };
  "plan.status_changed": { from: PlanStatus; to: Exclude<PlanStatus, "draft"> };
  /** A Plan log entry: bounded markdown. Its Event UUID is the client's entry ID. */
  "plan.log_appended": { message: string };
  "task.added": { title: string; position: number };
  "task.claimed": { leaseExpiresAt: string };
  /** A `--steal` takeover. The new holder is the Event's session_id. */
  "task.stolen": { fromSessionId: string; leaseExpiresAt: string };
  /**
   * The claim ended without the Task being done. The released holder is the
   * Event's session_id. `lease_expired` and `session_abandoned` are
   * time-driven: actor `system`, `effectiveAt` when the threshold was crossed.
   */
  "task.released": {
    reason:
      | "released"
      | "lease_expired"
      | "session_ended"
      | "session_stale"
      | "session_abandoned"
      | "plan_abandoned";
  };
  "task.started": { from: TaskStatus };
  "task.blocked": { reason: string };
  "task.done": Empty;
  "session.started": { agent: string; intent: string };
  /** The metadata fields that changed, with their new values. */
  "session.updated": Partial<{
    status: SessionStatus;
    agent: string;
    intent: string;
    machine: string | null;
    gitBranch: string | null;
    gitCommit: string | null;
    worktreePath: string | null;
  }>;
  "session.attached": { planId: string | null; taskId: string | null };
  /**
   * `previousStatus` is the effective status before the heartbeat (`stale`
   * when it revived the Session). `newCollection` is true when the heartbeat
   * started a new touched-path collection generation.
   */
  "session.heartbeat": {
    status: SessionStatus;
    previousStatus: SessionStatus;
    collectionId: string;
    newCollection: boolean;
  };
  /** A stored status the sweep or a mutation materialized (stale, abandoned). */
  "session.status_changed": { from: SessionStatus; to: SessionStatus };
  /**
   * The first accepted final summary. `status` is `ended`, or `abandoned`
   * when an abandoned Session accepted its summary and stayed abandoned.
   */
  "session.ended": { summary: string; status: "ended" | "abandoned" };
  "scope.added": { source: ScopeSource; value: string };
  "scope.removed": { source: ScopeSource; value: string };
  /** Touched paths a collection batch added as new Scopes (at most 16). */
  "scope.touched": { collectionId: string; batchIndex: number; values: string[] };
  /** A collection was verified against its manifest; its coverage is complete. */
  "scope.collection_finalized": { collectionId: string; pathCount: number };
  /**
   * The Session's sticky scope_history_incomplete was set: `pathCount` paths
   * were omitted by the client, could not be stored as written, or exceeded
   * the Session's touched-Scope limit; or (`unfinished_collection`) a
   * heartbeat started a new collection while `collectionId` was unfinished,
   * with `pathCount` its registered path count (0 if no manifest). Written
   * only when the flag changes.
   */
  "scope.coverage_lost": {
    collectionId: string | null;
    reason:
      | "omitted_paths"
      | "unrepresentable_paths"
      | "touched_capacity"
      | "unfinished_collection";
    pathCount: number;
  };
}

export type EventType = keyof EventPayloads;

export const EVENT_PAYLOAD_VERSIONS: { readonly [T in EventType]: number } = {
  "plan.created": 1,
  "plan.updated": 1,
  "plan.status_changed": 1,
  "plan.log_appended": 1,
  "task.added": 1,
  "task.claimed": 1,
  "task.stolen": 1,
  "task.released": 1,
  "task.started": 1,
  "task.blocked": 1,
  "task.done": 1,
  "session.started": 1,
  "session.updated": 1,
  "session.attached": 1,
  "session.heartbeat": 1,
  "session.status_changed": 1,
  "session.ended": 1,
  "scope.added": 1,
  "scope.removed": 1,
  "scope.touched": 1,
  "scope.collection_finalized": 1,
  "scope.coverage_lost": 1,
};

/**
 * Upper bound on an Event's DTO, the encoded JSON a reader receives (issue
 * #12; #11 derives its stream frame and batch budgets from it). The DTO is
 * defined in apps/web, which must test a maximal payload against this bound.
 */
export const MAX_EVENT_DTO_BYTES = 64 * 1024;

/**
 * Upper bound on an Event's encoded payload, enforced by `insertEvent`. It
 * leaves 4 KiB of `MAX_EVENT_DTO_BYTES` for the DTO's other fields (ids, type,
 * actor, timestamps), which are fixed-size. The largest legitimate payload, 8
 * KiB of markdown made of characters JSON escapes as `\u00XX`, encodes to
 * about 48 KiB.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 60 * 1024;

/** The UTF-8 length of `JSON.stringify(value)`. */
export function encodedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

export class EventPayloadTooLargeError extends Error {
  constructor(type: string, bytes: number) {
    super(`${type} payload is ${bytes} bytes; the limit is ${MAX_EVENT_PAYLOAD_BYTES}.`);
    this.name = "EventPayloadTooLargeError";
  }
}

export interface EventInput<T extends EventType> {
  projectId: string;
  type: T;
  payload: EventPayloads[T];
  /** Derived by the server from the authenticated caller, never from request fields. */
  actor: Actor;
  /** The records the Event is about. Each must belong to `projectId`. */
  planId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  /** The transaction's time (`CoordinationContext.now`), recorded as the write time. */
  now: Date;
  /** When the change took effect, if earlier than `now` (an expired lease). Defaults to `now`. */
  effectiveAt?: Date;
  /** The caller's UUID, for a Plan log entry. Otherwise Postgres generates one. */
  id?: string;
  /** For a Plan log entry: the fingerprint of its input (src/fingerprint.ts). */
  creationFingerprint?: string | null;
}

/**
 * Inserts an Event and returns it. `seq` and `writer_xid` come from Postgres;
 * callers cannot supply them. Throws `EventPayloadTooLargeError` for an
 * oversized payload, which aborts the caller's transaction with it.
 */
export async function insertEvent<T extends EventType>(
  tx: Transaction,
  input: EventInput<T>,
): Promise<Event> {
  const bytes = encodedJsonBytes(input.payload);
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) throw new EventPayloadTooLargeError(input.type, bytes);

  const actor = input.actor;
  const [row] = await tx
    .insert(event)
    .values({
      id: input.id,
      projectId: input.projectId,
      type: input.type,
      payloadVersion: EVENT_PAYLOAD_VERSIONS[input.type],
      payload: input.payload,
      actorKind: actor.kind,
      actorUserId: actor.kind === "user" ? actor.userId : null,
      actorKeyId: actor.kind === "project_key" ? actor.keyId : null,
      actorSessionId: actor.kind === "system" ? null : (actor.sessionId ?? null),
      planId: input.planId ?? null,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      effectiveAt: input.effectiveAt ?? input.now,
      creationFingerprint: input.creationFingerprint ?? null,
      createdAt: input.now,
    })
    .returning();
  if (!row) throw new Error("event insert returned no row");
  return row;
}
