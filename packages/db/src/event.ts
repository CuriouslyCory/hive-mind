import type { Transaction } from "./coordination.ts";
import type { Actor } from "./principal.ts";
import type { PlanStatus, SessionStatus, TaskStatus } from "./schema/coordination.ts";
import { type Event, event } from "./schema/event.ts";

// Writing Events. Every M2 domain mutation inserts its Event in the same
// transaction as the change (issue #12), so a rollback removes both.

/** Why a Session's touched-path coverage became incomplete for good. */
export type CoverageLostReason =
  | "omitted_paths"
  | "unrepresentable_paths"
  | "touched_capacity"
  | "collection_superseded";

/** Session fields a `session.updated` Event lists (the contract's `SESSION_UPDATE_FIELDS`). */
export type SessionUpdateField =
  | "agent"
  | "intent"
  | "hostname"
  | "gitBranch"
  | "gitCommit"
  | "status";

/** An ADR's status, as ADR-0001 defines it, in `adr.*` payloads. */
type AdrFileStatus = "proposed" | "accepted" | "deprecated" | "superseded";

/**
 * One ADR in an `adr.synced` Event (the contract's `ADR_SYNC_CHANGE_KINDS`).
 * A status is null where no published copy exists: before `added` or
 * `restored`, and after `removed`.
 */
export type AdrSyncChange =
  | { number: number; change: "added" | "restored"; statusFrom: null; statusTo: AdrFileStatus }
  | { number: number; change: "updated"; statusFrom: AdrFileStatus; statusTo: AdrFileStatus }
  | { number: number; change: "removed"; statusFrom: AdrFileStatus; statusTo: null };

/** At most this many changes are listed in one `adr.synced` Event. */
export const MAX_ADR_SYNC_EVENT_CHANGES = 100;

/**
 * The Event types and their payloads, at the payload version in
 * `EVENT_PAYLOAD_VERSIONS`. The records an Event is about (Plan, Task,
 * Session) and its actor are columns, not payload fields. Payloads hold only
 * what describes the change, never credentials or whole requests. Changing a
 * payload's shape or meaning means a new version, since stored Events keep the
 * old one; a value added to an enum may keep the version (ADR-0015).
 */
export interface EventPayloads {
  // Plan, Task and Session Events have the names and payloads of the
  // contract's `knownEventSchema` (packages/contract/src/event.ts). Reads
  // return a stored Event unchanged when the reading build knows its type,
  // version and payload, and as `event.unavailable` otherwise (ADR-0015).
  // That fallback is response-only and never a writable type here.
  /** `key` is the Plan's PLAN-N key. */
  "plan.created": { key: string; title: string; status: PlanStatus };
  /** `title` is the new title, or null if unchanged; the body is not repeated. */
  "plan.updated": { title: string | null; bodyChanged: boolean };
  "plan.status_changed": { from: PlanStatus; to: Exclude<PlanStatus, "draft"> };
  /** A Plan log entry: bounded markdown. Its Event UUID is the client's entry ID. */
  "plan.log_appended": { message: string };
  "task.added": { title: string; position: number };
  /**
   * The new holder is the Event's session_id. A `--steal` takeover of a live
   * claim names the former holder in `stolenFromSessionId`; otherwise null.
   * `leaseExpiresAt` is an ISO 8601 timestamp.
   */
  "task.claimed": { stolenFromSessionId: string | null; leaseExpiresAt: string };
  /**
   * The claim ended without the Task being done. The released holder is the
   * Event's session_id. A steal releases the former holder with reason `stolen`.
   * `lease_expired` and `session_abandoned` are
   * time-driven: actor `system`, `effectiveAt` when the threshold was crossed.
   */
  "task.released": {
    reason:
      | "released"
      | "stolen"
      | "lease_expired"
      | "session_ended"
      | "session_stale"
      | "session_abandoned"
      | "plan_abandoned";
  };
  "task.started": { from: TaskStatus };
  "task.blocked": { from: TaskStatus; reason: string };
  "task.done": { from: TaskStatus };
  "session.started": { agent: string; intent: string };
  /** The names of the fields that changed (`hostname` is the `machine` column). */
  "session.updated": { fields: SessionUpdateField[] };
  /** The new focus is the Event's plan_id/task_id (both null when cleared). */
  "session.attached": { previousPlanId: string | null; previousTaskId: string | null };
  /**
   * `from` is the effective status before the heartbeat (`stale` when it
   * revived the Session), `to` the status it set.
   */
  "session.heartbeat": {
    from: SessionStatus;
    to: "active" | "idle";
    renewedClaimCount: number;
    releasedClaimCount: number;
    collectionId: string;
  };
  /** A Session lapsing to stale or abandoned, written by the sweep or a later mutation. */
  "session.status_changed": { from: SessionStatus; to: "stale" | "abandoned" };
  /**
   * The first accepted final summary. `from` is the effective status before
   * it: `abandoned` when an abandoned Session accepted its summary and stayed
   * abandoned.
   */
  "session.ended": { from: SessionStatus; summary: string };
  /** A declared Scope: its row id and glob. Touched Scopes are recorded by `scope.touched`. */
  "scope.added": { scopeId: string; pattern: string };
  /** A removed declared Scope (touched Scopes cannot be removed). */
  "scope.removed": { scopeId: string; pattern: string };
  /** Touched paths a collection batch added as new Scopes (at most 16). */
  "scope.touched": { collectionId: string; paths: string[] };
  /** A collection was verified against its manifest; its coverage is complete. */
  "scope.collection_finalized": { collectionId: string; pathCount: number };
  /**
   * The Session's sticky scope_history_incomplete was set: `pathCount` paths
   * were omitted by the client, could not be stored as written, or exceeded
   * the Session's touched-Scope limit; or a heartbeat opened a new collection
   * while `collectionId` was unfinished (`collection_superseded`, `pathCount`
   * from its manifest, null if none was registered). Written only when the
   * flag changes.
   */
  "scope.coverage_lost": {
    collectionId: string | null;
    reason: CoverageLostReason;
    pathCount: number | null;
  };
  // ADR Events affect no Plan, Task or Session: the ADR is named in the
  // payload, and plan_id, task_id and session_id stay null (issue #19).
  /**
   * A reserved ADR number (1 to 9999). `floor` is the highest ADR number the
   * client saw locally and on the default branch, 0 when it saw none.
   */
  "adr.reserved": { adrId: string; number: number; title: string; slug: string; floor: number };
  /**
   * One sync of the ADRs at `commitSha` (a full lowercase commit hash).
   * `previousCommitSha` is the commit synced before, null for the first sync;
   * `forced` means the client skipped its ancestry check. The counts cover
   * every change (`added` includes `restored`); `changes` lists the first
   * `MAX_ADR_SYNC_EVENT_CHANGES` in number order and `truncated` says whether
   * there were more. Never titles or content.
   */
  "adr.synced": {
    commitSha: string;
    previousCommitSha: string | null;
    forced: boolean;
    added: number;
    updated: number;
    removed: number;
    changes: AdrSyncChange[];
    truncated: boolean;
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
  "adr.reserved": 1,
  "adr.synced": 1,
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
